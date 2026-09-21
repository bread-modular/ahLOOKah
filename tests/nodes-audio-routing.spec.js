import { test, expect } from '@playwright/test';
import { validateGraph } from '../src/nodes/model.js';
import { parseGraph, serializeGraph } from '../src/nodes/portability.js';
import { defaultNode } from '../src/nodes/definitions.js';
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
