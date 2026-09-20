import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { validateGraph, connect, deleteNode } from '../src/nodes/model.js';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });


test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    window.__permission = 'granted'; window.__requestPermission = 'granted';
    FileSystemHandle.prototype.queryPermission = async () => window.__permission;
    FileSystemHandle.prototype.requestPermission = async () => { window.__permission = window.__requestPermission; return window.__permission; };
  });
  context.on('page', page => page.on('dialog', dialog => dialog.accept()));
});

const graph = () => ({ version: 1, name: 'Neon composite', nodes: [
  { id: 'red', type: 'pattern', patternId: 'solid-color', x: 40, y: 60, params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 } },
  { id: 'green', type: 'pattern', patternId: 'solid-color', x: 40, y: 290, params: { hue: 1 / 3, saturation: 1, brightness: 1, pulse: 0 } },
  { id: 'mix', type: 'blend', x: 330, y: 170, mode: 'Screen', opacity: 1 },
  { id: 'output', type: 'output', x: 620, y: 170 },
], edges: [{ from: 'red', to: 'mix', port: 'base' }, { from: 'green', to: 'mix', port: 'layer' }, { from: 'mix', to: 'output', port: 'image' }] });
async function openFixture(page, data = graph()) {
  const file = await page.evaluate(async graph => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    return serializeGraph(graph, manifestFor(graph, SKETCHES));
  }, data);
  await page.evaluate(async text => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns', { create: true });
    const handle = await dir.getFileHandle('neon.nodes.json', { create: true });
    const writer = await handle.createWritable(); await writer.write(text); await writer.close();
    window.showDirectoryPicker = async () => dir;
    window.showOpenFilePicker = async () => [handle];
  }, file);
  await page.getByRole('button', { name: 'Link Folder', exact: true }).click();
  await expect(page.locator('.nodes-status')).toContainText('Linked');
  await page.getByRole('button', { name: 'Open pattern', exact: true }).click();
  await expect(page.getByLabel('Graph name')).toHaveValue(data.name);

}
const pixel = page => page.getByTestId('node-preview').evaluate(c => Array.from(c.getContext('2d').getImageData(240, 135, 1, 1).data));

test('graph validation rejects cycles, malformed ports, duplicates, limits and recursive references', () => {
  expect(validateGraph(graph(), { complete: true }).edges).toHaveLength(3);
  expect(() => connect(graph(), 'mix', 'mix', 'base')).toThrow(/cycle/);
  expect(() => connect(graph(), 'output', 'mix', 'base')).toThrow(/port/);
  expect(() => connect(graph(), 'red', 'mix', 'unknown')).toThrow(/port/);
  expect(() => validateGraph({ ...graph(), version: 9 })).toThrow(/version/);
  expect(() => validateGraph({ ...graph(), nodes: [...graph().nodes, graph().nodes[0]] })).toThrow(/duplicate/);
  expect(() => validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'red' ? { ...n, patternId: 'nodes-recursive' } : n) })).toThrow(/recurs/);
  expect(() => validateGraph({ ...graph(), nodes: graph().nodes.map(n => n.id === 'mix' ? { ...n, opacity: NaN } : n) })).toThrow(/opacity/);
  expect(() => validateGraph({ ...graph(), edges: [] }, { complete: true })).toThrow(/Connect/);
  expect(deleteNode(graph(), 'red').edges).toHaveLength(2);
  expect(deleteNode(graph(), 'output')).toEqual(graph());
  expect(() => validateGraph({ ...graph(), nodes: Array.from({ length: 25 }, (_, i) => ({ ...graph().nodes[0], id: `n${i}` })) })).toThrow(/24/);
});

test('all blend modes and opacity use pixel compositing', async ({ page }) => {
  await page.goto('/?role=nodes');
  const results = await page.evaluate(async () => {
    const { composite } = await import('/src/nodes/runtime.js');
    const make = color => { const c = document.createElement('canvas'); c.width = c.height = 1; const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return c; };
    const a = make('rgb(128,64,32)'), b = make('rgb(64,128,192)'), out = make('black');
    const result = {};
    for (const mode of ['Normal', 'Multiply', 'Screen', 'Overlay', 'Difference', 'Add']) {
      composite(out.getContext('2d'), a, b, mode, 1); result[mode] = [...out.getContext('2d').getImageData(0, 0, 1, 1).data];
    }
    composite(out.getContext('2d'), a, b, 'Normal', 0); result.zero = [...out.getContext('2d').getImageData(0, 0, 1, 1).data];
    composite(out.getContext('2d'), a, b, 'Normal', .5); result.half = [...out.getContext('2d').getImageData(0, 0, 1, 1).data];
    return result;
  });
  const expected = { Normal: [64, 128, 192], Multiply: [32, 32, 24], Screen: [160, 160, 200], Overlay: [65, 64, 48], Difference: [64, 64, 160], Add: [192, 192, 224], zero: [128, 64, 32], half: [96, 96, 112] };
  for (const [mode, rgb] of Object.entries(expected)) rgb.forEach((v, i) => expect(Math.abs(results[mode][i] - v)).toBeLessThanOrEqual(2));
});

test('real source rendering, chain editing, move, disconnect, delete and screenshot', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/?role=nodes'); await openFixture(page);
  await expect.poll(() => pixel(page)).toEqual([255, 255, 0, 255]);
  await page.getByRole('button', { name: 'Select Blend', exact: true }).click();
  await page.getByLabel('Blend mode').selectOption('Multiply');
  await expect.poll(() => pixel(page)).toEqual([0, 0, 0, 255]);
  await page.getByLabel('Blend mode').selectOption('Screen');
  await page.locator('[data-node-id="red"] .nodes-node-title').click();
  await page.getByLabel('Brightness', { exact: true }).fill('0.5');
  await expect.poll(async () => (await pixel(page))[0]).toBeGreaterThan(120);
  const title = page.locator('[data-node-id="red"] .nodes-node-title');
  await title.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-node-id="red"]')).toHaveCSS('left', '50px');
  const box = await title.boundingBox(); await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 65, box.y + 40); await page.mouse.up();
  await expect(page.locator('[data-node-id="red"]')).toHaveCSS('left', '95px');
  await page.getByRole('button', { name: 'Select Output', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('nodes-editor.png'), fullPage: true });
  await page.screenshot({ path: '/tmp/nodes-editor-review.png', fullPage: true });
  await page.getByRole('button', { name: 'Disconnect image', exact: true }).click();
  await expect.poll(() => pixel(page)).toEqual([0, 0, 0, 0]);
  await page.getByLabel('mix output', { exact: true }).click(); await page.getByLabel('output input image').click();
  await expect.poll(async () => (await pixel(page))[1]).toBe(255);
  await page.getByRole('button', { name: 'Select Blend', exact: true }).click(); await page.getByRole('button', { name: 'Delete node', exact: true }).click();
  await expect(page.locator('[data-node-id="mix"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('searchable palette accepts validated cross-tab drag payload, rejects foreign payload', async ({ page, context }) => {
  await page.goto('/?role=nodes');
  await page.getByLabel('Search patterns').fill('checkerboard');
  await expect(page.locator('.nodes-pattern-list button')).toHaveCount(1);
  await page.locator('.nodes-pattern-list button').dragTo(page.getByLabel('Graph workspace'), { targetPosition: { x: 100, y: 120 } });
  await expect(page.locator('[data-node-id]')).toHaveCount(2);
  const main = await context.newPage(); await main.goto('/');
  const payload = await main.locator('.library-btn[data-id="solid-color"]').evaluate(button => {
    const transfer = new DataTransfer(); button.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer })); return transfer.getData('application/x-viz-pattern+json');
  });
  await page.getByLabel('Graph workspace').evaluate((el, text) => { const dataTransfer = new DataTransfer(); dataTransfer.setData('application/x-viz-pattern+json', text); el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer, clientX: 350, clientY: 300 })); }, payload);
  await expect(page.locator('[data-node-id]')).toHaveCount(3);
  await page.getByLabel('Graph workspace').evaluate(el => { const dataTransfer = new DataTransfer(); dataTransfer.setData('application/x-viz-pattern+json', '{"version":1,"patternId":"not-real"}'); el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer })); });
  await expect(page.locator('.nodes-status')).toHaveText('Invalid pattern drag payload');
  await expect(page.locator('[data-node-id]')).toHaveCount(3);
});

test('disk persistence, stable overwrite, reload and isolated drafts across tabs', async ({ page, context }) => {
  await page.goto('/?role=nodes'); await openFixture(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.nodes-status')).toContainText('Saved Neon composite');
  const second = await context.newPage(); await second.goto('/?role=nodes');
  await expect(second.getByLabel('Graph name')).toHaveValue('Untitled graph');
  await expect(second.getByLabel('Saved graph').locator('option')).toHaveCount(2);
  await page.getByLabel('Graph name').fill('Disk update');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(second.getByLabel('Saved graph').locator('option')).toHaveCount(2);
  await expect(second.getByLabel('Saved graph')).toContainText('Disk update');
  await page.reload();
  await expect(page.getByLabel('Graph name')).toHaveValue('Untitled graph');
  await expect(page.getByLabel('Saved graph')).toContainText('Disk update');
  const id = await page.getByLabel('Saved graph').locator('option').nth(1).getAttribute('value');
  await page.getByLabel('Saved graph').selectOption(id);
  await page.getByRole('button', { name: 'Load pattern', exact: true }).click();
  await expect(page.getByLabel('Graph name')).toHaveValue('Disk update');
  await expect.poll(() => pixel(page)).toEqual([255, 255, 0, 255]);
  expect(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('viz2_nodes_v1:')))).toBe(false);
  await expect(page.getByRole('button', { name: /revision|Import JSON|Export JSON/i })).toHaveCount(0);
});

test('main link opens isolated editor; saved graph is selectable on real output; disk overwrite invalidates selected output', async ({ page, context }) => {
  test.setTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  const opened = context.waitForEvent('page'); await page.getByRole('link', { name: 'Open Nodes editor' }).click();
  const editor = await opened; await editor.waitForURL('**/?role=nodes');
  expect(await editor.evaluate(() => Boolean(window.__viz))).toBe(false);
  await openFixture(editor); await editor.getByRole('button', { name: 'Save' }).click();
  const button = page.locator('.library-btn').filter({ hasText: 'Neon composite' });
  await expect(button).toBeVisible();
  const id = await button.getAttribute('data-id');
  const screen = await context.newPage(); await screen.goto('/?role=screen');
  await page.waitForFunction(() => window.__viz?.screenOnline);
  await button.click({ modifiers: ['Shift'] });
  await screen.waitForFunction(() => window.__viz.cue?.phase === 'ready');
  await page.keyboard.press('Enter');
  await screen.waitForFunction(() => window.__viz.cue === null);
  await expect.poll(() => screen.evaluate(id => Boolean(document.querySelector(`[data-program-ids="${id}"] canvas`)), id)).toBe(true);
  await expect.poll(() => screen.evaluate(id => { const c = document.querySelector(`[data-program-ids="${id}"] canvas`); return c && [...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data]; }, id)).toEqual([255, 255, 0, 255]);
  await editor.locator('[data-node-id="red"] .nodes-node-title').click();
  await editor.getByLabel('Brightness', { exact: true }).fill('0');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.locator('.nodes-status')).toContainText('Saved');
  await expect.poll(() => screen.evaluate(id => { const c = document.querySelector(`[data-program-ids="${id}"] canvas`); return c && [...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data]; }, id)).toEqual([0, 255, 0, 255]);
  await expect(button).toHaveCount(1);
  await page.locator('.library-btn[data-id="checkerboard"]').click({ modifiers: ['Shift'] });
  await screen.waitForFunction(() => window.__viz.cue?.phase === 'ready');
  await editor.getByLabel('Brightness', { exact: true }).fill('0.25');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.locator('.nodes-status')).toContainText('Saved');
  await screen.waitForFunction(() => window.__viz.cue === null);
  await editor.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns');
    await dir.removeEntry('neon.nodes.json');
  });
  await editor.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await expect(button).toHaveCount(0);
  await screen.waitForFunction(id => window.__viz.patternId !== id, id);
  expect(errors).toEqual([]);
});

test('missing dependencies and camera preview are visible and never acquire capture', async ({ page }) => {
  await page.addInitScript(() => { window.captureCalls = 0; navigator.mediaDevices.getUserMedia = async () => { window.captureCalls++; throw new Error('unexpected capture'); }; });
  await page.goto('/?role=nodes');
  const cameraGraph = graph(); cameraGraph.nodes[0].patternId = 'video-chroma'; cameraGraph.nodes[0].params = {};
  await openFixture(page, cameraGraph);
  await expect(page.locator('.nodes-diagnostics')).toContainText('Camera is available only');
  expect(await page.evaluate(() => window.captureCalls)).toBe(0);
  const missing = graph(); missing.nodes[0].patternId = 'missing-file'; missing.nodes[0].params = {};
  await openFixture(page, missing);
  await expect(page.locator('.nodes-diagnostics')).toContainText('Missing pattern');
  await page.getByRole('button', { name: 'Save' }).click(); await expect(page.locator('.nodes-status')).toContainText('Missing pattern');
});

test('multi-blend DAG reuses source pixels, resizes and disposes independent audio slots', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async graph => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    graph.nodes.push({ id: 'mix2', type: 'blend', x: 400, y: 400, mode: 'Difference', opacity: 1 });
    graph.edges = graph.edges.filter(e => e.to !== 'output').concat([{ from: 'mix', to: 'mix2', port: 'base' }, { from: 'red', to: 'mix2', port: 'layer' }, { from: 'mix2', to: 'output', port: 'image' }]);
    const children = [], retired = [], slots = new Map();
    const store = { upsertSlot: d => slots.set(d.runtimeId, d), retireSlots: ids => retired.push(...ids), createBinding: () => ({ read: () => ({ continuous: { level: 0 } }), noteDraw() {}, setEventDeliveryEnabled() {} }) };
    const runtime = new GraphRuntime({ graph, sketches: SKETCHES, context: { audioControlStore: store, registerChildRuntime: r => children.push(r) } });
    await runtime.ready;
    const canvas = runtime.render(), color = [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data];
    const descriptors = children.flatMap(r => r.getAudioSlotDescriptors('live'));
    runtime.resize(320, 180); runtime.pause(); const paused = children.every(r => r.paused); runtime.resume();
    await new Promise(r => setTimeout(r, 100));
    const resized = [runtime.render().width, runtime.render().height];
    const instances = children.flatMap(r => r.instances); runtime.dispose();
    return { color, paused, resized, ids: descriptors.map(d => d.runtimeId), hues: descriptors.map(d => d.params.hue), retired, removed: instances.every(p => p._removed) };
  }, graph());
  expect(result.color).toEqual([0, 255, 0, 255]); expect(result.resized).toEqual([320, 180]); expect(result.paused).toBe(true); expect(result.removed).toBe(true);
  expect(new Set(result.ids).size).toBe(2); expect(result.hues).toEqual([0, 1 / 3]); expect(result.retired.sort()).toEqual(result.ids.sort());
});

test('projection and WebGL sources copy pixels immediately, not discarded frames', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { registerProjectionSketches } = await import('/src/projection/projection-registry.js');
    const sketches = [...SKETCHES];
    registerProjectionSketches(sketches, [{ id: 'projection-node-test', name: 'Mapped', surfaces: [{ id: 's1', name: 'Face', patternId: 'solid-color' }] }]);
    const nodes = [{ id: 'source', type: 'pattern', patternId: 'projection-node-test', x: 0, y: 0, params: { 's1:hue': 0, 's1:saturation': 1, 's1:brightness': 1, 's1:pulse': 0 } }, { id: 'output', type: 'output', x: 300, y: 0 }];
    const graph = { version: 1, name: 'Projection', nodes, edges: [{ from: 'source', to: 'output', port: 'image' }] };
    const runtime = new GraphRuntime({ graph, sketches }); await runtime.ready;
    const read = r => { const c = r.render(); return [...c.getContext('2d').getImageData(240, 135, 1, 1).data]; };
    const projection = read(runtime); runtime.dispose();
    sketches.push({ id: 'test-gpu', name: 'GPU', params: [], factory: () => p => {
      p.setup = () => p.createCanvas(480, 270, p.WEBGL);
      p.draw = () => { const gl = p.drawingContext; gl.clearColor(0, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); };
    } });
    nodes[0] = { ...nodes[0], patternId: 'test-gpu', params: {} };
    const gpu = new GraphRuntime({ graph, sketches }); await gpu.ready;
    await new Promise(r => setTimeout(r, 100)); const color = read(gpu); gpu.dispose();
    return { projection, color };
  });
  expect(result.projection).toEqual([255, 0, 0, 255]); expect(result.color).toEqual([0, 0, 255, 255]);
});

test('local media image/video and custom-script factory render through graph contracts', async ({ page }) => {
  await page.goto('/?role=nodes');
  const video = (await readFile(new URL('./fixtures/green.webm', import.meta.url))).toString('base64');
  const result = await page.evaluate(async ({ graph, video }) => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { putMediaRecord } = await import('/src/media/media-store.js');
    const { addMediaPattern } = await import('/src/media/media-registry.js');
    const { adaptPattern } = await import('/src/custom-scripts/adapter.js');
    const image = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'], 'red.svg', { type: 'image/svg+xml' });
    const clip = new File([Uint8Array.from(atob(video), c => c.charCodeAt(0))], 'green.webm', { type: 'video/webm' });
    for (const [id, kind, file] of [['node-image', 'image', image], ['node-video', 'video', clip]]) {
      await putMediaRecord({ id, name: id, kind, file }); addMediaPattern(SKETCHES, { id, name: id, kind });
    }
    graph.nodes[0] = { ...graph.nodes[0], patternId: 'media-node-image', params: {} };
    graph.nodes[1] = { ...graph.nodes[1], patternId: 'media-node-video', params: {} };
    const runtime = new GraphRuntime({ graph, sketches: SKETCHES }); await runtime.ready;
    await new Promise(r => setTimeout(r, 300));
    const c = runtime.render(), rgb = [...c.getContext('2d').getImageData(240, 135, 1, 1).data]; runtime.dispose();
    const errors = [];
    const custom = adaptPattern({ file: 'test.js', definition: { id: 'custom-test', name: 'Test', params: [], setup: ({ p }) => p.createCanvas(480, 270), draw: ({ p }) => p.background(255, 0, 255) } }, e => errors.push(e), () => null);
    const single = { ...graph, nodes: [{ ...graph.nodes[0], patternId: custom.id }, graph.nodes[3]], edges: [{ from: 'red', to: 'output', port: 'image' }] };
    const scripts = new GraphRuntime({ graph: single, sketches: [...SKETCHES, custom] }); await scripts.ready;
    const sc = scripts.render(), scriptColor = [...sc.getContext('2d').getImageData(240, 135, 1, 1).data]; scripts.dispose();
    return { rgb, scriptColor, errors };
  }, { graph: graph(), video });
  expect(result.rgb[0]).toBeGreaterThan(245); expect(result.rgb[1]).toBeGreaterThan(245); expect(result.rgb[2]).toBeLessThan(10);
  expect(result.scriptColor).toEqual([255, 0, 255, 255]); expect(result.errors).toEqual([]);
});

test('dependency changes and malformed disk records are isolated', async ({ page }) => {
  await page.goto('/?role=nodes'); await openFixture(page);
  const result = await page.evaluate(async graph => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, sourceDiagnostics } = await import('/src/nodes/portability.js');
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const writer = await (await nodePatterns.state.folder.handle.getFileHandle('broken.nodes.json', { create: true })).createWritable();
    await writer.write('{broken'); await writer.close();
    await nodePatterns.refresh();
    const changed = SKETCHES.map(s => s.id === 'solid-color' ? { ...s, params: [] } : s);
    return { count: nodePatterns.records.length, errors: nodePatterns.errors, diagnostics: sourceDiagnostics(graph, changed, manifestFor(graph, SKETCHES)) };
  }, graph());
  expect(result.count).toBe(1); expect(result.errors.join()).toContain('broken.nodes.json'); expect(result.diagnostics.join()).toContain('Changed dependency');
});

test('two graph camera nodes share the output camera owner and release consumers', async ({ page }) => {
  await page.goto('/?role=screen');
  const result = await page.evaluate(async graph => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { SharedCameraSource } = await import('/src/shared-camera-source.js');
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let calls = 0;
    navigator.mediaDevices.getUserMedia = async constraints => { calls++; return native(constraints); };
    const camera = new SharedCameraSource();
    for (const n of graph.nodes.filter(n => n.type === 'pattern')) { n.patternId = 'video-chroma'; n.params = {}; }
    const runtime = new GraphRuntime({ graph, sketches: SKETCHES, preview: false, context: { cameraSource: camera } });
    await runtime.ready;
    const problems = runtime.getDiagnostics();
    const count = runtime.sources.size; runtime.dispose(); camera.dispose();
    return { calls, count, problems };
  }, graph());
  expect(result.calls).toBe(1); expect(result.count).toBe(2); expect(result.problems).toEqual([]);
});

test('guide loads and links back to the independent editor', async ({ page }) => {
  await page.goto('/docs/nodes.html');
  await expect(page.getByRole('heading', { name: 'Nodes: build a pixel-composited pattern' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Nodes editor' })).toHaveAttribute('href', '/?role=nodes');
});

test('editor shares main theme and control chrome without changing draft gestures', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/?role=nodes'); await openFixture(page);
  await expect.poll(() => pixel(page)).toEqual([255, 255, 0, 255]);
  await expect(page.getByRole('button', { name: 'Save' })).toHaveClass('btn btn--solid');
  await expect(page.getByLabel('Saved graph')).toHaveClass('control-select');
  await expect(page.getByLabel('Search patterns')).toHaveClass('control-input');
  await page.getByRole('button', { name: 'Select Blend', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Opacity' })).toHaveClass('control-range');
  await page.getByRole('slider', { name: 'Opacity' }).focus(); await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('slider', { name: 'Opacity' })).toHaveValue('0.99');
  await expect(page.getByRole('slider', { name: 'Opacity' })).toHaveCSS('outline-style', 'solid');
  await page.locator('[data-node-id="red"] .nodes-node-title').click();
  await expect(page.getByLabel('Brightness', { exact: true })).toHaveClass('control-input');
  const styles = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      background: getComputedStyle(document.querySelector('.nodes-app')).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      font: getComputedStyle(document.querySelector('.nodes-app')).fontFamily,
      bodyFont: getComputedStyle(document.body).fontFamily,
      accent: root.getPropertyValue('--accent').trim(),
      wire: getComputedStyle(document.querySelector('.nodes-wires path')).stroke,
    };
  });
  expect(styles.background).toBe(styles.bodyBackground);
  expect(styles.font).toBe(styles.bodyFont);
  expect(styles.accent).toBe('#4da3ff'); expect(styles.wire).toBe('rgb(77, 163, 255)');
  await page.screenshot({ path: '/tmp/nodes-theme-review.png' });
  await page.setViewportSize({ width: 1000, height: 720 });
  await expect(page.getByRole('button', { name: 'Save' })).toBeInViewport();
  await expect(page.getByLabel('Brightness', { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// Pickers and permission states are mocked; native OPFS handles/writers and
// IndexedDB structured cloning exercise the real cross-tab persistence path.
const diskText = page => page.evaluate(async () => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns');
  return (await (await dir.getFileHandle('neon.nodes.json')).getFile()).text();
});

test('new drafts save in linked folder, collision cancellation and failed writes preserve disk', async ({ page }) => {
  await page.goto('/?role=nodes'); await openFixture(page);
  const before = await diskText(page);
  await page.getByLabel('Graph name').fill('Edited draft');
  page.removeAllListeners('dialog'); page.on('dialog', d => d.dismiss());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.nodes-status')).toContainText('Canceled');
  expect(await diskText(page)).toBe(before);
  await page.getByRole('button', { name: 'New draft', exact: true }).click();
  await expect(page.getByLabel('Graph name')).toHaveValue('Edited draft');
  page.removeAllListeners('dialog'); page.on('dialog', d => d.accept());
  await page.evaluate(() => {
    const native = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function () {
      const writer = await native.call(this);
      return { write: async () => { throw new Error('Mock disk full'); }, close: () => writer.close(), abort: () => writer.abort() };
    };
    window.__restoreWriter = () => { FileSystemFileHandle.prototype.createWritable = native; };
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.nodes-status')).toContainText('Mock disk full');
  expect(await diskText(page)).toBe(before);
  await page.evaluate(() => window.__restoreWriter());
  // A fresh graph, not a loaded document, derives its filename from its name.
  await page.getByRole('button', { name: 'New draft', exact: true }).click();
  await page.getByLabel('Search patterns').fill('checkerboard');
  await page.locator('.nodes-pattern-list button').click();
  await page.locator('.nodes-output').click(); await page.getByLabel('output input image').click();
  await page.getByLabel('Graph name').fill('Fresh pattern');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.nodes-status')).toContainText('Fresh-pattern.nodes.json');
  await expect(page.getByLabel('Saved graph').locator('option')).toHaveCount(3);
  const saved = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns');
    return JSON.parse(await (await (await dir.getFileHandle('Fresh-pattern.nodes.json')).getFile()).text());
  });
  expect(saved.graph.name).toBe('Fresh pattern'); expect(saved.dependencies[0].id).toBe('checkerboard');
});

test('stale drafts cannot overwrite another tab; refresh retires deleted disk patterns', async ({ page, context }) => {
  await page.goto('/?role=nodes'); await openFixture(page);
  const second = await context.newPage(); await second.goto('/?role=nodes');
  await expect(second.getByLabel('Saved graph').locator('option')).toHaveCount(2);
  const id = await second.getByLabel('Saved graph').locator('option').nth(1).getAttribute('value');
  await second.getByLabel('Saved graph').selectOption(id);
  await second.getByRole('button', { name: 'Load pattern', exact: true }).click();
  await expect(second.getByLabel('Graph name')).toHaveValue('Neon composite');
  await page.getByLabel('Graph name').fill('First writer');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.nodes-status')).toContainText('Saved First writer');
  await second.getByLabel('Graph name').fill('Stale writer');
  await second.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(second.locator('.nodes-status')).toContainText('File changed');
  expect(JSON.parse(await diskText(page)).graph.name).toBe('First writer');
  await expect(second.getByLabel('Graph name')).toHaveValue('Stale writer');
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns');
    await dir.removeEntry('neon.nodes.json');
  });
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await expect(page.getByLabel('Saved graph').locator('option')).toHaveCount(1);
  await expect(second.getByLabel('Saved graph').locator('option')).toHaveCount(1);
  await page.reload(); await expect(page.getByLabel('Saved graph').locator('option')).toHaveCount(1);
});

test('denied and expired permissions require a gesture; cancellation and unsupported pickers retain draft', async ({ page }) => {
  await page.goto('/?role=nodes'); await openFixture(page);
  const before = await diskText(page);
  await page.evaluate(() => { window.__permission = 'denied'; window.__requestPermission = 'denied'; });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.nodes-status')).toContainText('Permission denied');
  expect(await diskText(page)).toBe(before);
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await expect(page.getByLabel('Saved graph').locator('option')).toHaveCount(1);
  await page.evaluate(() => { window.__permission = 'prompt'; window.__requestPermission = 'granted'; });
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await expect(page.getByLabel('Saved graph').locator('option')).toHaveCount(2);
  expect(await page.evaluate(() => window.__permission)).toBe('granted');
  await page.evaluate(() => {
    window.showDirectoryPicker = window.showOpenFilePicker = async () => { throw new DOMException('Canceled', 'AbortError'); };
  });
  for (const name of ['Link Folder', 'Open pattern']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.nodes-status')).toContainText('Canceled');
    await expect(page.getByLabel('Graph name')).toHaveValue('Neon composite');
  }
  await page.evaluate(() => { window.showDirectoryPicker = undefined; window.showOpenFilePicker = undefined; });
  for (const name of ['Link Folder', 'Open pattern']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.nodes-status')).toContainText('desktop Chrome');
  }
});

test('outside picker files survive reload; invalid and oversized files never replace draft', async ({ page, context }) => {
  await page.goto('/?role=nodes'); await openFixture(page);
  const before = await diskText(page);
  await page.evaluate(async text => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('outside', { create: true });
    const handle = await dir.getFileHandle('outside.json', { create: true });
    const writer = await handle.createWritable();
    const data = JSON.parse(text); data.graph.name = 'Outside pattern';
    await writer.write(JSON.stringify(data)); await writer.close();
    window.showOpenFilePicker = async () => [handle];
  }, before);
  await page.getByRole('button', { name: 'Open pattern', exact: true }).click();
  await expect(page.getByLabel('Graph name')).toHaveValue('Outside pattern');
  const main = await context.newPage(); await main.goto('/');
  await expect(main.locator('.library-btn').filter({ hasText: 'Outside pattern' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Saved graph').locator('option')).toHaveCount(3);
  const id = await page.getByLabel('Saved graph').locator('option').filter({ hasText: 'Outside pattern' }).getAttribute('value');
  await page.getByLabel('Saved graph').selectOption(id);
  await page.getByRole('button', { name: 'Load pattern', exact: true }).click();
  await expect(page.getByLabel('Graph name')).toHaveValue('Outside pattern');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.nodes-status')).toContainText('Outside-pattern.nodes.json');
  expect(await diskText(page)).toBe(before);
  for (const [text, message] of [['{"format":"viz2-nodes","version":99}', 'Unsupported'], ['x'.repeat(200001), '200 KB']]) {
    await page.evaluate(async text => {
      const handle = await (await navigator.storage.getDirectory()).getFileHandle('bad.json', { create: true });
      const writer = await handle.createWritable(); await writer.write(text); await writer.close();
      window.showOpenFilePicker = async () => [handle];
    }, text);
    await page.getByRole('button', { name: 'Open pattern', exact: true }).click();
    await expect(page.locator('.nodes-status')).toContainText(message);
    await expect(page.getByLabel('Graph name')).toHaveValue('Outside pattern');
  }
});

test('background reload never prompts; disk is reread rather than stale browser content', async ({ page }) => {
  await page.goto('/?role=nodes'); await openFixture(page);
  await page.addInitScript(() => {
    window.__permission = 'prompt';
    window.__requests = 0;
    FileSystemHandle.prototype.requestPermission = async () => { window.__requests++; window.__permission = 'granted'; return 'granted'; };
  });
  await page.reload();
  await expect(page.locator('.nodes-status')).toContainText('Permission denied or expired');
  await expect(page.getByLabel('Saved graph').locator('option')).toHaveCount(1);
  expect(await page.evaluate(() => window.__requests)).toBe(0);
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await expect(page.getByLabel('Saved graph').locator('option')).toHaveCount(2);
  expect(await page.evaluate(() => window.__requests)).toBe(1);
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns');
    const handle = await dir.getFileHandle('neon.nodes.json');
    const data = JSON.parse(await (await handle.getFile()).text()); data.graph.name = 'External edit';
    const writer = await handle.createWritable(); await writer.write(JSON.stringify(data)); await writer.close();
  });
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await expect(page.getByLabel('Saved graph')).toContainText('External edit');
});

test('folder switch is atomic on storage failure and successful switch keeps files intact', async ({ page }) => {
  await page.goto('/?role=nodes'); await openFixture(page);
  const before = await diskText(page);
  await page.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('other-folder', { create: true });
    window.showDirectoryPicker = async () => dir;
    const store = nodePatterns.store;
    nodePatterns.store = async function (key, value) { if (arguments.length > 1) throw Error('Mock storage quota'); return store(key); };
    window.__restoreStore = () => { nodePatterns.store = store; };
  });
  await page.getByRole('button', { name: 'Link Folder', exact: true }).click();
  await expect(page.locator('.nodes-status')).toContainText('Mock storage quota');
  await expect(page.getByLabel('Saved graph').locator('option')).toHaveCount(2);
  await page.evaluate(() => window.__restoreStore());
  await page.getByRole('button', { name: 'Link Folder', exact: true }).click();
  await expect(page.locator('.nodes-status')).toContainText('Linked other-folder');
  await expect(page.getByLabel('Saved graph').locator('option')).toHaveCount(1);
  expect(await diskText(page)).toBe(before);
  await expect(page.getByLabel('Graph name')).toHaveValue('Neon composite');
});
