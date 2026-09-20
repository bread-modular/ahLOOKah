import { test, expect } from '@playwright/test';
import { validateGraph, connectSignal, mapSignal, deleteNode, connect } from '../src/nodes/model.js';
import { parameterView, numeric, mappedValue, signalValue, OPACITY } from '../src/nodes/modulation.js';
import { parseGraph, serializeGraph } from '../src/nodes/portability.js';
import { adaptPattern } from '../src/custom-scripts/adapter.js';
import { NODE_AUDIO_SOURCE } from '../src/nodes/audio-source.js';
import { SharedAudioAnalysisView } from '../src/pattern-audio-engine.js';
import { response } from '../src/sketches/feature-controls.js';

const graph = () => ({ version: 1, name: 'Audio ranges', nodes: [
  { id: 'color', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .2, pulse: 0 }, x: 50, y: 50 },
  { id: 'mix', type: 'blend', mode: 'Normal', opacity: .3, x: 330, y: 50 },
  { id: 'audio', type: 'audio', band: 'bass', x: 50, y: 310 },
  { id: 'audio2', type: 'audio', band: 'high', x: 330, y: 310 },
  { id: 'output', type: 'output', x: 600, y: 50 },
], edges: [{ from: 'color', to: 'output', port: 'image' }] });
const spectrum = band => {
  const left = new Float32Array(1024).fill(-120);
  left[{ bass: 4, mid: 45, high: 320 }[band]] = -22;
  return { left, right: left.slice(), sampleRate: 48000, fftSize: 2048, rms: .12 };
};

test('Audio bands use exact custom-script normalization, isolated bands and deterministic silence', () => {
  for (const band of ['bass', 'mid', 'high']) {
    const script = adaptPattern({ file: 'test', definition: { id: 'test' } }, () => {});
    const custom = script.createAudioController(), audio = NODE_AUDIO_SOURCE.createAudioController();
    for (let i = 0; i < 20; i++) {
      const frame = spectrum(band), shared = new SharedAudioAnalysisView(frame, 1 / 30);
      const input = { frame, shared, deltaSeconds: 1 / 30, params: {} };
      const expected = custom.update(input).continuous;
      const result = audio.update(input).continuous;
      expect(result).toEqual(expected);
      expect(signalValue(result, band)).toBe(response(expected[band]));
      expect(signalValue(result, band)).toBeGreaterThan(0);
      expect(signalValue(result, band)).toBeLessThanOrEqual(1);
    }
    expect(audio.update({ frame: null }).continuous).toEqual({ bass: 0, mid: 0, high: 0, kick: 0, snare: 0, hat: 0, beat: 0, energy: 0 });
    audio.dispose(); expect(audio.update({ frame: spectrum(band) }).continuous.bass).toBe(0);
  }
  expect(signalValue({ bass: 999 }, 'bass')).toBe(1);
  expect(signalValue({ bass: NaN }, 'bass')).toBe(0);
});

test('signal persistence, explicit replacement, fanout, deletion and malformed graph validation', () => {
  let g = connectSignal(graph(), 'audio', 'color');
  g = mapSignal(g, 'audio', 'color', 'brightness', .2, .8);
  g = mapSignal(g, 'audio', 'mix', 'opacity', .9, .1);
  expect(g.modulations).toHaveLength(2);
  expect(() => mapSignal(g, 'audio2', 'mix', 'opacity', 0, 1)).toThrow(/replace/);
  expect(mapSignal(g, 'audio2', 'mix', 'opacity', 0, 1, true).modulations).toHaveLength(2);
  const deps = [{ id: 'solid-color', kind: 'built-in', name: 'Solid Color', signature: null }];
  expect(parseGraph(serializeGraph(g, deps)).graph).toEqual(g);
  expect(deleteNode(g, 'audio').modulations).toEqual([]);
  expect(deleteNode(g, 'mix').modulations).toHaveLength(1);
  expect(() => connect(g, 'audio', 'output', 'image')).toThrow(/port/);
  for (const bad of [null, { from: 'nope', to: 'mix' }, { from: 'audio', to: 'output' }, { from: 'color', to: 'mix' }, { from: 'audio', to: 'mix', param: 'mode', min: 0, max: 1 }, { from: 'audio', to: 'color', param: '__proto__', min: 0, max: 1 }, { from: 'audio', to: 'mix', param: 'opacity', min: NaN, max: 1 }]) {
    expect(() => validateGraph({ ...g, modulations: [bad] })).toThrow();
  }
  expect(() => validateGraph({ ...g, modulations: [...g.modulations, g.modulations[0]] })).toThrow(/Duplicate/);
  expect(() => validateGraph({ ...g, modulations: {} })).toThrow();
  const old = { ...graph(), nodes: graph().nodes.filter(n => n.type !== 'audio') };
  expect(validateGraph(old)).toEqual(old);
});

test('mapped numeric views fan out, step/clamp/reverse and never mutate bases', () => {
  let g = mapSignal(graph(), 'audio', 'color', 'brightness', .2, .8);
  g = mapSignal(g, 'audio', 'mix', 'opacity', .9, .1);
  const before = JSON.stringify(g), sketches = [{ id: 'solid-color', params: [{ ...OPACITY, key: 'brightness', default: .2 }] }];
  let continuous = { bass: 1.6 };
  const a = parameterView(g, g.nodes[0], sketches, () => continuous), b = parameterView(g, g.nodes[1], sketches, () => continuous);
  expect(a.brightness).toBe(.5); expect(b.opacity).toBe(.5);
  continuous = {}; expect(a.brightness).toBe(.2); expect(b.opacity).toBe(.9);
  continuous = { bass: 3.2 }; expect(a.brightness).toBe(.8); expect(b.opacity).toBe(.1);
  expect(JSON.stringify(g)).toBe(before);
  expect(mappedValue({ min: -100, max: 100 }, 1, OPACITY)).toBe(1);
  expect(mappedValue({ min: 0, max: 1 }, .127, OPACITY)).toBe(.13);
  for (const def of [{ ...OPACITY, options: [] }, { ...OPACITY, type: 'boolean' }, { ...OPACITY, type: 'text' }]) expect(numeric(def)).toBe(false);
});

async function openFixture(page, data = graph()) {
  await page.goto('/?role=nodes');
  const id = await page.evaluate(async g => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('audio-tests', { create: true });
    const f = await dir.getFileHandle('audio.nodes.json', { create: true });
    const w = await f.createWritable(); await w.write(serializeGraph(g, manifestFor(g, SKETCHES))); await w.close();
    window.showDirectoryPicker = async () => dir; await nodePatterns.link(); return (await nodePatterns.open('audio.nodes.json')).id;
  }, data);
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue(data.name);
}
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => { FileSystemHandle.prototype.queryPermission = async () => 'granted'; FileSystemHandle.prototype.requestPermission = async () => 'granted'; });
});

test('preview and saved runtime use injected controls consistently without visual Audio budget or base writes', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async g => {
    const { GraphRuntime, graphFactory } = await import('/src/nodes/runtime.js');
    const { ProgramRuntime } = await import('/src/program-runtime.js');
    const { default: Core } = await import('/src/core/index.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { mapSignal } = await import('/src/nodes/model.js');
    g = mapSignal(g, 'audio', 'color', 'brightness', .2, .8);
    g = mapSignal(g, 'audio', 'mix', 'opacity', .9, .1);
    g.nodes.push({ id: 'black', type: 'pattern', patternId: 'solid-color', x: 0, y: 0, params: { hue: 0, saturation: 0, brightness: 0, pulse: 0 } });
    g.edges = [{ from: 'black', to: 'mix', port: 'base' }, { from: 'color', to: 'mix', port: 'layer' }, { from: 'mix', to: 'output', port: 'image' }];
    let signal = { bass: 1.6 };
    const store = { upsertSlot() {}, retireSlots() {}, createBinding: () => ({ read: () => ({ continuous: signal }), noteDraw() {}, setEventDeliveryEnabled() {} }) };
    const children = [];
    const preview = new GraphRuntime({ graph: g, sketches: SKETCHES, context: { audioControlStore: store, registerChildRuntime: c => children.push(c) } });
    await preview.ready;
    const nodeSketch = { id: 'nodes-test', nodesGraph: true, params: [], factory: graphFactory({ graph: g }, SKETCHES) };
    const layer = document.createElement('div');
    const saved = new ProgramRuntime({ coreConstructor: Core, selection: { ids: [nodeSketch.id], merge: false }, sketches: [...SKETCHES, nodeSketch], audioControlStore: store,
      getParams: () => ({}), layer, getSize: () => [48, 48], preview: false });
    await saved.prepare();
    const pixel = c => c.getContext('2d').getImageData(1, 1, 1, 1).data[0];
    await new Promise(r => setTimeout(r, 150));
    const half = [pixel(preview.render()), pixel(layer.querySelector('canvas'))];
    signal = {}; await new Promise(r => setTimeout(r, 150));
    const silent = [pixel(preview.render()), pixel(layer.querySelector('canvas'))];
    const slots = children.flatMap(c => c.getAudioSlotDescriptors('preview'));
    const info = { half, silent, canvasCount: preview.buffers.size, sourceCount: preview.sources.size, signals: slots.filter(s => s.patternId === '__node_audio_signal').length, base: preview.graph.nodes[0].params.brightness, opacity: preview.params.get('mix').opacity };
    preview.dispose(); saved.dispose(); return info;
  }, graph());
  for (const value of result.half) expect(Math.abs(value - 64)).toBeLessThanOrEqual(1);
  for (const value of result.silent) expect(Math.abs(value - 46)).toBeLessThanOrEqual(1);
  expect(result.canvasCount).toBe(4); expect(result.sourceCount).toBe(2); expect(result.signals).toBe(1); expect(result.base).toBe(.2); expect(result.opacity).toBe(.9);
});

test('endpoint selection, accessible mapping, drag-to-slider, range gestures, replacement and disk round trip', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  await openFixture(page);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.getByLabel('audio output', { exact: true }).click(); await page.getByLabel('color signal endpoint', { exact: true }).click();
  await expect(page.getByLabel('Target parameter')).toBeVisible();
  await page.getByLabel('Target parameter').selectOption('brightness'); await page.getByRole('button', { name: 'Map / replace parameter' }).click();
  const low = page.getByLabel('Brightness Mapping min (signal 0)', { exact: true }), high = page.getByLabel('Brightness Mapping max (signal 1)', { exact: true });
  await expect(low).toHaveValue('0.2'); await low.fill('0.3'); await high.fill('0.7');
  await page.getByRole('button', { name: 'Reverse range' }).click(); await expect(low).toHaveValue('0.7'); await expect(high).toHaveValue('0.3');
  const box = page.getByTestId('mapping-box-brightness'); await box.scrollIntoViewIfNeeded(); const rect = await box.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2 - 20, rect.y + rect.height / 2, { steps: 3 }); await page.mouse.up();
  expect(Number(await low.inputValue())).toBeLessThan(.7);
  const oldHigh = Number(await high.inputValue());
  const handle = page.locator('[data-param-target=brightness] .nodes-mapping-handle').last();
  const h = await handle.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down(); await page.mouse.move(h.x + h.width / 2 + 15, h.y + h.height / 2, { steps: 3 }); await page.mouse.up();
  expect(Number(await high.inputValue())).toBeGreaterThan(oldHigh);
  await expect(page.getByRole('slider', { name: 'Brightness', exact: true })).toHaveValue('0.2');
  const chip = page.getByRole('button', { name: /Audio · bass · drag/ });
  await chip.dragTo(page.getByRole('slider', { name: 'Saturation', exact: true }));
  await expect(page.getByLabel('Saturation Mapping min (signal 0)', { exact: true })).toHaveValue('1');
  await page.getByLabel('audio output', { exact: true }).click(); await page.getByLabel('mix signal endpoint', { exact: true }).click();
  await page.getByLabel('Target parameter').selectOption('opacity'); await page.getByRole('button', { name: 'Map / replace parameter' }).click();
  await expect(page.getByLabel('Opacity Mapping min (signal 0)', { exact: true })).toHaveValue('0.3');
  await page.getByLabel('audio2 output', { exact: true }).click(); await page.getByLabel('mix signal endpoint', { exact: true }).click();
  await page.getByLabel('Target parameter').selectOption('opacity');
  page.once('dialog', d => d.dismiss()); await page.getByRole('button', { name: 'Map / replace parameter' }).click();
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Map / replace parameter' }).click();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.locator('.nodes-status')).toHaveCount(0);
  const persisted = await page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('audio-tests');
    return JSON.parse(await (await (await d.getFileHandle('audio.nodes.json')).getFile()).text()).graph;
  });
  expect(persisted.modulations.filter(m => m.param)).toHaveLength(3);
  expect(persisted.modulations.find(m => m.param === 'opacity').from).toBe('audio2');
  expect(persisted.nodes.find(n => n.id === 'color').params.brightness).toBe(.2);
  await page.reload(); await page.getByLabel('mix signal endpoint', { exact: true }).click(); await expect(page.getByLabel('Target parameter')).toBeVisible();
  await page.getByLabel('color signal endpoint', { exact: true }).click();
  await page.screenshot({ path: '/tmp/nodes-audio-editor.png', fullPage: true });
  await page.getByLabel('audio2 output', { exact: true }).click();
  await page.getByLabel('Audio band').selectOption('mid');
  await page.getByRole('button', { name: 'Delete node', exact: true }).click();
  await expect(page.locator('.nodes-signal-wire')).toHaveCount(2); // both Pattern mappings survive; deleted Audio's Blend link is removed
  expect(errors).toEqual([]);
});

test('palette uses edge scrollbar, equal row/search widths, overflow only, and drag-only creation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/?role=nodes');
  const palette = page.locator('.nodes-palette');
  const geometry = () => page.evaluate(() => {
    const p = document.querySelector('.nodes-palette'), q = p.querySelector('input'), row = p.querySelector('.nodes-pattern-list button');
    return { search: q.getBoundingClientRect().width, row: row.getBoundingClientRect().width, overflow: p.scrollHeight > p.clientHeight, gutter: getComputedStyle(p).scrollbarGutter, overflowY: getComputedStyle(p).overflowY, listOverflow: getComputedStyle(p.querySelector('.nodes-pattern-list')).overflowY };
  });
  await expect.poll(async () => (await geometry()).overflow).toBe(true);
  let g = await geometry(); expect(g.row).toBeCloseTo(g.search, 1); expect(g.gutter).toBe('auto'); expect(g.overflowY).toBe('auto'); expect(g.listOverflow).toBe('visible');
  await page.getByLabel('Search patterns').fill('checkerboard');
  g = await geometry(); expect(g.overflow).toBe(false); expect(g.row).toBeCloseTo(g.search, 1);
  await page.locator('.nodes-pattern-list button').click(); await expect(page.locator('.nodes-node')).toHaveCount(1);
  await page.locator('.nodes-pattern-list button').dragTo(page.getByLabel('Graph workspace'), { targetPosition: { x: 80, y: 100 } });
  await expect(page.locator('.nodes-node')).toHaveCount(2);
  await page.getByLabel('Search patterns').fill(''); await palette.hover(); await page.mouse.wheel(0, 300); await expect.poll(() => palette.evaluate(p => p.scrollTop)).toBeGreaterThan(0);
  await palette.evaluate(p => p.scrollTop = 0); await page.screenshot({ path: '/tmp/nodes-palette-toolbar.png' });
});

test('Node Patterns ADD matches shared Custom Scripts and Projection action typography', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 }); await page.goto('/');
  const add = page.getByRole('link', { name: 'New Node Pattern', exact: true }); await expect(add).toBeVisible();
  const style = el => { const s = getComputedStyle(el); return Object.fromEntries(['fontFamily', 'fontWeight', 'fontSize', 'letterSpacing', 'lineHeight', 'padding', 'borderRadius'].map(k => [k, s[k]])); };
  expect(await add.evaluate(style)).toEqual(await page.getByRole('button', { name: 'New Script', exact: true }).evaluate(style));
  const projection = page.locator('.library-group').filter({ has: page.locator('.library-group-toggle', { hasText: 'Projection Mapping' }) }).locator('.library-add-btn');
  if (await projection.count()) expect(await add.evaluate(style)).toEqual(await projection.first().evaluate(style));
  await add.scrollIntoViewIfNeeded(); await page.screenshot({ path: '/tmp/nodes-library-toolbar.png' });
});

test('standalone editor receives shared capture-owner controls over the bus without microphone acquisition', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { createEditorAudio, createSignalConsumer } = await import('/src/nodes/audio-provider.js');
    const { PatternAudioControlEngine } = await import('/src/pattern-audio-engine.js');
    const { CHANNEL_NAME } = await import('/src/platform/constants.js');
    let acquisitions = 0;
    navigator.mediaDevices.getUserMedia = async () => { acquisitions++; throw new Error('No microphone allowed'); };
    const engine = new PatternAudioControlEngine({ ownerId: 'test-owner', getSketchById: () => null });
    const owner = new BroadcastChannel(CHANNEL_NAME);
    const editor = createEditorAudio(); const consumer = createSignalConsumer(editor.store);
    let planAccepted = false;
    owner.onmessage = ({ data }) => {
      if (data.type !== 'pattern-audio-plan') return;
      planAccepted = engine.receivePlan(data);
      const left = new Float32Array(1024).fill(-120); left[4] = -22;
      for (const packet of engine.update({ frame: { left, right: left, sampleRate: 48000, fftSize: 2048, rms: .1 }, deltaSeconds: 1 / 30, captureTime: 1, sequence: 1 }).packets) owner.postMessage(packet);
    };
    editor.setChildren([consumer]);
    for (let i = 0; i < 100 && !consumer.read().bass; i++) await new Promise(r => setTimeout(r, 10));
    const activity = consumer.read();
    editor.dispose(); consumer.dispose(); owner.close(); engine.disposeControllers();
    return { acquisitions, planAccepted: !!planAccepted, activity };
  });
  expect(result.acquisitions).toBe(0); expect(result.planAccepted).toBe(true); expect(result.activity.bass).toBeGreaterThan(0);
});

test('main preview and real saved LIVE/CUE plans retain the non-visual audio slot', async ({ page, context }) => {
  test.setTimeout(60000);
  await openFixture(page, mapSignal(graph(), 'audio', 'color', 'brightness', .2, .8));
  await page.goto('/');
  await page.evaluate(() => {
    window.__nodePlans = [];
    window.__nodeObserver = new BroadcastChannel('viz2_channel');
    window.__nodeObserver.onmessage = ({ data }) => { if (data.type === 'pattern-audio-plan') window.__nodePlans.push(data); };
  });
  const button = page.locator('.library-btn').filter({ hasText: 'Audio ranges' }); await expect(button).toBeVisible();
  await button.click();
  await expect.poll(() => page.evaluate(() => window.__nodePlans.some(p => p.slots.some(s => s.patternId === '__node_audio_signal' && s.role === 'preview')))).toBe(true);
  const screen = await context.newPage(); await screen.goto('/?role=screen'); await page.waitForFunction(() => window.__viz?.screenOnline);
  await button.click({ modifiers: ['Shift'] }); await screen.waitForFunction(() => window.__viz.cue?.phase === 'ready');
  await expect.poll(() => page.evaluate(() => window.__nodePlans.some(p => p.slots.some(s => s.patternId === '__node_audio_signal' && s.role === 'cue')))).toBe(true);
  await page.keyboard.press('Enter'); await screen.waitForFunction(() => window.__viz.cue === null);
  await expect.poll(() => page.evaluate(() => window.__nodePlans.some(p => p.slots.some(s => s.patternId === '__node_audio_signal' && s.role === 'live')))).toBe(true);
});

test('Audio creation supports multiple nodes and refuses enum mapping in the inspector', async ({ page }) => {
  await page.goto('/?role=nodes');
  const source = await page.evaluate(async () => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const s = SKETCHES.find(s => s.id === 'checkerboard'), d = s.params[0];
    d.options = [{ label: 'Low', value: d.min }, { label: 'High', value: d.max }];
    return { label: d.label, key: d.key };
  });
  await page.getByLabel('Search patterns').fill('checkerboard');
  await page.locator('.nodes-pattern-list button').dragTo(page.getByLabel('Graph workspace'), { targetPosition: { x: 40, y: 40 } });
  const target = await page.locator('.nodes-node').filter({ has: page.getByRole('button', { name: 'Select Checkerboard', exact: true }) }).getAttribute('data-node-id');
  await page.getByRole('button', { name: '+ Audio', exact: true }).click();
  const from = await page.locator('.nodes-node[data-primary=true]').getAttribute('data-node-id');
  await page.getByLabel(`${from} output`, { exact: true }).click(); await page.getByLabel(`${target} signal endpoint`, { exact: true }).click();
  await expect(page.getByLabel('Target parameter').locator(`option[value="${source.key}"]`)).toHaveAttribute('disabled', '');
  await page.getByRole('button', { name: /Audio · bass · drag/ }).dragTo(page.getByLabel(source.label, { exact: true }));
  await expect(page.locator('.nodes-status')).toContainText('Unsupported: only numeric sliders');
  await expect(page.locator('.nodes-mapping-box')).toHaveCount(0);
  await page.getByRole('button', { name: '+ Audio', exact: true }).click(); await page.getByLabel('Audio band').selectOption('high');
  await expect(page.getByRole('button', { name: 'Select Audio · bass', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Select Audio · high', exact: true })).toHaveCount(1);
});
