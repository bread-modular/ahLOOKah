import { test, expect } from '@playwright/test';

// Start with a v1 source graph; dragging an FX-capable pattern does not opt it
// into anything. Connecting an image is the only editor action that invokes FX.
const graph = () => ({ version: 1, name: 'Image input editor', nodes: [
  { id: 'source', type: 'pattern', patternId: 'solid-color', x: 30, y: 55,
    params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 } },
  { id: 'output', type: 'output', x: 650, y: 150 },
], edges: [] });

async function openFixture(page) {
  await page.goto('/?role=nodes');
  const id = await page.evaluate(async data => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('camera-fx-editor-tests', { create: true });
    const file = await dir.getFileHandle('image-input.nodes.json', { create: true });
    const writer = await file.createWritable();
    await writer.write(serializeGraph(data, manifestFor(data, SKETCHES))); await writer.close();
    window.showDirectoryPicker = async () => dir;
    await nodePatterns.link();
    return (await nodePatterns.open('image-input.nodes.json')).id;
  }, graph());
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue('Image input editor');
}

const diskGraph = page => page.evaluate(async () => {
  const { nodePatterns } = await import('/src/nodes/repository.js');
  return (await nodePatterns.load(new URLSearchParams(location.search).get('graph'))).graph;
});
// Reading the pattern while the editor's own save is in flight is expected to
// fail: Chrome refuses a read (NotReadableError) while a writable stream is open
// on that file, and `load()`'s folder re-scan can also miss the file for one
// pass and report "Pattern became unavailable on disk" (the repository records
// the failed pass in `errors` and heals on the next one). Both mean "not written
// yet", not a missing file, so polls read through this helper and keep checking
// for the eventual disk state; a permanently absent or corrupt file still fails.
const diskGraphWhenWritten = page => diskGraph(page).catch((error) => {
  if (/NotReadableError|became unavailable on disk/.test(String(error?.message ?? error))) return null;
  throw error;
});
const newPattern = page => page.locator('.nodes-node[data-primary=true]');
const fxRow = page => page.locator('.nodes-pattern-row').filter({ hasText: 'Video Chroma Key' });
const fxWire = id => `.nodes-wires [data-connection="image:${id}:image"]`;

async function dragFxPattern(page) {
  await page.getByLabel('Search patterns').fill('video chroma');
  await fxRow(page).locator('.nodes-pattern-source').dragTo(page.getByLabel('Graph workspace'), { targetPosition: { x: 310, y: 300 } });
  const id = await newPattern(page).getAttribute('data-node-id');
  return { id, card: page.locator(`[data-node-id="${id}"]`) };
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
    localStorage.setItem('viz2_video_device_id', 'cam-A');
    window.cameraCaptureRequests = 0;
    window.cameraDevices = [
      { kind: 'videoinput', deviceId: 'cam-A', label: 'Front Camera' },
      { kind: 'videoinput', deviceId: 'cam-B', label: 'USB Camera' },
      { kind: 'audioinput', deviceId: 'mic-A', label: 'Microphone' },
    ];
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true, value: async () => window.cameraDevices,
    });
    navigator.mediaDevices.getUserMedia = async () => { window.cameraCaptureRequests++; throw new Error('No editor camera capture'); };
  });
});

test('Node Patterns guide describes automatic FX wiring and sample preview, not a mode chooser', async ({ page }) => {
  await page.goto('/docs/nodes.html');
  const article = page.locator('.article');
  await expect(article).toContainText('FX only');
  await expect(article).toContainText('optional ● image input');
  await expect(article).toContainText('deleting the wire returns');
  await expect(article).toContainText('generated sample clip, not a real camera');
  await expect(article).not.toContainText('Add as FX');
  await expect(article).not.toContainText('Pattern input mode');
});

test('Camera sits immediately above Script; dragging it keeps the Global/pinned picker and previews a generated clip without capture', async ({ page }) => {
  await openFixture(page);
  await expect(page.locator('.nodes-palette-create button')).toHaveText(['+ Blend', '+ Color', '+ Transform', '+ Camera', '+ Script', '+ Audio']);
  await page.getByRole('button', { name: '+ Camera' }).dragTo(page.getByLabel('Graph workspace'), { targetPosition: { x: 260, y: 320 } });
  const camera = page.locator('.nodes-node').filter({ has: page.getByRole('button', { name: 'Select Camera', exact: true }) });
  await expect(camera).toHaveCount(1);
  const id = await camera.getAttribute('data-node-id');
  await expect(camera.getByRole('button', { name: `${id} output` })).toBeVisible();
  await expect(camera.locator('.nodes-input')).toHaveCount(0);
  await expect(page.getByLabel('Camera input device')).toHaveValue('');
  await expect(page.getByLabel('Camera input device')).toContainText('Global input (Settings) — Front Camera');
  await expect(page.getByTestId('node-camera-status')).toContainText('generated sample clip, not your real camera');
  await expect(page.getByTestId('node-camera-status')).toContainText('Connect Camera out');
  await expect(page.getByTestId('node-preview')).toBeVisible();
  await page.getByLabel('Camera input device').selectOption('cam-B');
  await expect(camera.locator('.nodes-node-detail')).toContainText('USB Camera · image out');
  await page.evaluate(() => {
    window.cameraDevices = [{ kind: 'videoinput', deviceId: 'cam-A', label: 'Front Camera' }];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await expect(page.getByLabel('Camera input device')).toHaveValue('cam-B');
  await expect(page.getByLabel('Camera input device')).toContainText('Unavailable camera');
  await expect(page.getByTestId('node-camera-status')).toContainText('Pinned camera unavailable');
  await camera.locator('.nodes-output').click();
  await page.getByRole('button', { name: 'output input image' }).click();
  await expect(page.locator('.nodes-wires [data-connection="image:output:image"]')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await diskGraphWhenWritten(page))?.nodes.find(n => n.id === id)?.deviceId).toBe('cam-B');
  expect((await diskGraph(page)).edges).toContainEqual({ from: id, to: 'output', port: 'image' });
  expect(await page.evaluate(() => localStorage.getItem('viz2_video_device_id'))).toBe('cam-A');
  expect(await page.evaluate(() => window.cameraCaptureRequests)).toBe(0);
  await page.reload();
  await page.locator(`[data-node-id="${id}"] .nodes-node-title`).click();
  await expect(page.getByLabel('Camera input device')).toHaveValue('cam-B');
});

test('FX-only filter intersects search, includes live script descriptors, but offers no Add as FX button', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(async () => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    SKETCHES.push({ ...SKETCHES.find(s => s.id === 'solid-color'), id: 'script-fx-fixture',
      name: 'Script Image Fixture', group: 'Custom', customScript: true, fx: { input: 'image' } });
  });
  const search = page.getByLabel('Search patterns');
  await search.fill('script image');
  await page.getByLabel('FX only').check();
  await expect(page.getByLabel('FX only')).toBeChecked();
  const row = page.locator('.nodes-pattern-row').filter({ hasText: 'Script Image Fixture' });
  await expect(row.locator('.nodes-fx-badge')).toHaveText('◇ FX');
  await expect(row.locator('.nodes-pattern-source')).toBeVisible();
  await expect(page.getByRole('button', { name: /Add .* as FX/ })).toHaveCount(0);
  await search.fill('solid color');
  await expect(page.locator('.nodes-pattern-row')).toHaveCount(0);
  await expect(page.getByText('No matching patterns with image-input FX capability.')).toBeVisible();
  await search.fill('video');
  const kaleido = page.locator('.nodes-pattern-row').filter({ hasText: 'Video Kaleidoscope' });
  await expect(kaleido.locator('.nodes-fx-badge')).toHaveText('◇ FX');
  await expect(fxRow(page).locator('.nodes-fx-badge')).toHaveText('◇ FX');
  await page.getByLabel('FX only').uncheck();
  await expect(kaleido).toHaveCount(1);
});

test('FX-capable custom script without camera reports Source default and inspector status only', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(async () => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    SKETCHES.push({ ...SKETCHES.find(s => s.id === 'solid-color'), id: 'custom-source-fx',
      name: 'Custom source FX', group: 'Custom', customScript: true, fx: { input: 'image' } });
  });
  await page.getByLabel('Search patterns').fill('custom source fx');
  await page.locator('.nodes-pattern-row').filter({ hasText: 'Custom source FX' }).locator('.nodes-pattern-source')
    .dragTo(page.getByLabel('Graph workspace'), { targetPosition: { x: 310, y: 300 } });
  const card = newPattern(page);
  await expect(card.locator('.nodes-fx-badge')).toHaveText(/◇ FX/);
  await expect(card.locator('.nodes-input')).toHaveCount(1);
  await expect(card.locator('.nodes-node-detail')).toContainText('Source default');
  await expect(page.getByTestId('node-image-input-status')).toHaveText('Image input: not connected (source default)');
  // The inspector keeps status only: the removed description and preview-hint
  // paragraphs must not come back.
  await expect(page.locator('.nodes-pattern-image-status p')).toHaveCount(0);
});

test('drag-to-add has an optional image socket; connect/disconnect automatically toggles camera default and FX', async ({ page }) => {
  await openFixture(page);
  const { id, card } = await dragFxPattern(page);
  await expect(card.locator('.nodes-fx-badge')).toContainText('◇ FX');
  await expect(card.locator('.nodes-node-title')).toHaveAccessibleDescription(/Accepts an image input/);
  await expect(card.getByRole('button', { name: `${id} input image` })).toBeVisible();
  await expect(page.getByTestId('node-image-input-status')).toHaveText('Image input: not connected (camera default)');
  await expect(card.locator('.nodes-node-detail')).toContainText('Camera default');
  await expect(page.getByLabel('Pattern input mode')).toHaveCount(0);
  await expect(page.getByLabel('Camera input device')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Add .* as FX/ })).toHaveCount(0);
  await page.locator('[data-node-id=source] .nodes-output').click();
  await card.getByRole('button', { name: `${id} input image` }).click();
  const wire = page.locator(fxWire(id));
  await expect(wire).toHaveCount(1);
  await card.locator('.nodes-node-title').click();
  await expect(page.getByTestId('node-image-input-status')).toHaveText('Image input: wired');
  await expect(card.locator('.nodes-node-detail')).toContainText('Image wired');
  await expect(page.getByTestId('node-preview')).toBeVisible();
  const ends = await page.evaluate(target => {
    const plane = document.querySelector('.nodes-plane');
    const zoom = new DOMMatrix(getComputedStyle(plane).transform).a;
    const bounds = plane.getBoundingClientRect();
    const socket = document.querySelector(`[data-node-id="${target}"] .nodes-input`).getBoundingClientRect();
    const path = document.querySelector(`[data-connection="image:${target}:image"]`);
    const points = path.getAttribute('d').match(/-?[\d.]+/g).map(Number);
    return { wireY: points.at(-1), socketY: (socket.top + socket.height / 2 - bounds.top) / zoom };
  }, id);
  expect(Math.abs(ends.wireY - ends.socketY)).toBeLessThanOrEqual(1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await diskGraphWhenWritten(page))?.version).toBe(2);
  await expect.poll(async () => (await diskGraphWhenWritten(page))?.edges.find(e => e.to === id)).toEqual({ from: 'source', to: id, port: 'image' });
  expect((await diskGraph(page)).nodes.find(n => n.id === id)?.inputMode).toBeUndefined(); // image edge, not a saved flag
  await wire.click();
  await page.getByRole('button', { name: 'Delete connection' }).click();
  await expect(wire).toHaveCount(0);
  await expect(card.getByRole('button', { name: `${id} input image` })).toBeVisible();
  await card.locator('.nodes-node-title').click();
  await expect(page.getByTestId('node-image-input-status')).toHaveText('Image input: not connected (camera default)');
  await expect(card.locator('.nodes-node-detail')).toContainText('Camera default');
  await expect(page.locator('[data-node-id=source]')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await diskGraphWhenWritten(page))?.edges.length).toBe(0);
  expect((await diskGraph(page)).nodes.find(n => n.id === id)?.inputMode).not.toBe('fx');
  expect(await page.evaluate(() => window.cameraCaptureRequests)).toBe(0);
});

test('the always-visible optional image row keeps a pattern signal endpoint aligned', async ({ page }) => {
  await openFixture(page);
  const { id, card } = await dragFxPattern(page);
  await page.getByRole('button', { name: '+ Audio' }).dragTo(page.getByLabel('Graph workspace'), { targetPosition: { x: 60, y: 400 } });
  const audio = page.locator('.nodes-node').filter({ has: page.getByRole('button', { name: /Select Audio/ }) });
  await audio.locator('.nodes-output').click();
  await card.locator('.nodes-signal-endpoint').click();
  const wire = page.locator(`.nodes-wires [data-connection^="modulation:"][data-connection-from]`).first();
  await expect(wire).toHaveCount(1);
  const ends = await page.evaluate(target => {
    const plane = document.querySelector('.nodes-plane');
    const zoom = new DOMMatrix(getComputedStyle(plane).transform).a;
    const bounds = plane.getBoundingClientRect();
    const socket = document.querySelector(`[data-node-id="${target}"] .nodes-signal-endpoint`).getBoundingClientRect();
    const path = document.querySelector('.nodes-wires [data-connection^="modulation:"]');
    const points = path.getAttribute('d').match(/-?[\d.]+/g).map(Number);
    return { wireY: points.at(-1), socketY: (socket.top + socket.height / 2 - bounds.top) / zoom };
  }, id);
  expect(Math.abs(ends.wireY - ends.socketY)).toBeLessThanOrEqual(1);
  await expect(card.getByRole('button', { name: `${id} input image` })).toBeVisible();
});

test('descriptor loss retains the wired image socket for repair without adding a mode selector', async ({ page }) => {
  await openFixture(page);
  const { id } = await dragFxPattern(page);
  await page.locator('[data-node-id=source] .nodes-output').click();
  await page.locator(`[data-node-id="${id}"] .nodes-input`).click();
  await expect(page.locator(fxWire(id))).toHaveCount(1);
  await page.evaluate(async () => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    delete SKETCHES.find(s => s.id === 'video-chroma').fx;
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  await page.locator(`[data-node-id="${id}"] .nodes-node-title`).click();
  await expect(page.locator(`[data-node-id="${id}"] .nodes-input`)).toHaveCount(1);
  await expect(page.locator(fxWire(id))).toHaveCount(1);
  await expect(page.getByLabel('Pattern input mode')).toHaveCount(0);
  await expect(page.getByTestId('node-image-input-status')).toHaveText('Image input: wired');
  await expect(page.getByText(/FX capability unavailable/)).toBeVisible();
  await expect(page.getByTestId('nodes-blocked')).toContainText(/FX|image input|capab/i);
  expect(await page.evaluate(() => window.cameraCaptureRequests)).toBe(0);
});
