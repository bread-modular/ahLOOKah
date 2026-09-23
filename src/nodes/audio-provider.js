import { PreviewAudio } from '../preview-audio.js';
import { FEATURE_SCHEMA } from '../sketches/feature-controls.js';
import { NODE_AUDIO_SOURCE } from './audio-source.js';
import { PatternAudioControlStore } from '../pattern-audio-controls.js';
import { CHANNEL_NAME } from '../platform/constants.js';
import {
  CATALOG_AUDIO_INPUTS_REQUEST_TYPE,
  CATALOG_AUDIO_INPUTS_TYPE,
  createAudioInputsCatalog,
} from '../audio-input-catalog.js';
import { PATTERN_AUDIO_PLAN_TYPE, PATTERN_AUDIO_PLAN_REQUEST_TYPE, PATTERN_AUDIO_CONTROLS_TYPE, PATTERN_AUDIO_PROTOCOL_VERSION, toPublicPlanSlot } from '../pattern-audio-protocol.js';
import { audioRouteKey, isDefaultAudioRoute, normalizeAudioRoute } from '../audio-routing.js';

// Internal controller only: never a palette entry, canvas, or microphone owner.

// Legacy single-consumer helper: one Global+Mono route slot (the exact slot the
// original implementation created), addressable through no-argument reads.
export function createSignalConsumer(store, role = 'preview') {
  return createSignalConsumers(store, role, [{ id: '__default__', deviceId: null, channel: 'mono' }]);
}

// One stable slot binding per distinct requested (deviceId, channel) route
// within this graph runtime; band is never part of the key because every
// internal slot already emits all bands. A null selector and an explicit id stay
// separate groups even while they resolve to the same input today.
export function createSignalConsumers(store, role = 'preview', audioNodes = []) {
  const nodeRoutes = new Map();

  const uuid = crypto.randomUUID();
  const entriesByKey = new Map();
  const descriptors = [];
  const addNodes = nodes => {
    let added = false;
    for (const node of nodes) {
      if (!node?.id || nodeRoutes.has(node.id)) continue;
      const route = normalizeAudioRoute(node.deviceId, node.channel) || { deviceId: null, channel: 'mono' };
      const key = audioRouteKey(route);
      nodeRoutes.set(node.id, key);
      if (entriesByKey.has(key)) continue;
      const descriptor = {
        runtimeId: `node-audio-${uuid}-${descriptors.length}`,
        patternId: NODE_AUDIO_SOURCE.id,
        role,
        childIndex: 0,
        paramsRevision: 1,
        params: {},
        audioTransport: 'pattern-controls',
        audioControlSchema: FEATURE_SCHEMA,
        audioInput: { ...route },
      };
      store?.upsertSlot(descriptor);
      const entry = { descriptor, binding: store?.createBinding(descriptor.runtimeId), active: true };
      entriesByKey.set(key, entry);
      descriptors.push(entry);
      added = true;
    }
    return added;
  };
  addNodes([...audioNodes].sort((a, b) => (isDefaultAudioRoute(a) ? -1 : 0) - (isDefaultAudioRoute(b) ? -1 : 0)));
  // Legacy no-argument reads prefer the default route even if it was added
  // later by a selected, previously disconnected preview branch.
  const defaultEntry = () => {
    const entry = entriesByKey.get(audioRouteKey({ deviceId: null, channel: 'mono' }));
    return entry?.active ? entry : descriptors.find(entry => entry.active) || null;
  };
  const entryFor = (nodeId) => {
    if (nodeId == null) return defaultEntry();
    const key = nodeRoutes.get(nodeId);
    return key != null ? (entriesByKey.get(key) || null) : null;
  };

  let disposed = false;
  return {
    addNodes(nodes) { return !disposed && addNodes(nodes); },
    // Lazy preview activation must not keep every previously inspected pinned
    // device in the owner's capture plan. Retain route ids/bindings for revisits,
    // but retire inactive slots so they stop consuming the input-pool budget.
    setActiveNodes(nodeIds) {
      if (disposed) return false;
      const activeKeys = new Set([...nodeIds].map(id => nodeRoutes.get(id)));
      let changed = false;
      for (const [key, entry] of entriesByKey) {
        const active = activeKeys.has(key);
        if (active === entry.active) continue;
        entry.active = active; changed = true;
        if (active) store?.upsertSlot(entry.descriptor);
        else store?.retireSlots([entry.descriptor.runtimeId]);
      }
      return changed;
    },
    read(nodeId = null) {
      if (disposed) return {};
      // Unknown node ids never fall through to another node's route; only a
      // legacy no-argument read resolves to the default route.
      if (nodeId != null && !nodeRoutes.has(nodeId)) return {};
      const entry = entryFor(nodeId) || defaultEntry();
      return entry?.active ? entry.binding?.read()?.continuous || {} : {};
    },
    getNodeStatus(nodeId) {
      if (disposed) return null;
      const entry = entryFor(nodeId);
      if (!entry?.active) return null;
      const state = entry.binding?.getState();
      if (!state) return null;
      return {
        audioInput: { ...entry.descriptor.audioInput },
        isReady: state.isReady,
        isFresh: state.isFresh,
        packetAge: state.packetAge,
        source: state.source ? { ...state.source } : null,
      };
    },
    getAudioSlotDescriptors(roleOverride = role) {
      if (disposed) return [];
      return descriptors.filter(entry => entry.active).map(({ descriptor }) => ({ ...descriptor, role: roleOverride }));
    },
    _controlFreshMarkers: () => [],
    dispose() {
      if (disposed) return;
      disposed = true;
      store?.retireSlots(descriptors.map(({ descriptor }) => descriptor.runtimeId));
    },
  };
}

// The standalone editor joins the existing capture owner's compact-control bus.
// It never acquires audio; without a main control window/input, signals are zero.
export function createEditorAudio() {
  const consumerSessionId = `nodes-editor-${crypto.randomUUID()}`;
  const store = new PatternAudioControlStore({ consumerSessionId });
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const audio = new PreviewAudio({ idleSignal: false });
  const inputs = createAudioInputsCatalog();
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
    if (data?.type === CATALOG_AUDIO_INPUTS_TYPE) inputs.accept(data);
  };
  const heartbeat = setInterval(publish, 1000);
  return {
    store, audio, refresh,
    setChildren(next) { if (disposed) return; children = next; publish(); },
    dispose() {
      if (disposed) return;
      children = []; publish(); disposed = true;
      clearInterval(heartbeat); audio.clearFrame(); channel.close(); inputs.reset();
    },
    // Same catalog interface as the internal runtime provider, fed by validated
    // owner broadcasts over this editor's own channel (never by local capture).
    getInputSnapshot: () => inputs.getSnapshot(),
    subscribeInputs: (listener) => inputs.subscribe(listener),
    refreshInputs() {
      if (disposed) return;
      channel.postMessage({ type: CATALOG_AUDIO_INPUTS_REQUEST_TYPE, requesterId: consumerSessionId });
      inputs.markStale();
    },
  };
}
