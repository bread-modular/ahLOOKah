import { test, expect } from '@playwright/test';

// An old source-only graph keeps its v1 shape. Editor actions, not this fixture,
// opt patterns into FX and add Camera nodes using the shared model defaults.
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
const newPattern = page => page.locator('.nodes-node[data-primary=true]');
const fxRow = page => page.locator('.nodes-pattern-row').filter({ hasText: 'Video Chroma Key' });

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

test('Camera palette drag creates an image source with Global/pinned selection, hotplug and owner-only preview status', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('button', { name: '+ Camera' }).dragTo(page.getByLabel('Graph workspace'), { targetPosition: { x: 260, y: 320 } });
  const camera = page.locator('.nodes-node').filter({ has: page.getByRole('button', { name: 'Select Camera', exact: true }) });
  await expect(camera).toHaveCount(1);
  const id = await camera.getAttribute('data-node-id');
  await expect(camera.getByRole('button', { name: `${id} output` })).toBeVisible();
  await expect(camera.locator('.nodes-input')).toHaveCount(0);
  await expect(page.getByLabel('Camera input device')).toHaveValue('');
  await expect(page.getByLabel('Camera input device')).toContainText('Global input (Settings) — Front Camera');
  await expect(page.getByTestId('node-camera-status')).toContainText('only on the output screen');
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
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await diskGraph(page)).nodes.find(n => n.id === id)?.deviceId).toBe('cam-B');
  expect((await diskGraph(page)).edges).toContainEqual({ from: id, to: 'output', port: 'image' });
  expect(await page.evaluate(() => localStorage.getItem('viz2_video_device_id'))).toBe('cam-A');
  expect(await page.evaluate(() => window.cameraCaptureRequests)).toBe(0);
  await page.reload();
  await page.locator(`[data-node-id="${id}"] .nodes-node-title`).click();
  await expect(page.getByLabel('Camera input device')).toHaveValue('cam-B');
});

test('descriptor-driven filter includes a loaded custom-script pattern and intersects search', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(async () => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    SKETCHES.push({ ...SKETCHES.find(s => s.id === 'solid-color'), id: 'script-fx-fixture',
      name: 'Script Image Fixture', group: 'Custom', customScript: true, fx: { input: 'image' } });
  });
  const search = page.getByLabel('Search patterns');
  await search.fill('Script Image');
  await page.getByLabel('FX only').focus();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('FX only')).toBeChecked();
  const row = page.locator('.nodes-pattern-row').filter({ hasText: 'Script Image Fixture' });
  await expect(row.locator('.nodes-fx-badge')).toHaveText('◇ FX');
  await expect(row.getByRole('button', { name: 'Add Script Image Fixture as FX' })).toBeVisible();
  await search.fill('solid color');
  await expect(page.locator('.nodes-pattern-row')).toHaveCount(0);
  await expect(page.getByText('No matching patterns with image-input FX capability.')).toBeVisible();
  await page.getByLabel('FX only').uncheck();
  await expect(page.locator('.nodes-pattern-row').filter({ hasText: 'Solid Color' })).toHaveCount(1);
});

test('FX-only intersects text search, keeps Source drag default and exposes custom-script capability', async ({ page }) => {
  await openFixture(page);
  const search = page.getByLabel('Search patterns');
  await search.fill('video');
  await expect(page.locator('.nodes-pattern-row').filter({ hasText: 'Video Kaleidoscope' })).toHaveCount(1);
  await page.getByLabel('FX only').check();
  await expect(page.locator('.nodes-pattern-row').filter({ hasText: 'Video Kaleidoscope' })).toHaveCount(0);
  await expect(fxRow(page).locator('.nodes-fx-badge')).toHaveText('◇ FX');
  await expect(fxRow(page).getByRole('button', { name: 'Add Video Chroma Key as FX' })).toBeVisible();
  await search.fill('no matching image effect');
  await expect(page.getByText('No matching patterns with image-input FX capability.')).toBeVisible();

  // Catalog entries are the source of truth. A loaded script descriptor has the
  // same selector/badge behavior as a built-in, without a camera/name allowlist.
  await page.evaluate(async () => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    SKETCHES.push({ ...SKETCHES.find(s => s.id === 'solid-color'), id: 'script-fx-fixture',
      name: 'Script Image Fixture', group: 'Custom', customScript: true, fx: { input: 'image' } });
  });
  await search.fill('script image');
  await expect(page.locator('.nodes-pattern-row').filter({ hasText: 'Script Image Fixture' }).locator('.nodes-fx-badge')).toBeVisible();
  await search.fill('video chroma');
  await fxRow(page).locator('.nodes-pattern-source').dragTo(page.getByLabel('Graph workspace'), { targetPosition: { x: 310, y: 300 } });
  const source = newPattern(page);
  await expect(source.locator('.nodes-node-detail')).toContainText('Source');
  await expect(source.locator('.nodes-input')).toHaveCount(0);
  await expect(page.getByLabel('Pattern input mode')).toHaveValue('source');
  await expect(source.locator('.nodes-fx-badge')).toContainText('◇ FX');
  await expect(source.locator('.nodes-node-title')).toHaveAccessibleDescription(/Accepts an image input/);
  await page.getByLabel('Pattern input mode').selectOption('fx');
  await expect(source.locator('.nodes-node-detail')).toContainText('FX active');
  await expect(source.locator('.nodes-input')).toHaveCount(1);
  await page.getByLabel('Pattern input mode').selectOption('source');
  await expect(source.locator('.nodes-input')).toHaveCount(0);
  await expect(source.locator('.nodes-fx-badge')).toHaveCount(1);
  await expect(page.getByTestId('node-camera-status')).toHaveCount(0);
});

test('explicit Add as FX, edge sockets, and confirmed Source switch never hide a wire', async ({ page }) => {
  await openFixture(page);
  await page.getByLabel('Search patterns').fill('video chroma');
  await fxRow(page).getByRole('button', { name: 'Add Video Chroma Key as FX' }).click();
  const fx = newPattern(page);
  const id = await fx.getAttribute('data-node-id');
  await expect(fx.locator('.nodes-node-detail')).toContainText('FX active');
  await expect(fx.locator('.nodes-fx-badge')).toContainText('◇ FX');
  await expect(page.getByLabel('Pattern input mode')).toHaveValue('fx');
  await expect(fx.getByRole('button', { name: `${id} input image` })).toBeVisible();
  await expect(page.getByText(/connect an image to this pattern's image input/i)).toBeVisible();
  await page.locator('[data-node-id=source] .nodes-output').click();
  await fx.locator('.nodes-input').click();
  const wire = page.locator(`.nodes-wires [data-connection="image:${id}:image"]`);
  await expect(wire).toHaveCount(1);
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
  await fx.locator('.nodes-node-title').click();
  await expect(page.getByTestId('node-preview')).toBeVisible();
  await expect(page.locator('.nodes-diagnostics')).not.toContainText('Camera is available only on the output screen');

  page.once('dialog', d => d.dismiss());
  await page.getByLabel('Pattern input mode').selectOption('source');
  await expect(page.getByLabel('Pattern input mode')).toHaveValue('fx');
  await expect(wire).toHaveCount(1);
  page.once('dialog', d => d.accept());
  await page.getByLabel('Pattern input mode').selectOption('source');
  await expect(page.getByLabel('Pattern input mode')).toHaveValue('source');
  await expect(fx.locator('.nodes-input')).toHaveCount(0);
  await expect(wire).toHaveCount(0);
  await expect(page.locator('[data-node-id=source]')).toHaveCount(1);
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await diskGraph(page)).edges.length).toBe(0);
  await expect.poll(async () => (await diskGraph(page)).nodes.find(n => n.id === id)?.inputMode ?? 'source').toBe('source');
});

test('capability loss preserves visible FX mode, input socket and wiring for repair', async ({ page }) => {
  await openFixture(page);
  await page.getByLabel('Search patterns').fill('video chroma');
  await fxRow(page).getByRole('button', { name: 'Add Video Chroma Key as FX' }).click();
  const id = await newPattern(page).getAttribute('data-node-id');
  await page.locator('[data-node-id=source] .nodes-output').click();
  await page.locator(`[data-node-id="${id}"] .nodes-input`).click();
  await page.evaluate(async () => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    delete SKETCHES.find(s => s.id === 'video-chroma').fx;
    // A catalog revision (including an incoming custom-script reload) re-runs
    // portability diagnostics without touching the saved graph or its edges.
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  await expect(page.locator(`[data-node-id="${id}"] .nodes-input`)).toHaveCount(1);
  await expect(page.locator(`.nodes-wires [data-connection="image:${id}:image"]`)).toHaveCount(1);
  await expect(page.getByLabel('Pattern input mode')).toHaveValue('fx');
  await expect(page.getByText(/FX capability unavailable/)).toBeVisible();
  await expect(page.getByTestId('nodes-blocked')).toContainText(/FX|image input|capab/i);
});
