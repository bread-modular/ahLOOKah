// Blend modes (TouchDesigner's Composite TOP operation list) and the Transform
// image node: the stored contract, the geometry, the shader table and the rendered
// pixels. Pure table/validation/math checks run in Node; pixels run in the editor
// preview (real Canvas2D plus the shared WebGL2 compositor).
import { test, expect } from '@playwright/test';
import { MODES, MODE_NAMES, NATIVE_MODES, EXTENDED_MODES, isExtendedMode, isNativeMode, canvasOperation, blendFragmentSource, blendModeIndex } from '../src/nodes/blend-modes.js';
import { validateGraph, newGraph, connect, readPaletteDrag, DRAG_TYPE } from '../src/nodes/model.js';
import { TYPES, VISUAL_TYPES, VISUAL_SOURCES, MODULATION_TARGETS, parameters, defaultNode, inputs, activeInputs, isVisualSource, isModulationTarget } from '../src/nodes/definitions.js';
import { TRANSFORM_PARAMS, transformDefaults, isIdentityTransform, transformMatrix, projectedQuad, CAMERA_Z, MOVE_Z_MAX } from '../src/nodes/transform.js';
import { definitions } from '../src/nodes/modulation.js';
import { manifestFor, serializeGraph, parseGraph } from '../src/nodes/portability.js';

test.use({ launchOptions: { args: [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
] } });

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    window.__permission = 'granted'; window.__requestPermission = 'granted';
    FileSystemHandle.prototype.queryPermission = async () => window.__permission;
    FileSystemHandle.prototype.requestPermission = async () => { window.__permission = window.__requestPermission; return window.__permission; };
  });
  context.on('page', page => page.on('dialog', dialog => dialog.accept()));
});

const solid = (id, hue, x = 40, y = 0) => ({ id, type: 'pattern', patternId: 'solid-color', x, y, params: { hue, saturation: 1, brightness: 1, pulse: 0 } });
const blendNode = (id, mode, opacity = 1) => ({ id, type: 'blend', x: 300, y: 0, mode, opacity });
const audioNode = { id: 'band', type: 'audio', x: 300, y: 240, band: 'bass', deviceId: null, channel: 'mono' };
const out = { id: 'output', type: 'output', x: 620, y: 0 };
// Local stand-ins for the two built-ins a graph needs: an ordinary source and an
// image-input FX capability (only the latter may receive a picture).
const SKETCHES = [{ id: 'solid-color', name: 'Solid color', params: [] }, { id: 'effect', name: 'Effect', fx: { input: 'image' }, params: [] }];

// ---------------------------------------------------------------------------
// Mode table, validation and shader generation (no browser needed)
// ---------------------------------------------------------------------------

test('blend table names TouchDesigner modes, separates canvas from shader work, and validates every name', () => {
  expect(MODE_NAMES).toEqual(Object.keys(MODES));
  expect(MODE_NAMES).toHaveLength(Object.keys(NATIVE_MODES).length + Object.keys(EXTENDED_MODES).length);
  for (const mode of Object.keys(NATIVE_MODES)) {
    expect(isNativeMode(mode)).toBe(true);
    expect(isExtendedMode(mode)).toBe(false);
    expect(MODES[mode]).toBe(NATIVE_MODES[mode]);
  }
  for (const mode of Object.keys(EXTENDED_MODES)) {
    expect(isExtendedMode(mode)).toBe(true);
    expect(isNativeMode(mode)).toBe(false);
    expect(MODES[mode]).toBeNull();
    expect(blendModeIndex(mode)).toBeGreaterThan(0);
  }
  // The modes the graph has always supported keep their exact canvas operations.
  expect(NATIVE_MODES).toMatchObject({ Normal: 'source-over', Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay', Difference: 'difference', Add: 'lighter' });
  const operations = new Set(['source-over', 'lighter', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'destination-over', 'source-atop', 'destination-atop', 'xor', 'hue', 'saturation', 'color', 'luminosity']);
  for (const operation of Object.values(NATIVE_MODES)) expect(operations.has(operation)).toBe(true);
  // The TouchDesigner operations this feature set out to match.
  for (const mode of ['Subtract', 'Divide', 'Average', 'Linear Burn', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix', 'Negate', 'Reflect', 'Glow', 'Freeze', 'Heat', 'Darker Color', 'Lighter Color', 'Under', 'Inside', 'Outside', 'Xor'])
    expect(MODES, mode).toHaveProperty(mode);
  // An unknown or mis-cased mode never renders as something else silently.
  expect(canvasOperation('Multiply')).toBe('multiply');
  expect(canvasOperation('Hard Mix')).toBe('source-over');
  expect(canvasOperation('not-a-mode')).toBe('source-over');
  // One shader branch per shader mode, keyed by the same 1-based index.
  const shader = blendFragmentSource();
  expect(shader).toContain('uniform int uMode');
  expect(shader).toContain('float luma(vec3 c)');
  Object.keys(EXTENDED_MODES).forEach((mode, index) => {
    expect(shader).toContain(`if (uMode == ${index + 1}) return ${EXTENDED_MODES[mode]};`);
    expect(blendModeIndex(mode)).toBe(index + 1);
  });
});

test('a blend node accepts every mode name, rejects unknown modes, and maps opacity only', () => {
  const base = mode => ({ version: 1, name: 'modes', nodes: [solid('base', 0), solid('layer', 1 / 3), blendNode('mix', mode), out],
    edges: [{ from: 'base', to: 'mix', port: 'base' }, { from: 'layer', to: 'mix', port: 'layer' }, { from: 'mix', to: 'output', port: 'image' }] });
  for (const mode of MODE_NAMES) expect(validateGraph(base(mode)).nodes.find(n => n.id === 'mix').mode).toBe(mode);
  for (const bad of ['screen', 'MULTIPLY', 'Over ', 'Phoenix', '', 7, null])
    expect(() => validateGraph(base(bad))).toThrow(/blend mode/);
  expect(defaultNode('blend')).toMatchObject({ mode: 'Normal', opacity: 1 });
  const mapped = validateGraph({ ...base('Normal'), nodes: [...base('Normal').nodes, audioNode], modulations: [{ from: 'band', to: 'mix', param: 'opacity', min: 0, max: 1 }] });
  expect(mapped.modulations[0].param).toBe('opacity');
  expect(() => validateGraph({ ...base('Normal'), nodes: [...base('Normal').nodes, audioNode], modulations: [{ from: 'band', to: 'mix', param: 'mode', min: 0, max: 1 }] })).toThrow(/modulation parameter/);
});

// ---------------------------------------------------------------------------
// Transform node contract: definitions, ports, validation, palette, persistence
// ---------------------------------------------------------------------------

test('transform is a first-class image node in every shared contract', () => {
  expect(TYPES).toContain('transform');
  expect(VISUAL_TYPES).toContain('transform');
  expect(VISUAL_SOURCES).toContain('transform');
  expect(MODULATION_TARGETS).toContain('transform');
  expect(inputs({ type: 'transform' })).toEqual(['image']);
  expect(activeInputs({ type: 'transform' })).toEqual(['image']);
  expect(isVisualSource({ type: 'transform' })).toBe(true);
  expect(isModulationTarget({ type: 'transform' })).toBe(true);
  const node = defaultNode('transform', 10, 20);
  expect(node).toMatchObject({ type: 'transform', x: 10, y: 20 });
  expect(isIdentityTransform(node.params)).toBe(true);
  const defs = definitions(node, []);
  expect(defs).toEqual(parameters(node));
  expect(defs.map(d => d.key)).toEqual(['moveX', 'moveY', 'moveZ', 'scaleX', 'scaleY', 'scaleZ', 'rotateX', 'rotateY', 'rotateZ']);
  expect(defs.map(d => d.default)).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0]);
  for (const def of defs) {
    expect(Number.isFinite(def.min) && Number.isFinite(def.max) && Number.isFinite(def.step)).toBe(true);
    expect(def.max).toBeGreaterThan(def.min);
    expect(def.step).toBeGreaterThan(0);
    expect(def.label.length).toBeGreaterThan(0);
  }
  expect(parameters({ type: 'color' })).not.toEqual(defs);
  expect(parameters({ type: 'audio' })).toEqual([]);
});

test('transform graphs validate, wire in both directions, and round-trip through a file', () => {
  const graph = () => ({ version: 1, name: 'transform', nodes: [solid('src', 0), defaultNode('transform', 300, 0, 'move'), out],
    edges: [{ from: 'src', to: 'move', port: 'image' }, { from: 'move', to: 'output', port: 'image' }] });
  const valid = validateGraph(graph());
  expect(valid.nodes.find(n => n.id === 'move').params).toEqual(transformDefaults());
  // A transform can feed a Blend, a Color filter, another transform or an FX pattern.
  const chained = validateGraph({ ...graph(), nodes: [...graph().nodes, blendNode('mix', 'Screen')],
    edges: [{ from: 'src', to: 'mix', port: 'base' }, { from: 'move', to: 'mix', port: 'layer' }, { from: 'mix', to: 'output', port: 'image' }] });
  expect(chained.edges).toHaveLength(3);
  const withFx = validateGraph({ ...graph(), nodes: [...graph().nodes, { id: 'fx', type: 'pattern', patternId: 'effect', x: 0, y: 0, params: {} }] });
  expect(connect(withFx, 'move', 'fx', 'image', { sketches: SKETCHES }).edges).toContainEqual({ from: 'move', to: 'fx', port: 'image' });
  expect(() => connect(withFx, 'move', 'src', 'image', { sketches: SKETCHES })).toThrow(/FX-capable/);
  // Two transforms in a row cannot be wired into a cycle.
  const chain = validateGraph({ ...graph(), nodes: [...graph().nodes, defaultNode('transform', 460, 0, 'again')],
    edges: [{ from: 'src', to: 'again', port: 'image' }, { from: 'again', to: 'move', port: 'image' }, { from: 'move', to: 'output', port: 'image' }] });
  expect(() => connect(chain, 'move', 'again', 'image', { sketches: SKETCHES })).toThrow(/cycle/);
  expect(() => validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'move' ? { ...n, params: { spin: 1 } } : n) })).toThrow(/transform parameter: spin/);
  expect(() => validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'move' ? { ...n, params: { moveZ: MOVE_Z_MAX + 0.1 } } : n) })).toThrow(/moveZ/);
  expect(() => validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'move' ? { ...n, params: { rotateX: 'x' } } : n) })).toThrow(/rotateX/);
  expect(() => validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'move' ? { ...n, params: [] } : n) })).toThrow(/transform parameters/);
  // A partial parameter set is completed with identity defaults, never rejected.
  const partial = validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'move' ? { ...n, params: { moveX: 0.5 } } : n) });
  expect(partial.nodes.find(n => n.id === 'move').params).toEqual({ ...transformDefaults(), moveX: 0.5 });
  // Every transform slider is a modulation target.
  const mapped = validateGraph({ ...graph(), nodes: [...graph().nodes, audioNode], modulations: [{ from: 'band', to: 'move', param: 'rotateZ', min: -180, max: 180 }] });
  expect(mapped.modulations[0]).toMatchObject({ param: 'rotateZ', min: -180, max: 180 });
  // Save/reload keeps the node and its nine values exactly; a fresh graph is untouched.
  const reread = parseGraph(serializeGraph(mapped, manifestFor(mapped, SKETCHES))).graph;
  expect(reread.nodes.find(n => n.id === 'move')).toEqual(mapped.nodes.find(n => n.id === 'move'));
  expect(newGraph().nodes.map(n => n.type)).toEqual(['output']);
});

test('the palette can create a transform node and refuses non-createable kinds', () => {
  const read = nodeType => readPaletteDrag({ getData: () => JSON.stringify({ version: 1, nodeType }) }, []);
  expect(read('transform')).toEqual({ nodeType: 'transform' });
  expect(read('blend')).toEqual({ nodeType: 'blend' });
  for (const type of ['output', 'math', 'pattern', 'transform ', 'nope']) expect(read(type)).toBeNull();
  expect(readPaletteDrag({ getData: () => 'not json' }, [])).toBeNull();
  expect(DRAG_TYPE).toContain('viz-pattern');
});

// ---------------------------------------------------------------------------
// Transform geometry (the matrix the shader receives)
// ---------------------------------------------------------------------------

test('transform geometry defaults to identity and projects real perspective', () => {
  expect(isIdentityTransform({})).toBe(true);
  expect(isIdentityTransform(transformDefaults())).toBe(true);
  expect(isIdentityTransform({ moveX: 0.01 })).toBe(false);
  // Scale Z cannot move a flat, unrotated plane, so it is not a visual change.
  expect(isIdentityTransform({ scaleZ: 3 })).toBe(true);
  const matrix = transformMatrix(transformDefaults());
  // P alone: x and y pass through, w = 1 - z (the z coefficient is row 3 of the
  // third column), and clip.z stays 0 (the graph never depth-tests).
  expect(Array.from(matrix)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 1]);
  const flat = projectedQuad(transformDefaults());
  expect(flat.map(p => [p.x, p.y])).toEqual([[-1, 1], [1, 1], [1, -1], [-1, -1]]);
  for (const point of flat) expect(point.w).toBeCloseTo(1, 6);
  // Move X/Y are half-frame units; Move Z of +0.5 doubles the picture, so its
  // corners land outside the frame.
  expect(projectedQuad({ moveX: 1 })[0]).toMatchObject({ x: 0, y: 1 });
  expect(projectedQuad({ moveY: -0.5 })[0]).toMatchObject({ x: -1, y: 0.5 });
  expect(projectedQuad({ moveZ: 0.5 })[0]).toMatchObject({ x: -2, y: 2 });
  expect(projectedQuad({ moveZ: -0.5 })[0]).toMatchObject({ x: -2 / 3, y: 2 / 3 });
  expect(projectedQuad({ scaleX: 0.5 })[0]).toMatchObject({ x: -0.5, y: 1 });
  const spun = projectedQuad({ rotateZ: 90 });
  expect(spun[0].x).toBeCloseTo(-1, 6);
  expect(spun[0].y).toBeCloseTo(-1, 6);
  // Rotate X/Y are true 3D rotations: the plane projects to a trapezoid (near edge
  // magnified past the frame, far edge shrunk) instead of a scaled rectangle.
  const tilt = projectedQuad({ rotateX: 60 });
  expect(tilt[0].y).toBeGreaterThan(1.5);
  expect(tilt[2].y).toBeLessThan(0);
  expect(tilt[2].y).toBeGreaterThan(-1);
  expect(Math.abs(tilt[1].x - tilt[0].x)).toBeGreaterThan(Math.abs(tilt[2].x - tilt[3].x));
  // Edge-on, the plane passes through the camera: nothing finite is projected.
  expect(Number.isFinite(projectedQuad({ rotateX: 90 })[0].x)).toBe(false);
  expect(CAMERA_Z).toBe(1);
});

// ---------------------------------------------------------------------------
// Rendered pixels: canvas modes, shader modes and the Transform node
// ---------------------------------------------------------------------------

async function seedFixture(page, data) {
  const file = await page.evaluate(async graph => {
    const { SKETCHES: registry } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    return serializeGraph(graph, manifestFor(graph, registry));
  }, data);
  await page.evaluate(async text => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns', { create: true });
    const handle = await dir.getFileHandle('blend-transform.nodes.json', { create: true });
    const writer = await handle.createWritable(); await writer.write(text); await writer.close();
    window.showDirectoryPicker = async () => dir;
    window.showOpenFilePicker = async () => [handle];
  }, file);
}

async function openFixture(page, data) {
  // The seed runs in the app's own origin, so the page has to be there first.
  await page.goto('/?role=nodes');
  await seedFixture(page, data);
  const id = await page.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    await nodePatterns.link(); return (await nodePatterns.open('blend-transform.nodes.json')).id;
  });
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue(data.name);
}

const pixel = (page, x = 240, y = 135) => page.getByTestId('node-preview').evaluate((c, point) => Array.from(c.getContext('2d').getImageData(point.x, point.y, 1, 1).data), { x, y });
const setSlider = (page, label, value) => page.getByLabel(label, { exact: true }).evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);

test('every mode composites through the graph: canvas modes unchanged, shader modes exact', async ({ page }) => {
  await page.goto('/?role=nodes');
  const results = await page.evaluate(async () => {
    const { composite } = await import('/src/nodes/runtime.js');
    const make = color => { const c = document.createElement('canvas'); c.width = c.height = 1; const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return c; };
    const a = make('rgb(128,64,32)'), b = make('rgb(64,128,192)'), out = make('black'), white = make('white'), black = make('black');
    const read = () => [...out.getContext('2d').getImageData(0, 0, 1, 1).data];
    const result = {};
    for (const mode of ['Normal', 'Multiply', 'Screen', 'Subtract', 'Divide', 'Average', 'Linear Burn', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix', 'Negate', 'Reflect', 'Glow', 'Freeze', 'Heat', 'Darker Color', 'Lighter Color'])
      result[mode] = (composite(out.getContext('2d'), a, b, mode, 1), read());
    result.transparentBase = (composite(out.getContext('2d'), null, b, 'Hard Mix', 1), read());
    result.halfOpacity = (composite(out.getContext('2d'), a, b, 'Average', .5), read());
    result.divideBlack = (composite(out.getContext('2d'), a, black, 'Divide', 1), read());
    result.reflectWhite = (composite(out.getContext('2d'), a, white, 'Reflect', 1), read());
    result.freezeBlack = (composite(out.getContext('2d'), a, black, 'Freeze', 1), read());
    result.identity = (composite(out.getContext('2d'), a, null, 'Normal', 1), read());
    return result;
  });
  // The original canvas modes are untouched (same expectations as the core spec).
  expect(results.Normal.slice(0, 3)).toEqual([64, 128, 192]);
  expect(results.Multiply.slice(0, 3)).toEqual([32, 32, 24]);
  expect(results.Screen.slice(0, 3)).toEqual([160, 160, 200]);
  expect(results.identity.slice(0, 3)).toEqual([128, 64, 32]);
  const base = [128, 64, 32], layer = [64, 128, 192];
  const near = (actual, expected, mode) => { expect(expected.every((v, i) => Math.abs(actual[i] - v) <= 2), `${mode} ${actual}`).toBe(true); };
  const channel = fn => base.map((v, i) => fn(v, layer[i]));
  near(results.Subtract, channel((b, s) => Math.max(b - s, 0)), 'Subtract');
  near(results.Average, channel((b, s) => (b + s) / 2), 'Average');
  near(results['Linear Burn'], channel((b, s) => Math.max(b + s - 255, 0)), 'Linear Burn');
  near(results['Linear Light'], channel((b, s) => Math.min(255, Math.max(0, b + 2 * s - 255))), 'Linear Light');
  near(results['Hard Mix'], channel((b, s) => (b + s >= 255 ? 255 : 0)), 'Hard Mix');
  near(results.Divide, channel((b, s) => Math.min(255, b / s * 255)), 'Divide');
  near(results.Negate, channel((b, s) => 255 - Math.abs(255 - b - s)), 'Negate');
  // Documented edge cases of the quadratic and dodge family.
  expect(results.divideBlack.slice(0, 3)).toEqual([255, 255, 255]);
  expect(results.reflectWhite.slice(0, 3)).toEqual([255, 255, 255]);
  expect(results.freezeBlack.slice(0, 3)).toEqual([0, 0, 0]);
  // Every shader result is a real opaque pixel, never NaN or out of range.
  for (const mode of Object.keys(EXTENDED_MODES)) {
    expect(results[mode].every(value => Number.isInteger(value) && value >= 0 && value <= 255), mode).toBe(true);
    expect(results[mode][3], mode).toBe(255);
  }
  // Colour selectors pick a whole pixel by luma: base luma 75 < layer luma 119.
  expect(results['Darker Color'].slice(0, 3)).toEqual(base);
  expect(results['Lighter Color'].slice(0, 3)).toEqual(layer);
  // A transparent base leaves the layer untouched, exactly like the canvas path.
  expect(results.transparentBase.slice(0, 3)).toEqual(layer);
  expect(results.transparentBase[3]).toBe(255);
  // Opacity scales the layer: half of the blended result over half of the base.
  near(results.halfOpacity, base.map((v, i) => .5 * ((v + layer[i]) / 2) + .5 * v), 'half opacity');
});

test('the blend inspector lists both mode groups and an extended mode renders end to end', async ({ page }) => {
  const graph = () => ({ version: 1, name: 'Blend modes', nodes: [solid('base', 0, 40, 60), solid('layer', 1 / 3, 40, 290), blendNode('mix', 'Normal'), out],
    edges: [{ from: 'base', to: 'mix', port: 'base' }, { from: 'layer', to: 'mix', port: 'layer' }, { from: 'mix', to: 'output', port: 'image' }] });
  await openFixture(page, graph());
  // Normal: the opaque layer covers the base.
  await expect.poll(() => pixel(page)).toEqual([0, 255, 0, 255]);
  await page.getByRole('button', { name: 'Select Blend', exact: true }).click();
  await expect(page.locator('optgroup[label="Canvas blend modes"] option')).toHaveCount(Object.keys(NATIVE_MODES).length);
  await expect(page.locator('optgroup[label="WebGL2 blend modes"] option')).toHaveCount(Object.keys(EXTENDED_MODES).length);
  await expect(page.getByTestId('node-blend-status')).toContainText('canvas blend operation');
  await page.getByLabel('Blend mode').selectOption('Screen');
  await expect.poll(() => pixel(page)).toEqual([255, 255, 0, 255]);
  // Shader modes composite the same graph through the shared WebGL2 compositor.
  await page.getByLabel('Blend mode').selectOption('Average');
  await expect.poll(() => pixel(page)).toEqual([128, 128, 0, 255]);
  await expect(page.getByTestId('node-blend-status')).toContainText('WebGL2 compositor');
  await page.getByLabel('Blend mode').selectOption('Hard Mix');
  await expect.poll(() => pixel(page)).toEqual([255, 255, 0, 255]);
  await page.getByLabel('Blend mode').selectOption('Subtract');
  await expect.poll(() => pixel(page)).toEqual([255, 0, 0, 255]);
  await page.getByLabel('Blend mode').selectOption('Divide');
  await expect.poll(() => pixel(page)).toEqual([255, 0, 255, 255]);
  // Opacity still scales the layer only.
  await page.getByLabel('Blend mode').selectOption('Average');
  await setSlider(page, 'Opacity', 0);
  await expect.poll(() => pixel(page)).toEqual([255, 0, 0, 255]);
  await expect(page.locator('.nodes-diagnostics')).toBeEmpty();
});

test('the Transform node copies its input at identity and projects it in 3D', async ({ page }) => {
  const graph = { version: 1, name: 'Transform', nodes: [solid('src', 0, 40, 60), defaultNode('transform', 300, 60, 'move'), out],
    edges: [{ from: 'src', to: 'move', port: 'image' }, { from: 'move', to: 'output', port: 'image' }] };
  await openFixture(page, graph);
  await expect(page.locator('[data-node-id="move"]')).toHaveCount(1);
  await expect.poll(() => pixel(page, 2, 2)).toEqual([255, 0, 0, 255]);
  await page.getByRole('button', { name: 'Select Transform', exact: true }).click();
  await expect(page.getByTestId('node-transform-status')).toContainText('Identity');
  // Nine sliders, exactly as the node definition declares.
  for (const def of TRANSFORM_PARAMS) await expect(page.getByLabel(def.label, { exact: true })).toBeVisible();
  // Scale X shrinks the plane, so the outer sixth of the frame turns transparent.
  await setSlider(page, 'Scale X', 0.5);
  await expect.poll(() => pixel(page, 30, 135)).toEqual([0, 0, 0, 0]);
  await expect.poll(() => pixel(page)).toEqual([255, 0, 0, 255]);
  await expect(page.getByTestId('node-transform-status')).toContainText('WebGL2 perspective transform');
  // Rotate X tilts the plane into perspective: the near edge grows past the frame
  // and the far edge recedes, so the bottom of the frame is empty.
  await setSlider(page, 'Scale X', 1);
  await setSlider(page, 'Rotate X', 60);
  await expect.poll(() => pixel(page, 240, 250)).toEqual([0, 0, 0, 0]);
  await expect.poll(() => pixel(page, 240, 40)).toEqual([255, 0, 0, 255]);
  // Back to a flat plane: the centre stays covered, and Move Y pushes it down.
  await setSlider(page, 'Rotate X', 0);
  await setSlider(page, 'Rotate Z', 180);
  await expect.poll(() => pixel(page)).toEqual([255, 0, 0, 255]);
  await setSlider(page, 'Move Y', -1);
  await expect.poll(() => pixel(page, 240, 20)).toEqual([0, 0, 0, 0]);
  await expect(page.locator('.nodes-diagnostics')).toBeEmpty();
  // The graph stays valid and saves with the new values.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.nodes-disk-error')).toHaveCount(0);
});

test('two graphs of different sizes share one compositor and keep the transform exact', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { transformDefaults } = await import('/src/nodes/transform.js');
    const graph = { version: 1, name: 'sized', nodes: [
      { id: 'src', type: 'pattern', patternId: 'solid-color', x: 0, y: 0, params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 } },
      { id: 'move', type: 'transform', x: 0, y: 0, params: { ...transformDefaults(), scaleX: 0.5 } },
      { id: 'output', type: 'output', x: 0, y: 0 },
    ], edges: [{ from: 'src', to: 'move', port: 'image' }, { from: 'move', to: 'output', port: 'image' }] };
    // The editor preview is 480x270; an output screen is bigger. Both must reuse the
    // one shared compositor without the first size leaking into the second.
    const read = async (width, height) => {
      const runtime = new GraphRuntime({ graph, sketches: SKETCHES, width, height });
      await runtime.ready;
      const image = await runtime.renderFrame();
      const ctx = image.getContext('2d');
      const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
      const sample = { size: [image.width, image.height], inside: at(Math.round(width / 2), Math.round(height / 2)), outside: at(2, Math.round(height / 2)) };
      runtime.dispose();
      return sample;
    };
    return { small: await read(480, 270), big: await read(640, 360) };
  });
  expect(result.small.size).toEqual([480, 270]);
  expect(result.big.size).toEqual([640, 360]);
  for (const [size, sample] of Object.entries(result)) {
    expect(sample.inside, size).toEqual([255, 0, 0, 255]);
    expect(sample.outside, size).toEqual([0, 0, 0, 0]);
  }
});

test('a grown compositor canvas does not shift a later, smaller shader blend', async ({ page }) => {
  await page.goto('/?role=nodes');
  const rows = await page.evaluate(async () => {
    const { composite } = await import('/src/nodes/runtime.js');
    const grid = (w, h, fill) => {
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { ctx.fillStyle = fill(x, y); ctx.fillRect(x, y, 1, 1); }
      return canvas;
    };
    // Grow the shared intermediate canvas with a bigger graph first: the small
    // render below then uses a viewport with a non-zero origin.
    const big = grid(8, 8, () => 'rgb(0,0,0)');
    composite(big.getContext('2d'), big, big, 'Average', 1);
    // Horizontally varying base, vertically varying layer: Average keeps both
    // axes, so any vertical smear or clamp is visible per row.
    const base = grid(4, 4, x => `rgb(${x * 60},0,0)`);
    const layer = grid(4, 4, (x, y) => `rgb(0,${y * 60},0)`);
    const out = grid(4, 4, () => 'black');
    composite(out.getContext('2d'), base, layer, 'Average', 1);
    const data = out.getContext('2d').getImageData(0, 0, 4, 4).data;
    return [...data].reduce((acc, value, index) => {
      const pixel = Math.floor(index / 4), channel = index % 4;
      (acc[pixel] ||= [])[channel] = value;
      return acc;
    }, []);
  });
  rows.forEach((pixel, index) => {
    const [x, y] = [index % 4, Math.floor(index / 4)];
    expect(pixel, `pixel ${x},${y}`).toEqual([x * 30, y * 30, 0, 255]);
  });
});

test('without WebGL2 the shader modes fall back to Normal and the transform passes through', async ({ page, context }) => {
  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return String(type).startsWith('webgl') ? null : original.call(this, type, ...rest);
    };
  });
  const graph = { version: 1, name: 'No GPU', nodes: [solid('base', 0, 40, 60), solid('layer', 1 / 3, 40, 290), blendNode('mix', 'Screen'), defaultNode('transform', 460, 60, 'move'), out],
    edges: [{ from: 'base', to: 'mix', port: 'base' }, { from: 'layer', to: 'mix', port: 'layer' }, { from: 'mix', to: 'move', port: 'image' }, { from: 'move', to: 'output', port: 'image' }] };
  await openFixture(page, graph);
  await expect.poll(() => pixel(page)).toEqual([255, 255, 0, 255]);
  // A transform that needs the GPU still shows the picture, and says what happened.
  await page.getByRole('button', { name: 'Select Transform', exact: true }).click();
  await setSlider(page, 'Move X', 1);
  await expect(page.getByTestId('node-transform-status')).toContainText('passes through unchanged');
  await expect.poll(() => pixel(page)).toEqual([255, 255, 0, 255]);
  await expect(page.locator('.nodes-diagnostics')).toContainText('Transform needs WebGL2');
  // An extended blend mode degrades to Normal visibly instead of guessing.
  await page.getByRole('button', { name: 'Select Blend', exact: true }).click();
  await page.getByLabel('Blend mode').selectOption('Average');
  await expect(page.getByTestId('node-blend-status')).toContainText('needs WebGL2');
  await expect.poll(() => pixel(page)).toEqual([0, 255, 0, 255]);
  await expect(page.locator('.nodes-diagnostics')).toContainText('Blend mode Average needs WebGL2');
  // Canvas modes are unaffected by the missing GPU.
  await page.getByLabel('Blend mode').selectOption('Screen');
  await expect.poll(() => pixel(page)).toEqual([255, 255, 0, 255]);
});
