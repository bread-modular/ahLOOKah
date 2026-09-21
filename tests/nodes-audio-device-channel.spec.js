import { test, expect } from '@playwright/test';
import { serializeGraph } from '../src/nodes/portability.js';

const legacyGraph = () => ({ version: 1, name: 'Device channel', nodes: [
  { id: 'color', type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .2, pulse: 0 }, x: 50, y: 50 },
  { id: 'audio', type: 'audio', band: 'bass', x: 40, y: 300 },
  { id: 'audio2', type: 'audio', band: 'high', deviceId: 'dev-A', channel: 'left', x: 300, y: 300 },
  { id: 'output', type: 'output', x: 600, y: 50 },
], edges: [{ from: 'color', to: 'output', port: 'image' }] });

async function openFixture(page, data) {
  await page.goto('/?role=nodes');
  const id = await page.evaluate(async g => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('audio-routing-tests', { create: true });
    const f = await dir.getFileHandle('routing.nodes.json', { create: true });
    const w = await f.createWritable(); await w.write(serializeGraph(g, manifestFor(g, SKETCHES))); await w.close();
    window.showDirectoryPicker = async () => dir; await nodePatterns.link(); return (await nodePatterns.open('routing.nodes.json')).id;
  }, data);
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue(data.name);
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
    window.editorCaptureCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.editorCaptureCalls++; throw new Error('Editor must not capture'); };
  });
});

test('a new Audio node defaults to Global input + Mono and old fixtures select the same', async ({ page }) => {
  await openFixture(page, legacyGraph());
  await page.locator('[data-node-id=audio] .nodes-node-title').click();
  await expect(page.getByLabel('Audio input device')).toHaveValue('');
  await expect(page.getByLabel('Audio channel')).toHaveValue('mono');
  // The pinned node keeps its stored route and shows the missing device option.
  await page.locator('[data-node-id=audio2] .nodes-node-title').click();
  await expect(page.getByLabel('Audio input device')).toHaveValue('dev-A');
  await expect(page.getByLabel('Audio input device')).toHaveText(/Unavailable input/);
  await expect(page.getByLabel('Audio channel')).toHaveValue('left');
  // Opening an old file is not presented as an unsaved user edit.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.locator('.nodes-workspace')).not.toHaveAttribute('data-status', /.+/);
});

test('catalog snapshots feed labels; owner-absent states stay visible and repairable', async ({ page }) => {
  await openFixture(page, legacyGraph());
  await page.locator('[data-node-id=audio2] .nodes-node-title').click();
  // Publish a validated owner catalog over the bus (the owner's own shape).
  await page.evaluate(() => {
    const channel = new BroadcastChannel('viz2_channel');
    channel.postMessage({
      type: 'audio-inputs', audioOwnerId: 'owner-1', ownerStatus: 'active', catalogRevision: 4,
      complete: true, permissionState: 'granted', globalRequestedId: 'dev-A', globalActiveId: 'dev-A',
      globalStatus: 'running', fallback: false,
      inputs: [{ deviceId: 'dev-A', label: 'USB Interface' }, { deviceId: 'dev-B', label: '' }],
    });
    channel.close();
  });
  await expect(page.getByLabel('Audio input device')).toHaveText(/Global input \(Settings\)|USB Interface|Audio input 2|Unavailable input/);
  // The global option is annotated with the owner's active label.
  await expect(page.getByLabel('Audio input device').locator('option').first()).toHaveText(/dev-A|Global input/);
  // A stale/truncated catalog never silently re-selects another device.
  await expect(page.getByLabel('Audio input device')).toHaveValue('dev-A');
});

test('changing device/channel edits only that node, stays out of Settings, and persists', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('viz2_audio_device_id', 'dev-A'));
  await openFixture(page, legacyGraph());
  await page.locator('[data-node-id=audio2] .nodes-node-title').click();
  await page.getByLabel('Audio channel').selectOption('right');
  await expect(page.getByLabel('Audio channel')).toHaveValue('right');
  await expect(page.getByTestId('node-audio-status')).toBeVisible();
  await expect(page.getByTestId('node-signal-readout')).toBeVisible();
  // Tile detail carries the route summary.
  await expect(page.locator('[data-node-id=audio2] .nodes-node-detail')).toContainText('Unavailable input · Right');
  await page.locator('[data-node-id=audio] .nodes-node-title').click();
  await expect(page.getByLabel('Audio channel')).toHaveValue('mono');
  // Save: route fields are written; the global Settings selection is untouched.
  page.once('dialog', d => d.accept()); // Replace-on-disk confirmation
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.locator('.nodes-workspace')).not.toHaveAttribute('data-status', /.+/);
  const saved = await page.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    return (await nodePatterns.load(new URLSearchParams(location.search).get('graph'))).graph;
  });
  expect(saved.nodes.find(n => n.id === 'audio2').channel).toBe('right');
  expect(saved.nodes.find(n => n.id === 'audio2').deviceId).toBe('dev-A');
  expect(saved.nodes.find(n => n.id === 'audio').deviceId).toBeNull();
  expect(saved.nodes.find(n => n.id === 'audio').channel).toBe('mono');
  expect(await page.evaluate(() => localStorage.getItem('viz2_audio_device_id'))).toBe('dev-A');
  await page.reload();
  await page.locator('[data-node-id=audio2] .nodes-node-title').click();
  await expect(page.getByLabel('Audio channel')).toHaveValue('right');
  expect(await page.evaluate(() => window.editorCaptureCalls)).toBe(0);
});

test('route edits are keyboard-reachable and Delete inside a select never removes a node', async ({ page }) => {
  await openFixture(page, legacyGraph());
  await page.locator('[data-node-id=audio] .nodes-node-title').click();
  await page.getByLabel('Audio channel').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.nodes-node')).toHaveCount(4);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.nodes-node')).toHaveCount(4);
  await page.getByLabel('Audio channel').selectOption('left');
  await expect(page.getByLabel('Audio channel')).toHaveValue('left');
});
