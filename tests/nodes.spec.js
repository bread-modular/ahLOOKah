import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { validateGraph, connect, deleteNode } from '../src/nodes/model.js';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

const graph = () => ({ version: 1, name: 'Neon composite', nodes: [
  { id: 'red', type: 'pattern', patternId: 'solid-color', x: 40, y: 60, params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 } },
  { id: 'green', type: 'pattern', patternId: 'solid-color', x: 40, y: 290, params: { hue: 1 / 3, saturation: 1, brightness: 1, pulse: 0 } },
  { id: 'mix', type: 'blend', x: 330, y: 170, mode: 'Screen', opacity: 1 },
  { id: 'output', type: 'output', x: 620, y: 170 },
], edges: [{ from: 'red', to: 'mix', port: 'base' }, { from: 'green', to: 'mix', port: 'layer' }, { from: 'mix', to: 'output', port: 'image' }] });
async function importFixture(page, data = graph()) {
  const file = await page.evaluate(async graph => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, exportGraph } = await import('/src/nodes/portability.js');
    return exportGraph(graph, manifestFor(graph, SKETCHES));
  }, data);
  await page.getByLabel('Import graph file').setInputFiles({ name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(file) });
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
  await page.goto('/?role=nodes'); await importFixture(page);
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

test('immutable persistence, export/import, reload and isolated drafts across tabs', async ({ page, context }) => {
  await page.goto('/?role=nodes'); await importFixture(page);
  await page.getByRole('button', { name: 'Save revision', exact: true }).click();
  await expect(page.locator('.nodes-status')).toContainText('Saved Neon composite');
  const second = await context.newPage(); await second.goto('/?role=nodes');
  await expect(second.getByLabel('Graph name')).toHaveValue('Untitled graph');
  await expect(second.getByLabel('Saved graph').locator('option')).toHaveCount(2);
  await page.getByLabel('Graph name').fill('New revision');
  await page.getByRole('button', { name: 'Save revision', exact: true }).click();
  await expect(second.getByLabel('Saved graph').locator('option')).toHaveCount(3);
  await page.reload(); await expect(page.getByLabel('Graph name')).toHaveValue('New revision');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const text = await readFile(await (await download).path(), 'utf8');
  expect(JSON.parse(text).dependencies[0].id).toBe('solid-color');
  await second.getByLabel('Import graph file').setInputFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(second.getByLabel('Graph name')).toHaveValue('New revision');
  await expect.poll(() => pixel(second)).toEqual([255, 255, 0, 255]);
  await second.getByLabel('Import graph file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"viz2-nodes","version":99}') });
  await expect(second.locator('.nodes-status')).toContainText('Unsupported');
  await expect(second.getByLabel('Graph name')).toHaveValue('New revision');
});

test('main link opens isolated editor; saved graph is selectable on real output; saves never replace LIVE', async ({ page, context }) => {
  test.setTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  const opened = context.waitForEvent('page'); await page.getByRole('link', { name: 'Open Nodes editor' }).click();
  const editor = await opened; await editor.waitForURL('**/?role=nodes');
  expect(await editor.evaluate(() => Boolean(window.__viz))).toBe(false);
  await importFixture(editor); await editor.getByRole('button', { name: 'Save revision' }).click();
  const button = page.locator('.library-btn').filter({ hasText: 'Neon composite' });
  await expect(button).toBeVisible();
  const id = await button.getAttribute('data-id');
  const screen = await context.newPage(); await screen.goto('/?role=screen');
  await page.waitForFunction(() => window.__viz?.screenOnline);
  await button.click();
  await expect.poll(() => screen.evaluate(id => Boolean(document.querySelector(`[data-program-ids="${id}"] canvas`)), id)).toBe(true);
  await expect.poll(() => screen.evaluate(id => { const c = document.querySelector(`[data-program-ids="${id}"] canvas`); return c && [...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data]; }, id)).toEqual([255, 255, 0, 255]);
  await editor.getByLabel('Graph name').fill('Unpromoted'); await editor.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.locator('.library-btn').filter({ hasText: 'Unpromoted' })).toBeVisible();
  await expect(screen.locator(`[data-program-ids="${id}"]`)).toBeVisible();
  await page.locator('.library-btn').filter({ hasText: 'Unpromoted' }).click({ modifiers: ['Shift'] });
  await screen.waitForFunction(() => window.__viz.cue?.phase === 'ready');
  const childSlots = await screen.evaluate(() => Object.values(window.__viz.patternAudio.store.slots).filter(s => s.patternId === 'solid-color'));
  expect(childSlots.length).toBeGreaterThanOrEqual(4);
  await page.keyboard.press('Enter');
  await screen.waitForFunction(old => window.__viz.patternId !== old && window.__viz.cue === null, id);
  expect(errors).toEqual([]);
});

test('missing dependencies and camera preview are visible and never acquire capture', async ({ page }) => {
  await page.addInitScript(() => { window.captureCalls = 0; navigator.mediaDevices.getUserMedia = async () => { window.captureCalls++; throw new Error('unexpected capture'); }; });
  await page.goto('/?role=nodes');
  const cameraGraph = graph(); cameraGraph.nodes[0].patternId = 'video-chroma'; cameraGraph.nodes[0].params = {};
  await importFixture(page, cameraGraph);
  await expect(page.locator('.nodes-diagnostics')).toContainText('Camera is available only');
  expect(await page.evaluate(() => window.captureCalls)).toBe(0);
  const missing = graph(); missing.nodes[0].patternId = 'missing-file'; missing.nodes[0].params = {};
  await importFixture(page, missing);
  await expect(page.locator('.nodes-diagnostics')).toContainText('Missing pattern');
  await page.getByRole('button', { name: 'Save revision' }).click(); await expect(page.locator('.nodes-status')).toContainText('Missing pattern');
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

test('dependency changes and malformed saved records fail visibly without corrupting library', async ({ page }) => {
  await page.goto('/?role=nodes'); await importFixture(page);
  const result = await page.evaluate(async graph => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, sourceDiagnostics } = await import('/src/nodes/portability.js');
    const { saveGraph, listGraphs, PREFIX } = await import('/src/nodes/repository.js');
    const manifest = manifestFor(graph, SKETCHES);
    const first = saveGraph(graph, manifest), second = saveGraph(graph, manifest);
    localStorage.setItem(PREFIX + 'nodes-00000000-0000-0000-0000-000000000000', '{broken');
    const changed = SKETCHES.map(s => s.id === 'solid-color' ? { ...s, params: [] } : s);
    return { count: listGraphs().length, unique: first.id !== second.id, diagnostics: sourceDiagnostics(graph, changed, manifest) };
  }, graph());
  expect(result.count).toBe(2); expect(result.unique).toBe(true); expect(result.diagnostics.join()).toContain('Changed dependency');
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
  await page.goto('/?role=nodes'); await importFixture(page);
  await expect.poll(() => pixel(page)).toEqual([255, 255, 0, 255]);
  await expect(page.getByRole('button', { name: 'Save revision' })).toHaveClass('btn btn--solid');
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
  await expect(page.getByRole('button', { name: 'Save revision' })).toBeInViewport();
  await expect(page.getByLabel('Brightness', { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
