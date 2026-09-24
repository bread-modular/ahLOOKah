// The MIDI signal node: its stored contract, the device/channel session, the
// envelope and glide math, the live runtime path and the editor inspector. Pure
// checks run in Node; the runtime and the inspector run in the real editor page.
//
// The node follows the LFO's shape: it emits one normalized 0…1 value and its own
// sliders (Attack, Decay, Apply Velocity) are automated through the ordinary
// modulation endpoint — never through scalar input ports, and never for its
// switches (mode, gate mode, channel, device).
import { test, expect } from '@playwright/test';
import { validateGraph, mapSignal, readPaletteDrag, DRAG_TYPE } from '../src/nodes/model.js';
import { manifestFor, serializeGraph, parseGraph, graphDiagnostics } from '../src/nodes/portability.js';
import { TYPES, SIGNAL_TYPES, MODULATION_TARGETS, parameters, defaultNode, inputs, isSignalSource, isModulationTarget, isScalarConsumer } from '../src/nodes/definitions.js';
import { definitions, mappedValue, clampStep, defaultInputRange } from '../src/nodes/modulation.js';
import { MIDI_MODES, MIDI_GATE_MODES, MIDI_CHANNELS, MIDI_PARAMS, MIDI_CC_PARAM, MIDI_PARAM_SLEW, midiDefaults, midiParameters, midiGlide, midiNodeParams, midiModeOf, midiChannelOf, midiDeviceOf, midiCcOf } from '../src/nodes/midi.js';
import { LFO_RATE_SLEW } from '../src/nodes/lfo.js';
import { createMidiService, newChannelState, applyMidiMessage, gateLevel, midiLevel, ccLevel, clamp01, PULSE_FLOOR_S } from '../src/midi/midi-service.js';

const solid = (id, x = 40, y = 40) => ({ id, type: 'pattern', patternId: 'solid-color', x, y, params: { hue: 0, saturation: 1, brightness: .5, pulse: 0 } });
const colorNode = (id, x = 260, y = 40) => ({ id, type: 'color', x, y, params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 } });
const out = { id: 'output', type: 'output', x: 480, y: 40 };
const midiNode = (id, overrides = {}, x = 40, y = 320) => ({ ...defaultNode('midi', x, y, id), ...overrides });
// band sweeps the node's own Attack, and the node's value sweeps a Color slider:
// both directions the feature promises, with no signal edges involved.
const graph = () => ({
  version: 2, name: 'MIDI sweep',
  nodes: [solid('base'), colorNode('tint'), midiNode('m'), { id: 'band', type: 'audio', x: 40, y: 520, band: 'bass', deviceId: null, channel: 'mono' }, out],
  edges: [{ from: 'base', to: 'tint', port: 'image' }, { from: 'tint', to: 'output', port: 'image' }],
  modulations: [
    { from: 'm', to: 'tint', param: 'saturation', min: 0, max: 2 },
    { from: 'band', to: 'm', param: 'attack', min: .001, max: 5 },
  ],
});
const withMidi = (node, base = graph()) => ({ ...base, nodes: base.nodes.map(n => n.id === 'm' ? { ...n, ...node } : n) });
// A realistic fake MIDIAccess: a Map of inputs plus a real statechange listener.
function fakeAccess() {
  const listeners = new Set();
  const ports = new Map();
  const fire = () => { for (const listener of listeners) listener({ port: null }); };
  return {
    access: { inputs: ports, sysexEnabled: false, addEventListener: (_type, callback) => listeners.add(callback), removeEventListener: (_type, callback) => listeners.delete(callback) },
    // A device plugged in after the grant must reach the session through statechange.
    connect(port) { ports.set(port.id, port); fire(); },
    unplug(port) { ports.delete(port.id); fire(); },
  };
}
const midiPort = (id, name = 'Controller') => ({ id, name, manufacturer: '', onmidimessage: null });

// ---------------------------------------------------------------------------
// Stored contract, validation and the automation domain (no browser needed)
// ---------------------------------------------------------------------------

test('midi is a first-class signal source and an automation target with no scalar ports', () => {
  expect(TYPES).toContain('midi');
  expect(SIGNAL_TYPES).toContain('midi');
  expect(MODULATION_TARGETS).toContain('midi');
  expect(isSignalSource({ type: 'midi' })).toBe(true);
  expect(isModulationTarget({ type: 'midi' })).toBe(true);
  // It emits a scalar, never a picture, and it takes no scalar input ports: its own
  // sliders are automated through the mapping system, exactly like the LFO's.
  expect(isScalarConsumer({ type: 'midi' })).toBe(false);
  expect(inputs({ type: 'midi' })).toEqual([]);
  // Only the active mode's sliders are offered, and both are logarithmic durations.
  expect(midiParameters({ mode: 'gate' }).map(def => def.key)).toEqual(['attack', 'decay', 'velocity']);
  expect(midiParameters({ mode: 'cc' })).toEqual([]);
  expect(parameters({ type: 'midi', mode: 'gate' })).toEqual(midiParameters({ mode: 'gate' }));
  for (const key of ['attack', 'decay']) {
    const def = MIDI_PARAMS.find(p => p.key === key);
    expect(def).toMatchObject({ scale: 'log', format: 'duration', min: .001, max: 5 });
  }
  // The CC number is stored with the sliders but is deliberately not a slider: it is
  // a chosen value (number field + Learn), never an automation target.
  expect(parameters({ type: 'midi', mode: 'gate' }).map(def => def.key)).not.toContain('cc');
  expect(MIDI_CC_PARAM).toMatchObject({ key: 'cc', min: 0, max: 127, default: 1 });
  // A fresh node listens to any device, channel 1, Gate/Pulse, with instant times.
  expect(defaultNode('midi', 0, 0, 'n1')).toEqual({ id: 'n1', type: 'midi', x: 0, y: 0, mode: 'gate', gateMode: 'pulse', channel: 1, deviceId: null, params: midiDefaults() });
  expect(midiDefaults()).toEqual({ attack: .001, decay: .001, velocity: 0, cc: 1 });
  expect(midiModeOf('nope')).toBe('gate');
  expect(midiChannelOf(0)).toBe(1);
  expect(midiDeviceOf('')).toBeNull();
  expect(midiCcOf({ params: { cc: 200 } })).toBe(1);
  // The palette drag is the only way a new node is created, and it knows the kind.
  expect(readPaletteDrag({ getData: () => JSON.stringify({ version: 1, nodeType: 'midi' }) }, [])).toEqual({ nodeType: 'midi' });
  expect(readPaletteDrag({ getData: () => JSON.stringify({ version: 1, nodeType: 'midi ' }) }, [])).toBeNull();
  expect(DRAG_TYPE).toContain('viz-pattern');
});

test('the MIDI node validates its switches, device, channel and sliders, and round-trips', () => {
  const g = validateGraph(graph());
  expect(validateGraph(structuredClone(g))).toEqual(g);
  const patch = node => ({ ...g, nodes: g.nodes.map(n => n.id === 'm' ? { ...n, ...node } : n) });
  expect(() => validateGraph(patch({ mode: 'velocity' }))).toThrow(/MIDI mode/);
  expect(() => validateGraph(patch({ gateMode: 'hold' }))).toThrow(/gate mode/);
  expect(() => validateGraph(patch({ channel: 17 }))).toThrow(/channel/);
  expect(() => validateGraph(patch({ channel: 2.5 }))).toThrow(/channel/);
  expect(() => validateGraph(patch({ deviceId: 5 }))).toThrow(/device/);
  expect(() => validateGraph(patch({ params: { attack: 9 } }))).toThrow(/MIDI parameter/);
  expect(() => validateGraph(patch({ params: { decay: 0 } }))).toThrow(/MIDI parameter/);
  expect(() => validateGraph(patch({ params: { cc: 1.5 } }))).toThrow(/MIDI parameter/);
  expect(() => validateGraph(patch({ params: { bend: 1 } }))).toThrow(/MIDI parameter/);
  // An unknown *mapping* parameter is never silently dropped (only a known, inactive
  // Gate slider is): it stays a visible, blocking diagnostic naming the node, and a
  // ghost source or a broken range is a hard error even on a mapping this mode drops.
  const unknown = validateGraph({ ...g, modulations: [{ from: 'band', to: 'm', param: 'bend', min: 0, max: 1 }] });
  expect(graphDiagnostics(unknown, []).messages).toContain('Unsupported modulation parameter: m.bend; only numeric sliders can map (not enum, bool or text).');
  // `cc` is a stored value but never a slider, so its mapping is kept and diagnosed
  // rather than dropped like an inactivated Gate slider.
  const ccMapped = validateGraph({ ...g, modulations: [{ from: 'band', to: 'm', param: 'cc', min: 0, max: 127 }] });
  expect(ccMapped.modulations).toEqual([{ from: 'band', to: 'm', param: 'cc', min: 0, max: 127 }]);
  expect(graphDiagnostics(ccMapped, []).messages).toContain('Unsupported modulation parameter: m.cc; only numeric sliders can map (not enum, bool or text).');
  const ccMode = withMidi({ mode: 'cc' });
  expect(() => validateGraph({ ...ccMode, modulations: [{ from: 'ghost', to: 'm', param: 'attack', min: 0, max: 1 }] })).toThrow(/modulation/);
  expect(() => validateGraph({ ...ccMode, modulations: [{ from: 'band', to: 'm', param: 'attack', min: 0, max: Infinity }] })).toThrow(/modulation range/);
  expect(() => validateGraph(patch({ params: [] }))).toThrow(/MIDI parameters/);
  // An absent field falls back to the documented default instead of failing the load.
  const sparse = validateGraph(patch({ channel: undefined, deviceId: undefined, params: { cc: 42 } }));
  expect(sparse.nodes.find(n => n.id === 'm')).toMatchObject({ mode: 'gate', gateMode: 'pulse', channel: 1, deviceId: null, params: { attack: .001, decay: .001, velocity: 0, cc: 42 } });
  // A mapping onto a MIDI slider saves, reloads and drives a Color slider too.
  const round = parseGraph(serializeGraph(g, manifestFor(g, [])));
  expect(round.graph.modulations).toEqual(g.modulations);
  expect(mapSignal(g, 'm', 'tint', 'hue', -180, 180).modulations).toHaveLength(3);
  // CC mode hides the envelope sliders, so their mappings are dropped: a mapping no
  // control can show could never be edited or removed, and would block Save. It is a
  // drop, never a load error, and the node's own output mapping survives.
  expect(g.modulations).toHaveLength(2);
  const cc = validateGraph(withMidi({ mode: 'cc' }));
  expect(cc.modulations).toEqual([{ from: 'm', to: 'tint', param: 'saturation', min: 0, max: 2 }]);
  // A linked-but-unmapped signal (a ◇ connection with no parameter yet) is not a
  // mapping, so it always survives the switch.
  const linked = validateGraph({ ...withMidi({ mode: 'cc' }), modulations: [{ from: 'band', to: 'm', param: null }] });
  expect(linked.modulations).toEqual([{ from: 'band', to: 'm', param: null }]);
});

test('a signal mapped onto a MIDI slider converts through the control domain', () => {
  const node = { ...defaultNode('midi', 0, 0, 'm'), mode: 'gate' };
  expect(definitions(node, []).map(def => def.key)).toEqual(['attack', 'decay', 'velocity']);
  expect(definitions({ ...node, mode: 'cc' }, [])).toEqual([]);
  // A MIDI source maps across 0…1 by default, like Audio and Script.
  expect(defaultInputRange({ type: 'midi' })).toEqual({ inputMin: 0, inputMax: 1 });
  const attack = MIDI_PARAMS[0];
  // Attack sweeps logarithmically (1 ms … 5 s is more than three decades): the middle
  // of a 10 ms → 1 s mapping is the geometric mean, not the arithmetic one.
  expect(mappedValue({ min: .01, max: 1, inputMin: 0, inputMax: 1 }, .5, attack)).toBeCloseTo(.1, 6);
  expect(mappedValue({ min: .01, max: 1, inputMin: 0, inputMax: 1 }, .5, { ...attack, scale: 'linear' })).toBeCloseTo(.505, 6);
  // Endpoints and out-of-range signals clamp into the slider's own domain.
  expect(mappedValue({ min: .01, max: 40, inputMin: 0, inputMax: 1 }, 1, attack)).toBeGreaterThan(4.9);
  expect(mappedValue({ min: .01, max: 40, inputMin: 0, inputMax: 1 }, 1, attack)).toBeLessThanOrEqual(attack.max);
  expect(mappedValue({ min: .01, max: 1, inputMin: 0, inputMax: 1 }, -3, attack)).toBe(.01);
  // A gesture or a typed value snaps in decades and clamps into the slider's domain.
  expect(clampStep(9, attack)).toBeLessThanOrEqual(attack.max);
  expect(clampStep(9, attack)).toBeGreaterThan(4.9);
  expect(clampStep(.000001, attack)).toBe(attack.min);
});

test('gate and CC output is normalized, with pulse/sustain, attack/decay and velocity', () => {
  const state = newChannelState();
  const gate = { mode: 'gate', gateMode: 'sustain', attack: 0, decay: 0, velocity: 0 };
  expect(midiLevel(gate, state, 0)).toBe(0);                      // nothing played yet
  applyMidiMessage(state, [0x90, 60, 127], 1);
  expect(gateLevel(gate, state, 1)).toBe(1);                      // attack 0 → full at once
  expect(gateLevel({ ...gate, attack: .1 }, state, 1.05)).toBeCloseTo(.5, 12);
  applyMidiMessage(state, [0x80, 60, 0], 2);
  expect(gateLevel({ ...gate, decay: .2 }, state, 2.05)).toBeCloseTo(.75, 12);
  expect(gateLevel({ ...gate, decay: .2 }, state, 2.2)).toBe(0);
  // Pulse ignores how long the key is held and always fires one envelope per note,
  // with a floor that keeps the 1 ms/1 ms defaults visible.
  const pulse = newChannelState();
  applyMidiMessage(pulse, [0x90, 60, 127], 1);
  expect(gateLevel({ mode: 'gate', gateMode: 'pulse', attack: 0, decay: 0 }, pulse, 1)).toBe(1);
  expect(gateLevel({ mode: 'gate', gateMode: 'pulse', attack: 0, decay: 0 }, pulse, 1 + PULSE_FLOOR_S / 2)).toBeCloseTo(.5, 12);
  expect(gateLevel({ mode: 'gate', gateMode: 'pulse', attack: 0, decay: 0 }, pulse, 1 + PULSE_FLOOR_S + .005)).toBe(0);
  applyMidiMessage(pulse, [0x90, 62, 127], 1.04);                  // a second note re-fires it
  expect(gateLevel({ mode: 'gate', gateMode: 'pulse', attack: 0, decay: .1 }, pulse, 1.09)).toBeCloseTo(.5, 12);
  // Apply Velocity blends toward the note's own velocity as the slider rises.
  const velocity = newChannelState();
  applyMidiMessage(velocity, [0x90, 60, 64], 0);
  expect(midiLevel({ ...gate, velocity: 0 }, velocity, 0)).toBe(1);
  expect(midiLevel({ ...gate, velocity: 1 }, velocity, 0)).toBeCloseTo(64 / 127, 12);
  // CC mode returns the selected controller, normalized, and never leaves 0…1.
  const cc = newChannelState();
  applyMidiMessage(cc, [0xb0, 7, 96], 0);
  expect(midiLevel({ mode: 'cc', cc: 7 }, cc, 0)).toBeCloseTo(96 / 127, 12);
  expect(midiLevel({ mode: 'cc', cc: 6 }, cc, 0)).toBe(0);
  expect(ccLevel(cc, -4)).toBe(0);
  expect(ccLevel(cc, 999)).toBe(0);
  expect(clamp01(2)).toBe(1);
});

test('the control glide eases a steppy source like the LFO rate', () => {
  // Same response time as the LFO's rate glide, so both nodes feel identical.
  expect(MIDI_PARAM_SLEW).toBe(LFO_RATE_SLEW);
  // Engaging a mapping hands the control over from its stored value (never a jump),
  // a frame with no elapsed time never moves, and the approach is exponential.
  expect(midiGlide(undefined, 5, 0, .25)).toBe(.25);
  expect(midiGlide(5, .001, 0)).toBe(5);
  expect(midiGlide(5, .001, .04)).toBeCloseTo(5 - (5 - .001) * (1 - Math.exp(-.5)), 9);
  expect(midiGlide(5, .001, .08)).toBeCloseTo(5 - (5 - .001) * (1 - Math.exp(-1)), 9);
  expect(midiGlide(5, .001, 10)).toBeCloseTo(.001, 6);
  // Frame-rate independence: the same wall-clock time covers the same ground,
  // whether it arrives as one 80 ms frame or four 20 ms ones.
  let up = 0;
  for (let i = 0; i < 4; i += 1) up = midiGlide(up, 5, .02);
  expect(up).toBeCloseTo(midiGlide(0, 5, .08), 9);
  expect(up).toBeGreaterThan(3);
  expect(up).toBeLessThan(5);
  let down = 5;
  for (let i = 0; i < 4; i += 1) down = midiGlide(down, .001, .02);
  expect(down).toBeCloseTo(midiGlide(5, .001, .08), 9);
  expect(down).toBeLessThan(5);
  expect(down).toBeGreaterThan(.001);
  // The runtime hands each control its mapped value; unmapped controls stay stored.
  const node = { ...defaultNode('midi', 0, 0, 'm'), params: { attack: .5, decay: .25, velocity: 0, cc: 9 } };
  expect(midiNodeParams(node)).toMatchObject({ attack: .5, decay: .25, cc: 9, mode: 'gate', channel: 1, deviceId: null });
  // The hook receives the target *and* the stored base of each active control.
  const seen = [];
  const glided = midiNodeParams(node, { attack: 2, velocity: 1 }, (key, target, base) => { seen.push({ key, target, base }); return target / 2; });
  expect(seen).toEqual([{ key: 'attack', target: 2, base: .5 }, { key: 'decay', target: .25, base: .25 }, { key: 'velocity', target: 1, base: 0 }]);
  expect(glided).toMatchObject({ attack: 1, decay: .125, velocity: .5 });
  // CC mode keeps the other mode's stored sliders and reads no envelope.
  expect(midiNodeParams({ ...node, mode: 'cc' }, { cc: 3 })).toMatchObject({ mode: 'cc', attack: .5, cc: 9 });
});

// ---------------------------------------------------------------------------
// The window session: one request, per-device state, learn, unplug, disposal
// ---------------------------------------------------------------------------

test('the session reads one device and one channel, blends CC neighbours and learns a CC', async () => {
  let clock = 0;
  const fake = fakeAccess();
  const session = createMidiService({ requestAccess: () => Promise.resolve(fake.access), now: () => clock });
  const states = [];
  const unsubscribe = session.subscribe(status => states.push(status.state));
  expect(states).toEqual(['idle']);                       // subscribing reports the state once
  await session.request();
  const a = midiPort('dev-a', 'Keys A'), b = midiPort('dev-b', 'Pad B');
  fake.connect(a); fake.connect(b);
  expect(session.status()).toMatchObject({ state: 'ready', attached: 2 });
  expect(session.status().inputs.map(input => input.id)).toEqual(['dev-a', 'dev-b']);
  expect(typeof a.onmidimessage).toBe('function');
  // Each device's own bucket and the merged one both exist: a node pinned to dev-a
  // ignores dev-b, and "any device" sees both.
  clock = 100;
  a.onmidimessage({ data: [0x90, 60, 127] });              // dev-a holds a note on channel 1
  b.onmidimessage({ data: [0x95, 60, 127] });              // dev-b holds one on channel 6
  const gate = { mode: 'gate', gateMode: 'sustain', attack: 0, decay: 0, velocity: 0 };
  expect(session.level({ ...gate, channel: 1, deviceId: 'dev-a' })).toBe(1);
  expect(session.level({ ...gate, channel: 1, deviceId: 'dev-b' })).toBe(0);
  expect(session.level({ ...gate, channel: 1, deviceId: null })).toBe(1);
  expect(session.level({ ...gate, channel: 6, deviceId: null })).toBe(1);
  expect(session.level({ ...gate, channel: 6, deviceId: 'dev-a' })).toBe(0);
  // A CC number a mapped signal sweeps blends its two neighbours.
  a.onmidimessage({ data: [0xb0, 63, 127] });
  a.onmidimessage({ data: [0xb0, 64, 0] });
  expect(session.level({ mode: 'cc', channel: 1, deviceId: null, cc: 63 })).toBe(1);
  expect(session.level({ mode: 'cc', channel: 1, deviceId: null, cc: 63.5 })).toBeCloseTo(.5, 12);
  // Learn adopts the next controller's channel and CC number, and cancel resolves null.
  const learned = session.learnCc({ timeoutMs: 0 });
  clock = 200; b.onmidimessage({ data: [0xb6, 74, 127] });
  await expect(learned).resolves.toEqual({ channel: 7, cc: 74 });
  const cancelled = session.learnCc({ timeoutMs: 0 });
  session.cancelLearn();
  await expect(cancelled).resolves.toBeNull();
  // Unplugging dev-a releases only its notes and detaches its handler; CC values keep
  // their last position, like a fader whose controller went away.
  clock = 300; fake.unplug(a);
  expect(a.onmidimessage).toBeNull();
  expect(typeof b.onmidimessage).toBe('function');
  expect(session.status().inputs.map(input => input.id)).toEqual(['dev-b']);
  expect(session.level({ ...gate, channel: 1, deviceId: 'dev-a' })).toBe(0);
  expect(session.level({ ...gate, channel: 6, deviceId: null })).toBe(1);
  expect(session.level({ mode: 'cc', channel: 1, deviceId: null, cc: 63 })).toBe(1);
  // Disposal removes the statechange listener and stops reporting.
  const removed = [];
  const tracked = { inputs: new Map(), addEventListener: () => {}, removeEventListener: type => removed.push(type) };
  const trackedSession = createMidiService({ requestAccess: () => Promise.resolve(tracked) });
  await trackedSession.request();
  trackedSession.dispose();
  expect(removed).toEqual(['statechange']);
  unsubscribe();
  session.dispose();
  expect(states.at(-1)).toBe('ready');
  expect(session.status()).toMatchObject({ state: 'idle', attached: 0, inputs: [] });
});

test('a browser without Web MIDI is a capability gap, not a crash', async () => {
  const session = createMidiService({});
  expect(session.status().supported).toBe(false);
  expect((await session.request()).state).toBe('unsupported');
  expect(session.level({ mode: 'cc', channel: 1, cc: 1 })).toBe(0);
  session.dispose();
});

test('a denied request stays non-fatal and can be retried', async () => {
  let denials = 0;
  const fake = fakeAccess();
  const session = createMidiService({
    requestAccess: () => { denials += 1; return denials === 1 ? Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) : Promise.resolve(fake.access); },
  });
  expect((await session.request()).state).toBe('denied');
  expect(session.status().error).toBe('blocked');
  expect((await session.request()).state).toBe('ready');
  session.dispose();
});

// ---------------------------------------------------------------------------
// The live runtime and the editor inspector (real editor page)
// ---------------------------------------------------------------------------

async function installMidiStub(page) {
  await page.addInitScript(() => {
    const listeners = new Set();
    const ports = new Map();
    window.__midi = { calls: 0, pending: [], ports };
    const makePort = (id, name) => {
      const port = { id, name, manufacturer: '', onmidimessage: null };
      ports.set(id, port);
      return port;
    };
    const setPorts = () => { ports.clear(); makePort('dev-a', 'Keys A'); makePort('dev-b', 'Pad B'); };
    window.__midi.send = (id, data) => {
      const port = ports.get(id);
      if (!port?.onmidimessage) throw new Error(`${id} is not attached`);
      port.onmidimessage({ data });
    };
    // The access object resolves only when the test says so, so the "not configured"
    // state (button, denial, retry) is reachable from the UI.
    navigator.requestMIDIAccess = () => {
      window.__midi.calls += 1;
      setPorts();
      const access = { inputs: ports, sysexEnabled: false, addEventListener: (_type, callback) => listeners.add(callback), removeEventListener: (_type, callback) => listeners.delete(callback) };
      return new Promise((resolve, reject) => window.__midi.pending.push({ resolve: () => resolve(access), reject }));
    };
  });
}

test('the runtime reads the pinned controller and glides a mapped control', async ({ page }) => {
  await installMidiStub(page);
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { MIDI } = await import('/src/midi/midi-service.js');
    const { defaultNode } = await import('/src/nodes/definitions.js');
    let band = 1;
    const node = { ...defaultNode('midi', 0, 0, 'm'), gateMode: 'sustain', deviceId: 'dev-a' };
    const graph = { version: 2, name: 'MIDI runtime', nodes: [node,
      { id: 'band', type: 'audio', band: 'bass', deviceId: null, channel: 'mono', x: 0, y: 200 },
      { id: 'output', type: 'output', x: 400, y: 0 }], edges: [],
      modulations: [{ from: 'band', to: 'm', param: 'attack', min: .001, max: 5 }] };
    const runtime = new GraphRuntime({ graph, sketches: SKETCHES, context: { readAudioSignals: () => ({ bass: band, mid: 0, high: 0 }) } });
    await runtime.ready;
    let t = 0;
    runtime.elapsed = () => t;
    // One rendered frame: the clock advances, the per-frame cache is dropped and the
    // node is read. `control` is the live value the node actually used.
    const frame = () => {
      runtime.advanceSignals(); runtime.frameSignals.clear();
      const value = runtime.signalValue('m');
      return { value, control: runtime.midiGlide.get('m')?.get('attack') ?? null };
    };
    runtime.signalValue('m');                        // plans the node → asks for access once
    window.__midi.pending.shift().resolve();
    for (let i = 0; i < 200 && MIDI.status().state !== 'ready'; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
    const info = { state: MIDI.status().state, requests: window.__midi.calls, inputs: MIDI.status().inputs.map(input => input.id) };
    // The mapped Attack (band 1 → ~5 s) hands the control over from the stored 1 ms…
    info.mapped = runtime.params.get('m')?.attack;
    info.first = frame();
    // …and glides toward it, frame by frame, never jumping.
    t = 1 / 60; info.second = frame();
    info.rising = [];
    for (let i = 2; i <= 8; i += 1) { t = i / 60; info.rising.push(frame().control); }
    // Stepping the source back to 0 glides the other way, and a long frame arrives.
    band = 0;
    t += 1 / 60; info.falling = frame().control;
    t += 1;                                          // a frame longer than the glide arrives
    info.settled = frame();
    // A note from the other controller is ignored; the pinned one opens the gate.
    window.__midi.send('dev-b', [0x90, 60, 127]);
    info.otherDevice = frame().value;
    window.__midi.send('dev-a', [0x90, 60, 127]);
    await new Promise(resolve => setTimeout(resolve, 5));
    t += 1 / 60; info.pinned = frame().value;
    // Only the mapped control is glided: an unmapped slider is used exactly as
    // stored, every frame.
    info.glidedKeys = [...(runtime.midiGlide.get('m')?.keys() ?? [])];
    info.decay = runtime.params.get('m')?.decay;
    // Removing the mapping forgets the glide: a runtime without it has no entry and
    // reads the stored Attack.
    const unwired = new GraphRuntime({ graph: { ...graph, modulations: [] }, sketches: SKETCHES, context: { readAudioSignals: () => ({ bass: band, mid: 0, high: 0 }) } });
    await unwired.ready;
    unwired.signalValue('m');
    info.unwiredGlide = [...(unwired.midiGlide.get('m')?.keys() ?? [])];
    info.unwiredAttack = unwired.params.get('m')?.attack;
    unwired.dispose();
    // CC mode returns the controller value, already normalized.
    const ccRuntime = new GraphRuntime({ graph: { version: 2, name: 'cc', nodes: [{ ...defaultNode('midi', 0, 0, 'm'), mode: 'cc', deviceId: null, params: { attack: .001, decay: .001, velocity: 0, cc: 7 } }, { id: 'output', type: 'output', x: 400, y: 0 }], edges: [] }, sketches: SKETCHES, context: {} });
    await ccRuntime.ready;
    window.__midi.send('dev-b', [0xb0, 7, 64]);
    info.cc = ccRuntime.signalValue('m');
    ccRuntime.dispose();
    runtime.dispose();
    info.glideCleared = runtime.midiGlide.size === 0;
    return info;
  });
  expect(result.state).toBe('ready');
  expect(result.inputs).toEqual(['dev-a', 'dev-b']);
  expect(result.requests).toBe(1);                   // one window, one request
  // A new mapping starts from the stored Attack (1 ms), never from the source's
  // value, and the approach is monotonic.
  expect(result.first.control).toBe(.001);
  expect(result.second.control).toBeGreaterThan(result.first.control);
  expect(result.second.control).toBeLessThan(result.mapped);
  for (let i = 1; i < result.rising.length; i += 1) expect(result.rising[i]).toBeGreaterThan(result.rising[i - 1]);
  expect(result.rising.at(-1)).toBeLessThan(result.mapped);
  // The source stepping back to 0 glides the other way, and a long frame lands.
  expect(result.falling).toBeLessThan(result.rising.at(-1));
  // The integration step is capped at 250 ms, so one long frame lands within a
  // couple of milliseconds of the target rather than exactly on it.
  expect(result.settled.control).toBeLessThan(.002);
  expect(result.otherDevice).toBe(0);                // another controller is ignored
  expect(result.pinned).toBe(1);                     // the pinned one opens the gate
  expect(result.cc).toBeCloseTo(64 / 127, 12);
  expect(result.glideCleared).toBe(true);
  // Manual controls are immediate; only a mapped one carries glide state.
  expect(result.glidedKeys).toEqual(['attack']);
  expect(result.decay).toBe(.001);
  expect(result.unwiredGlide).toEqual([]);
  expect(result.unwiredAttack).toBe(.001);
});

// ---------------------------------------------------------------------------
// Editor: the palette item, the inspector and the configuration flow
// ---------------------------------------------------------------------------

async function openFixture(page, data) {
  await page.goto('/?role=nodes');
  const id = await page.evaluate(async g => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('midi-tests', { create: true });
    const f = await dir.getFileHandle('midi.nodes.json', { create: true });
    const w = await f.createWritable(); await w.write(serializeGraph(g, manifestFor(g, SKETCHES))); await w.close();
    window.showDirectoryPicker = async () => dir; await nodePatterns.link(); return (await nodePatterns.open('midi.nodes.json')).id;
  }, data);
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue(data.name);
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
  });
});

test('the editor configures MIDI, keeps log-scale durations and learns a CC', async ({ page }) => {
  await installMidiStub(page);
  await openFixture(page, { ...graph(), nodes: [...graph().nodes.filter(n => n.id !== 'band'), { id: 'band', type: 'audio', x: 40, y: 520, band: 'bass', deviceId: null, channel: 'mono' }] });
  await expect(page.locator('.nodes-palette-create button')).toHaveText(['+ Blend', '+ Color', '+ Transform', '+ Camera', '+ Script', '+ Audio', '+ LFO', '+ MIDI']);
  await expect(page.locator('[data-node-id=m] .nodes-node-title')).toHaveText(/MIDI · Gate/);
  await expect(page.locator('[data-node-id=m] .nodes-node-detail')).toContainText('Any device · Ch 1 · Pulse');
  await page.locator('[data-node-id=m] .nodes-node-title').click();
  await expect(page.getByLabel('MIDI mode')).toHaveValue('gate');
  await expect(page.getByLabel('MIDI channel')).toHaveValue('1');
  await expect(page.getByLabel('MIDI gate mode')).toHaveValue('pulse');
  await expect(page.getByLabel('MIDI input device')).toHaveValue('');
  // Attack and Decay are the shared sliders on logarithmic tracks, and the readout
  // says so in the operator's own units (1 ms at the floor, seconds above it).
  for (const key of ['attack', 'decay']) {
    const row = page.locator(`.nodes-modulated-param[data-param-target="${key}"]`);
    await expect(row).toHaveCount(1);
    await expect(row.locator('input[type=range]')).toHaveAttribute('min', '-3');
    await expect(row.locator('input[type=range]')).toHaveAttribute('max', String(Math.log10(5)));
    await expect(row.locator('.param-value')).toHaveText('1 ms');
  }
  // A CC number field exists only in CC mode, where the durations are not shown.
  // Selecting the node asks for access once; a denial leaves a visible retry.
  await expect(page.getByTestId('node-midi-status')).toContainText('Requesting MIDI access…');
  await page.evaluate(() => window.__midi.pending.shift().reject(Object.assign(new Error('denied by operator'), { name: 'NotAllowedError' })));
  await expect(page.getByTestId('node-midi-status')).toContainText('MIDI access was denied');
  const retry = page.getByTestId('midi-enable');
  await expect(retry).toHaveText('Retry MIDI');
  await retry.click();
  await page.evaluate(() => window.__midi.pending.shift().resolve());
  await expect(page.getByTestId('node-midi-status')).toContainText('MIDI ready · 2 inputs connected');
  await expect(page.getByTestId('midi-enable')).toHaveCount(0);
  // The device select lists the live inputs, and pinning one shows on the card.
  await page.getByLabel('MIDI input device').selectOption('dev-b');
  await expect(page.locator('[data-node-id=m] .nodes-node-detail')).toContainText('Pad B · Ch 1');
  // CC mode swaps the controls for the CC number and Learn; the durations stay stored.
  await page.getByLabel('MIDI mode').selectOption('cc');
  await expect(page.getByLabel('MIDI gate mode')).toHaveCount(0);
  // CC mode hides the mapped Attack slider, so the switch drops that mapping and says
  // so instead of leaving a mapping no control could remove (and Save could refuse).
  await expect(page.getByTestId('nodes-action-error')).toContainText('that mapping was removed');
  await expect(page.getByLabel('MIDI CC number')).toHaveValue('1');
  await expect(page.locator('[data-node-id=m] .nodes-node-detail')).toContainText('Pad B · Ch 1 · CC 1');
  // Learn adopts the next controller's channel and CC number, and the readout follows.
  await page.getByTestId('midi-learn').click();
  await expect(page.getByTestId('midi-learn')).toHaveText('Waiting for a CC message…');
  await page.evaluate(() => window.__midi.send('dev-b', [0xb6, 74, 127]));
  await expect(page.getByLabel('MIDI channel')).toHaveValue('7');
  await expect(page.getByLabel('MIDI CC number')).toHaveValue('74');
  await expect(page.getByTestId('midi-learn')).toHaveText('Learn CC');
  await expect(page.getByTestId('node-signal-readout')).toHaveText('Output 1.000');
  // Switching back to Gate keeps the learned channel and the stored Pulse mode: the
  // switch is a switch, and the CC number stays stored for when CC mode returns.
  await page.getByLabel('MIDI mode').selectOption('gate');
  await expect(page.getByLabel('MIDI gate mode')).toHaveValue('pulse');
  await expect(page.locator('[data-node-id=m] .nodes-node-detail')).toContainText('Pad B · Ch 7 · Pulse');
  await page.getByLabel('MIDI mode').selectOption('cc');
  await expect(page.getByLabel('MIDI CC number')).toHaveValue('74');
});
