import { test, expect } from '@playwright/test';
import { validateGraph } from '../src/nodes/model.js';
import { parseGraph, serializeGraph } from '../src/nodes/portability.js';
import { defaultNode } from '../src/nodes/definitions.js';
import { createSignalConsumer, createSignalConsumers } from '../src/nodes/audio-provider.js';
import { GraphRuntime } from '../src/nodes/runtime.js';
import { PatternAudioControlStore } from '../src/pattern-audio-controls.js';
import { FEATURE_SCHEMA } from '../src/sketches/feature-controls.js';
import {
  DEFAULT_AUDIO_INPUT, AUDIO_CHANNELS, MAX_AUDIO_DEVICE_ID_LENGTH,
  normalizeAudioRoute, isValidAudioDeviceId, sameAudioRoute, isDefaultAudioRoute,
  audioRouteKey, projectChannelFrame, effectiveAudioChannel,
} from '../src/audio-routing.js';

const baseGraph = (nodes) => ({ version: 1, name: 'Routing', nodes: [
  { id: 'color', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .2, pulse: 0 }, x: 50, y: 50 },
  ...nodes,
  { id: 'output', type: 'output', x: 600, y: 50 },
], edges: [{ from: 'color', to: 'output', port: 'image' }] });
const audioGraph = (audio) => baseGraph([{ id: 'audio', type: 'audio', band: 'bass', x: 40, y: 300, ...audio }]);

test('@core new Audio nodes default to Global input + Mono and old graphs migrate', () => {
  const node = defaultNode('audio', 10, 20);
  expect(node.deviceId).toBeNull();
  expect(node.channel).toBe('mono');
  // Missing fields in a stored graph normalize to the documented defaults.
  const migrated = validateGraph(baseGraph([{ id: 'audio', type: 'audio', band: 'mid', x: 1, y: 2 }]));
  const audio = migrated.nodes.find(n => n.id === 'audio');
  expect(audio.deviceId).toBeNull();
  expect(audio.channel).toBe('mono');
  // Explicit null stays the Global selector; opaque ids keep case/punctuation.
  const pinned = validateGraph(audioGraph({ deviceId: 'usb:Device "{a,b}-1', channel: 'left' })).nodes.find(n => n.id === 'audio');
  expect(pinned.deviceId).toBe('usb:Device "{a,b}-1');
  expect(pinned.channel).toBe('left');
  // Omitted channel keeps the stored pin and falls back to Mono.
  const pinOnly = validateGraph(audioGraph({ deviceId: 'input-B' })).nodes.find(n => n.id === 'audio');
  expect(pinOnly).toMatchObject({ deviceId: 'input-B', channel: 'mono' });
  // Route fields are not signal/image ports: they add no inputs to the contract.
  expect(migrated.nodes.find(n => n.id === 'audio')).not.toHaveProperty('inputs');
});

test('@core invalid routing values are rejected, not silently repaired', () => {
  const cases = [
    { deviceId: '' }, // empty string is invalid in files (only the UI maps '' to Global)
    { deviceId: 'x'.repeat(MAX_AUDIO_DEVICE_ID_LENGTH + 1) },
    { deviceId: 'bad\ncontrol' },
    { deviceId: 'bad\tcontrol' },
    { deviceId: 42 },
    { deviceId: ['a'] },
    { deviceId: { id: 'a' } },
    { deviceId: null, channel: 'stereo' },
    { deviceId: null, channel: 'Mono' },
    { deviceId: null, channel: null },
    { deviceId: null, channel: 1 },
    { deviceId: null, channel: ['left'] },
  ];
  for (const audio of cases) expect(() => validateGraph(audioGraph(audio)), JSON.stringify(audio)).toThrow(/route/);
  // Band validation and the rest of the contract are untouched.
  expect(() => validateGraph(audioGraph({ band: 'sub' }))).toThrow(/band/);
  expect(normalizeAudioRoute(undefined, undefined)).toEqual(DEFAULT_AUDIO_INPUT);
  expect(isValidAudioDeviceId('a'.repeat(MAX_AUDIO_DEVICE_ID_LENGTH))).toBe(true);
  expect(isValidAudioDeviceId('')).toBe(false);
});

test('@core canonical reserialization is stable and opening an old file is not a user edit', () => {
  const deps = [{ id: 'solid-color', kind: 'built-in', name: 'Solid Color', signature: null }];
  const legacy = JSON.stringify({ format: 'viz2-nodes', version: 1, graph: baseGraph([{ id: 'audio', type: 'audio', band: 'bass', x: 40, y: 300 }]), dependencies: deps });
  const parsed = parseGraph(legacy);
  // The editor's dirty baseline is built from the normalized graph, so loading
  // an old file never presents migration as an unsaved user edit.
  const first = serializeGraph(parsed.graph, parsed.dependencies);
  const second = serializeGraph(parseGraph(first).graph, parsed.dependencies);
  expect(second).toBe(first);
  const graph = JSON.parse(first).graph;
  expect(graph.nodes.find(n => n.id === 'audio')).toMatchObject({ deviceId: null, channel: 'mono' });
  // Pinned routes round-trip exactly (no case folding or id rewriting).
  const routed = serializeGraph(validateGraph(audioGraph({ deviceId: 'USB_Interface_2', channel: 'right' })), []);
  expect(JSON.parse(routed).graph.nodes.find(n => n.id === 'audio').deviceId).toBe('USB_Interface_2');
});

test('@core route keys group by requested selector, never by band or resolved device', () => {
  expect(audioRouteKey({ deviceId: null, channel: 'mono' })).toBe(audioRouteKey(DEFAULT_AUDIO_INPUT));
  expect(audioRouteKey({ deviceId: 'a', channel: 'left' })).not.toBe(audioRouteKey({ deviceId: 'a', channel: 'right' }));
  expect(audioRouteKey({ deviceId: 'a', channel: 'left' })).not.toBe(audioRouteKey({ deviceId: 'b', channel: 'left' }));
  // A null selector and an explicit id stay separate even while both resolve to
  // the same input today: their future behavior differs.
  expect(audioRouteKey({ deviceId: null, channel: 'mono' })).not.toBe(audioRouteKey({ deviceId: 'default', channel: 'mono' }));
  // Delimiter-bearing ids cannot collide with crafted tuples.
  expect(audioRouteKey({ deviceId: 'a\u0000b', channel: 'left' })).not.toBe(audioRouteKey({ deviceId: 'a', channel: 'left' }).replace('left', 'b\u0000left'));
  expect(sameAudioRoute(DEFAULT_AUDIO_INPUT, { deviceId: null, channel: 'mono' })).toBe(true);
  expect(isDefaultAudioRoute({ deviceId: null, channel: 'mono' })).toBe(true);
  expect(isDefaultAudioRoute({ deviceId: null, channel: 'left' })).toBe(false);
});

test('@core channel projection isolates one channel and never copies combined RMS', () => {
  const frame = () => ({
    left: new Float32Array([-80, -40]),
    right: new Float32Array([-70, -50]),
    waveformLeft: new Float32Array([.5, -.5]),
    waveformRight: new Float32Array([.1, -.1]),
    sampleRate: 48000, fftSize: 4, time: 7, deviceId: 'd', channels: 2,
    rms: .9, // combined override must not leak into a single channel
  });
  const left = projectChannelFrame(frame(), 'left');
  expect(left.right).toBeUndefined();
  expect(left.waveformRight).toBeUndefined();
  expect(left.left).toEqual(new Float32Array([-80, -40]));
  expect(left.rms).toBeCloseTo(Math.sqrt((.25 + .25) / 2), 12);
  const right = projectChannelFrame(frame(), 'right');
  expect(right.left).toEqual(new Float32Array([-70, -50]));
  // Float32 waveform storage: compare with realistic precision.
  expect(right.rms).toBeCloseTo(Math.sqrt((.01 + .01) / 2), 6);
  // Mono is the identity: today's combined frame flows through unchanged.
  const mono = frame();
  expect(projectChannelFrame(mono, 'mono')).toBe(mono);
  // Source arrays are shared read-only views, never duplicated per tick.
  const sameSource = frame(), leftView = projectChannelFrame(sameSource, 'left');
  expect(leftView.left).toBe(sameSource.left);
  expect(leftView.waveformLeft).toBe(sameSource.waveformLeft);
  // Missing waveform data leaves RMS to the extractor's own computation.
  const bare = projectChannelFrame({ ...frame(), waveformLeft: undefined, waveformRight: undefined }, 'left');
  expect(bare.rms).toBeUndefined();
  expect(projectChannelFrame(null, 'left')).toBeNull();
});

test('@core physical mono mirrors every selection onto the same effective route', () => {
  expect(effectiveAudioChannel('left', 1)).toBe('mono');
  expect(effectiveAudioChannel('right', 1)).toBe('mono');
  expect(effectiveAudioChannel('mono', 1)).toBe('mono');
  expect(effectiveAudioChannel('left', 2)).toBe('left');
  expect(effectiveAudioChannel('right', 2)).toBe('right');
  // Unknown count keeps the conservative mono-mirror assumption.
  expect(effectiveAudioChannel('left', null)).toBe('mono');
  expect(effectiveAudioChannel('left', undefined)).toBe('mono');
  // More than two exposed channels still analyses only the first two.
  expect(effectiveAudioChannel('right', 8)).toBe('right');
  expect(AUDIO_CHANNELS).toEqual(['left', 'right', 'mono']);
});


// ---------------------------------------------------------------------------
// Grouped route consumers (one slot per distinct requested route per runtime).
// These run inside the browser page: the consumer and runtime touch the store
// and document-bound runtime services, matching the repo's existing spec style.
// ---------------------------------------------------------------------------

test('@core Audio nodes sharing a route share one slot; different routes never collapse', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { PatternAudioControlStore } = await import('/src/pattern-audio-controls.js');
    const { createSignalConsumer, createSignalConsumers } = await import('/src/nodes/audio-provider.js');
    const { DEFAULT_AUDIO_INPUT } = await import('/src/audio-routing.js');
    const node = (id, deviceId, channel, band = 'bass') => ({ id, type: 'audio', band, deviceId, channel });
    const store = new PatternAudioControlStore({ consumerSessionId: 'graph' });
    const consumer = createSignalConsumers(store, 'preview', [
      node('a1', null, 'mono', 'bass'),
      node('a2', null, 'mono', 'high'), // same route, different band
      node('b', 'input-B', 'right', 'bass'),
      node('c', null, 'left', 'mid'),
    ]);
    const descriptors = consumer.getAudioSlotDescriptors();
    const routes = descriptors.map(d => d.audioInput);
    const unique = new Set(descriptors.map(d => d.runtimeId)).size;
    const legacy = createSignalConsumer(store, 'cue');
    const legacyDescriptors = legacy.getAudioSlotDescriptors();
    const legacyOk = legacyDescriptors.length === 1 && legacyDescriptors[0].audioInput.deviceId === null
      && legacyDescriptors[0].audioInput.channel === 'mono' && legacyDescriptors[0].role === 'cue'
      && legacy.getNodeStatus('__default__') !== null;
    consumer.dispose();
    legacy.dispose();
    const afterDispose = consumer.getAudioSlotDescriptors().length + store.slots.size;
    consumer.dispose(); // idempotent
    return { routes, unique, afterDispose, legacyDescriptors: legacyDescriptors.length, legacyOk, DEFAULT: DEFAULT_AUDIO_INPUT };
  });
  expect(result.routes).toEqual([
    { deviceId: null, channel: 'mono' },
    { deviceId: 'input-B', channel: 'right' },
    { deviceId: null, channel: 'left' },
  ]);
  expect(result.unique).toBe(3);
  expect(result.afterDispose).toBe(0);
  expect(result.legacyDescriptors).toBe(1);
  expect(result.legacyOk).toBe(true);
});

test('@core read(nodeId) and getNodeStatus resolve each node to its own binding', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { PatternAudioControlStore } = await import('/src/pattern-audio-controls.js');
    const { createSignalConsumers } = await import('/src/nodes/audio-provider.js');
    const { response } = await import('/src/sketches/feature-controls.js');
    const node = (id, deviceId, channel) => ({ id, type: 'audio', band: 'bass', deviceId, channel });
    const store = new PatternAudioControlStore({ consumerSessionId: 'graph' });
    const consumer = createSignalConsumers(store, 'preview', [node('a', null, 'mono'), node('b', 'input-B', 'right')]);
    const descriptors = consumer.getAudioSlotDescriptors();
    store.setPlan({ consumerSessionId: 'graph', planRevision: 1, version: 2, slots: descriptors });
    const frames = [{ bass: 1.6 }, { bass: 3.2 }];
    const sources = ['primary', 'extra:input-B'];
    store.acceptPacket({
      type: 'pattern-audio-controls', version: 2, consumerSessionId: 'graph', planRevision: 1,
      audioOwnerId: 'owner', streamGeneration: 'g1', sequence: 1, captureTime: 0, audioActive: true,
      slots: descriptors.map((d, i) => ({
        runtimeId: d.runtimeId, paramsRevision: 1, continuous: frames[i], arrays: {}, events: [],
        audioInput: d.audioInput,
        source: { id: sources[i], generation: 1, activeDeviceId: null, channels: 2, status: 'running', fallback: false, calibration: 'none' },
      })),
    });
    const statusB = consumer.getNodeStatus('b');
    const info = {
      a: response(consumer.read('a').bass),
      b: response(consumer.read('b').bass),
      missing: consumer.read('missing'),
      statusB: { audioInput: statusB.audioInput, isFresh: statusB.isFresh, sourceId: statusB.source.id, status: statusB.source.status },
    };
    consumer.dispose();
    return info;
  });
  expect(result.a).toBeCloseTo(1.6 / 3.2, 12);
  expect(result.b).toBe(1);
  expect(result.missing).toEqual({});
});

test('@core both scalar read paths use the node-specific route binding', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { signalValue } = await import('/src/nodes/modulation.js');
    const { audioRouteKey } = await import('/src/audio-routing.js');
    const { PatternAudioControlStore } = await import('/src/pattern-audio-controls.js');
    const graph = { version: 1, name: 'paths', nodes: [
      { id: 'colorA', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .2, pulse: 0 }, x: 0, y: 0 },
      { id: 'colorB', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .2, pulse: 0 }, x: 200, y: 0 },
      { id: 'sum', type: 'math', op: 'add', a: 0, b: 0, c: 1, x: 0, y: 200 },
      { id: 'ga', type: 'audio', band: 'bass', deviceId: null, channel: 'mono', x: 0, y: 300 },
      { id: 'gb', type: 'audio', band: 'bass', deviceId: 'input-B', channel: 'right', x: 100, y: 300 },
      { id: 'output', type: 'output', x: 400, y: 0 },
    ], edges: [{ from: 'colorA', to: 'output', port: 'image' }],
    signalEdges: [{ from: 'ga', to: 'sum', port: 'a' }, { from: 'gb', to: 'sum', port: 'b' }],
    modulations: [
      { from: 'ga', to: 'colorA', param: 'brightness', min: .2, max: .8 },
      { from: 'gb', to: 'colorB', param: 'brightness', min: .2, max: .8 },
    ] };
    const frames = { [audioRouteKey({ deviceId: null, channel: 'mono' })]: { bass: 1.6 }, [audioRouteKey({ deviceId: 'input-B', channel: 'right' })]: { bass: 3.2 } };
    const registry = new Map();
    const realStore = new PatternAudioControlStore({ consumerSessionId: 'graph' });
    const store = {
      upsertSlot: d => registry.set(d.runtimeId, d),
      retireSlots: ids => ids.forEach(id => registry.delete(id)),
      createBinding: (runtimeId) => ({ read: () => ({ continuous: frames[audioRouteKey(registry.get(runtimeId).audioInput)] || {} }) }),
    };
    void realStore;
    const runtime = new GraphRuntime({ graph, sketches: [{ id: 'solid-color', params: [{ key: 'brightness', label: 'Brightness', min: 0, max: 1, step: .01, default: .2 }] }], context: { audioControlStore: store } });
    const views = [...runtime.params.values()];
    const info = {
      brightnessA: views[0].brightness,
      brightnessB: views[1].brightness,
      ga: runtime.signalValue('ga'),
      gb: runtime.signalValue('gb'),
      sum: runtime.signalValue('sum'),
    };
    info.mathMatchesBindings = Math.abs(info.sum - (info.ga + info.gb)) < 1e-9;
    info.directMatchesBindings = Math.abs(info.brightnessB - (.2 + .6 * info.gb)) < 1e-9
      && Math.abs(info.brightnessA - (.2 + .6 * info.ga)) < 1e-9;
    runtime.dispose();
    return info;
  });
  expect(result.ga).toBeCloseTo(0.5, 6);
  expect(result.gb).toBe(1);
  expect(result.mathMatchesBindings).toBe(true);
  expect(result.directMatchesBindings).toBe(true);
  expect(result.brightnessB).toBeGreaterThan(result.brightnessA);
});
