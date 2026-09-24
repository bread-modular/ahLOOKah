import { test, expect } from '@playwright/test';

import { compileScript, evaluateScript, scriptCompileStats } from '../src/nodes/script.js';
import { scriptValue, scriptProgram, scriptLanguageOf, scriptSource } from '../src/nodes/scalar.js';
import { createScriptStateStore } from '../src/nodes/script-state.js';
import { MAX_STATE_SLOTS, MAX_STATE_STEP } from '../src/nodes/script-core.js';
import { approveScript, clearApprovals } from '../src/nodes/script-approval.js';
import { validateGraph } from '../src/nodes/model.js';
import { serializeGraph, parseGraph, manifestFor } from '../src/nodes/portability.js';
import { COLOR_PARAMS } from '../src/nodes/definitions.js';

const program = source => {
  const compiled = compileScript(source, 'body');
  expect(compiled.ok, compiled.error).toBe(true);
  return compiled;
};
const rejects = (source, message) => {
  const compiled = compileScript(source, 'body');
  expect(compiled.ok, `expected rejection: ${source}`).toBe(false);
  if (message) expect(compiled.error, source).toMatch(message);
  return compiled;
};
// A body runs against an explicit store here; the runtime supplies the same
// Float64Array through script-state.js.
const run = (compiled, vars = {}, state = null) => {
  const issues = [];
  const store = state || Float64Array.from(compiled.program.state.init);
  return { value: evaluateScript(compiled, vars, issues, store), issues, store };
};
const node = (source, extra = {}) => ({ type: 'script', language: 'body', source, ...extra });
const harness = () => {
  const cache = new Map();
  const store = createScriptStateStore();
  return {
    cache, store,
    entry: source => scriptProgram(node(source), cache),
    // One node's frame: `tick` is the runtime's frame counter, `time` the clock.
    frame: (id, entry, { tick, time = tick / 60, x = 0, dt } = {}) => store.run(id, { tick, time, entry },
      (step, state) => scriptValue(node(entry.source, { inputX: x }), { dt: dt ?? step, time, entry, state }, cache)),
  };
};

test('@core the body language accepts state slots and buffers, and rejects everything else about them', () => {
  const ok = source => expect(compileScript(source, 'body').ok, source).toBe(true);
  ok('state.a = 0;\nreturn state.a + dt;');
  ok('state.a = x;\nstate.a += dt;\nreturn state.a;');
  ok('state.h = [0, 0, 0, 0];\nstate.i = (state.i + 1) % 4;\nstate.h[state.i] = x;\nreturn state.h[0];');
  ok('state.n = state.n + 1;\nif (x > 0) state.m = x;\nreturn state.n + state.m;');
  ok('return state.h = [1, 2];'); // a declaration is an expression like any other
  ok('state.h = [0, 0];\nstate.h = [0, 0];\nreturn state.h[1];'); // identical re-declaration
  // a stored value is a number, not an object or an array
  rejects('return state;', /persistent store; read a slot like state\.level/);
  rejects('return state.a;', /read before this script ever assigns it/);
  rejects('state.a = 0;\nreturn state[b];', /fixed names/);
  rejects('state.a = 1;\nreturn state.a.b;', /single stored number; it has no properties/);
  rejects('state.h = [0, 1];\nreturn state.h[0].x;', /buffer of 2; read one value/);
  rejects('state.h = [0, 1];\nreturn state.h[0][0];', /one level deep/);
  rejects('state.h = [0, 1];\nreturn state.h;', /buffer of 2; index it/);
  rejects('state.a = 0;\nreturn state.a[0];', /single number; read it without an index/);
  rejects('state.a = 0;\nreturn state.a(1);', /math functions/);
  rejects('state.a = state.b;\nreturn 1;', /assign it first/);
  // a stored number is not an object, however the access is spelled
  rejects('state.h = [1, 2];\nreturn state.h.foo[0];', /buffer of 2; read one value/);
  rejects('state.h = [1, 2];\nstate.h.foo[0] = 3;\nreturn 1;', /buffer of 2; read one value/);
  rejects('state.h = [1, 2];\nstate.h.foo = [1];\nreturn 1;', /buffer of 2; read one value/);
  rejects('state.a = 1;\nreturn state.a.b[0];', /single stored number; it has no properties/);
  rejects('state.a = 1;\nstate.a.b[0] = 2;\nreturn 1;', /single stored number; it has no properties/);
  // buffers need a declaration (a size) before they can be indexed
  rejects('state.h[0] = 1;\nreturn 1;', /Declare the buffer first/);
  rejects('state.h = 5;\nreturn state.h[0];', /single number; read it without an index/);
  rejects('state.h = [0, 1];\nstate.h = 1;\nreturn 1;', /is a buffer; assign one value/);
  rejects('state.h = [0, 1];\nstate.h = [0, 2];\nreturn 1;', /already declared as a buffer of 2/);
  rejects('state.a = 1;\nstate.a = [0, 1];\nreturn 1;', /already declared as a number/);
  rejects('state.a = [x, 1];\nreturn 1;', /plain numbers/);
  rejects('state.a = [];\nreturn 1;', /at least one value/);
  // names, inputs and the store itself stay out of the slot namespace
  rejects('state.__proto__ = 1;\nreturn 1;', /not a state slot name/);
  rejects('state.constructor = 1;\nreturn 1;', /not a state slot name/);
  rejects('let state = 1;\nreturn 1;', /reserved/);
  rejects('dt = 1;\nreturn dt;', /read-only input/);
  // arrays are still rejected everywhere except a buffer declaration
  rejects('let a = [1, 2];\nreturn 1;', /Arrays and objects are not allowed/);
  rejects('state.h = [0, 1];\nstate.h[0] = [1];\nreturn 1;', /Arrays and objects are not allowed/);
  rejects('window.x = [1];\nreturn 1;', /Only a declared local or a state slot/);
  // capacity is bounded before any code is emitted
  rejects(`state.h = [${Array.from({ length: MAX_STATE_SLOTS + 1 }, () => '0').join(', ')}];\nreturn 1;`, /State is too large/);
  rejects(`state.h = [${Array.from({ length: MAX_STATE_SLOTS }, () => '0').join(', ')}];\nstate.extra = 0;\nreturn 1;`, /State is too large/);
  ok(`state.h = [${Array.from({ length: MAX_STATE_SLOTS }, () => '0').join(', ')}];\nreturn state.h[0];`);
  // the expression language is untouched: no state, no dt, same single value
  const expression = compileScript('x + 1', 'expression');
  expect(expression.ok).toBe(true);
  expect(expression.uses).toEqual({ x: true, y: false, time: false });
  expect(compileScript('state.a', 'expression').error).toMatch(/body language only/);
  expect(compileScript('state.a + 1', 'expression').error).toMatch(/body language only/);
  expect(compileScript('dt', 'expression').error).toMatch(/body language only/);
});

test('@core the compiled program carries only the layout of its state', () => {
  const compiled = program('state.n = 0;\nstate.hist = [0, 1, 0, 1];\nstate.i = 0;\nreturn state.hist[state.i];');
  const { state, uses } = compiled.program;
  expect(uses.dt).toBe(false);
  expect(state.slots).toBe(6);
  expect(state.init).toEqual([0, 0, 1, 0, 1, 0]);
  expect(state.entries).toEqual([
    { name: 'n', kind: 'scalar', base: 0, size: 1, initial: null },
    { name: 'hist', kind: 'buffer', base: 1, size: 4, initial: [0, 1, 0, 1] },
    { name: 'i', kind: 'scalar', base: 5, size: 1, initial: null },
  ]);
  // `dt` is a real input, recorded in `uses` like x/y/time
  expect(program('return dt;').uses.dt).toBe(true);
  // no state at all: a body stays a pure function (and the store allocates nothing)
  const pure = program('return x + time;');
  expect(pure.program.state.slots).toBe(0);
  expect(pure.uses).toMatchObject({ x: true, time: true, dt: false });
});

test('@core state slots and buffers read and write numbers across evaluations', () => {
  // without a store every evaluation starts from the declared initial values
  const counter = program('state.n = state.n + 1;\nreturn state.n;');
  expect(run(counter).value).toBe(1);
  expect(run(counter).value).toBe(1);
  // with a store the value persists
  const store = Float64Array.from(counter.program.state.init);
  expect([run(counter, {}, store).value, run(counter, {}, store).value, run(counter, {}, store).value]).toEqual([1, 2, 3]);
  expect([...store]).toEqual([3]);
  // assignment expressions evaluate to the stored value, compound forms work
  expect(run(program('return (state.a = 2) + 1;')).value).toBe(3);
  expect(run(program('state.a = 1;\nstate.a += 2;\nreturn state.a;')).value).toBe(3);
  expect(run(program('state.a = 1;\nstate.a *= 4;\nreturn state.a;')).value).toBe(4);
  // buffers: initial contents, indexed write, truncated index, ring cursor
  const buffer = program('state.h = [0, 1, 2, 3];\nstate.i = (state.i + 1) % 4;\nstate.h[state.i] = x;\nreturn state.h[0] + state.h[1] + state.h[2] + state.h[3];');
  const slots = Float64Array.from(buffer.program.state.init);
  expect(run(buffer, { x: 10 }, slots).value).toBe(15); // 0+10+2+3
  expect(run(buffer, { x: 10 }, slots).value).toBe(23); // 0+10+10+3
  expect([...slots]).toEqual([0, 10, 10, 3, 2]); // the four values, then the ring cursor
  expect(run(program('state.h = [0, 0];\nlet i = 1.9;\nstate.h[i] = 7;\nreturn state.h[1];')).value).toBe(7);
  // compound assignment to a buffer element reads and writes the same slot
  expect(run(program('state.h = [1, 2];\nreturn (state.h[0] += 5) + state.h[0];')).value).toBe(12);
  // an index outside the buffer is an error, never a neighbouring slot
  expect(() => run(program('state.h = [1, 2];\nstate.i = 2;\nreturn state.h[state.i];')))
    .toThrow(/state\.h\[2] is outside 0…1/);
  expect(() => run(program('state.h = [1, 2];\nlet i = -1;\nstate.h[i] = 3;\nreturn 1;')))
    .toThrow(/state\.h\[-1] is outside 0…1/);
  // a documented weighted average of the last four values
  const weighted = program('state.hist = [0, 0, 0, 0];\nstate.i = (state.i + 1) % 4;\nstate.hist[state.i] = x;\nlet w = state.hist[state.i] * 4 + state.hist[(state.i + 3) % 4] * 3 + state.hist[(state.i + 2) % 4] * 2 + state.hist[(state.i + 1) % 4];\nreturn w / 10;');
  const history = Float64Array.from(weighted.program.state.init);
  expect([1, 2, 3, 4, 5].map(x => run(weighted, { x }, history).value))
    .toEqual([0.4, 1.1, 2, 3, 4]); // once the window is full the newest sample dominates (weights 4 3 2 1)
});

test('@core the store updates once per frame, bounds dt and never commits a failed body', () => {
  const { entry, frame, store } = harness();
  const counter = entry('state.n = state.n + 1;\nreturn state.n;');
  // one update per tick: a second read in the same frame replays that frame's value
  expect(frame('a', counter, { tick: 1, time: 0 }).value).toBe(1);
  expect(frame('a', counter, { tick: 1, time: 0 }).value).toBe(1);
  expect(frame('a', counter, { tick: 1, time: 0.001 }).value).toBe(1);
  expect(frame('a', counter, { tick: 2, time: 0.016 }).value).toBe(2);
  expect(store.readout('a')).toEqual([{ name: 'n', kind: 'scalar', size: 1, value: 2, values: null }]);
  // dt: 0 on the first update, real elapsed time afterwards, clamped to the cap
  const clock = entry('return dt;');
  expect(frame('b', clock, { tick: 1, time: 100 }).value).toBe(0);
  expect(frame('b', clock, { tick: 2, time: 100.016 }).value).toBeCloseTo(0.016, 9);
  expect(frame('b', clock, { tick: 3, time: 130 }).value).toBe(MAX_STATE_STEP);
  expect(frame('b', clock, { tick: 4, time: 100 }).value).toBe(0); // a clock that stepped back never goes negative
  // an error, a non-finite return or a non-finite stored value changes nothing
  const failing = entry('state.n = state.n + 1;\nif (x > 0) return sqrt(-1);\nreturn state.n;');
  const failed = frame('c', failing, { tick: 1, time: 0, x: 1 });
  expect(failed.error).toMatch(/non-finite/);
  expect(failed.value).toBe(0);
  expect(failed.committed).toBe(false);
  expect(store.readout('c')[0].value).toBe(0);
  expect(frame('c', failing, { tick: 2, time: 0.016, x: 0 }).value).toBe(1); // the failed frame did not count
  const infinite = entry('state.a = exp(1000);\nreturn 1;');
  const stored = frame('d', infinite, { tick: 1, time: 0 });
  expect(stored.error).toMatch(/not finite/);
  expect(stored.committed).toBe(false);
  expect(store.readout('d')[0].value).toBe(0);
  // nodes never share a store, and a different layout replaces it
  expect(frame('e1', counter, { tick: 1, time: 0 }).value).toBe(1);
  expect(frame('e2', counter, { tick: 1, time: 0 }).value).toBe(1);
  expect(frame('e1', counter, { tick: 2, time: 0.016 }).value).toBe(2);
  expect(frame('e1', entry('state.h = [0, 0];\nreturn state.h[0];'), { tick: 3, time: 0.032 }).value).toBe(0);
  expect(store.readout('e1')).toEqual([{ name: 'h', kind: 'buffer', size: 2, value: null, values: [0, 0] }]);
  expect(store.size()).toBe(6); // a, b, c, d, e1, e2 (e1 keeps one record across the layout change)
  // reset restores the declared initial values and forgets the timing
  const buffer = entry('state.h = [0, 1, 0, 1];\nstate.n = state.n + 1;\nreturn state.h[3];');
  frame('f', buffer, { tick: 1, time: 0 });
  expect(store.readout('f').map(s => s.kind === 'buffer' ? s.values : s.value)).toEqual([[0, 1, 0, 1], 1]);
  expect(store.reset('f')).toBe(true);
  expect(store.readout('f').map(s => s.kind === 'buffer' ? s.values : s.value)).toEqual([[0, 1, 0, 1], 0]);
  expect(frame('f', buffer, { tick: 1, time: 0 }).value).toBe(1); // the same frame runs again after a reset
  expect(frame('f', buffer, { tick: 1, time: 0 }).value).toBe(1);
  // drop/clear, and a node with no state at all
  expect(store.readout('nope')).toBeNull();
  expect(store.reset('nope')).toBe(false);
  expect(store.drop('f')).toBe(true);
  expect(store.readout('f')).toBeNull();
  expect(store.run('g', { tick: 1, time: 0, entry: entry('return x;') }, (dt, state) => {
    expect(state).toBeNull(); // no slots: the body gets no array at all
    return { value: dt, error: null, uses: null, language: 'body' };
  }).value).toBe(0);
  // a frame the renderer discards is not rolled back: the state advances once for
  // that tick and the next tick steps by its own elapsed time, never by a longer
  // replay of the discarded interval
  const durable = entry('state.n = state.n + 1;\nreturn dt;');
  expect(frame('h', durable, { tick: 1, time: 0 }).value).toBe(0);
  expect(frame('h', durable, { tick: 2, time: 0.016 }).value).toBeCloseTo(0.016, 9);
  expect(frame('h', durable, { tick: 3, time: 0.032 }).value).toBeCloseTo(0.016, 9);
  expect(store.readout('h')[0].value).toBe(3);
  store.clear();
  expect(store.size()).toBe(0);
});

test('@core a state node still compiles once per source and evaluates once per frame', () => {
  const { entry, frame } = harness();
  const slow = entry('state.level = state.level + (x - state.level) * dt;\nreturn state.level;');
  const before = { ...scriptCompileStats };
  for (let tick = 1; tick <= 50; tick++) frame('slow', slow, { tick, time: tick / 60, x: 1 });
  expect(scriptCompileStats.parses - before.parses).toBe(0); // the retained program is reused
  expect(scriptCompileStats.evaluations - before.evaluations).toBe(50); // exactly one per frame
  // a smoothing run converges towards its input and never overshoots
  const values = [];
  const smooth = entry('state.level = state.level + (x - state.level) * (1 - exp(-dt / 0.15));\nreturn state.level;');
  for (let tick = 1; tick <= 200; tick++) values.push(frame('smooth', smooth, { tick, time: tick / 60, x: 1 }).value);
  expect(values[0]).toBe(0); // the first frame has dt = 0, so nothing moved yet
  expect(values[10]).toBeGreaterThan(values[5]);
  expect(values[199]).toBeLessThan(1);
  expect(values[199]).toBeGreaterThan(0.9);
  expect(values.every(value => value >= 0 && value <= 1)).toBe(true);
});

test('@core state is runtime memory: a saved graph never carries a stored value', () => {
  clearApprovals();
  const source = 'state.n = state.n + 1;\nreturn state.n;';
  const graph = {
    version: 1, name: 'State chain',
    nodes: [
      { id: 'base', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .5, pulse: 0 }, x: 40, y: 40 },
      { id: 'shape', type: 'script', language: 'body', source, inputX: 0, inputY: 0, x: 440, y: 300 },
      { id: 'output', type: 'output', x: 620, y: 40 },
    ],
    edges: [], modulations: [{ from: 'shape', to: 'base', param: 'brightness', min: 0, max: 1 }],
  };
  const sketches = [{ id: 'solid-color', name: 'Solid Color', params: COLOR_PARAMS }];
  const validated = validateGraph(structuredClone(graph));
  expect(validated.nodes.find(n => n.id === 'shape')).toEqual({ id: 'shape', type: 'script', x: 440, y: 300, language: 'body', source, inputX: 0, inputY: 0 });
  const text = serializeGraph(validated, manifestFor(validated, sketches));
  expect(text).not.toMatch(/"(state|values|slots|tick|dt)"/);
  expect(parseGraph(text).graph).toEqual(validated);
  // the same source in a graph that never ran still compiles to the same layout
  expect(scriptSource(validated.nodes.find(n => n.id === 'shape'))).toBe(source);
  expect(scriptLanguageOf(validated.nodes.find(n => n.id === 'shape'))).toBe('body');
});

test('@core the nodes guide documents persistent state, dt, buffers and the reset action', async ({ request }) => {
  const response = await request.get('/docs/nodes.html');
  expect(response.ok()).toBe(true);
  const article = await response.text();
  for (const contract of ['Persistent state', 'state.&lt;name&gt;', '<code>dt</code>', 'buffer', 'Reset state', '64 values', 'One update per frame']) {
    expect(article).toContain(contract);
  }
});

const useGraph = async (page, graph) => page.evaluate(async data => {
  FileSystemHandle.prototype.queryPermission = async () => 'granted';
  FileSystemHandle.prototype.requestPermission = async () => 'granted';
  const { SKETCHES } = await import('/src/sketch-registry.js');
  const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
  const { approveScript } = await import('/src/nodes/script-approval.js');
  for (const n of data.nodes) if (n.type === 'script') approveScript(n.language ?? 'expression', n.source);
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('script-state-tests', { create: true });
  const file = await dir.getFileHandle('state.nodes.json', { create: true });
  const writer = await file.createWritable(); await writer.write(serializeGraph(data, manifestFor(data, SKETCHES))); await writer.close();
  window.showDirectoryPicker = async () => dir;
  const { nodePatterns } = await import('/src/nodes/repository.js');
  await nodePatterns.link();
  return (await nodePatterns.open('state.nodes.json')).id;
}, graph);

test('@core a running graph keeps its state across ordinary edits and drops it when the plan changes', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { approveScript } = await import('/src/nodes/script-approval.js');
    const source = 'state.n = state.n + 1;\nreturn state.n;';
    approveScript('body', source);
    const graph = {
      version: 1, name: 'State runtime',
      nodes: [
        { id: 'shape', type: 'script', language: 'body', source, inputX: 0, inputY: 0, x: 0, y: 0 },
        { id: 'output', type: 'output', x: 200, y: 0 },
      ],
      edges: [], modulations: [],
    };
    const runtime = new GraphRuntime({ graph, sketches: [], audio: null, width: 32, height: 18 });
    await runtime.ready;
    // One frame per render: the script is not wired to Output, so the inspector
    // read is what evaluates it — exactly one update per frame either way.
    const step = () => { runtime.render('output'); return runtime.signalValue('shape'); };
    const values = [step(), step(), step()];
    // An ordinary edit — a changed input literal — keeps the plan and the state.
    const edited = { ...graph, nodes: graph.nodes.map(n => n.id === 'shape' ? { ...n, inputX: 1 } : n) };
    const kept = runtime.updateGraph(edited);
    const after = [step(), step()];
    // A different source is a structural change: updateGraph refuses and the
    // owner builds a new runtime, whose store starts from the declared values.
    const changed = { ...edited, nodes: edited.nodes.map(n => n.id === 'shape' ? { ...n, source: 'state.n = 0;\nreturn 1;' } : n) };
    const structural = runtime.updateGraph(changed);
    const state = runtime.getScriptState('shape');
    runtime.dispose();
    return { values, kept, after, structural, state };
  });
  expect(result.values).toEqual([1, 2, 3]);
  expect(result.kept).toBe(true);
  expect(result.after).toEqual([4, 5]);
  expect(result.structural).toBe(false);
  expect(result.state).toEqual([{ name: 'n', kind: 'scalar', size: 1, value: 5, values: null }]);
});

// A real cancellation: an FX frame is invalidated while it is in flight. The
// hook is the graph's own audio read, which happens while the script's tick is
// being evaluated.
test('@core a cancelled FX frame keeps the update its script already made', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { approveScript } = await import('/src/nodes/script-approval.js');
    const source = 'state.n = state.n + 1;\nreturn x;';
    approveScript('body', source);
    const graph = {
      version: 2, name: 'Cancelled FX frame',
      nodes: [
        { id: 'cam', type: 'camera', deviceId: null, x: 40, y: 40 },
        { id: 'tint', type: 'color', params: { saturation: 1, brightness: .5, contrast: 1, hue: 0 }, x: 260, y: 40 },
        { id: 'band', type: 'audio', band: 'bass', x: 40, y: 300 },
        { id: 'shape', type: 'script', language: 'body', source, inputX: .5, inputY: 0, x: 240, y: 300 },
        { id: 'output', type: 'output', x: 480, y: 40 },
      ],
      edges: [{ from: 'cam', to: 'tint', port: 'image' }, { from: 'tint', to: 'output', port: 'image' }],
      signalEdges: [{ from: 'band', to: 'shape', port: 'x' }],
      modulations: [{ from: 'shape', to: 'tint', param: 'brightness', min: .2, max: .9 }],
    };
    // An ordinary edit (one Color parameter) — the same kind of change the
    // editor commits while a preview frame is being drawn.
    const edited = brightness => ({ ...graph, nodes: graph.nodes.map(n => n.id === 'tint' ? { ...n, params: { ...n.params, brightness } } : n) });
    let reads = 0, cancel = null;
    const runtime = new GraphRuntime({ graph, sketches: [], audio: null, width: 64, height: 36,
      context: { readAudioSignals: () => { reads++; cancel?.(); return { bass: .5, mid: .25, high: 0 }; } } });
    await runtime.ready;
    const count = () => runtime.getScriptState('shape')[0].value;
    const first = await runtime.renderFrame('output');
    const afterFirst = count();
    // An edit that lands while the frame is still awaiting its activation is
    // absorbed: that frame still commits and the script advanced exactly once.
    const activating = runtime.renderFrame('output');
    const absorbed = runtime.updateGraph(edited(.25));
    const second = await activating;
    const afterSecond = count();
    // An edit that lands mid-flight — from inside the script's own input read,
    // deferred by a microtask so the tick's state is already committed — retires
    // that frame's pixels. The update the tick made still stands.
    let atCancel = null;
    cancel = () => {
      cancel = null;
      queueMicrotask(() => { atCancel = count(); runtime.updateGraph(edited(.3)); });
    };
    const third = await runtime.renderFrame('output');
    const afterThird = count();
    // The next frame commits normally and advances exactly once more.
    const fourth = await runtime.renderFrame('output');
    const afterFourth = count();
    runtime.dispose();
    return { painted: [!!first, !!second], afterFirst, absorbed, discarded: third, atCancel,
      afterSecond, afterThird, paintedFourth: !!fourth, afterFourth, reads };
  });
  expect(result.reads).toBeGreaterThan(0); // the script really did read its audio input
  expect(result.painted).toEqual([true, true]); // ordinary frames commit an image
  expect(result.absorbed).toBe(true);
  expect(result.afterFirst).toBe(1);
  expect(result.afterSecond).toBe(2); // absorbed edit: still exactly one update
  expect(result.discarded).toBeNull(); // mid-flight cancel: the frame committed no image
  expect(result.atCancel).toBe(3); // the cancelled tick's update was already committed ...
  expect(result.afterThird).toBe(3); // ... and it stands, rather than being rolled back
  expect(result.afterThird).toBe(result.afterSecond + 1); // one update for a discarded frame
  expect(result.paintedFourth).toBe(true); // the next frame commits normally
  expect(result.afterFourth).toBe(4); // exactly one update per tick, never two
});

test('@core the inspector shows live state, advances it once per frame and resets it', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?role=nodes');
  const source = 'state.n = state.n + 1;\nstate.level = state.level + (x - state.level) * 0.1;\nreturn state.n + state.level;';
  const id = await useGraph(page, {
    version: 1, name: 'State chain',
    nodes: [
      { id: 'base', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .5, pulse: 0 }, x: 40, y: 40 },
      { id: 'shape', type: 'script', language: 'body', source, inputX: 1, inputY: 0, x: 440, y: 300 },
      { id: 'output', type: 'output', x: 620, y: 40 },
    ],
    edges: [{ from: 'base', to: 'output', port: 'image' }],
  });
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await page.getByRole('button', { name: 'Select Script', exact: true }).click();
  await expect(page.getByLabel('Script source')).toHaveValue(source);
  // the status line names the slots, and the readout shows their live values
  await expect(page.getByTestId('script-status')).toContainText('· state n, level');
  const readout = page.getByTestId('script-state');
  await expect(readout).toContainText('state n = ');
  const counter = async () => Number((await readout.textContent()).match(/n = ([\d.]+)/)?.[1]);
  await expect.poll(counter).toBeGreaterThan(5);
  const output = async () => Number((await page.getByTestId('node-signal-readout').textContent()).match(/Output ([\d.]+)/)?.[1]);
  await expect.poll(output).toBeGreaterThan(5); // the node's scalar output follows its state
  // state advances once per frame, so the counter grows at roughly the frame rate
  const before = await counter();
  await page.waitForTimeout(500);
  const advanced = await counter() - before;
  expect(advanced).toBeGreaterThan(10);
  expect(advanced).toBeLessThan(200);
  // Reset state restores the declared values (all slots start at 0)
  await page.getByTestId('script-reset-state').click();
  await expect.poll(counter).toBeLessThan(before + 30);
  expect(errors).toEqual([]);
});
