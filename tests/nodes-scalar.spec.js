import { test, expect } from '@playwright/test';
import { validateGraph, connectSignal, connectSignalEdge, mapSignal, mapSignalInput, deleteNode, connect } from '../src/nodes/model.js';
import { mappedValue, parameterView, numeric, OPACITY } from '../src/nodes/modulation.js';
import { parseGraph, serializeGraph, manifestFor } from '../src/nodes/portability.js';
import { compileExpression, evaluateExpression } from '../src/nodes/script.js';
import { mathValue, mathIssue, scriptValue } from '../src/nodes/scalar.js';
import { expressionHash, isExpressionApproved, approveExpression, revokeExpression, clearApprovals } from '../src/nodes/script-approval.js';
import { defaultNode, inputs, COLOR_PARAMS, MATH_LITERALS } from '../src/nodes/definitions.js';

const solid = (id, x, y) => ({ id, type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .5, pulse: 0 }, x, y });
const visual = () => ({ version: 1, name: 'Scalar colour', nodes: [
  solid('base', 40, 40),
  { id: 'tint', type: 'color', params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 }, x: 260, y: 40 },
  { id: 'output', type: 'output', x: 480, y: 40 },
], edges: [{ from: 'base', to: 'tint', port: 'image' }, { from: 'tint', to: 'output', port: 'image' }] });
// audio → math (literal b = 8) → script (x / 2 + y * 0) → two terminal mappings.
const scalar = () => ({ version: 1, name: 'Scalar chain', nodes: [
  solid('base', 40, 40),
  { id: 'tint', type: 'color', params: { saturation: 1, brightness: .5, contrast: 1, hue: 0 }, x: 260, y: 40 },
  { id: 'source', type: 'audio', band: 'bass', x: 40, y: 300 },
  { id: 'scale', type: 'math', op: 'multiply', a: 0, b: 8, c: 1, x: 240, y: 300 },
  { id: 'shape', type: 'script', source: 'x / 2 + y * 0', inputX: 0, inputY: 0, x: 440, y: 300 },
  { id: 'output', type: 'output', x: 620, y: 40 },
], edges: [{ from: 'base', to: 'tint', port: 'image' }, { from: 'tint', to: 'output', port: 'image' }],
  signalEdges: [
    { from: 'source', to: 'scale', port: 'a' },
    { from: 'scale', to: 'shape', port: 'x' },
    { from: 'scale', to: 'shape', port: 'y' },
  ] });
const chained = () => ({
  ...scalar(),
  modulations: [
    { from: 'shape', to: 'tint', param: 'brightness', min: .1, max: .7, inputMin: 0, inputMax: 3 },
    { from: 'shape', to: 'tint', param: 'saturation', min: .2, max: .8 },
  ],
});

test('graph validation accepts colour, math and script nodes with separate scalar wiring', () => {
  const g = chained();
  const parsed = validateGraph(structuredClone(g), { complete: true });
  expect(parsed.nodes).toHaveLength(6);
  expect(parsed.signalEdges).toEqual(g.signalEdges);
  expect(parsed.modulations).toEqual(g.modulations);
  expect(inputs({ type: 'color' })).toEqual(['image']);
  expect(inputs({ type: 'math' })).toEqual(['a', 'b', 'c']);
  expect(inputs({ type: 'script' })).toEqual(['x', 'y']);
  expect(inputs({ type: 'blend' })).toEqual(['base', 'layer']);
  // Old graphs and their mappings are copied unchanged.
  const legacy = visual();
  expect(validateGraph(structuredClone(legacy), { complete: true })).toEqual(legacy);
  const withSignal = validateGraph({ ...legacy, nodes: [...legacy.nodes, { id: 'sig', type: 'audio', band: 'bass', x: 0, y: 0 }] });
  const unmapped = { ...withSignal, modulations: [{ from: 'sig', to: 'tint', param: null }] };
  expect(validateGraph(structuredClone(unmapped))).toEqual(unmapped);
  expect(connectSignal(unmapped, 'sig', 'tint')).toEqual(unmapped); // already connected
  const mapped = mapSignal(withSignal, 'sig', 'tint', 'contrast', .2, .8);
  expect(mapped.modulations).toEqual([{ from: 'sig', to: 'tint', param: 'contrast', min: .2, max: .8 }]);
  expect(mapSignalInput(mapped, 'sig', 'tint', 'contrast', 0, 4).modulations[0])
    .toEqual({ from: 'sig', to: 'tint', param: 'contrast', min: .2, max: .8, inputMin: 0, inputMax: 4 });
});

test('scalar wiring rejects wrong kinds, duplicate inputs, cycles, bad literals and unknown versions', () => {
  const g = chained();
  expect(() => validateGraph({ ...g, signalEdges: [...g.signalEdges, { from: 'base', to: 'scale', port: 'a' }] })).toThrow(/signal/);
  expect(() => validateGraph({ ...g, signalEdges: [...g.signalEdges, { from: 'source', to: 'output', port: 'a' }] })).toThrow(/signal/);
  expect(() => validateGraph({ ...g, signalEdges: [...g.signalEdges, { from: 'source', to: 'scale', port: 'z' }] })).toThrow(/signal/);
  expect(() => validateGraph({ ...g, signalEdges: [...g.signalEdges, { from: 'source', to: 'scale', port: 'b' }] })).not.toThrow();
  // Signal wires are limited by distinct ports and references, not by a count
  // budget: a long scalar chain validates without a node or wire cap.
  const chain = { version: 1, name: 'chain', nodes: [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, type: 'math', op: 'add', a: 0, b: 1, c: 1, x: 0, y: 0 })),
    { id: 'output', type: 'output', x: 0, y: 0 },
  ], edges: [], signalEdges: Array.from({ length: 29 }, (_, i) => ({ from: `m${i}`, to: `m${i + 1}`, port: 'a' })) };
  expect(validateGraph(chain).signalEdges).toHaveLength(29);
  expect(validateGraph(chain).nodes).toHaveLength(31);
  expect(() => validateGraph({ ...g, nodes: g.nodes.map(n => n.id === 'scale' ? { ...n, op: 'pow' } : n) })).toThrow(/math operation/);
  expect(() => validateGraph({ ...g, nodes: g.nodes.map(n => n.id === 'scale' ? { ...n, b: Infinity } : n) })).toThrow(/literal/);
  expect(() => validateGraph({ ...g, nodes: g.nodes.map(n => n.id === 'shape' ? { ...n, source: 7 } : n) })).toThrow(/Script source/);
  expect(() => validateGraph({ ...g, nodes: g.nodes.map(n => n.id === 'shape' ? { ...n, source: 'x'.repeat(257) } : n) })).toThrow(/256/);
  expect(() => validateGraph({ ...g, nodes: g.nodes.map(n => n.id === 'tint' ? { ...n, params: { brightness: NaN } } : n) })).toThrow(/color/);
  expect(() => validateGraph({ ...g, modulations: [{ from: 'shape', to: 'tint', param: 'saturation', min: 0, max: 1, inputMin: 4, inputMax: 4 }] })).toThrow(/input range/);
  expect(() => validateGraph({ ...g, modulations: [{ from: 'base', to: 'tint', param: 'saturation', min: 0, max: 1 }] })).toThrow(/modulation reference/);
  const loop = { version: 1, name: 'loop', nodes: [
    { id: 'one', type: 'math', op: 'add', a: 0, b: 0, c: 1, x: 0, y: 0 },
    { id: 'two', type: 'math', op: 'add', a: 0, b: 0, c: 1, x: 0, y: 0 },
    { id: 'output', type: 'output', x: 0, y: 0 },
  ], edges: [], signalEdges: [{ from: 'one', to: 'two', port: 'a' }, { from: 'two', to: 'one', port: 'a' }] };
  expect(() => validateGraph(loop)).toThrow(/cycle/);
  expect(() => validateGraph({ ...g, version: 9 })).toThrow(/version/);
  expect(() => connect(g, 'source', 'tint', 'image')).toThrow(/port/);
  expect(connectSignalEdge(g, 'scale', 'shape', 'y').signalEdges.filter(e => e.to === 'shape' && e.port === 'y')).toHaveLength(1);
});

test('deleting a node removes image wires, scalar wires and terminal mappings together', () => {
  const g = chained();
  const withoutScale = deleteNode(g, 'scale');
  expect(withoutScale.signalEdges).toEqual([]);
  expect(withoutScale.modulations).toHaveLength(2); // terminal mappings survive an upstream deletion
  const withoutShape = deleteNode(g, 'shape');
  expect(withoutShape.modulations).toEqual([]);
  expect(withoutShape.signalEdges).toHaveLength(1);
  const withoutTint = deleteNode(g, 'tint');
  expect(withoutTint.edges).toEqual([]);
  expect(withoutTint.modulations).toEqual([]);
  expect(withoutTint.signalEdges).toHaveLength(3);
  expect(deleteNode(g, 'output')).toEqual(g);
});

test('math nodes use literal defaults when disconnected and never produce NaN', () => {
  const read = values => port => values[port] ?? null;
  const node = op => ({ type: 'math', op, a: 2, b: 8, c: 5 });
  expect(mathValue(node('add'), read({}))).toBe(10);
  expect(mathValue(node('subtract'), read({}))).toBe(-6);
  expect(mathValue(node('multiply'), read({}))).toBe(16);
  expect(mathValue(node('divide'), read({}))).toBe(.25);
  expect(mathValue(node('min'), read({}))).toBe(2);
  expect(mathValue(node('max'), read({}))).toBe(8);
  expect(mathValue(node('clamp'), read({}))).toBe(5);
  expect(mathValue(node('abs'), read({ a: -3 }))).toBe(3);
  expect(mathValue(node('add'), read({ a: 1.5, b: -2.25 }))).toBe(-.75); // wires beat literals, signs kept
  expect(mathValue({ ...node('add'), a: NaN, b: 3 }, read({ a: NaN }))).toBe(MATH_LITERALS.a + 3);
  expect(mathValue(node('divide'), read({ a: 4, b: 0 }))).toBe(0);
  expect(mathIssue(node('divide'), read({ b: 0 }))).toMatch(/division by zero/);
  expect(mathIssue(node('divide'), read({ b: 2 }))).toBe(null);
  expect(mathIssue(node('add'), read({}))).toBe(null);
  expect(mathValue({ ...node('multiply'), a: 1e308, b: 1e308 }, read({}))).toBe(Infinity); // the runtime clamps non-finite output
});

test('the script language is a restricted expression, not JavaScript', () => {
  const ok = text => expect(compileExpression(text).ok, text).toBe(true);
  const bad = (text, message) => {
    const result = compileExpression(text);
    expect(result.ok, text).toBe(false);
    if (message) expect(result.error).toMatch(message);
  };
  for (const text of ['x', 'x * 2 + 0.5', '-y', 'time', 'sin(time) * 2', 'clamp(x, -1, 1)', 'lerp(x, y, 0.5)', 'pow(x, 2) % 3', 'pi * x']) ok(text);
  bad('', /empty/i);
  bad('x; y', /single expression/i);
  bad('const a = 1', /single expression/i);
  bad('x = 2', /Assignments/i);
  bad('x++', /Assignments/i);
  bad('window.location', /Property access/i);
  bad('x.__proto__', /Property access/i);
  bad('alert(1)', /math functions/i);
  bad('fetch("x")', /math functions/i);
  bad('new Date()', /not allowed/i);
  bad('(() => 1)()', /math functions|not allowed/i);
  bad('[1,2].map(x)', /math functions|Property access/i);
  bad('a + 1', /Unknown name/i);
  bad('sin(x, y, 1, 2)', /at most 3 arguments/i);
  bad('x'.repeat(257), /256 characters/i);
  bad(Array.from({ length: 40 }, () => 'x').join('+'), /too complex|too deep/i);
  bad(`${'('.repeat(14)}x`, /deep|Syntax/i);
  expect(compileExpression('x + time').uses).toEqual({ x: true, y: false, time: true });
  expect(evaluateExpression(compileExpression('clamp(x * 2, -1, 1)').ast, { x: 1.5 })).toBe(1);
  const zero = [];
  expect(evaluateExpression(compileExpression('1 / 0').ast, {}, zero)).toBe(0);
  expect(zero).toEqual(['division by zero → 0']);
  // A nested zero divisor is reported; the node-level fallback (scriptValue)
  // zeroes the whole output instead of leaking the partial 1.
  const nested = [];
  expect(evaluateExpression(compileExpression('1 + x / 0').ast, { x: 4 }, nested)).toBe(1);
  expect(nested).toEqual(['division by zero → 0']);
  expect(() => evaluateExpression(compileExpression('log(-1)').ast, {})).toThrow(/non-finite/);
  expect(() => evaluateExpression(compileExpression('x + 1').ast, { x: NaN })).toThrow(/finite/);
});

test('image wires never reach scalar inputs and colour parameters are validated against their definitions', () => {
  const g = chained();
  expect(() => validateGraph({ ...g, edges: [...g.edges, { from: 'base', to: 'scale', port: 'a' }] })).toThrow(/port/);
  expect(() => validateGraph({ ...g, edges: [...g.edges, { from: 'tint', to: 'shape', port: 'x' }] })).toThrow(/port/);
  expect(() => validateGraph({ ...g, edges: [...g.edges, { from: 'base', to: 'scale', port: 'image' }] })).toThrow(/port/);
  // Scalar inputs carry signal wires only; an image wire can never occupy one.
  expect(() => validateGraph({ ...g, signalEdges: [{ from: 'base', to: 'scale', port: 'a' }] })).toThrow(/signal/);
  expect(() => connect(g, 'base', 'scale', 'a')).toThrow(/port/);
  const withColor = params => ({ ...g, nodes: g.nodes.map(n => n.id === 'tint' ? { ...n, params } : n) });
  for (const params of [{ body: 1 }, { saturation: 'x' }, { saturation: 3 }, { hue: 999 }, { brightness: NaN }, [], 7, null]) {
    expect(() => validateGraph(withColor(params))).toThrow(/color parameter/);
  }
  // Omitted fields fall back to the documented identity defaults.
  expect(validateGraph(withColor({ brightness: .25 })).nodes.find(n => n.id === 'tint').params)
    .toEqual({ saturation: 1, brightness: .25, contrast: 1, hue: 0 });
  expect(validateGraph(withColor({ saturation: 2, brightness: 0, contrast: 2, hue: -180 })).nodes.find(n => n.id === 'tint').params)
    .toEqual({ saturation: 2, brightness: 0, contrast: 2, hue: -180 });
});

test('script sources are approved per exact text, outside the exported graph', () => {
  clearApprovals();
  expect(isExpressionApproved('x * 2')).toBe(false);
  approveExpression('x * 2');
  expect(isExpressionApproved('x * 2')).toBe(true);
  expect(isExpressionApproved('x * 3')).toBe(false); // one character invalidates approval
  expect(isExpressionApproved('x*2')).toBe(false); // exact text only, no normalization
  expect(isExpressionApproved('x'.repeat(257))).toBe(false);
  expect(() => approveExpression('')).toThrow(/1–256/);
  expect(() => approveExpression('x'.repeat(257))).toThrow(/1–256/);
  expect(expressionHash('x * 2')).not.toBe(expressionHash('x * 3'));
  // The approval store is bounded: the oldest entries are dropped.
  for (let i = 0; i < 70; i++) approveExpression(`x + ${i}`);
  expect(isExpressionApproved('x + 1')).toBe(false);
  expect(isExpressionApproved('x + 69')).toBe(true);
  revokeExpression('x + 69');
  expect(isExpressionApproved('x + 69')).toBe(false);
  clearApprovals();
  const g = chained();
  const text = serializeGraph(g, manifestFor(g, []));
  expect(text).not.toMatch(/approv|trust/i); // no trust flag travels with the file
  expect(parseGraph(text).graph).toEqual(g);
});

test('script values fall back safely and report errors instead of NaN', () => {
  clearApprovals();
  const cache = new Map();
  approveExpression('x / 2');
  const node = { type: 'script', source: 'x / 2', inputX: 0, inputY: 0 };
  expect(scriptValue(node, { readInput: port => port === 'x' ? 3 : null }, cache)).toEqual({ value: 1.5, error: null, uses: { x: true, y: false, time: false }, language: 'expression' });
  expect(scriptValue(node, {}, cache).value).toBe(0); // unwired x uses its literal
  expect(scriptValue({ ...node, source: 'sqrt(x)' }, { readInput: () => -4 }, cache)).toMatchObject({ value: 0 });
  expect(scriptValue({ ...node, source: 'window.x' }, {}, cache)).toMatchObject({ value: 0 });
  expect(scriptValue({ ...node, source: 'x' }, { readInput: () => 2, time: 0 }, cache).value).toBe(2);
  // A zero divisor zeroes the whole node output and reports it.
  approveExpression('1 + x / 0');
  expect(scriptValue({ type: 'script', source: '1 + x / 0', inputX: 0, inputY: 0 }, { readInput: () => 4 }, cache))
    .toEqual({ value: 0, error: 'Script: division by zero → 0.', uses: { x: true, y: false, time: false }, language: 'expression' });
  approveExpression('x % 0');
  expect(scriptValue({ type: 'script', source: 'x % 0', inputX: 2, inputY: 0 }, {}, cache)).toMatchObject({ value: 0, error: 'Script: modulo by zero → 0.' });
  // Recovery: a repaired expression reports nothing.
  approveExpression('x + 1');
  expect(scriptValue({ type: 'script', source: 'x + 1', inputX: 0, inputY: 0 }, { readInput: () => 4 }, cache))
    .toEqual({ value: 5, error: null, uses: { x: true, y: false, time: false }, language: 'expression' });
});

test('terminal mappings convert a custom signal input range and keep the legacy 0..1 default', () => {
  expect(mappedValue({ min: 0, max: 1 }, .127, OPACITY)).toBe(.13);
  expect(mappedValue({ min: -100, max: 100 }, 1, OPACITY)).toBe(1);
  expect(mappedValue({ min: .1, max: .7, inputMin: 0, inputMax: 3 }, 1.5, OPACITY)).toBe(.4);
  expect(mappedValue({ min: .1, max: .7, inputMin: 0, inputMax: 3 }, 9, OPACITY)).toBe(.7);
  expect(mappedValue({ min: .1, max: .7, inputMin: 0, inputMax: 4 }, -2, OPACITY)).toBe(.1);
  expect(mappedValue({ min: .7, max: .1, inputMin: 0, inputMax: 2 }, 1, OPACITY)).toBe(.4);
  const g = chained(), before = JSON.stringify(g), sketches = [{ id: 'solid-color', params: COLOR_PARAMS }];
  const tint = g.nodes.find(n => n.id === 'tint');
  const view = parameterView(g, tint, sketches, () => ({}), () => 1.5);
  expect(view.brightness).toBe(.4);
  expect(view.contrast).toBe(1);
  expect(view.hue).toBe(0);
  expect(JSON.stringify(g)).toBe(before); // bases are never mutated
  // A runtime without a scalar reader simply leaves the stored base in place.
  expect(parameterView(g, tint, sketches, () => ({})).brightness).toBe(.5);
  expect(numeric(COLOR_PARAMS[0])).toBe(true);
  expect(numeric({ ...COLOR_PARAMS[0], options: [] })).toBe(false);
});

test('serialization keeps legacy graphs identical and rejects unknown versions', () => {
  const legacy = visual();
  const deps = manifestFor(legacy, [{ id: 'solid-color', name: 'Solid Color', params: COLOR_PARAMS }]);
  expect(parseGraph(serializeGraph(legacy, deps)).graph).toEqual(legacy);
  expect(() => parseGraph('{"format":"viz2-nodes","version":9}')).toThrow(/Unsupported/);
  const g = chained();
  const manifest = manifestFor(g, [{ id: 'solid-color', name: 'Solid Color', params: COLOR_PARAMS }]);
  const parsed = parseGraph(serializeGraph(g, manifest)).graph;
  expect(parsed.signalEdges).toEqual(g.signalEdges);
  expect(parsed.nodes.find(n => n.id === 'scale')).toEqual({ id: 'scale', type: 'math', x: 240, y: 300, op: 'multiply', a: 0, b: 8, c: 1 });
  expect(parsed.nodes.find(n => n.id === 'shape')).toEqual({ id: 'shape', type: 'script', x: 440, y: 300, source: 'x / 2 + y * 0', inputX: 0, inputY: 0 });
  expect(parsed.modulations[1]).toEqual({ from: 'shape', to: 'tint', param: 'saturation', min: .2, max: .8 });
  expect(defaultNode('color').params).toEqual({ saturation: 1, brightness: 1, contrast: 1, hue: 0 });
  expect(defaultNode('math')).toMatchObject({ op: 'add', a: 0, b: 0, c: 1 });
  expect(defaultNode('script')).toMatchObject({ language: 'body', source: 'return x;', inputX: 0, inputY: 0 });
});

const useGraph = async (page, data) => page.evaluate(async graph => {
  FileSystemHandle.prototype.queryPermission = async () => 'granted';
  FileSystemHandle.prototype.requestPermission = async () => 'granted';
  const { SKETCHES } = await import('/src/sketch-registry.js');
  const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
  const { approveScript } = await import('/src/nodes/script-approval.js');
  for (const n of graph.nodes) if (n.type === 'script') approveScript(n.language ?? 'expression', n.source);
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scalar-tests', { create: true });
  const file = await dir.getFileHandle('scalar.nodes.json', { create: true });
  const writer = await file.createWritable(); await writer.write(serializeGraph(graph, manifestFor(graph, SKETCHES))); await writer.close();
  window.showDirectoryPicker = async () => dir;
  const { nodePatterns } = await import('/src/nodes/repository.js');
  await nodePatterns.link();
  return (await nodePatterns.open('scalar.nodes.json')).id;
}, data);

test('colour nodes render real pixels: identity, adjustments, alpha and chaining', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime, applyColor, colorFilter } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const make = (width, height, draw) => { const c = document.createElement('canvas'); c.width = width; c.height = height; draw(c.getContext('2d'), c); return c; };
    const pixel = (c, x = 10, y = 10) => [...c.getContext('2d').getImageData(x, y, 1, 1).data];
    const noop = () => {};
    const source = make(64, 64, ctx => { ctx.fillStyle = 'rgba(200, 100, 50, 0.5)'; ctx.fillRect(0, 0, 64, 64); });
    const read = (params, from = source) => { const out = make(64, 64, noop); applyColor(out.getContext('2d'), from, params); return pixel(out); };
    const identity = read({ saturation: 1, brightness: 1, contrast: 1, hue: 0 });
    const lowered = read({ saturation: 1, brightness: .5, contrast: 1, hue: 0 });
    const gray = read({ saturation: 0, brightness: 1, contrast: 1, hue: 0 });
    const shifted = read({ saturation: 1, brightness: 1, contrast: 1, hue: 120 });
    const chain = make(64, 64, noop);
    applyColor(chain.getContext('2d'), source, { saturation: 1, brightness: 1, contrast: 1, hue: 0 });
    const chainedPixel = read({ saturation: 1, brightness: .5, contrast: 1, hue: 0 }, chain);
    const empty = read({ saturation: 1, brightness: 1, contrast: 1, hue: 0 }, null);
    const graph = { version: 1, name: 'pixels', nodes: [
      { id: 'base', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .5, pulse: 0 }, x: 0, y: 0 },
      { id: 'tint', type: 'color', params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 }, x: 0, y: 0 },
      { id: 'output', type: 'output', x: 0, y: 0 },
    ], edges: [{ from: 'base', to: 'tint', port: 'image' }, { from: 'tint', to: 'output', port: 'image' }] };
    const identityRuntime = new GraphRuntime({ graph, sketches: SKETCHES }); await identityRuntime.ready;
    const identityPixels = pixel(identityRuntime.render(), 20, 20);
    const basePixels = pixel(identityRuntime.buffers.get('base'), 20, 20);
    identityRuntime.dispose();
    graph.nodes[1].params = { saturation: 1, brightness: .25, contrast: 1, hue: 0 };
    const dimmed = new GraphRuntime({ graph, sketches: SKETCHES }); await dimmed.ready;
    const dimmedPixels = pixel(dimmed.render(), 20, 20);
    dimmed.resize(320, 180);
    const resized = [dimmed.render().width, dimmed.render().height];
    const emptyColor = new GraphRuntime({ graph: { ...graph, edges: [{ from: 'tint', to: 'output', port: 'image' }] }, sketches: SKETCHES });
    await emptyColor.ready;
    const emptyPixels = pixel(emptyColor.render(), 20, 20);
    emptyColor.dispose();
    dimmed.dispose();
    return { sourcePixels: pixel(source), identity, lowered, gray, shifted, chainedPixel, empty, identityPixels, basePixels, dimmedPixels, emptyPixels, resized, filters: [colorFilter({}), colorFilter({ brightness: .5 })] };
  });
  expect(result.identity).toEqual(result.sourcePixels); // exact copy, alpha preserved
  expect(result.empty).toEqual([0, 0, 0, 0]);
  expect(result.filters[0]).toBe('none');
  expect(result.filters[1]).toContain('brightness(0.5)');
  expect(result.lowered[0]).toBeLessThan(result.identity[0]);
  expect(result.lowered[0]).toBeGreaterThan(result.identity[0] / 4);
  expect(result.lowered[3]).toBe(128); // filter adjusts colour, never alpha
  expect(result.gray[0]).toBe(result.gray[1]);
  expect(result.gray[1]).toBe(result.gray[2]);
  expect(result.shifted[0]).not.toBe(result.identity[0]);
  expect(result.shifted[3]).toBe(128);
  expect(result.chainedPixel).toEqual(result.lowered);
  expect(result.identityPixels).toEqual(result.basePixels);
  expect(result.emptyPixels).toEqual([0, 0, 0, 0]);
  expect(result.dimmedPixels[0]).toBeLessThan(result.basePixels[0]);
  expect(result.resized).toEqual([320, 180]);
});

test('scalar DAG evaluates once per frame with fanout, signed floats and visible errors', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async graph => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { approveExpression } = await import('/src/nodes/script-approval.js');
    approveExpression('x / 2 + y * 0');
    const store = { upsertSlot() {}, retireSlots() {}, createBinding: () => ({ read: () => ({ continuous: { bass: 1.2 } }), noteDraw() {}, setEventDeliveryEnabled() {} }) };
    const runtime = new GraphRuntime({ graph, sketches: SKETCHES, context: { audioControlStore: store } });
    await runtime.ready;
    let calls = 0;
    const native = runtime.computeSignal.bind(runtime);
    runtime.computeSignal = (id, visiting) => { calls++; return native(id, visiting); };
    const params = runtime.params.get('tint');
    const values = [runtime.signalValue('scale'), runtime.signalValue('shape'), params.brightness, params.saturation];
    const base = { ...graph.nodes.find(n => n.id === 'tint').params };
    runtime.render();
    const before = calls;
    for (let i = 0; i < 4; i++) { params.brightness; params.saturation; }
    const perRead = (calls - before) / 8;
    const diagnostics = runtime.getDiagnostics();
    const pixels = [...runtime.render().getContext('2d').getImageData(20, 20, 1, 1).data];
    runtime.dispose();
    return { values, base, perRead, diagnostics, pixels };
  }, chained());
  // audio 1.2 → response() 0.375 → ×8 = 3 → ÷2 = 1.5 → input range 0…3 → brightness .4
  expect(result.values[0]).toBeCloseTo(3, 6);
  expect(result.values[1]).toBeCloseTo(1.5, 6);
  expect(result.values[2]).toBe(.4);
  expect(result.values[3]).toBe(.8);
  // Fanout reads the same frame memo: one signal lookup per parameter read.
  expect(result.perRead).toBe(1);
  expect(result.base).toEqual({ saturation: 1, brightness: .5, contrast: 1, hue: 0 });
  expect(result.diagnostics).toEqual([]);
  expect(result.pixels[3]).toBe(255);
});

test('unapproved, broken and divide-by-zero signals stay finite, visible and recoverable', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { approveExpression, clearApprovals } = await import('/src/nodes/script-approval.js');
    clearApprovals();
    const store = { upsertSlot() {}, retireSlots() {}, createBinding: () => ({ read: () => ({ continuous: { bass: 1.2 } }), noteDraw() {}, setEventDeliveryEnabled() {} }) };
    const graph = (source, divisor) => ({ version: 1, name: 'guards', nodes: [
      { id: 'source', type: 'audio', band: 'bass', x: 0, y: 0 },
      { id: 'divide', type: 'math', op: 'divide', a: 0, b: divisor, c: 1, x: 0, y: 0 },
      { id: 'shape', type: 'script', source, inputX: 0, inputY: 0, x: 0, y: 0 },
      { id: 'tint', type: 'color', params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 }, x: 0, y: 0 },
      { id: 'base', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .5, pulse: 0 }, x: 0, y: 0 },
      { id: 'output', type: 'output', x: 0, y: 0 },
    ], edges: [{ from: 'base', to: 'tint', port: 'image' }, { from: 'tint', to: 'output', port: 'image' }],
      signalEdges: [{ from: 'source', to: 'divide', port: 'a' }, { from: 'divide', to: 'shape', port: 'x' }],
      modulations: [{ from: 'shape', to: 'tint', param: 'brightness', min: 0, max: 1 }] });
    const run = async (source, divisor) => {
      const runtime = new GraphRuntime({ graph: graph(source, divisor), sketches: SKETCHES, context: { audioControlStore: store } });
      await runtime.ready;
      const value = runtime.signalValue('shape');
      const mapped = runtime.params.get('tint').brightness;
      const diagnostics = runtime.getDiagnostics();
      const pixel = [...runtime.render().getContext('2d').getImageData(20, 20, 1, 1).data];
      runtime.dispose();
      return { value, mapped, diagnostics, finite: Number.isFinite(value) && Number.isFinite(mapped), pixel };
    };
    const unapproved = await run('x / 2', 4);
    approveExpression('x / 2');
    const approved = await run('x / 2', 4);
    const divideZero = await run('x / 2', 0);
    approveExpression('window.location');
    const forbidden = await run('window.location', 4);
    const repaired = await run('x / 2', 4);
    return { unapproved, approved, divideZero, forbidden, repaired };
  });
  expect(result.unapproved.value).toBe(0);
  expect(result.unapproved.mapped).toBe(0);
  expect(result.unapproved.diagnostics.join(' ')).toMatch(/not approved/i);
  // 0.375 / 4 = 0.09375 → /2 → 0.047 → stepped into the parameter range.
  expect(result.approved.value).toBeCloseTo(.046875, 6);
  expect(result.approved.mapped).toBe(.05);
  expect(result.approved.diagnostics).toEqual([]);
  expect(result.approved.finite).toBe(true);
  // Division by zero is reported and mapped to zero instead of NaN.
  expect(result.divideZero.value).toBe(0);
  expect(result.divideZero.mapped).toBe(0);
  expect(result.divideZero.diagnostics.join(' ')).toMatch(/division by zero/);
  expect(result.divideZero.finite).toBe(true);
  expect(result.divideZero.pixel[3]).toBe(255);
  // Even an explicitly re-approved forbidden expression never executes: the parser rejects it.
  expect(result.forbidden.diagnostics.join(' ')).toMatch(/Script:/);
  expect(result.forbidden.finite).toBe(true);
  expect(result.repaired.value).toBeCloseTo(.046875, 6);
  expect(result.repaired.diagnostics).toEqual([]);
});

test('editor creates, wires, maps, saves and reloads Color, Math and Script nodes', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto('/?role=nodes');
  const id = await useGraph(page, scalar());
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue('Scalar chain');
  await expect(page.locator('.nodes-node')).toHaveCount(6);
  await expect(page.locator('.nodes-signal-wire')).toHaveCount(3);
  // Colour node: shared numeric controls plus the identity description.
  await page.getByRole('button', { name: 'Select Color', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Color', exact: true })).toBeVisible();
  await page.getByRole('slider', { name: 'Brightness', exact: true }).evaluate(el => { el.value = '0.2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.getByRole('slider', { name: 'Brightness', exact: true })).toHaveValue('0.2');
  // Math node: operation, literals and the live readout.
  await page.getByRole('button', { name: 'Select Math · multiply', exact: true }).click();
  await page.getByLabel('Math operation').selectOption('add');
  await expect(page.getByRole('button', { name: 'Select Math · add', exact: true })).toHaveCount(1);
  await page.getByLabel('Math b literal').fill('4');
  await expect(page.getByTestId('node-signal-readout')).toContainText('Output');
  // Script node: invalid expressions are reported and cannot be applied.
  await page.getByRole('button', { name: 'Select Script', exact: true }).click();
  await expect(page.getByLabel('Script language')).toHaveValue('expression');
  await page.getByLabel('Script source').fill('window.location');
  await expect(page.getByTestId('script-status')).toHaveText('Not applied');
  await expect(page.getByRole('alert')).toContainText('Property access is not allowed');
  await expect(page.getByRole('button', { name: 'Apply script' })).toBeDisabled();
  await page.getByLabel('Script source').fill('x / 2 + y * 0');
  await page.getByRole('button', { name: 'Apply script' }).click();
  await expect(page.getByTestId('script-status')).toContainText('Applied and approved');
  await expect(page.getByTestId('script-status')).toContainText('x, y');
  // Map the scalar output by dragging its connected-signal chip onto the slider,
  // then edit the custom signal input range inside the collapsed settings.
  await page.getByLabel('shape output', { exact: true }).click();
  await page.getByLabel('tint signal endpoint', { exact: true }).click();
  await expect(page.locator('.nodes-signal-chip')).toHaveCount(1);
  await page.locator('.nodes-signal-chip').dragTo(page.getByRole('slider', { name: 'Brightness', exact: true }));
  const settings = page.getByRole('button', { name: 'Brightness mapping settings' });
  await expect(settings).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Brightness Signal in min', { exact: true })).toHaveCount(0);
  await settings.click();
  await expect(settings).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Brightness Signal in min', { exact: true })).toHaveValue('0');
  await page.getByLabel('Brightness Signal in max', { exact: true }).fill('3');
  await expect(page.getByTestId('mapping-live-brightness')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Brightness', exact: true })).toBeDisabled();
  await page.screenshot({ path: '/tmp/nodes-scalar-editor.png' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.locator('.nodes-status')).toHaveCount(0);
  const saved = await page.evaluate(async id => (await import('/src/nodes/repository.js')).nodePatterns.load(id).then(r => r.graph), id);
  expect(saved.signalEdges).toEqual(scalar().signalEdges);
  expect(saved.nodes.find(n => n.id === 'scale')).toMatchObject({ op: 'add', b: 4 });
  expect(saved.nodes.find(n => n.id === 'shape').source).toBe('x / 2 + y * 0');
  expect(saved.modulations).toEqual([{ from: 'shape', to: 'tint', param: 'brightness', min: .2, max: .7, inputMin: 0, inputMax: 3 }]);
  expect(saved.nodes.find(n => n.id === 'tint').params.brightness).toBe(.2);
  // Reload restores graph, nodes and the approval bound to the exact source.
  await page.reload();
  await expect(page.locator('.nodes-node')).toHaveCount(6);
  await page.getByRole('button', { name: 'Select Script', exact: true }).click();
  await expect(page.getByTestId('script-status')).toContainText('Applied and approved');
  // Deleting the middle Math node removes the three scalar wires that touch it.
  await page.getByRole('button', { name: 'Select Math · add', exact: true }).click();
  await page.getByRole('button', { name: 'Delete node', exact: true }).click();
  await expect(page.locator('.nodes-node')).toHaveCount(5);
  await expect(page.locator('.nodes-signal-wire')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a disk-loaded script source must be reviewed in this browser before it runs', async ({ page }) => {
  await page.goto('/?role=nodes');
  const id = await page.evaluate(async graph => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const { clearApprovals } = await import('/src/nodes/script-approval.js');
    clearApprovals();
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scalar-review', { create: true });
    const file = await dir.getFileHandle('review.nodes.json', { create: true });
    const writer = await file.createWritable(); await writer.write(serializeGraph(graph, manifestFor(graph, SKETCHES))); await writer.close();
    window.showDirectoryPicker = async () => dir;
    const { nodePatterns } = await import('/src/nodes/repository.js');
    await nodePatterns.link();
    return (await nodePatterns.open('review.nodes.json')).id;
  }, chained());
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.locator('.nodes-diagnostics')).toContainText('not approved');
  await page.getByRole('button', { name: 'Select Script', exact: true }).click();
  await expect(page.getByTestId('script-status')).toContainText('review required');
  await page.getByRole('button', { name: 'Apply script' }).click();
  await expect(page.getByTestId('script-status')).toContainText('Applied and approved');
  await expect(page.locator('.nodes-diagnostics')).not.toContainText('not approved');
  expect(await page.evaluate(async () => (await import('/src/nodes/script-approval.js')).isScriptApproved('expression', 'x / 2 + y * 0'))).toBe(true);
});
