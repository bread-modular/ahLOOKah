import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { mapSignal } from '../src/nodes/model.js';

const graph = () => ({ version: 1, name: 'Internal color', nodes: [
  { id: 'color', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .2, pulse: 0 }, x: 40, y: 70 },
  { id: 'audio', type: 'audio', band: 'bass', x: 40, y: 300 },
  { id: 'output', type: 'output', x: 340, y: 70 },
], edges: [{ from: 'color', to: 'output', port: 'image' }] });
const editor = page => page.locator('.app-tab-panel:not([hidden])');
const red = page => editor(page).getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(10, 10, 1, 1).data[0]);
async function seed(page, g = graph()) {
  return page.evaluate(async g => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('internal-tests', { create: true });
    const f = await dir.getFileHandle('color.nodes.json', { create: true });
    const w = await f.createWritable(); await w.write(serializeGraph(g, manifestFor(g, SKETCHES))); await w.close();
    window.showDirectoryPicker = async () => dir;
    await nodePatterns.link();
    return nodePatterns.records[0].id;
  }, g);
}
async function openFile(page) {
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await page.getByRole('button', { name: 'Open Pattern', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Open Pattern' });
  await dialog.getByRole('combobox').selectOption('color.nodes.json');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(editor(page).getByLabel('Graph name')).toBeVisible();
}
test.beforeEach(async ({ page, context }) => {
  await page.setViewportSize({ width: 1536, height: 950 });
  await context.addInitScript(() => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.captureCalls = [];
    navigator.mediaDevices.getUserMedia = options => { window.captureCalls.push(options); return acquire(options); };
    const Channel = window.BroadcastChannel;
    window.channelNames = [];
    window.BroadcastChannel = class extends Channel { constructor(name) { super(name); window.channelNames.push(name); } };
  });
});

test('internal New/Open/Edit deduplicate, retain drafts and navigation, confirm close; right rail screenshot', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Node Pattern', exact: true }).click();
  await editor(page).getByLabel('Graph name').fill('Unsaved draft');
  await editor(page).getByRole('button', { name: '+ Blend', exact: true }).click();
  await page.getByRole('button', { name: '+ New graph', exact: true }).click();
  await editor(page).getByLabel('Graph name').fill('Second draft');
  await page.getByRole('tab', { name: 'Unsaved draft' }).click();
  await expect(editor(page).locator('.nodes-node')).toHaveCount(2);
  await expect(editor(page).getByLabel('Graph name')).toHaveValue('Unsaved draft');
  page.once('dialog', d => d.dismiss());
  await page.getByRole('button', { name: 'Close Unsaved draft', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Unsaved draft' })).toBeVisible();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Close Unsaved draft', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Unsaved draft' })).toHaveCount(0);
  const id = await seed(page);
  await openFile(page);
  await editor(page).getByLabel('Graph name').fill('Retained edit');
  await openFile(page);
  await expect(editor(page).getByLabel('Graph name')).toHaveValue('Retained edit');
  await expect(page.getByRole('tab', { name: 'Retained edit' })).toHaveCount(1);
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await page.locator(`.library-btn[data-id="${id}"]`).click();
  await page.getByRole('button', { name: 'Edit Pattern', exact: true }).click();
  await expect(editor(page).getByLabel('Graph name')).toHaveValue('Retained edit');
  await expect(page.getByRole('tab')).toHaveCount(3);
  expect(context.pages()).toHaveLength(1);
  expect(new URL(page.url()).search).toBe('');
  const rail = await page.getByLabel('Workspace tabs').boundingBox();
  expect(rail.x + rail.width).toBe(1536);
  await page.screenshot({ path: '/tmp/nodes-internal-tabs.png' });
});

test('internal editing keeps main canvas and external output, save propagates without tab loss', async ({ page, context }) => {
  test.setTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto('/'); const id = await seed(page);
  const screen = await context.newPage(); await screen.goto('/?role=screen');
  await page.waitForFunction(() => window.__viz?.screenOnline);
  await expect.poll(() => screen.evaluate(async id => (await import('/src/sketch-registry.js')).SKETCHES.some(s => s.id === id), id)).toBe(true);
  await page.locator(`.library-btn[data-id="${id}"]`).click({ modifiers: ['Shift'] });
  await expect.poll(() => screen.evaluate(() => ({ cue: window.__viz.cue, audio: window.__viz.patternAudio })), { timeout: 10000 }).toMatchObject({ cue: { phase: 'ready' } });
  await page.keyboard.press('Enter'); await screen.waitForFunction(() => window.__viz.cue === null);
  const screenRed = () => screen.evaluate(id => {
    const c = document.querySelector(`[data-program-ids="${id}"] canvas`);
    return c && c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data[0];
  }, id);
  await expect.poll(screenRed).toBe(51);
  await page.evaluate(() => { window.originalPreview = document.querySelector('#panel-main canvas'); });
  await openFile(page);
  await editor(page).locator('[data-node-id=color] .nodes-node-title').click();
  await editor(page).getByLabel('Brightness', { exact: true }).fill('0.8');
  await expect.poll(() => red(page)).toBe(204);
  await expect.poll(screenRed).toBe(51); // editing never replaces LIVE
  expect(await page.evaluate(() => window.originalPreview.isConnected)).toBe(true);
  await page.keyboard.press('Enter'); // editor keyboard must not take main cue
  await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(screenRed).toBe(204);
  await expect(page.getByRole('tab', { name: 'Internal color', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Pattern', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(editor(page).getByLabel('Brightness', { exact: true })).toHaveValue('0.8');
  await page.getByRole('button', { name: 'Close Internal color', exact: true }).click();
  await expect.poll(screenRed).toBe(204);
  expect(errors).toEqual([]);
});

test('real shared analyser drives internal preview and mapping; no new channel, context or capture', async ({ page, context }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => localStorage.setItem('viz2_audio_device_id', 'default'));
  await page.goto('/');
  await page.waitForFunction(() => window.__viz?.captureAudio?.isStarted);
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await page.evaluate(async () => {
    const audio = window.__viz.captureAudio; await audio.audioContext.resume(); audio.source.disconnect();
    const ctx = audio.audioContext, tone = ctx.createOscillator(), gain = ctx.createGain();
    tone.frequency.value = 94; gain.gain.value = 0; tone.connect(gain); gain.connect(audio.splitter); tone.start();
    window.toneGain = gain; window.originalContext = ctx; window.originalStream = audio.stream;
  });
  await seed(page, mapSignal(graph(), 'audio', 'color', 'brightness', .2, .8));
  const channels = await page.evaluate(() => window.channelNames.length);
  await openFile(page);
  await editor(page).locator('[data-node-id=color] .nodes-node-title').click();
  await expect.poll(() => red(page)).toBe(51);
  await page.evaluate(() => { window.toneGain.gain.value = .3; });
  await expect.poll(() => red(page)).toBeGreaterThan(65);
  await expect.poll(() => editor(page).getByTestId('mapping-live-brightness').evaluate(el => parseFloat(el.style.left))).toBeGreaterThan(25);
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await page.evaluate(() => { window.toneGain.gain.value = 0; });
  await page.getByRole('tab', { name: 'Internal color', exact: true }).click();
  await expect.poll(() => red(page)).toBe(51);
  expect(await page.evaluate(() => ({ calls: captureCalls.length, channels: channelNames.length, sameContext: window.__viz.captureAudio.audioContext === originalContext, sameStream: window.__viz.captureAudio.stream === originalStream }))).toEqual({ calls: 1, channels, sameContext: true, sameStream: true });
  expect(context.pages()).toHaveLength(1);
  await page.getByRole('button', { name: 'Close Internal color', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__viz.patternAudio.engine.activeControllers.filter(c => c.patternId === '__node_audio_signal').length)).toBe(0);
});

test('internal video uses existing media store and retains decoder across switching; camera never recaptures', async ({ page }) => {
  await page.goto('/');
  const video = (await readFile(new URL('./fixtures/green.webm', import.meta.url))).toString('base64');
  await page.evaluate(async video => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { putMediaRecord } = await import('/src/media/media-store.js');
    const { addMediaPattern } = await import('/src/media/media-registry.js');
    const file = new File([Uint8Array.from(atob(video), c => c.charCodeAt(0))], 'green.webm', { type: 'video/webm' });
    await putMediaRecord({ id: 'internal-video', name: 'Shared video', kind: 'video', file });
    addMediaPattern(SKETCHES, { id: 'internal-video', name: 'Shared video', kind: 'video' });
    window.videosCreated = [];
    const create = document.createElement.bind(document);
    document.createElement = (...args) => { const el = create(...args); if (args[0] === 'video') window.videosCreated.push(el); return el; };
  }, video);
  const g = graph(); g.nodes[0].patternId = 'media-internal-video'; g.nodes[0].params = {};
  await seed(page, g); await openFile(page);
  await expect.poll(() => editor(page).getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(240, 135, 1, 1).data[1])).toBeGreaterThan(240);
  const count = await page.evaluate(() => window.videosCreated.length);
  expect(count).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await page.getByRole('tab', { name: 'Internal color', exact: true }).click();
  await expect.poll(() => editor(page).getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(240, 135, 1, 1).data[1])).toBeGreaterThan(240);
  expect(await page.evaluate(() => window.videosCreated.length)).toBe(count);
  await page.getByRole('button', { name: 'Close Internal color', exact: true }).click();
  const camera = graph(); camera.nodes[0].patternId = 'video-chroma'; camera.nodes[0].params = {};
  await seed(page, camera); await openFile(page);
  await expect(editor(page).locator('.nodes-diagnostics')).toContainText('Camera is available only on the output screen');
  expect(await page.evaluate(() => window.captureCalls.length)).toBe(0);
});

test('internal new draft Save adopts repository identity; busy close and collision retain both drafts', async ({ page }) => {
  await page.goto('/'); await seed(page);
  await page.getByRole('button', { name: '+ New graph', exact: true }).click();
  await connectDraft(page);
  await editor(page).getByLabel('Graph name').fill('Saved draft');
  await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Saved draft', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await page.locator('.library-btn').filter({ hasText: 'Saved draft' }).click();
  await page.getByRole('button', { name: 'Edit Pattern', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: '+ New graph', exact: true }).click();
  await connectDraft(page);
  await editor(page).getByLabel('Graph name').fill('Saved draft');
  await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor(page).locator('.nodes-status')).toContainText('already has an open editor');
  await expect(page.getByRole('tab')).toHaveCount(3);
  await editor(page).getByLabel('Graph name').fill('Delayed save');
  await page.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const save = nodePatterns.save.bind(nodePatterns);
    nodePatterns.save = async (...args) => { await new Promise(r => window.releaseSave = r); return save(...args); };
  });
  await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close Delayed save' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Main', exact: true }).click();
  await page.evaluate(() => window.releaseSave());
  await expect(page.getByRole('button', { name: 'Close Delayed save' })).toBeEnabled();
  await expect(page.getByRole('tab', { name: 'Delayed save', exact: true })).toBeVisible();
});

async function connectDraft(page) {
  await editor(page).getByRole('button', { name: /^Solid Color / }).dragTo(editor(page).locator('.nodes-workspace'), { targetPosition: { x: 60, y: 60 } });
  await editor(page).locator('.nodes-output').click();
  await editor(page).locator('[data-node-id=output] .nodes-input').click();
}
