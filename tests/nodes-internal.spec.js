import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { mapSignal } from '../src/nodes/model.js';

const graph = () => ({ version: 1, name: 'Internal color', nodes: [
  { id: 'color', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .2, pulse: 0 }, x: 40, y: 70 },
  { id: 'audio', type: 'audio', band: 'bass', x: 40, y: 300 },
  { id: 'output', type: 'output', x: 340, y: 70 },
], edges: [{ from: 'color', to: 'output', port: 'image' }] });
const editor = page => page.locator('.app-editor-panel');
const mainPanel = page => page.locator('#panel-main');
const back = page => page.getByRole('button', { name: 'Back to Main', exact: true });
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
    // Files are added explicitly (as OPEN does); linking never lists a folder.
    return (await nodePatterns.open('color.nodes.json')).id;
  }, g);
}
// One editor session: main-view "Open Pattern" fills it, Back to Main clears it.
async function openFile(page) {
  await expect(mainPanel(page)).not.toHaveClass(/is-inactive/);
  await page.getByRole('button', { name: 'Open Pattern', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Open Pattern' });
  await dialog.getByRole('combobox').selectOption('color.nodes.json');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(editor(page).getByLabel('Graph name')).toBeVisible();
}
async function backToMain(page) {
  await back(page).click();
  await expect(page.locator('.app-editor-panel')).toHaveCount(0);
  await expect(mainPanel(page)).not.toHaveClass(/is-inactive/);
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

test('New, Open and Edit share one internal editor view with no rail or popups', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('.app-tabs-rail')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(mainPanel(page)).not.toHaveClass(/is-inactive/);
  await page.getByRole('button', { name: 'New Node Pattern', exact: true }).click();
  await expect(editor(page)).toHaveCount(1);
  await expect(editor(page).getByLabel('Graph name')).toHaveValue('Untitled graph');
  await expect(editor(page).locator('.nodes-node')).toHaveCount(1);
  await expect(mainPanel(page)).toHaveClass(/is-inactive/);
  expect(context.pages()).toHaveLength(1);
  expect(new URL(page.url()).search).toBe('');
  await backToMain(page); // a clean new draft never prompts
  const id = await seed(page);
  await openFile(page);
  await expect(editor(page).getByLabel('Graph name')).toHaveValue('Internal color');
  await expect(page.locator('.app-editor-panel')).toHaveCount(1);
  await backToMain(page);
  await page.locator(`.library-btn[data-id="${id}"]`).click();
  await page.getByRole('button', { name: 'Edit Pattern', exact: true }).click();
  await expect(editor(page).getByLabel('Graph name')).toHaveValue('Internal color');
  await expect(page.locator('.app-editor-panel')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Close / })).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(context.pages()).toHaveLength(1);
  await page.screenshot({ path: '/tmp/nodes-internal-editor.png' });
});

test('the embedded editor reads Ctrl/Cmd+A as canvas select-all, never as UI text selection', async ({ page }) => {
  await page.goto('/');
  await seed(page);
  await openFile(page);
  const selected = () => editor(page).locator('.nodes-node.is-selected').evaluateAll(nodes => nodes.map(n => n.dataset.nodeId));
  // Focus still belongs to the main-panel button that opened the session, so the
  // shortcut has to be read from the window rather than from the editor root.
  await page.keyboard.press('Control+a');
  await expect.poll(selected).toEqual(['color', 'audio']);
  await expect(editor(page).locator('[data-node-id=output]')).not.toHaveClass(/is-selected/);
  expect(await page.evaluate(() => window.getSelection().toString())).toBe('');
  // Delete removes the group from the embedded canvas and keeps the Output.
  await editor(page).getByLabel('Graph workspace').focus();
  await page.keyboard.press('Delete');
  await expect(editor(page).locator('.nodes-node')).toHaveCount(1);
  await expect(editor(page).locator('[data-node-id=output]')).toHaveClass(/is-selected/);
  await expect(mainPanel(page)).toHaveClass(/is-inactive/);
});

test('leaving a dirty editor confirms; cancel keeps the draft and accept discards it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Node Pattern', exact: true }).click();
  await editor(page).getByLabel('Graph name').fill('Unsaved draft');
  await editor(page).getByRole('button', { name: '+ Blend', exact: true }).dragTo(editor(page).locator('.nodes-workspace'));
  await expect(editor(page).locator('.nodes-node')).toHaveCount(2);
  let warned = '';
  page.once('dialog', d => { warned = d.message(); d.dismiss(); });
  await back(page).click();
  await expect(editor(page).getByLabel('Graph name')).toHaveValue('Unsaved draft');
  await expect(editor(page).locator('.nodes-node')).toHaveCount(2);
  expect(warned).toBe('Discard unsaved changes to this draft?');
  page.once('dialog', d => d.accept());
  await back(page).click();
  await expect(page.locator('.app-editor-panel')).toHaveCount(0);
  await expect(mainPanel(page)).not.toHaveClass(/is-inactive/);
  // Sessions are not retained as hidden drafts: the next editor starts empty.
  await page.getByRole('button', { name: 'New Node Pattern', exact: true }).click();
  await expect(editor(page).getByLabel('Graph name')).toHaveValue('Untitled graph');
  await expect(editor(page).locator('.nodes-node')).toHaveCount(1);
});

test('save adopts repository identity; Back to Main then reopen loads the saved graph', async ({ page }) => {
  await page.goto('/'); await seed(page);
  await page.getByRole('button', { name: 'New Node Pattern', exact: true }).click();
  await connectDraft(page);
  await editor(page).getByLabel('Graph name').fill('Saved draft');
  await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor(page).locator('.nodes-workspace')).not.toHaveAttribute('data-status', /.+/);
  await backToMain(page);
  const saved = page.locator('.library-btn').filter({ hasText: 'Saved draft' });
  await expect(saved).toBeVisible();
  await saved.click();
  await page.getByRole('button', { name: 'Edit Pattern', exact: true }).click();
  await expect(editor(page).getByLabel('Graph name')).toHaveValue('Saved draft');
  await expect(editor(page).locator('.nodes-node')).toHaveCount(2);
  await backToMain(page);
  expect(await page.evaluate(async () => (await import('/src/nodes/repository.js')).nodePatterns.records.some(r => r.graph.name === 'Saved draft'))).toBe(true);
});

test('Back to Main is blocked during a disk write and a failed save retains the draft', async ({ page }) => {
  await page.goto('/'); await seed(page);
  await page.getByRole('button', { name: 'New Node Pattern', exact: true }).click();
  await connectDraft(page);
  await editor(page).getByLabel('Graph name').fill('Delayed save');
  await page.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const save = nodePatterns.save.bind(nodePatterns);
    window.__realSave = save;
    nodePatterns.save = async (...args) => { await new Promise(r => window.releaseSave = r); return save(...args); };
  });
  await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor(page).getByLabel('Graph name')).toBeDisabled();
  await expect(back(page)).toBeDisabled();
  await page.evaluate(() => window.releaseSave());
  await expect(back(page)).toBeEnabled();
  await expect(editor(page).getByLabel('Graph name')).toBeEnabled();
  expect(await page.evaluate(async () => (await import('/src/nodes/repository.js')).nodePatterns.records.some(r => r.graph.name === 'Delayed save'))).toBe(true);
  await page.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    nodePatterns.save = async () => { throw new Error('Mock write failure'); };
  });
  await editor(page).getByLabel('Graph name').fill('Kept after failure');
  await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor(page).locator('.nodes-workspace')).toHaveAttribute('data-status', /Mock write failure/);
  await expect(editor(page).getByLabel('Graph name')).toHaveValue('Kept after failure');
  await expect(back(page)).toBeEnabled();
  await expect(page.locator('.app-editor-panel')).toHaveCount(1);
});

test('internal editing keeps the main canvas, external output and save propagation', async ({ page, context }) => {
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
  await page.keyboard.press('Enter'); // editor keyboard must not take the main cue
  await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(screenRed).toBe(204);
  await backToMain(page);
  await page.getByRole('button', { name: 'Edit Pattern', exact: true }).click();
  await editor(page).locator('[data-node-id=color] .nodes-node-title').click();
  await expect(editor(page).getByLabel('Brightness', { exact: true })).toHaveValue('0.8');
  await backToMain(page);
  await expect.poll(screenRed).toBe(204);
  expect(errors).toEqual([]);
  expect(context.pages()).toHaveLength(2);
});

test('real shared analyser drives internal preview and mapping; no new channel, context or capture', async ({ page, context }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => localStorage.setItem('viz2_audio_device_id', 'default'));
  await page.goto('/');
  await page.waitForFunction(() => window.__viz?.captureAudio?.isStarted);
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
  await page.evaluate(() => { window.toneGain.gain.value = 0; });
  await expect.poll(() => red(page)).toBe(51);
  await backToMain(page);
  // Leaving disposes the editor's borrowed audio slots; the main capture keeps running.
  await expect.poll(() => page.evaluate(() => window.__viz.patternAudio.engine.activeControllers.filter(c => c.patternId === '__node_audio_signal').length)).toBe(0);
  expect(await page.evaluate(() => ({ calls: captureCalls.length, channels: channelNames.length, sameContext: window.__viz.captureAudio.audioContext === originalContext, sameStream: window.__viz.captureAudio.stream === originalStream, started: window.__viz.captureAudio.isStarted }))).toEqual({ calls: 1, channels, sameContext: true, sameStream: true, started: true });
  expect(context.pages()).toHaveLength(1);
});

test('internal video uses the existing media store; camera FX previews a generated sample without capture', async ({ page }) => {
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
  const mediaCount = () => page.evaluate(async () => (await import('/src/media/media-store.js')).listMediaRecords().then(r => r.length));
  const green = () => editor(page).getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(240, 135, 1, 1).data[1]);
  const g = graph(); g.nodes[0].patternId = 'media-internal-video'; g.nodes[0].params = {};
  const id = await seed(page, g); await openFile(page);
  await expect.poll(green).toBeGreaterThan(240);
  expect(await mediaCount()).toBe(1);
  await backToMain(page);
  await page.locator(`.library-btn[data-id="${id}"]`).click();
  await page.getByRole('button', { name: 'Edit Pattern', exact: true }).click();
  await expect.poll(green).toBeGreaterThan(240); // same persisted record, no duplicate media
  expect(await mediaCount()).toBe(1);
  await backToMain(page);
  const camera = graph(); camera.nodes[0].patternId = 'video-chroma'; camera.nodes[0].params = {};
  await seed(page, camera); await openFile(page);
  await editor(page).locator('[data-node-id=color] .nodes-node-title').click();
  await expect(editor(page).getByTestId('node-image-input-status')).toHaveText('Image input: not connected (camera default)');
  await expect(editor(page).locator('.nodes-diagnostics')).toBeEmpty();
  await expect.poll(() => editor(page).getByTestId('node-preview').evaluate(c => {
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 400) if (data[i + 3]) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return colors.size;
  })).toBeGreaterThan(3);
  expect(await page.evaluate(() => window.captureCalls.length)).toBe(0);
});

async function connectDraft(page) {
  await editor(page).getByRole('button', { name: /^Solid Color / }).dragTo(editor(page).locator('.nodes-workspace'), { targetPosition: { x: 60, y: 60 } });
  await editor(page).locator('.nodes-output').click();
  await editor(page).locator('[data-node-id=output] .nodes-input').click();
}
