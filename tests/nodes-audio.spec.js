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
  await expect(page.locator('.nodes-signal-chip')).toHaveCount(1);
  await page.locator('.nodes-signal-chip').dragTo(page.getByRole('slider', { name: 'Brightness', exact: true }));
  const low = page.getByLabel('Brightness Mapping min', { exact: true }), high = page.getByLabel('Brightness Mapping max', { exact: true });
  await expect(low).toHaveCount(0); // collapsed by default
  await page.getByRole('button', { name: 'Brightness mapping settings' }).click();
  await expect(low).toHaveValue('0.2'); await low.fill('0.3'); await high.fill('0.7');
  // Reversing is a field edit now (min above max is a valid sweep): max first so
  // the two edits never pass through an equal pair.
  await high.fill('0.3'); await low.fill('0.7'); await expect(low).toHaveValue('0.7'); await expect(high).toHaveValue('0.3');
  const settings = page.getByRole('button', { name: 'Brightness mapping settings' });
  const box = page.getByTestId('mapping-box-brightness'); await box.scrollIntoViewIfNeeded(); const rect = await box.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2 - 20, rect.y + rect.height / 2, { steps: 3 }); await page.mouse.up();
  // Moving the range is a drag: the settings collapse and stay collapsed.
  await expect(low).toHaveCount(0);
  await settings.click();
  expect(Number(await low.inputValue())).toBeLessThan(.7);
  const oldHigh = Number(await high.inputValue());
  const handle = page.locator('[data-param-target=brightness] .nodes-mapping-handle').last();
  const h = await handle.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down(); await page.mouse.move(h.x + h.width / 2 + 15, h.y + h.height / 2, { steps: 3 }); await page.mouse.up();
  await expect(high).toHaveCount(0); // resizing never reopens the fields
  await settings.click();
  expect(Number(await high.inputValue())).toBeGreaterThan(oldHigh);
  await expect(page.getByRole('slider', { name: 'Brightness', exact: true })).toHaveValue('0.2');
  const chip = page.getByRole('button', { name: 'Audio · bass', exact: true });
  await chip.dragTo(page.getByRole('slider', { name: 'Saturation', exact: true }));
  await page.getByRole('button', { name: 'Saturation mapping settings' }).click();
  await expect(page.getByLabel('Saturation Mapping min', { exact: true })).toHaveValue('1');
  await page.getByLabel('audio output', { exact: true }).click(); await page.getByLabel('mix signal endpoint', { exact: true }).click();
  await page.locator('.nodes-signal-chip').dragTo(page.getByRole('slider', { name: 'Opacity', exact: true }));
  await page.getByRole('button', { name: 'Opacity mapping settings' }).click();
  await expect(page.getByLabel('Opacity Mapping min', { exact: true })).toHaveValue('0.3');
  // Dropping another connected signal on the same slider is the replacement path.
  await page.getByLabel('audio2 output', { exact: true }).click(); await page.getByLabel('mix signal endpoint', { exact: true }).click();
  const highChip = page.getByRole('button', { name: 'Audio · high', exact: true });
  page.once('dialog', d => d.dismiss()); await highChip.dragTo(page.getByTestId('mapping-box-opacity'));
  page.once('dialog', d => d.accept()); await highChip.dragTo(page.getByTestId('mapping-box-opacity'));
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.locator('.nodes-workspace')).not.toHaveAttribute('data-status', /.+/);
  const persisted = await page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('audio-tests');
    return JSON.parse(await (await (await d.getFileHandle('audio.nodes.json')).getFile()).text()).graph;
  });
  expect(persisted.modulations.filter(m => m.param)).toHaveLength(3);
  expect(persisted.modulations.find(m => m.param === 'opacity').from).toBe('audio2');
  expect(persisted.nodes.find(n => n.id === 'color').params.brightness).toBe(.2);
  await page.reload(); await page.getByLabel('mix signal endpoint', { exact: true }).click();
  // The endpoint selects the connection (not the node): the sidebar names the one
  // mapping and the surviving chip, and the node itself stays deletable-proof.
  await expect(page.getByTestId('selected-connection')).toHaveText('Audio · high → Blend opacity (modulation)');
  await expect(page.getByRole('button', { name: 'Audio · high', exact: true })).toHaveCount(1);
  await expect(page.locator('.nodes-node[data-node-id=mix]')).not.toHaveClass(/is-selected/);
  await page.getByLabel('color signal endpoint', { exact: true }).click();
  await page.screenshot({ path: '/tmp/nodes-audio-editor.png', fullPage: true });
  await page.getByLabel('audio2 output', { exact: true }).click();
  await page.getByLabel('Audio band').selectOption('mid');
  await page.getByLabel('Graph workspace').focus(); await page.keyboard.press('Delete');
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
  const add = page.getByRole('button', { name: 'New Node Pattern', exact: true }); await expect(add).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Audio · bass', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Audio · bass', exact: true }).dragTo(page.getByLabel(source.label, { exact: true }));
  await expect(page.locator('.nodes-workspace')).toHaveAttribute('data-status', /Unsupported: only numeric sliders/);
  await expect(page.locator('.nodes-mapping-box')).toHaveCount(0);
  await page.getByRole('button', { name: '+ Audio', exact: true }).click(); await page.getByLabel('Audio band').selectOption('high');
  await expect(page.getByRole('button', { name: 'Select Audio · bass', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Select Audio · high', exact: true })).toHaveCount(1);
});

const previewRed = page => page.getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(10, 10, 1, 1).data[0]);
async function sharedInput(main, active) {
  await main.evaluate(active => {
    window.__viz.captureAudio.isStarted = true;
    window.__viz.captureAudio.getAnalysisFrame = () => ({ left: new Float32Array(1024).fill(active ? -30 : -120), right: new Float32Array(1024).fill(active ? -30 : -120), sampleRate: 48000, fftSize: 2048, rms: active ? .2 : 0, time: performance.now() / 1000 });
  }, active);
}
test('ordinary editor audio reacts to changing main shared capture across tabs without Audio nodes', async ({ page, context }) => {
  await forbidEditorCapture(page);
  const main = await context.newPage(); await main.goto('/');
  await main.waitForFunction(() => window.__viz?.audioOwner);
  await sharedInput(main, false);
  const g = graph(); g.nodes = g.nodes.filter(n => n.type !== 'audio'); g.nodes[0].params.pulse = 1;
  await openFixture(page, g);
  await expect.poll(() => previewRed(page)).toBe(51);
  await sharedInput(main, true);
  await expect.poll(() => previewRed(page)).toBeGreaterThan(110);
  await sharedInput(main, false);
  await expect.poll(() => previewRed(page)).toBeLessThan(55);
  await page.locator('[data-node-id=color] .nodes-node-title').click();
  await page.getByLabel('Brightness', { exact: true }).fill('0.3');
  await sharedInput(main, true);
  await expect.poll(() => previewRed(page)).toBeGreaterThan(140);
  expect(await page.evaluate(() => window.editorCaptureCalls)).toBe(0);
});

test('mapped editor preview follows main input before and after graph edits', async ({ page, context }) => {
  const main = await context.newPage(); await main.goto('/'); await main.waitForFunction(() => window.__viz?.audioOwner);
  await sharedInput(main, false);
  await openFixture(page, mapSignal(graph(), 'audio', 'color', 'brightness', .2, .8));
  await expect.poll(() => previewRed(page)).toBe(51);
  await sharedInput(main, true);
  await expect.poll(() => previewRed(page)).toBeGreaterThan(80);
  await page.locator('[data-node-id=color] .nodes-node-title').click();
  await page.getByRole('button', { name: 'Brightness mapping settings' }).click();
  await page.getByLabel('Brightness Mapping min', { exact: true }).fill('0.4');
  await expect.poll(() => previewRed(page)).toBeGreaterThan(105);
  await sharedInput(main, false);
  await expect.poll(() => previewRed(page)).toBe(102);
});

// Inspect real rendered thumb pixels, not just a CSS class or disabled flag.
async function blueThumbPixels(page, locator) {
  const image = (await locator.screenshot()).toString('base64');
  return page.evaluate(async image => {
    const img = new Image(); img.src = `data:image/png;base64,${image}`; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = pixels.slice(i, i + 3);
      if (b > 80 && b > r * 1.5 && b > g * 1.2) count++;
    }
    return count;
  }, image);
}
async function forbidEditorCapture(page) {
  await page.addInitScript(() => {
    window.editorCaptureCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.editorCaptureCalls++; throw new Error('Editor must not capture'); };
  });
}
async function saveAndRead(page) {
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.locator('.nodes-workspace')).not.toHaveAttribute('data-status', /.+/);
  return page.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    return (await nodePatterns.load(new URLSearchParams(location.search).get('graph'))).graph;
  });
}

test('LIVE indicator follows actual selected preview across owner restart, reverse, remove and reload', async ({ page, context }, testInfo) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1536, height: 1050 });
  await forbidEditorCapture(page);
  const g = graph(); g.nodes = g.nodes.filter(n => !['mix', 'audio2'].includes(n.id));
  await openFixture(page, mapSignal(g, 'audio', 'color', 'brightness', .2, .8));
  await page.locator('[data-node-id=color] .nodes-node-title').click();
  const live = page.getByLabel('Brightness LIVE mapped value');
  const marker = page.getByTestId('mapping-live-brightness');
  const base = page.getByLabel('Brightness', { exact: true });
  await expect(base).toBeDisabled();
  expect(await blueThumbPixels(page, base)).toBe(0);
  await expect(page.locator('[data-param-target=brightness]')).toHaveClass(/is-mapped/);
  await expect(live).toHaveText('LIVE 0.2');
  await expect(marker).toHaveCSS('left', /.+/);
  expect(await marker.evaluate(el => el.style.left)).toBe('20%');
  let main = await context.newPage(); await main.goto('/'); await main.waitForFunction(() => window.__viz?.audioOwner);
  await sharedInput(main, true);
  await expect.poll(async () => Number((await live.textContent()).replace('LIVE ', ''))).toBeGreaterThan(.3);
  // Compare independent rendered pixels against the displayed stepped value,
  // allowing one frame of movement while the capture envelope settles.
  await expect.poll(async () => Math.abs((await previewRed(page)) / 255 - Number((await live.textContent()).replace('LIVE ', '')))).toBeLessThan(.025);
  expect(await base.inputValue()).toBe('0.2');
  await page.screenshot({ path: testInfo.outputPath('live-mapping.png') });
  await main.close();
  await expect(live).toHaveText('LIVE 0.2');
  await expect.poll(() => previewRed(page)).toBe(51);
  main = await context.newPage(); await main.goto('/'); await main.waitForFunction(() => window.__viz?.audioOwner); await sharedInput(main, true);
  await expect.poll(async () => Number((await live.textContent()).replace('LIVE ', ''))).toBeGreaterThan(.3);
  await page.getByRole('button', { name: 'Brightness mapping settings' }).click();
  // Reverse the sweep from the fields themselves: min above max is a valid range.
  await page.getByLabel('Brightness Mapping max', { exact: true }).fill('0.2');
  await page.getByLabel('Brightness Mapping min', { exact: true }).fill('0.8');
  await sharedInput(main, false);
  await expect(live).toHaveText('LIVE 0.8');
  await expect.poll(() => previewRed(page)).toBe(204);
  await expect.poll(() => marker.evaluate(el => el.style.left)).toBe('80%');
  await page.getByRole('button', { name: 'Remove mapping', exact: true }).click();
  await expect(marker).toHaveCount(0); await expect(base).toBeEnabled(); await expect(base).toHaveValue('0.2');
  expect(await blueThumbPixels(page, base)).toBeGreaterThan(20);
  await expect(page.locator('[data-param-target=brightness]')).not.toHaveClass(/is-mapped/);
  await expect.poll(() => previewRed(page)).toBe(51);
  expect(await page.evaluate(() => window.editorCaptureCalls)).toBe(0);
  const saved = await saveAndRead(page);
  expect(saved.nodes.find(n => n.id === 'color').params.brightness).toBe(.2);
  expect(saved.modulations || []).toEqual([]);
  await page.reload(); await page.locator('[data-node-id=color] .nodes-node-title').click();
  await expect(base).toBeEnabled(); await expect(base).toHaveValue('0.2');
  expect(await page.evaluate(() => window.editorCaptureCalls)).toBe(0);
});

for (const action of ['Delete', 'Backspace']) {
  test(`mixed multi-selection ${action} cleans incident links at zoom and persists with Output protected`, async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 1050 });
    let g = graph();
    g.nodes.push({ id: 'keep', type: 'pattern', patternId: 'solid-color', params: { hue: .5, saturation: 1, brightness: .4, pulse: 0 }, x: 560, y: 330 });
    g.edges = [{ from: 'color', to: 'mix', port: 'base' }, { from: 'keep', to: 'mix', port: 'layer' }, { from: 'keep', to: 'output', port: 'image' }];
    g = mapSignal(g, 'audio', 'color', 'brightness', .1, .9);
    g = mapSignal(g, 'audio', 'keep', 'hue', .1, .9);
    g = connectSignal(g, 'audio2', 'mix');
    g = mapSignal(g, 'audio2', 'keep', 'brightness', .2, .6);
    await openFixture(page, g);
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    const workspace = page.getByLabel('Graph workspace');
    const area = await workspace.boundingBox();
    await page.mouse.move(area.x + 400, area.y + 500); await page.mouse.down({ button: 'middle' });
    await page.mouse.move(area.x + 430, area.y + 520); await page.mouse.up({ button: 'middle' });
    const title = id => page.locator(`[data-node-id=${id}] .nodes-node-title`);
    await title('color').click();
    for (const id of ['mix', 'audio', 'output']) await title(id).click({ modifiers: ['Control'] });
    await expect(page.locator('.nodes-node.is-selected')).toHaveCount(4);
    await expect(page.locator('[data-node-id=output]')).toHaveAttribute('data-primary', 'true');
    // Output primary must not veto the group: every selected node is removable.
    await expect(page.locator('.nodes-node')).toHaveCount(6);
    // Editing inputs cannot accidentally delete the selected group.
    await page.getByLabel('Graph name').focus(); await page.keyboard.press('Backspace');
    await page.getByLabel('Search patterns').focus(); await page.keyboard.press('Delete');
    await expect(page.locator('.nodes-node')).toHaveCount(6);
    await workspace.focus(); await page.keyboard.press(action);
    await expect(page.locator('.nodes-node')).toHaveCount(3);
    await expect(page.locator('.nodes-workspace')).toHaveAttribute('data-status', /Output is required and was kept/);
    await expect(page.locator('.nodes-wires path')).toHaveCount(2);
    // Output alone stays protected: Delete is refused and it survives.
    await workspace.focus(); await page.keyboard.press('Delete');
    await expect(page.locator('.nodes-node')).toHaveCount(3);
    const saved = await saveAndRead(page);
    expect(saved.nodes.map(n => n.id).sort()).toEqual(['audio2', 'keep', 'output']);
    expect(saved.edges).toEqual([{ from: 'keep', to: 'output', port: 'image' }]);
    expect(saved.modulations).toEqual([{ from: 'audio2', to: 'keep', param: 'brightness', min: .2, max: .6 }]);
    await page.reload(); await expect(page.locator('.nodes-node')).toHaveCount(3);
    await expect(page.locator('.nodes-wires path')).toHaveCount(2);
    await title('keep').click(); await expect(page.getByTestId('mapping-live-brightness')).toBeVisible();
    await title('output').click(); await workspace.focus(); await page.keyboard.press('Delete');
    await expect(page.locator('.nodes-node')).toHaveCount(3);
  });
}

test('marquee batch deletion and contenteditable keyboard guard use the actual canvas selection', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  const g = graph();
  g.nodes.push({ ...g.nodes[0], id: 'keep', x: 560, y: 330 });
  g.edges = [{ from: 'keep', to: 'output', port: 'image' }];
  await openFixture(page, mapSignal(g, 'audio', 'color', 'brightness', .2, .8));
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  const workspace = page.getByLabel('Graph workspace'), area = await workspace.boundingBox();
  const view = await page.locator('.nodes-plane').evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return { x: m.e, y: m.f, z: m.a }; });
  const point = (x, y) => ({ x: area.x + view.x + x * view.z, y: area.y + view.y + y * view.z });
  const a = point(20, 20), b = point(525, 425);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.nodes-node.is-selected')).toHaveCount(4);
  // No current editable node title, so insert a DOM-only editable descendant to
  // exercise bubbling protection for future inline fields, not selection state.
  await workspace.evaluate(el => { const e = document.createElement('div'); e.contentEditable = 'true'; e.textContent = 'edit'; el.append(e); e.focus(); });
  await page.keyboard.press('Backspace'); await expect(page.locator('.nodes-node')).toHaveCount(6);
  await workspace.focus(); await page.keyboard.press('Delete');
  await expect(page.locator('.nodes-node')).toHaveCount(2);
  expect((await saveAndRead(page)).modulations || []).toEqual([]);
  await page.reload(); await expect(page.locator('.nodes-node')).toHaveCount(2);
});

test('legacy editor keeps ordinary pulse reactive through mapping edits, audio-node removal and reload', async ({ page, context }) => {
  test.setTimeout(60000);
  await page.goto('/'); await page.waitForFunction(() => window.__viz?.audioOwner);
  const editor = await context.newPage();
  await editor.goto('/?role=nodes');
  await forbidEditorCapture(editor);
  const g = graph(); g.nodes = g.nodes.filter(n => !['mix', 'audio2'].includes(n.id)); g.nodes[0].params.pulse = 1;
  await openFixture(editor, mapSignal(g, 'audio', 'color', 'saturation', .2, .8));
  await editor.locator('[data-node-id=color] .nodes-node-title').click();
  await sharedInput(page, false); await expect.poll(() => previewRed(editor)).toBe(51);
  await sharedInput(page, true); await expect.poll(() => previewRed(editor)).toBeGreaterThan(110);
  await editor.getByRole('button', { name: 'Saturation mapping settings' }).click();
  await editor.getByLabel('Saturation Mapping min', { exact: true }).fill('0.4');
  await expect.poll(() => previewRed(editor)).toBeGreaterThan(110);
  await editor.getByRole('button', { name: 'Remove mapping', exact: true }).click();
  await editor.locator('[data-node-id=audio] .nodes-node-title').click();
  await editor.getByLabel('Graph workspace').focus(); await editor.keyboard.press('Delete');
  await editor.locator('[data-node-id=color] .nodes-node-title').click();
  await expect.poll(() => previewRed(editor)).toBeGreaterThan(110);
  await sharedInput(page, false); await expect.poll(() => previewRed(editor)).toBeLessThan(55);
  const saved = await saveAndRead(editor); expect(saved.nodes.some(n => n.type === 'audio')).toBe(false);
  expect(await editor.evaluate(() => window.editorCaptureCalls)).toBe(0);
  await editor.reload(); await editor.locator('[data-node-id=color] .nodes-node-title').click();
  await sharedInput(page, true); await expect.poll(() => previewRed(editor)).toBeGreaterThan(110);
  expect(await editor.evaluate(() => window.editorCaptureCalls)).toBe(0);
});

test('editor provider coalesces refreshes, preserves heartbeat authority and retires pending work on dispose', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { createEditorAudio, createSignalConsumer } = await import('/src/nodes/audio-provider.js');
    const provider = createEditorAudio(), signal = createSignalConsumer(provider.store);
    const observer = new BroadcastChannel('viz2_channel'), plans = [];
    const id = provider.store.consumerSessionId;
    observer.onmessage = ({ data }) => { if (data.type === 'pattern-audio-plan' && data.consumerSessionId === id) plans.push(data); };
    provider.setChildren([signal]);
    const initial = provider.store.planRevision;
    for (let i = 0; i < 8; i++) provider.refresh();
    await new Promise(r => setTimeout(r, 1150));
    const stable = plans.every(p => p.planRevision === initial && p.slots.length === 1);
    provider.refresh(); provider.dispose(); provider.dispose(); provider.setChildren([signal]);
    await new Promise(r => setTimeout(r, 50));
    const final = plans.at(-1), count = plans.length;
    await new Promise(r => setTimeout(r, 1100));
    signal.dispose(); observer.close();
    return { stable, count, final, after: plans.length, slots: provider.store.slots.size, active: provider.audio.isStarted };
  });
  expect(result.stable).toBe(true); expect(result.final.slots).toEqual([]);
  expect(result.final.planRevision).toBeGreaterThan(1);
  expect(result.after).toBe(result.count); expect(result.slots).toBe(0); expect(result.active).toBe(false);
});
