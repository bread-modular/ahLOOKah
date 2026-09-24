// The LFO signal node: its stored contract, the shape/phase math, validation
// (including the modulation loops a signal node makes reachable for the first
// time), the live runtime path and the editor's Custom drawing pad. Pure checks
// run in Node; the runtime and the pad run in the real editor page.
import { test, expect } from '@playwright/test';
import { validateGraph, connectSignal, mapSignal, readPaletteDrag, DRAG_TYPE } from '../src/nodes/model.js';
import { manifestFor, serializeGraph, parseGraph } from '../src/nodes/portability.js';
import { TYPES, SIGNAL_TYPES, MODULATION_TARGETS, parameters, defaultNode, inputs, activeInputs, isSignalSource, isModulationTarget, isScalarConsumer } from '../src/nodes/definitions.js';
import { definitions, mappedValue, clampStep, defaultInputRange } from '../src/nodes/modulation.js';
import { LFO_PARAMS, LFO_PATTERNS, LFO_RANGES, LFO_POINT_COUNT, lfoDefaults, defaultLfoPoints, lfoPointsOf, lfoPosition, lfoShape, lfoValue, lfoRangeOf, lfoCycleOf } from '../src/nodes/lfo.js';

const solid = (id, x = 40, y = 40) => ({ id, type: 'pattern', patternId: 'solid-color', x, y, params: { hue: 0, saturation: 1, brightness: .5, pulse: 0 } });
const colorNode = (id, x = 260, y = 40) => ({ id, type: 'color', x, y, params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 } });
const out = { id: 'output', type: 'output', x: 480, y: 40 };
const lfoNode = (id, overrides = {}, x = 40, y = 300) => ({ ...defaultNode('lfo', x, y, id), ...overrides });
// audio → math, so a signal also has a *node* source to chain from.
const audioNode = { id: 'band', type: 'audio', x: 40, y: 520, band: 'bass', deviceId: null, channel: 'mono' };
// wave sweeps a Color parameter; slow automates wave's own Cycle time — the two
// directions the feature promises (a signal maps onto the LFO, and the LFO drives
// something else) with no signal edges involved. Cycle time is a rate, so the
// mapping reads "0.25 s … 4 s as the signal sweeps 0…1" and is interpolated
// logarithmically, like the slider track itself.
const graph = () => ({ version: 1, name: 'LFO sweep', nodes: [solid('base'), colorNode('tint'), lfoNode('wave', { pattern: 'sine' }), lfoNode('slow', { params: { cycle: 4, phase: 0 } }, 40, 480), audioNode, out],
  edges: [{ from: 'base', to: 'tint', port: 'image' }, { from: 'tint', to: 'output', port: 'image' }],
  modulations: [
    { from: 'wave', to: 'tint', param: 'saturation', min: 0, max: 2 },
    { from: 'slow', to: 'wave', param: 'cycle', min: .25, max: 4 },
  ] });

// ---------------------------------------------------------------------------
// Stored contract and the shape/phase math (no browser needed)
// ---------------------------------------------------------------------------

test('lfo is a first-class signal source in every shared contract', () => {
  expect(TYPES).toContain('lfo');
  expect(SIGNAL_TYPES).toContain('lfo');
  expect(MODULATION_TARGETS).toContain('lfo');
  expect(isSignalSource({ type: 'lfo' })).toBe(true);
  expect(isModulationTarget({ type: 'lfo' })).toBe(true);
  // It emits scalars, never pictures: no image port, and no scalar input ports
  // either — automating a control is a mapping, not a wire.
  expect(isScalarConsumer({ type: 'lfo' })).toBe(false);
  expect(inputs({ type: 'lfo' })).toEqual([]);
  expect(activeInputs({ type: 'lfo' })).toEqual([]);
  const node = defaultNode('lfo', 10, 20);
  expect(node).toMatchObject({ type: 'lfo', x: 10, y: 20, pattern: 'linear', range: 'unipolar', seed: 0 });
  expect(node.params).toEqual(lfoDefaults());
  // A fresh node carries no drawn table: the shared ramp is its fallback shape.
  expect(node.points).toBeUndefined();
  expect(lfoPointsOf(node)).toHaveLength(LFO_POINT_COUNT);
  const defs = definitions(node, []);
  expect(defs).toEqual(parameters(node));
  expect(defs).toEqual(LFO_PARAMS);
  expect(defs.map(d => d.key)).toEqual(['cycle', 'phase']);
  for (const def of defs) {
    expect(Number.isFinite(def.min) && Number.isFinite(def.max) && Number.isFinite(def.step)).toBe(true);
    expect(def.max).toBeGreaterThan(def.min);
    expect(def.step).toBeGreaterThan(0);
    expect(def.default).toBeGreaterThanOrEqual(def.min);
    expect(def.default).toBeLessThanOrEqual(def.max);
  }
  // Cycle time is the 100 ms … 10 s duration readout, on a logarithmic track.
  expect(LFO_PARAMS[0]).toMatchObject({ key: 'cycle', min: .1, max: 10, scale: 'log', format: 'duration', default: 1 });
  expect(LFO_PATTERNS).toEqual(['linear', 'sine', 'noise', 'random', 'custom']);
  expect(LFO_RANGES).toEqual(['unipolar', 'bipolar']);
});

test('one cycle traces a wrapped shape and the range maps it to 0…1 or −1…1', () => {
  const at = (overrides, time) => lfoValue(lfoNode('w', overrides), { time });
  // Linear is the phase itself; a cycle wraps back to 0 exactly.
  expect([0, .25, .5, .75, 1].map(t => at({ pattern: 'linear', params: { cycle: 1, phase: 0 } }, t))).toEqual([0, .25, .5, .75, 0]);
  // Sine starts where the saw starts and rises to 1 at the half cycle.
  expect([0, .25, .5, .75, 1].map(t => at({ pattern: 'sine', params: { cycle: 1, phase: 0 } }, t)).map(v => Number(v.toFixed(6)))).toEqual([0, .5, 1, .5, 0]);
  // The bipolar range is the same shape mapped onto −1…1, so a sweep can start
  // below a target parameter's own floor once its input range says so.
  expect(at({ pattern: 'linear', range: 'bipolar', params: { cycle: 1, phase: 0 } }, .75)).toBeCloseTo(.5, 12);
  expect(at({ pattern: 'linear', range: 'bipolar', params: { cycle: 1, phase: 0 } }, .25)).toBeCloseTo(-.5, 12);
  expect(lfoRangeOf('bipolar')).toBe('bipolar');
  expect(lfoRangeOf('nonsense')).toBe('unipolar');
  // Start Position is a phase offset; a longer cycle takes proportionally longer
  // to reach the same position (100 ms and 10 s are the ends of the track).
  expect(at({ pattern: 'linear', params: { cycle: 1, phase: .25 } }, .25)).toBeCloseTo(.5, 12);
  expect(at({ pattern: 'linear', params: { cycle: .5, phase: 0 } }, .25)).toBeCloseTo(.5, 12);
  expect(at({ pattern: 'linear', params: { cycle: 1, phase: 0 } }, 4.5)).toBeCloseTo(.5, 12);
  expect(at({ pattern: 'linear', params: { cycle: .1, phase: 0 } }, .05)).toBeCloseTo(.5, 12);
  expect(at({ pattern: 'linear', params: { cycle: 10, phase: 0 } }, .5)).toBeCloseTo(.05, 12);
  // A travel (what the runtime integrates) answers instead of the elapsed time:
  // the position is that travel, anchored on Start Position, whatever `time` says.
  expect(lfoPosition(lfoNode('w', { params: { cycle: 1, phase: .25 } }), { travel: .25, time: 99 })).toBeCloseTo(.5, 12);
  expect(lfoPosition(lfoNode('w', { params: { cycle: .25, phase: 0 } }), { travel: 3.5 })).toBeCloseTo(.5, 12);
  // A cycle outside the control's domain is clamped, never divided by zero.
  expect(lfoCycleOf({ params: { cycle: 0 } })).toBe(.1);
  expect(lfoCycleOf({ params: { cycle: -5 } })).toBe(.1);
  expect(lfoCycleOf({ params: { cycle: 99 } })).toBe(10);
  expect(lfoCycleOf({ params: {} })).toBe(1);
  expect(lfoValue(lfoNode('w', { params: { cycle: 0, phase: 0 } }), { time: .05 })).toBeCloseTo(.5, 12);
  // Every pattern stays inside its own range over a dense sweep of time.
  for (const pattern of LFO_PATTERNS) for (const range of LFO_RANGES) {
    for (let i = 0; i < 400; i++) {
      const value = at({ pattern, range, seed: 7, params: { cycle: 3.7, phase: .31 } }, i * .037);
      expect(Number.isFinite(value), `${pattern}/${range}/${i}`).toBe(true);
      const [low, high] = range === 'bipolar' ? [-1, 1] : [0, 1];
      expect(value).toBeGreaterThanOrEqual(low);
      expect(value).toBeLessThanOrEqual(high);
    }
  }
  // A non-finite or missing time never produces NaN.
  expect(lfoValue(lfoNode('w'), { time: NaN })).toBe(0);
  expect(lfoPosition(lfoNode('w'), { time: Infinity })).toBe(0);
  expect(lfoShape('linear', NaN)).toBe(0);
});

test('noise and random are seeded and repeat, and Custom plays the drawn table', () => {
  const seeded = (pattern, seed, time = .3) => lfoValue(lfoNode('w', { pattern, seed, params: { cycle: 1, phase: 0 } }), { time });
  for (const pattern of ['noise', 'random']) {
    // Deterministic: the same node and time always emit the same number.
    expect(seeded(pattern, 3)).toBe(seeded(pattern, 3));
    expect(seeded(pattern, 4)).not.toBe(seeded(pattern, 3));
    // A pattern repeats every cycle — at the same phase, in every window that
    // renders it (binary-exact times, so the phase is bit-identical).
    expect(seeded(pattern, 3, .25)).toBe(seeded(pattern, 3, 1.25));
  }
  // Random is sample & hold: equal inside one step, different across steps.
  const at = t => lfoValue(lfoNode('w', { pattern: 'random', seed: 5, params: { cycle: 1, phase: 0 } }), { time: t });
  expect(at(.01)).toBe(at(.11));
  expect(at(.01)).not.toBe(at(.2));
  // Noise is continuous: neighbouring samples stay close, unlike the stepped one.
  const noise = t => lfoValue(lfoNode('w', { pattern: 'noise', seed: 5, params: { cycle: 1, phase: 0 } }), { time: t });
  expect(Math.abs(noise(.5) - noise(.505))).toBeLessThan(.2);
  // ... and continuous where the cycle wraps: the noise lattice is a ring, so the
  // last segment lands back on the first hash instead of jumping to it.
  for (const seed of [0, 3, 7]) {
    const noiseAt = t => lfoValue(lfoNode('w', { pattern: 'noise', seed, params: { cycle: 1, phase: 0 } }), { time: t });
    expect(Math.abs(noiseAt(1) - noiseAt(1 - 1e-6)), `seam at 1 (seed ${seed})`).toBeLessThan(.001);
    expect(Math.abs(noiseAt(2) - noiseAt(2 - 1e-6)), `seam at 2 (seed ${seed})`).toBeLessThan(.001);
    expect(noiseAt(1)).toBe(noiseAt(0));
  }
  // The drawn table: a ramp by default, the node's own points when it has any.
  expect(lfoValue(lfoNode('w', { pattern: 'custom', params: { cycle: 1, phase: 0 } }), { time: .5 })).toBeCloseTo(.5, 12);
  const drawn = lfoNode('w', { pattern: 'custom', points: [1, 1], params: { cycle: 1, phase: 0 } });
  expect(lfoValue(drawn, { time: .25 })).toBe(1);
  expect(lfoValue(drawn, { time: .75 })).toBe(1);
  expect(defaultLfoPoints()).toHaveLength(LFO_POINT_COUNT);
  // A bad or empty table falls back to the ramp instead of throwing.
  expect(lfoPointsOf({ points: [] })).toHaveLength(LFO_POINT_COUNT);
});

// ---------------------------------------------------------------------------
// Validation, wiring and persistence
// ---------------------------------------------------------------------------

test('LFO graphs validate, take a signal on their own sliders, and refuse loops', () => {
  const valid = validateGraph(structuredClone(graph()));
  expect(valid.nodes.find(n => n.id === 'wave').pattern).toBe('sine');
  expect(valid.nodes.find(n => n.id === 'slow').params).toEqual({ cycle: 4, phase: 0 });
  expect(valid.modulations).toEqual(graph().modulations);
  // A completed LFO node is written back the same way on every pass.
  expect(validateGraph(valid)).toEqual(valid);
  // Drawn tables live inside the node, and only when the file had one.
  const withPoints = validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'wave' ? { ...n, points: [0, .25, .5, .75] } : n) });
  expect(withPoints.nodes.find(n => n.id === 'wave').points).toEqual([0, .25, .5, .75]);
  expect(valid.nodes.find(n => n.id === 'wave').points).toBeUndefined();
  // A partial parameter set is completed with the documented defaults.
  const partial = validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'wave' ? { ...n, params: { cycle: 4 } } : n) });
  expect(partial.nodes.find(n => n.id === 'wave').params).toEqual({ cycle: 4, phase: 0 });
  // Files written while the control was named `speed` (cycles per second) keep
  // their rate: 4 cycles/s is a 250 ms cycle, and 0 (frozen) is the slowest cycle
  // the new control has. An explicit `cycle` in the same file wins.
  const legacy = validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'wave' ? { ...n, params: { speed: 4 } } : n) });
  expect(legacy.nodes.find(n => n.id === 'wave').params).toEqual({ cycle: .25, phase: 0 });
  const frozen = validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'wave' ? { ...n, params: { speed: 0, phase: .5 } } : n) });
  expect(frozen.nodes.find(n => n.id === 'wave').params).toEqual({ cycle: 10, phase: .5 });
  const explicit = validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'wave' ? { ...n, params: { speed: 4, cycle: 2 } } : n) });
  expect(explicit.nodes.find(n => n.id === 'wave').params).toEqual({ cycle: 2, phase: 0 });

  const bad = patch => () => validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'wave' ? { ...n, ...patch } : n) });
  expect(bad({ pattern: 'square' })).toThrow(/LFO pattern/);
  expect(bad({ range: 'both' })).toThrow(/LFO range/);
  expect(bad({ seed: 1.5 })).toThrow(/LFO seed/);
  expect(bad({ seed: -1 })).toThrow(/LFO seed/);
  expect(bad({ seed: 10000 })).toThrow(/LFO seed/);
  expect(bad({ params: { cycle: 11 } })).toThrow(/cycle/);
  expect(bad({ params: { cycle: .05 } })).toThrow(/cycle/);
  // `speed` is the pre-release name (cycles per second): it still loads, and it
  // still has to be a non-negative number.
  expect(bad({ params: { speed: -1 } })).toThrow(/speed/);
  expect(bad({ params: { phase: -0.1 } })).toThrow(/phase/);
  expect(bad({ params: { wobble: 1 } })).toThrow(/wobble/);
  expect(bad({ params: [] })).toThrow(/LFO parameters/);
  expect(bad({ params: undefined })).toThrow(/LFO parameters/);
  expect(bad({ points: [0.5] })).toThrow(/LFO points/);
  expect(bad({ points: new Array(65).fill(.5) })).toThrow(/LFO points/);
  expect(bad({ points: [0, 1.5] })).toThrow(/LFO points/);
  expect(bad({ points: [0, 'x'] })).toThrow(/LFO points/);

  // A signal reaches the LFO's own sliders through the ordinary modulation link,
  // and the LFO in turn drives anything else a signal can reach.
  expect(graph().modulations.find(m => m.to === 'wave')).toMatchObject({ from: 'slow', param: 'cycle' });
  expect(() => validateGraph({ ...graph(), modulations: [...graph().modulations, { from: 'band', to: 'slow', param: 'phase', min: 0, max: 1 }] })).not.toThrow();
  // ... but a loop through those mappings is a cycle: it would recurse on every
  // frame a target reads its source, so connecting and saving it are refused.
  expect(() => validateGraph({ ...graph(), modulations: [...graph().modulations, { from: 'wave', to: 'slow', param: 'phase', min: 0, max: 1 }] })).toThrow(/cycle/);
  expect(() => validateGraph({ ...graph(), modulations: [...graph().modulations, { from: 'wave', to: 'wave', param: 'phase', min: 0, max: 1 }] })).toThrow(/cycle/);
  expect(() => validateGraph({ ...graph(), modulations: [...graph().modulations, { from: 'slow', to: 'slow', param: 'phase', min: 0, max: 1 }] })).toThrow(/cycle/);
  expect(() => validateGraph({ ...graph(), modulations: [
    { from: 'slow', to: 'wave', param: 'phase', min: 0, max: 1 },
    { from: 'wave', to: 'slow', param: 'phase', min: 0, max: 1 },
  ] })).toThrow(/cycle/);
  // An LFO is not an image sink: a picture cannot be wired into it.
  expect(() => validateGraph({ ...graph(), edges: [...graph().edges, { from: 'base', to: 'wave', port: 'image' }] })).toThrow(/port/);

  // A bipolar LFO maps across the whole slider by default; everything else keeps
  // the historical 0…1 input range.
  expect(defaultInputRange({ type: 'lfo', range: 'bipolar' })).toEqual({ inputMin: -1, inputMax: 1 });
  expect(defaultInputRange({ type: 'lfo', range: 'unipolar' })).toEqual({ inputMin: 0, inputMax: 1 });
  expect(defaultInputRange({ type: 'audio' })).toEqual({ inputMin: 0, inputMax: 1 });
  const saturation = { min: 0, max: 2, step: .01 };
  expect(mappedValue({ min: 0, max: 2, inputMin: -1, inputMax: 1 }, -1, saturation)).toBe(0);
  expect(mappedValue({ min: 0, max: 2, inputMin: -1, inputMax: 1 }, 0, saturation)).toBe(1);
  expect(mappedValue({ min: 0, max: 2, inputMin: -1, inputMax: 1 }, 1, saturation)).toBe(2);
  expect(clampStep(2 * .5, saturation)).toBe(1);
});

test('an LFO node round-trips through a file and the palette can create one', () => {
  const source = { ...graph(), nodes: graph().nodes.map(n => n.id === 'wave' ? { ...n, pattern: 'custom', points: [0, 1, .5] } : n) };
  const validated = validateGraph(source);
  const reread = parseGraph(serializeGraph(validated, manifestFor(validated, []))).graph;
  expect(reread).toEqual(validated);
  expect(reread.nodes.find(n => n.id === 'wave').points).toEqual([0, 1, .5]);
  expect(reread.modulations).toEqual(validated.modulations);
  // A hand-written node with no optional fields still loads with its defaults.
  const minimal = validateGraph({ version: 1, name: 'minimal', nodes: [{ id: 'output', type: 'output', x: 0, y: 0 },
    { id: 'w', type: 'lfo', x: 0, y: 0, params: {} }], edges: [] });
  expect(minimal.nodes.find(n => n.id === 'w')).toMatchObject({ pattern: 'linear', range: 'unipolar', seed: 0, params: lfoDefaults() });

  const read = nodeType => readPaletteDrag({ getData: () => JSON.stringify({ version: 1, nodeType }) }, []);
  expect(read('lfo')).toEqual({ nodeType: 'lfo' });
  expect(readPaletteDrag({ getData: () => JSON.stringify({ version: 1, nodeType: 'lfo ' }) }, [])).toBeNull();
  expect(DRAG_TYPE).toContain('viz-pattern');
  // The model's own connect/map helpers accept the LFO as a target. Cycle time
  // already carries a mapping, so replacing it must be explicit, exactly as for
  // any other mapped control.
  const connected = connectSignal(validated, 'band', 'wave');
  expect(connected.modulations).toContainEqual({ from: 'band', to: 'wave', param: null });
  expect(() => mapSignal(connected, 'band', 'wave', 'cycle', .1, 10)).toThrow(/already mapped/);
  // Replacing drops the mapping it replaces, exactly as it does for any other
  // target; the unrelated Color mapping is untouched.
  expect(mapSignal(connected, 'band', 'wave', 'cycle', .1, 10, true).modulations)
    .toEqual([validated.modulations[0], { from: 'band', to: 'wave', param: 'cycle', min: .1, max: 10 }]);
  // A logarithmic control sweeps logarithmically between its endpoints: a 100 ms …
  // 10 s range is two decades wide, so the quarter point is 10^-0.5 and the middle
  // is 1 s, not the 5.05 s a linear interpolation would give.
  const cycleDef = LFO_PARAMS[0];
  expect(mappedValue({ min: .1, max: 10, inputMin: 0, inputMax: 1 }, .5, cycleDef)).toBeCloseTo(1, 3);
  expect(mappedValue({ min: .1, max: 10, inputMin: 0, inputMax: 1 }, .75, cycleDef)).toBeCloseTo(10 ** .5, 3);
  expect(mappedValue({ min: .1, max: 10, inputMin: 0, inputMax: 1 }, .25, cycleDef)).toBeCloseTo(10 ** -0.5, 3);
  // An endpoint with no logarithm is read at the domain floor, never as NaN.
  expect(mappedValue({ min: 0, max: 10, inputMin: 0, inputMax: 1 }, 0, cycleDef)).toBeCloseTo(.1, 3);
  expect(clampStep(11, cycleDef)).toBe(10);
  expect(clampStep(0, cycleDef)).toBe(.1);
  // A mapping saved while the control was called `speed` keeps its automation: the
  // link is renamed and its endpoints become the same sweep in seconds per cycle,
  // so the input that selected the fast end still selects the fast end (0 cycles/s
  // — the old "frozen" — becomes the slowest cycle). Converting is idempotent and
  // survives a file round trip.
  const migrated = validateGraph({ ...graph(), modulations: [{ from: 'slow', to: 'wave', param: 'speed', min: 4, max: .25 }] });
  expect(migrated.modulations).toEqual([{ from: 'slow', to: 'wave', param: 'cycle', min: .25, max: 4 }]);
  expect(validateGraph(migrated)).toEqual(migrated);
  expect(parseGraph(serializeGraph(migrated, manifestFor(migrated, []))).graph.modulations).toEqual(migrated.modulations);
  const frozenMapping = validateGraph({ ...graph(), modulations: [{ from: 'slow', to: 'wave', param: 'speed', min: 0, max: 10 }] });
  expect(frozenMapping.modulations[0]).toMatchObject({ param: 'cycle', min: 10, max: .1 });
  // Only an LFO target has that pre-release name: a sketch parameter really called
  // `speed` is left exactly as saved.
  const sketchSpeed = validateGraph({ ...graph(), modulations: [{ from: 'slow', to: 'base', param: 'speed', min: 0, max: 1 }] });
  expect(sketchSpeed.modulations.at(-1)).toMatchObject({ to: 'base', param: 'speed' });
});

// ---------------------------------------------------------------------------
// The live runtime
// ---------------------------------------------------------------------------

test('the runtime advances the LFO and drives a mapped parameter every frame', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async graph => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { clampStep, definitions } = await import('/src/nodes/modulation.js');
    const runtime = new GraphRuntime({ graph, sketches: SKETCHES, context: {} });
    await runtime.ready;
    const tint = runtime.params.get('tint');
    const saturationDef = definitions(graph.nodes.find(n => n.id === 'tint'), SKETCHES).find(d => d.key === 'saturation');
    // render() clears the once-per-frame signal cache, exactly like a drawn frame.
    const sample = () => { runtime.render('tint'); const wave = runtime.signalValue('wave'); return { wave, saturation: tint.saturation, expected: clampStep(wave * 2, saturationDef) }; };
    const first = sample();
    await new Promise(resolve => setTimeout(resolve, 150));
    const second = sample();
    runtime.dispose();
    return { first, second };
  }, { ...graph(), modulations: [{ from: 'wave', to: 'tint', param: 'saturation', min: 0, max: 2 }] });
  // A live oscillator moves on its own clock...
  expect(Math.abs(result.second.wave - result.first.wave)).toBeGreaterThan(.05);
  // ... and every consumer of it sees the same converted value in that frame.
  expect(result.first.saturation).toBe(result.first.expected);
  expect(result.second.saturation).toBe(result.second.expected);
  expect(result.first.wave).toBeGreaterThanOrEqual(0);
  expect(result.first.wave).toBeLessThanOrEqual(1);
});

test('a signal mapped onto the LFO converts through the control domain, and a loop is reported', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async graph => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { defaultNode } = await import('/src/nodes/definitions.js');
    const runtime = new GraphRuntime({ graph, sketches: SKETCHES, context: {} });
    await runtime.ready;
    // slow (0…1, mapped 250 ms … 4 s onto Cycle time) is a live modulation target
    // of the LFO, so the control's own view carries the converted value, never the
    // stored base.
    const slow = runtime.signalValue('slow');
    const view = runtime.params.get('wave');
    const mappedCycle = view.cycle;
    const phase = view.phase;
    const stored = graph.nodes.find(n => n.id === 'wave').params;
    runtime.dispose();

    // A graph file can never carry a modulation loop (validation refuses it), so
    // the runtime guard is reached the only way that is left: a mutated graph.
    const loopGraph = { version: 1, name: 'loop', nodes: [{ id: 'output', type: 'output', x: 0, y: 0 },
      { ...defaultNode('lfo', 0, 0, 'wave'), params: { cycle: 1, phase: 0 } }], edges: [] };
    const looped = new GraphRuntime({ graph: loopGraph, sketches: SKETCHES, context: {} });
    // Start Position is read while the *value* is computed, so a self-loop there
    // would recurse: it is reported and yields 0 instead of blowing the stack. No
    // parameter view is cached, so the lazy one is built with the loop in place.
    looped.graph.modulations = [{ from: 'wave', to: 'wave', param: 'phase', min: 0, max: 1 }];
    looped.params.clear();
    looped.frameSignals.clear(); looped.messages.clear();
    const loopValue = looped.signalValue('wave');
    const messages = [...looped.messages.values()];
    // Cycle time is read by the *frame*, never by the value, so a self-loop there
    // resolves in one pass: the engine never asks a node for its own rate while
    // computing its value.
    looped.graph.modulations = [{ from: 'wave', to: 'wave', param: 'cycle', min: .1, max: 10 }];
    looped.params.clear();
    looped.frameSignals.clear(); looped.messages.clear();
    looped.signalValue('wave');
    looped.advanceSignals();
    await new Promise(resolve => setTimeout(resolve, 20));
    looped.frameSignals.clear();
    looped.advanceSignals();
    const rateMessages = [...looped.messages.values()];
    const rateTravel = looped.lfoTravel.get('wave');
    looped.dispose();
    return { slow, mappedCycle, phase, stored, loopValue, messages, rateMessages, rateTravel };
  }, graph());
  // Signal 0…1 → cycle 250 ms … 4 s, interpolated logarithmically (4 s / 250 ms
  // is a factor of 16) and quantized to the control's own four significant digits.
  expect(result.slow).toBeGreaterThanOrEqual(0);
  expect(result.slow).toBeLessThanOrEqual(1);
  expect(result.mappedCycle).toBeCloseTo(.25 * 16 ** result.slow, 3);
  expect(result.mappedCycle).not.toBe(result.stored.cycle);
  // Start Position is not mapped, so it reads the stored base value.
  expect(result.phase).toBe(result.stored.phase);
  // A loop yields 0 with a visible message instead of blowing the stack, and the
  // rate path stays silent and finite: it advances the travel, never recursing.
  expect(result.loopValue).toBe(0);
  expect(result.messages.join(' ')).toMatch(/loop/i);
  expect(result.rateMessages).toEqual([]);
  expect(result.rateTravel).toBeGreaterThan(0);
});

test('a mapped Cycle time reads its source in the same frame, whatever the node order', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { defaultNode } = await import('/src/nodes/definitions.js');
    const base = { id: 'output', type: 'output', x: 0, y: 0 };
    // A unipolar linear LFO IS its own position, so its value reads the travel.
    const slow = { ...defaultNode('lfo', 0, 0, 'slow'), pattern: 'linear' };
    const wave = { ...defaultNode('lfo', 0, 0, 'wave'), pattern: 'linear' };
    const step = async order => {
      const runtime = new GraphRuntime({ graph: { version: 1, name: 'order', nodes: [base, ...order], edges: [],
        modulations: [{ from: 'slow', to: 'wave', param: 'cycle', min: .25, max: 4 }] }, sketches: SKETCHES, context: {} });
      await runtime.ready;
      // Activate the plan the way a preview does (these nodes feed no image), then
      // start a frame, exactly like render() does.
      runtime.signalValue('wave');
      runtime.frameSignals.clear();
      // A scripted clock pins dt exactly: the first step only starts the clock, the
      // second integrates 0.1 s, as an editor frame would.
      const times = [0, .1];
      runtime.elapsed = () => times.length > 1 ? times.shift() : times[0];
      runtime.advanceSignals();
      runtime.advanceSignals();
      const slowValue = runtime.signalValue('slow');
      const mappedCycle = runtime.params.get('wave').cycle;
      const travel = runtime.lfoTravel.get('wave');
      runtime.dispose();
      return { slowValue, mappedCycle, travel };
    };
    // The same graph with the modulating source stored before AND after its consumer.
    return { sourceFirst: await step([slow, wave]), sourceLast: await step([wave, slow]) };
  });
  // Advancing sources first makes both orders produce the identical frame…
  expect(result.sourceLast).toEqual(result.sourceFirst);
  expect(result.sourceFirst.slowValue).toBeCloseTo(.1, 9);
  // …and the consumer travels at the CURRENT rate: a 0.1 → 0.25 s … 4 s mapping is
  // 0.25 · 16^0.1 ≈ 0.33 s per cycle here, not the 0.25 s the previous frame's
  // source value would have given.
  expect(result.sourceFirst.mappedCycle).toBeCloseTo(.25 * 16 ** .1, 3);
  expect(result.sourceFirst.travel).toBeCloseTo(.1 / result.sourceFirst.mappedCycle, 9);
  expect(result.sourceFirst.travel).not.toBeCloseTo(.4, 3);
});

test('a mapped Cycle time reads through Math in the same frame, whatever the node order', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { defaultNode } = await import('/src/nodes/definitions.js');
    const base = { id: 'output', type: 'output', x: 0, y: 0 };
    const slow = { ...defaultNode('lfo', 0, 0, 'slow'), pattern: 'linear' };
    const sum = { id: 'sum', type: 'math', x: 0, y: 0, op: 'add', a: 0, b: 0, c: 1 };
    const wave = { ...defaultNode('lfo', 0, 0, 'wave'), pattern: 'linear' };
    const step = async order => {
      const runtime = new GraphRuntime({ graph: { version: 1, name: 'chain', nodes: [base, ...order], edges: [],
        signalEdges: [{ from: 'slow', to: 'sum', port: 'a' }],
        modulations: [{ from: 'sum', to: 'wave', param: 'cycle', min: .25, max: 4 }] }, sketches: SKETCHES, context: {} });
      await runtime.ready;
      runtime.signalValue('wave');
      runtime.frameSignals.clear();
      const times = [0, .1];
      runtime.elapsed = () => times.length > 1 ? times.shift() : times[0];
      runtime.advanceSignals();
      runtime.advanceSignals();
      const sumValue = runtime.signalValue('sum');
      const mappedCycle = runtime.params.get('wave').cycle;
      const travel = runtime.lfoTravel.get('wave');
      runtime.dispose();
      return { sumValue, mappedCycle, travel };
    };
    // slow → Math(add) → wave's Cycle time, with the upstream source stored both
    // before and after the two nodes that depend on it.
    return { chainFirst: await step([slow, sum, wave]), chainLast: await step([wave, sum, slow]) };
  });
  // The Math node in the middle is traversed as a dependency too, so the whole
  // chain advances before the consumer reads it in either storage order.
  expect(result.chainLast).toEqual(result.chainFirst);
  expect(result.chainFirst.sumValue).toBeCloseTo(.1, 9);
  // The consumer travelled at the rate this frame's control reports (the control is
  // quantized to four significant digits, so the travel is compared with the value
  // the view actually carries).
  expect(result.chainFirst.mappedCycle).toBeCloseTo(.25 * 16 ** .1, 3);
  expect(result.chainFirst.travel).toBeCloseTo(.1 / result.chainFirst.mappedCycle, 9);
  // The stale (previous-frame) value of 0 would have travelled at .4 instead.
  expect(result.chainFirst.travel).not.toBeCloseTo(.4, 3);
});

test('a rate step glides into the new speed instead of kicking the shape', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { defaultNode } = await import('/src/nodes/definitions.js');
    const { validateGraph } = await import('/src/nodes/model.js');
    const wave = { ...defaultNode('lfo', 0, 0, 'wave'), pattern: 'linear' };
    const graph = { version: 1, name: 'glide', nodes: [{ id: 'output', type: 'output', x: 0, y: 0 }, wave], edges: [] };
    const runtime = new GraphRuntime({ graph, sketches: SKETCHES, context: {} });
    await runtime.ready;
    runtime.signalValue('wave');
    runtime.frameSignals.clear();
    // 60 fps frames, so the glide is measured in real frames.
    let t = 0;
    runtime.elapsed = () => t;
    runtime.advanceSignals();                     // starts the clock
    t = 1 / 60; runtime.advanceSignals();
    const before = runtime.lfoRate.get('wave');
    // Jump the cycle 1 s → 100 ms (10 cycles/s) while it runs.
    const jumped = runtime.updateGraph(validateGraph({ ...graph,
      nodes: graph.nodes.map(n => n.id === 'wave' ? { ...n, params: { ...n.params, cycle: .1 } } : n) }));
    const rates = [];
    for (let frame = 2; frame <= 11; frame++) { t = frame / 60; runtime.advanceSignals(); rates.push(runtime.lfoRate.get('wave')); }
    const travel = runtime.lfoTravel.get('wave');
    runtime.dispose();
    return { jumped, before, rates, travel };
  });
  expect(result.jumped).toBe(true);
  expect(result.before).toBeCloseTo(1, 9);
  // The first frame after the jump is still close to the old speed and every frame
  // moves toward the new one, so the step arrives as acceleration over ~0.1 s.
  expect(result.rates[0]).toBeGreaterThan(1);
  expect(result.rates[0]).toBeLessThan(4);
  for (let i = 1; i < result.rates.length; i++) expect(result.rates[i]).toBeGreaterThan(result.rates[i - 1]);
  expect(result.rates.at(-1)).toBeGreaterThan(8.5);
  expect(result.rates.at(-1)).toBeLessThan(10);
  // The travel only ever moves forward: a speed change never rewinds the shape.
  expect(result.travel).toBeGreaterThan(0);
});

test('cycle time is a rate: the shape accelerates instead of restarting', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async graph => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { validateGraph } = await import('/src/nodes/model.js');
    const runtime = new GraphRuntime({ graph, sketches: SKETCHES, context: {} });
    await runtime.ready;
    // A unipolar LINEAR LFO *is* its own phase, so signalValue reads the position
    // directly. A frame only happens on a render, exactly as it does in the editor.
    const tick = () => { runtime.render('tint'); return runtime.signalValue('wave'); };;
    tick();                                        // the first tick only starts the clock
    await new Promise(resolve => setTimeout(resolve, 120));
    const before = tick();
    // Slow the cycle down 1 s → 10 s while it runs: the position keeps going from
    // where it was and only the rate changes. (`elapsed × rate` would snap it back
    // towards 0 here, which is the behaviour this replaced.)
    const slowed = validateGraph({ ...graph, nodes: graph.nodes.map(n => n.id === 'wave' ? { ...n, params: { ...n.params, cycle: 10 } } : n) });
    const updated = runtime.updateGraph(slowed);
    const afterChange = tick();
    const started = performance.now();
    await new Promise(resolve => setTimeout(resolve, 200));
    const later = tick();
    const seconds = (performance.now() - started) / 1000;
    runtime.dispose();
    return { updated, before, afterChange, later, seconds };
  }, { ...graph(), nodes: graph().nodes.map(n => n.id === 'wave' ? { ...n, pattern: 'linear' } : n), modulations: [{ from: 'wave', to: 'tint', param: 'saturation', min: 0, max: 2 }] });
  // The graph update was a hot parameter edit, not a rebuilt runtime: the clock and
  // the travel survive it.
  expect(result.updated).toBe(true);
  expect(result.before).toBeGreaterThan(.05);
  expect(Math.abs(result.afterChange - result.before)).toBeLessThan(.02);
  expect(result.afterChange).toBeGreaterThanOrEqual(result.before);
  // Editor frames here are ~0.2 s, longer than the 0.08 s rate glide, so the new
  // speed is in effect for the whole window: about a tenth of the elapsed time is
  // travelled, where the old 1 s cycle would have covered all of it (~1.0).
  const advanced = result.later - result.afterChange;
  expect(advanced).toBeGreaterThan(result.seconds * .05);
  expect(advanced).toBeLessThan(result.seconds * .3);
});

// ---------------------------------------------------------------------------
// The editor: creation from the palette, the inspector and the drawing pad
// ---------------------------------------------------------------------------

const fileText = (page, name) => page.evaluate(async name => (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns'))
  .getFileHandle(name)).getFile().then(file => file.text()), name);
const readPad = page => page.locator('.nodes-lfo-pad-line').getAttribute('points')
  .then(text => text.trim().split(/\s+/).map(pair => Number(pair.split(',')[1])));

test('the inspector creates an LFO, draws a Custom shape and saves it', async ({ page }) => {
  await page.goto('/?role=nodes');
  // Drag the palette item onto the canvas: a new signal node with the defaults.
  await page.getByRole('button', { name: '+ LFO', exact: true }).dragTo(page.getByLabel('Graph workspace'), { targetPosition: { x: 90, y: 140 } });
  await expect(page.locator('[data-node-id]')).toHaveCount(2);
  // The draft holds Output plus the new node, and the locator stays valid when the
  // node's own title changes with the chosen pattern.
  const card = page.locator('[data-node-id]').nth(1);
  await expect(card.locator('.nodes-node-title')).toContainText('LFO · linear');
  await expect(card.locator('.nodes-node-detail')).toHaveText('linear · 0…1 · 1.00 s');
  await card.click();
  // The LFO is a scalar source: its inspector shows the node's controls and a
  // live output, and no image preview at all.
  await expect(page.getByLabel('LFO range')).toHaveValue('unipolar');
  await expect(page.getByLabel('LFO pattern')).toHaveValue('linear');
  await expect(page.getByTestId('node-lfo-status')).toContainText('One cycle takes 1.00 s');
  await expect(page.getByTestId('node-preview')).toHaveCount(0);
  // The readout follows the running oscillator.
  const readout = () => page.getByTestId('node-signal-readout').innerText();
  const before = await readout();
  await page.waitForTimeout(200);
  expect(await readout()).not.toBe(before);
  // Cycle time and Start Position are ordinary numeric controls, which is what
  // makes them mappable like every other slider.
  await expect(page.locator('.nodes-modulated-param[data-param-target="cycle"]')).toHaveCount(1);
  await expect(page.locator('.nodes-modulated-param[data-param-target="phase"]')).toHaveCount(1);
  // The cycle-time track is genuinely logarithmic: the native input's own domain is
  // log10(0.1)…log10(10), so the middle of the track is 1 s (a linear track would
  // read 5.05 s there) and the readout is a duration in ms/s.
  const cycle = page.locator('.nodes-inspector input[data-key="cycle"]');
  const cycleLabel = page.locator('.nodes-inspector .param-value[data-value="cycle"]');
  expect(await cycle.getAttribute('min')).toBe('-1');
  expect(await cycle.getAttribute('max')).toBe('1');
  const drive = value => cycle.evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await drive(-1);
  await expect(cycleLabel).toHaveText('100 ms');
  await drive(0);
  await expect(cycleLabel).toHaveText('1.00 s');
  await drive(1);
  await expect(cycleLabel).toHaveText('10.00 s');
  await drive(.5);
  await expect(cycleLabel).toHaveText('3.16 s');
  await expect(card.locator('.nodes-node-detail')).toHaveText('linear · 0…1 · 3.16 s');
  // Linear has no shape to reseed; Noise and Random do.
  await expect(page.getByRole('button', { name: 'Reshuffle LFO shape' })).toHaveCount(0);
  await page.getByLabel('LFO pattern').selectOption('noise');
  await expect(card.locator('.nodes-node-detail')).toHaveText('noise · 0…1 · 3.16 s');
  await page.getByRole('button', { name: 'Reshuffle LFO shape' }).click();
  // Custom opens the drawing pad over the default ramp.
  await page.getByLabel('LFO pattern').selectOption('custom');
  await expect(page.locator('.nodes-lfo-pad')).toHaveCount(1);
  const ramp = await readPad(page);
  expect(ramp).toHaveLength(LFO_POINT_COUNT + 1);
  expect(ramp[19]).toBeCloseTo(1 - 19 / LFO_POINT_COUNT, 6);
  // One stroke draws: the column under the pointer takes the pointer's height.
  const box = await page.locator('.nodes-lfo-pad').boundingBox();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .9);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .1, { steps: 10 });
  await page.mouse.up();
  const drawn = await readPad(page);
  expect(drawn[19]).toBeCloseTo(.9, 6);
  expect(drawn[6]).toBeCloseTo(.1, 6);
  expect(drawn[0]).toBeCloseTo(1, 6);
  // The whole stroke is ONE undo step, and undoing it restores the ramp.
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await readPad(page))[19]).toBeCloseTo(1 - 19 / LFO_POINT_COUNT, 6);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await readPad(page))[19]).toBeCloseTo(.9, 6);

  // Save: the graph writes the drawn table and the chosen shape to disk.
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns', { create: true });
    window.showDirectoryPicker = async () => dir;
    const { nodePatterns } = await import('/src/nodes/repository.js');
    await nodePatterns.link();
  });
  await page.getByLabel('Graph name').fill('LFO pad');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.nodes-disk-error')).toHaveCount(0);
  const saved = JSON.parse(await fileText(page, 'LFO-pad.nodes.json'));
  const node = saved.graph.nodes.find(n => n.type === 'lfo');
  expect(node).toMatchObject({ pattern: 'custom', range: 'unipolar' });
  expect(node.points).toHaveLength(LFO_POINT_COUNT);
  // The pad stores the drawn values (up is 1), not the pad's screen coordinates.
  expect(node.points[19]).toBeCloseTo(.1, 6);
  expect(node.points[6]).toBeCloseTo(.9, 6);
  // The cycle time is the logarithmic midpoint of the track: 10 ** 0.5 = 3.162 s,
  // not the 5.05 s a linear track would have stored, and still on the 4-digit grid.
  expect(node.params.phase).toBe(0);
  expect(node.params.cycle).toBeCloseTo(3.162, 3);
  expect(saved.dependencies).toEqual([]);
});

test('a saved LFO graph reloads with its wirings and follows the live mapping', async ({ page }) => {
  await page.goto('/?role=nodes');
  const file = await page.evaluate(async graph => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    return serializeGraph(graph, manifestFor(graph, SKETCHES));
  }, graph());
  const id = await page.evaluate(async text => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns', { create: true });
    const handle = await dir.getFileHandle('lfo.nodes.json', { create: true });
    const writer = await handle.createWritable(); await writer.write(text); await writer.close();
    window.showDirectoryPicker = async () => dir;
    window.showOpenFilePicker = async () => [handle];
    const { nodePatterns } = await import('/src/nodes/repository.js');
    await nodePatterns.link(); return (await nodePatterns.open('lfo.nodes.json')).id;
  }, file);
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue('LFO sweep');
  // Mappings onto and from an LFO are legal links, so the graph loads clean.
  await expect(page.getByTestId('nodes-blocked')).toHaveCount(0);
  const cards = page.locator('[data-node-id]');
  await expect(cards.filter({ hasText: 'LFO · sine' })).toHaveCount(1);
  await expect(cards.filter({ hasText: 'LFO · linear' })).toHaveCount(1);
  // Both signal wires are drawn and selectable like any other link.
  await expect(page.locator('path[data-connection^="modulation:wave:tint"]')).toHaveCount(1);
  await page.locator('path[data-connection^="modulation:slow:wave"]').click();
  await expect(page.getByTestId('selected-connection')).toContainText('LFO · linear → LFO · sine cycle (modulation)');
  // The LFO's own Speed is mapped, so its slider shows the source and the LIVE
  // value coming from it, and that value moves with the source.
  await cards.filter({ hasText: 'LFO · sine' }).click();
  await expect(page.getByTestId('mapping-source-cycle')).toHaveText('LFO · linear');
  const live = () => page.getByTestId('mapping-live-cycle').getAttribute('title');
  const first = await live();
  await page.waitForTimeout(300);
  expect(await live()).not.toBe(first);
  // The LFO drives the Color target the same way every other signal does.
  await page.locator('[data-node-id="tint"]').click();
  await expect(page.getByTestId('mapping-source-saturation')).toHaveText('LFO · sine');
  await expect.poll(async () => Number((await page.getByTestId('mapping-live-saturation').getAttribute('title')).replace('LIVE ', '')))
    .toBeGreaterThanOrEqual(0);
});
