import { test, expect } from '@playwright/test';
import {
  PATTERN_AUDIO_PROTOCOL_VERSION, SUPPORTED_PATTERN_AUDIO_PROTOCOL_VERSIONS,
  PATTERN_AUDIO_PLAN_TYPE, PATTERN_AUDIO_CONTROLS_TYPE, PATTERN_CONTROLS_TRANSPORT,
  NODE_AUDIO_SIGNAL_PATTERN_ID, DEFAULT_AUDIO_INPUT,
  validatePatternAudioPlan, validatePatternAudioControls, toPublicPlanSlot,
  audioInputFingerprint,
} from '../src/pattern-audio-protocol.js';
import { PatternAudioControlStore } from '../src/pattern-audio-controls.js';
import { NODE_AUDIO_SOURCE } from '../src/nodes/audio-source.js';
import { FEATURE_SCHEMA } from '../src/sketches/feature-controls.js';

const sketches = () => ({ getSketchById: (id) => id === NODE_AUDIO_SOURCE.id ? NODE_AUDIO_SOURCE : null });

const v2Plan = (slots, over = {}) => ({
  type: PATTERN_AUDIO_PLAN_TYPE, version: 2, consumerSessionId: 'consumer-a',
  planRevision: 1, sentAt: 0, complete: true, slots, ...over,
});
const signalSlot = (over = {}) => ({
  runtimeId: 'node-audio-r1', patternId: NODE_AUDIO_SIGNAL_PATTERN_ID, role: 'preview',
  childIndex: 0, paramsRevision: 1, params: {}, audioTransport: PATTERN_CONTROLS_TRANSPORT,
  audioInput: { deviceId: null, channel: 'mono' }, ...over,
});

test('@core v2 plans carry routing metadata through every serializer boundary', () => {
  expect(SUPPORTED_PATTERN_AUDIO_PROTOCOL_VERSIONS).toEqual([1, 2]);
  const plan = validatePatternAudioPlan(v2Plan([signalSlot()]), sketches());
  expect(plan).not.toBeNull();
  expect(plan.version).toBe(2);
  expect(plan.slots[0].audioInput).toEqual({ deviceId: null, channel: 'mono' });
  // Public (wire) slots keep the selector; labels are never used as identity.
  expect(toPublicPlanSlot(plan.slots[0]).audioInput).toEqual({ deviceId: null, channel: 'mono' });
  const pinned = validatePatternAudioPlan(v2Plan([signalSlot({ audioInput: { deviceId: 'input-B', channel: 'right' } })]), sketches());
  expect(pinned.slots[0].audioInput).toEqual({ deviceId: 'input-B', channel: 'right' });
});

test('@core v2 routing metadata is strictly validated at the plan boundary', () => {
  // Required on v2 node-audio signal slots.
  const missing = { ...signalSlot() }; delete missing.audioInput;
  expect(validatePatternAudioPlan(v2Plan([missing]), sketches())).toBeNull();
  // Malformed selectors are rejected, never coerced into global routing.
  for (const audioInput of [{}, { deviceId: null }, { deviceId: 'a' }, { deviceId: null, channel: 'stereo' },
    { deviceId: '', channel: 'mono' }, { deviceId: 7, channel: 'mono' }, { deviceId: null, channel: 'mono', extra: 1 }]) {
    expect(validatePatternAudioPlan(v2Plan([signalSlot({ audioInput })]), sketches()), JSON.stringify(audioInput)).toBeNull();
  }
  // Nondefault routing is only meaningful on the node-audio signal source here.
  const patternSlot = { runtimeId: 'pattern-1', patternId: 'solid-color', role: 'preview', childIndex: 0,
    paramsRevision: 1, params: {}, audioTransport: PATTERN_CONTROLS_TRANSPORT };
  expect(validatePatternAudioPlan(v2Plan([{ ...patternSlot, audioInput: { deviceId: 'x', channel: 'left' } }]), { getSketchById: id => id === 'solid-color' ? { id, params: [], audioTransport: PATTERN_CONTROLS_TRANSPORT } : null })).toBeNull();
  // Ordinary v2 pattern slots may omit routing and keep global semantics.
  expect(validatePatternAudioPlan(v2Plan([patternSlot]), { getSketchById: id => id === 'solid-color' ? { id, params: [], audioTransport: PATTERN_CONTROLS_TRANSPORT } : null })).not.toBeNull();
});

test('@core v1 plans keep their exact semantics and refuse routing intent', () => {
  const legacy = { type: PATTERN_AUDIO_PLAN_TYPE, version: 1, consumerSessionId: 'old', planRevision: 3,
    sentAt: 0, complete: true, slots: [{ runtimeId: 'legacy-1', patternId: NODE_AUDIO_SIGNAL_PATTERN_ID,
      role: 'preview', childIndex: 0, paramsRevision: 1, params: {}, audioTransport: PATTERN_CONTROLS_TRANSPORT }] };
  const plan = validatePatternAudioPlan(legacy, sketches());
  expect(plan.version).toBe(1);
  expect(plan.slots[0]).not.toHaveProperty('audioInput');
  // A v1 plan that smuggles routing fields is rejected, not silently downgraded.
  expect(validatePatternAudioPlan({ ...legacy, slots: [signalSlot({ runtimeId: 'legacy-1' })] }, sketches())).toBeNull();
});

test('@core v2 controls carry source metadata and a matching routing echo', () => {
  const source = { id: 'owner-scoped-1', generation: 7, activeDeviceId: 'input-B', channels: 2,
    status: 'running', fallback: false, calibration: 'none' };
  const packet = {
    type: PATTERN_AUDIO_CONTROLS_TYPE, version: 2, consumerSessionId: 'consumer-a', planRevision: 1,
    audioOwnerId: 'owner', streamGeneration: 'gen-1', sequence: 4, captureTime: 12, audioActive: true,
    slots: [{ runtimeId: 'node-audio-r1', paramsRevision: 1, continuous: { bass: 1 }, arrays: {}, events: [],
      audioInput: { deviceId: 'input-B', channel: 'right' }, source }],
  };
  const clean = validatePatternAudioControls(packet);
  expect(clean).not.toBeNull();
  expect(clean.slots[0].source).toEqual(source);
  expect(clean.slots[0].audioInput).toEqual({ deviceId: 'input-B', channel: 'right' });
  // Bounded source metadata: bad status/enums/channels/device ids are malformed.
  for (const broken of [
    { ...source, status: 'exploded' }, { ...source, calibration: 'made-up' },
    { ...source, channels: 0 }, { ...source, channels: 257 }, { ...source, generation: -1 },
    { ...source, activeDeviceId: 'x'.repeat(513) }, { ...source, id: 'x'.repeat(161) },
    { ...source, fallback: 'yes' },
  ]) {
    expect(validatePatternAudioControls({ ...packet, slots: [{ ...packet.slots[0], source: broken }] }), JSON.stringify(broken)).toBeNull();
  }
  // v2 without source metadata is incomplete.
  const noSource = { ...packet.slots[0] }; delete noSource.source;
  expect(validatePatternAudioControls({ ...packet, slots: [noSource] })).toBeNull();
  // Unsupported versions never pass.
  expect(validatePatternAudioControls({ ...packet, version: 3 })).toBeNull();
  // v1 packets must not carry routing/source fields.
  const v1Packet = { ...packet, version: 1, slots: [{ runtimeId: 'node-audio-r1', paramsRevision: 1, continuous: {}, arrays: {}, events: [] }] };
  expect(validatePatternAudioControls(v1Packet)).not.toBeNull();
  expect(validatePatternAudioControls({ ...v1Packet, slots: [{ ...v1Packet.slots[0], source }] })).toBeNull();
});

test('@core the store accepts only packets echoing the registered selector', () => {
  const store = new PatternAudioControlStore({ consumerSessionId: 'consumer-a' });
  store.setPlan({ consumerSessionId: 'consumer-a', planRevision: 5, version: 2, slots: [
    { runtimeId: 'route-b', patternId: NODE_AUDIO_SOURCE.id, paramsRevision: 1, params: {},
      audioTransport: PATTERN_CONTROLS_TRANSPORT, audioControlSchema: FEATURE_SCHEMA,
      audioInput: { deviceId: 'input-B', channel: 'right' } },
  ] });
  const packet = (over = {}, slot = {}) => ({
    type: PATTERN_AUDIO_CONTROLS_TYPE, version: 2, consumerSessionId: 'consumer-a', planRevision: 5,
    audioOwnerId: 'owner', streamGeneration: 'g1', sequence: packet.sequence += 1, captureTime: 1, audioActive: true,
    slots: [{ runtimeId: 'route-b', paramsRevision: 1, continuous: { bass: 1.2 }, arrays: {}, events: [],
      audioInput: { deviceId: 'input-B', channel: 'right' },
      source: { id: 's1', generation: 1, activeDeviceId: 'input-B', channels: 2, status: 'running', fallback: false, calibration: 'none' },
      ...slot }], ...over,
  });
  packet.sequence = 10;
  expect(store.acceptPacket(packet()).slots).toBe(1);
  // Wrong selector echo: the slot is dropped with a diagnostic, never applied
  // as global audio (packet-level acceptance stays, matching per-slot policy).
  expect(store.acceptPacket(packet({}, { audioInput: { deviceId: 'input-C', channel: 'right' } })).slots).toBe(0);
  expect(store.acceptPacket(packet({}, { audioInput: { deviceId: 'input-B', channel: 'left' } })).slots).toBe(0);
  const missingEcho = packet(); delete missingEcho.slots[0].audioInput;
  expect(store.acceptPacket(missingEcho).slots).toBe(0);
  expect(store.diagnostics.droppedSelector).toBeGreaterThanOrEqual(3);
  // The last accepted sample survives the rejections.
  expect(store.read('route-b').continuous.bass).toBe(1.2);
  // A different wire version than the published plan is refused.
  expect(store.acceptPacket({ ...packet(), version: 1 }).accepted).toBe(false);
});

test('@core a source tuple change resets only its own slot, others keep history', () => {
  const store = new PatternAudioControlStore({ consumerSessionId: 'consumer-a' });
  store.setPlan({ consumerSessionId: 'consumer-a', planRevision: 2, version: 2, slots: [
    { runtimeId: 'route-a', patternId: NODE_AUDIO_SOURCE.id, paramsRevision: 1, params: {},
      audioTransport: PATTERN_CONTROLS_TRANSPORT, audioControlSchema: FEATURE_SCHEMA,
      audioInput: { deviceId: null, channel: 'mono' } },
    { runtimeId: 'route-b', patternId: NODE_AUDIO_SOURCE.id, paramsRevision: 1, params: {},
      audioTransport: PATTERN_CONTROLS_TRANSPORT, audioControlSchema: FEATURE_SCHEMA,
      audioInput: { deviceId: 'input-B', channel: 'right' } },
  ] });
  const slot = (runtimeId, source, extra = {}) => ({ runtimeId, paramsRevision: 1, continuous: { bass: 2 }, arrays: {}, events: [],
    audioInput: runtimeId === 'route-b' ? { deviceId: 'input-B', channel: 'right' } : { deviceId: null, channel: 'mono' }, source, ...extra });
  const running = (id, generation) => ({ id, generation, activeDeviceId: null, channels: null, status: 'running', fallback: false, calibration: 'none' });
  expect(store.acceptPacket({ type: PATTERN_AUDIO_CONTROLS_TYPE, version: 2, consumerSessionId: 'consumer-a',
    planRevision: 2, audioOwnerId: 'owner', streamGeneration: 'g1', sequence: 1, captureTime: 1, audioActive: true,
    slots: [slot('route-a', running('primary', 3)), slot('route-b', running('pin-b', 9))] }).accepted).toBe(true);
  // Same tuples again: plain renewal, no reset.
  expect(store.acceptPacket({ type: PATTERN_AUDIO_CONTROLS_TYPE, version: 2, consumerSessionId: 'consumer-a',
    planRevision: 2, audioOwnerId: 'owner', streamGeneration: 'g1', sequence: 2, captureTime: 2, audioActive: true,
    slots: [slot('route-a', running('primary', 3)), slot('route-b', running('pin-b', 9))] }).accepted).toBe(true);
  // B restarts (new generation): its slot restarts from the new sample with no
  // interpolation across the source change; A keeps its sample.
  expect(store.acceptPacket({ type: PATTERN_AUDIO_CONTROLS_TYPE, version: 2, consumerSessionId: 'consumer-a',
    planRevision: 2, audioOwnerId: 'owner', streamGeneration: 'g1', sequence: 3, captureTime: 3, audioActive: true,
    slots: [slot('route-a', running('primary', 3)), slot('route-b', running('pin-b', 10), { continuous: { bass: .5 } })] }).accepted).toBe(true);
  expect(store.read('route-a').continuous.bass).toBe(2);
  expect(store.read('route-b').continuous.bass).toBe(.5);
  expect(store.getState('route-b').source.generation).toBe(10);
});

test('@core selector fingerprints separate routes without numeric coercion', () => {
  expect(audioInputFingerprint(DEFAULT_AUDIO_INPUT)).toBe(JSON.stringify([null, 'mono']));
  expect(audioInputFingerprint({ deviceId: 'a', channel: 'left' }))
    .not.toBe(audioInputFingerprint({ deviceId: 'a', channel: 'right' }));
  expect(audioInputFingerprint({ deviceId: '1', channel: 'mono' }))
    .not.toBe(audioInputFingerprint({ deviceId: 1, channel: 'mono' }));
  expect(PATTERN_AUDIO_PROTOCOL_VERSION).toBe(2);
});
