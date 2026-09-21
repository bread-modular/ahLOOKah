import { PreviewAudio } from '../preview-audio.js';
import { FEATURE_SCHEMA } from '../sketches/feature-controls.js';
import { NODE_AUDIO_SOURCE } from './audio-source.js';
import { PatternAudioControlStore } from '../pattern-audio-controls.js';
import { CHANNEL_NAME } from '../platform/constants.js';
import { PATTERN_AUDIO_PLAN_TYPE, PATTERN_AUDIO_PLAN_REQUEST_TYPE, PATTERN_AUDIO_CONTROLS_TYPE, PATTERN_AUDIO_PROTOCOL_VERSION, toPublicPlanSlot } from '../pattern-audio-protocol.js';

// Internal controller only: never a palette entry, canvas, or microphone owner.

export function createSignalConsumer(store, role = 'preview') {
  const descriptor = { runtimeId: `node-audio-${crypto.randomUUID()}`, patternId: NODE_AUDIO_SOURCE.id, role, childIndex: 0, paramsRevision: 1, params: {}, audioTransport: 'pattern-controls', audioControlSchema: FEATURE_SCHEMA };
  store?.upsertSlot(descriptor);
  const binding = store?.createBinding(descriptor.runtimeId);
  let disposed = false;
  return {
    read: () => disposed ? {} : binding?.read()?.continuous || {},
    getAudioSlotDescriptors: (role = descriptor.role) => disposed ? [] : [{ ...descriptor, role }],
    _controlFreshMarkers: () => [],
    dispose() { if (disposed) return; disposed = true; store?.retireSlots([descriptor.runtimeId]); },
  };
}
// The standalone editor joins the existing capture owner's compact-control bus.
// It never acquires audio; without a main control window/input, signals are zero.
export function createEditorAudio() {
  const consumerSessionId = `nodes-editor-${crypto.randomUUID()}`;
  const store = new PatternAudioControlStore({ consumerSessionId });
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const audio = new PreviewAudio({ idleSignal: false });
  let children = [], revision = 0, topology = '', disposed = false, queued = false;
  const publish = () => {
    if (disposed) return;
    const slots = children.flatMap(c => c.getAudioSlotDescriptors('preview'));
    const nextTopology = JSON.stringify(slots.map(s => s.runtimeId).sort());
    if (nextTopology !== topology) { topology = nextTopology; revision++; }
    const plan = { type: PATTERN_AUDIO_PLAN_TYPE, version: PATTERN_AUDIO_PROTOCOL_VERSION, consumerSessionId, planRevision: revision, sentAt: performance.now(), complete: true, slots };
    store.setPlan(plan);
    channel.postMessage({ ...plan, windowId: consumerSessionId, slots: slots.map(toPublicPlanSlot) });
  };
  // Slot notifications may fire while a child is being constructed or while
  // descriptors refresh. Defer/coalesce to avoid publishing a partial graph or
  // recursively re-entering descriptor collection. Heartbeats retain revisions.
  const refresh = () => {
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; publish(); });
  };
  channel.onmessage = ({ data }) => {
    if (data?.type === PATTERN_AUDIO_CONTROLS_TYPE) {
      if (data.windowId && data.windowId !== data.audioOwnerId) return;
      const receipt = store.acceptPacket(data);
      if (receipt.accepted && receipt.slots > 0) {
        if (data.audioActive) audio.setControlActive();
        else audio.clearFrame();
      }
    }
    if (data?.type === PATTERN_AUDIO_PLAN_REQUEST_TYPE) publish();
  };
  const heartbeat = setInterval(publish, 1000);
  return {
    store, audio, refresh,
    setChildren(next) { if (disposed) return; children = next; publish(); },
    dispose() {
      if (disposed) return;
      children = []; publish(); disposed = true;
      clearInterval(heartbeat); audio.clearFrame(); channel.close();
    },
  };
}
