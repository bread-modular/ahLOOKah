import { test, expect } from '@playwright/test';

// The inspector preview's pin. Pinned, the window stops following the selection
// and keeps drawing one image node, so a scalar node (Audio, Math, Script, LFO,
// MIDI) — which carries no picture of its own — no longer takes the picture away.
// The pin is transient editor state: never part of the draft, the history or the
// file. See the pin contract in src/nodes/NodesEditor.jsx.

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    window.__permission = 'granted'; window.__requestPermission = 'granted';
    FileSystemHandle.prototype.queryPermission = async () => window.__permission;
    FileSystemHandle.prototype.requestPermission = async () => { window.__permission = window.__requestPermission; return window.__permission; };
  });
  context.on('page', page => page.on('dialog', dialog => dialog.accept()));
});

// Red at full brightness (255) feeds a Color node at 0.2 (51) and then the Output,
// so the picture a node shows is never confused with the branch the Output plays.
const graph = () => ({ version: 1, name: 'Pinned preview', nodes: [
  { id: 'red', type: 'pattern', patternId: 'solid-color', x: 40, y: 60, params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 } },
  { id: 'dim', type: 'color', x: 330, y: 60, params: { saturation: 1, brightness: .2, contrast: 1, hue: 0 } },
  { id: 'meter', type: 'audio', band: 'bass', x: 40, y: 320 },
  { id: 'output', type: 'output', x: 620, y: 60 },
], edges: [{ from: 'red', to: 'dim', port: 'image' }, { from: 'dim', to: 'output', port: 'image' }] });

const FILE = 'pinned.nodes.json';
async function seedFixture(page, data = graph()) {
  const file = await page.evaluate(async graph => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    return serializeGraph(graph, manifestFor(graph, SKETCHES));
  }, data);
  await page.evaluate(async ({ text, name }) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns', { create: true });
    const handle = await dir.getFileHandle(name, { create: true });
    const writer = await handle.createWritable(); await writer.write(text); await writer.close();
    window.showDirectoryPicker = async () => dir;
    window.showOpenFilePicker = async () => [handle];
  }, { text: file, name: FILE });
}
async function readFixture(page) {
  return page.evaluate(async name => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns');
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, FILE);
}
async function openFixture(page, data = graph()) {
  await seedFixture(page, data);
  const id = await page.evaluate(async name => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    await nodePatterns.link(); return (await nodePatterns.open(name)).id;
  }, FILE);
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue(data.name);
}
const previewRed = page => page.getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(10, 10, 1, 1).data[0]);
const pin = page => page.getByTestId('preview-pin');
const pill = page => page.getByTestId('preview-pin-target');
const note = page => page.getByTestId('preview-pin-note');
const select = (page, id) => page.locator(`[data-node-id=${id}] .nodes-node-title`).click();

test('@core the preview pin keeps an image node on screen while a signal node is selected', async ({ page }) => {
  await page.goto('/?role=nodes');
  await openFixture(page);
  // Unpinned, the window follows the selection and offers the toggle for it.
  await expect(pin(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(pill(page)).toHaveCount(0);
  await expect(page.getByLabel('Selected node live preview')).toHaveCount(1);
  await select(page, 'red');
  await expect.poll(() => previewRed(page)).toBe(255);
  // The heading keeps the node's name and its IMAGE level label on one line; the pin
  // lives under the window instead.
  await expect(page.locator('.nodes-level-tag')).toHaveText('image');
  await expect(page.locator('.nodes-inspector-head h2')).toHaveText('Solid Color');
  // Pinning captures the node the window is showing, and a small pill beside the pin
  // names it instead of adding a second line of text.
  await pin(page).click();
  await expect(pin(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(pill(page)).toHaveText('Solid Color');
  await expect(note(page)).toHaveCount(0);
  await expect(page.getByLabel('Pinned preview of Solid Color')).toHaveCount(1);
  // A scalar node has no picture, so the window keeps this one — and the picture
  // that stays is the pinned node's (255), not the Output's dimmed red (51).
  await select(page, 'meter');
  await expect(note(page)).toHaveCount(0);
  await expect(page.locator('.nodes-level-tag')).toHaveText('signal');
  await expect.poll(() => previewRed(page)).toBe(255);
  // The pin sits directly under the preview, with the pinned node's pill on the same
  // line right after it — under the heading, never competing with the node's name.
  const canvasBox = await page.getByTestId('node-preview').boundingBox();
  const pinBox = await pin(page).boundingBox();
  const pillBox = await pill(page).boundingBox();
  expect(pinBox.y).toBeGreaterThan(canvasBox.y + canvasBox.height - 1);
  expect(pinBox.y - (canvasBox.y + canvasBox.height)).toBeLessThan(24);
  expect(pillBox.x - (pinBox.x + pinBox.width)).toBeLessThan(20);
  expect(Math.abs(pillBox.y + pillBox.height / 2 - (pinBox.y + pinBox.height / 2))).toBeLessThan(8);
  // The pin keeps no button outline and pinned its bare glyph is amber like the pill.
  // The pill hangs off its own text — no fixed height — with 4px over and under and
  // 5px at the sides.
  await expect(pill(page)).toHaveCSS('padding-top', '4px');
  await expect(pill(page)).toHaveCSS('padding-bottom', '4px');
  await expect(pill(page)).toHaveCSS('padding-left', '5px');
  await expect(pin(page)).toHaveCSS('border-top-width', '0px');
  await expect(pin(page)).toHaveCSS('color', 'rgb(255, 233, 168)');
  // The pill selects the node the window holds, without unpinning it.
  await pill(page).click();
  await expect(page.locator('[data-node-id=red]')).toHaveAttribute('data-primary', 'true');
  await expect(page.locator('.nodes-inspector-head h2')).toHaveText('Solid Color');
  await expect(pin(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => previewRed(page)).toBe(255);
  // Unpinning hands the window back to the selection: a scalar node has no image.
  await select(page, 'meter');
  await pin(page).click();
  await expect(pin(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(pill(page)).toHaveCount(0);
  await expect(page.getByTestId('node-preview')).toHaveCount(0);
  await expect(note(page)).toHaveText('A signal node has no picture; pin the preview to keep an image node on screen.');
  // Pinning from the scalar node itself pins the last image node that was shown.
  await pin(page).click();
  await expect(page.getByTestId('node-preview')).toBeVisible();
  await expect.poll(() => previewRed(page)).toBe(255);
  // A pinned window ignores a new image selection, and unpinning shows it again.
  await select(page, 'dim');
  await expect.poll(() => previewRed(page)).toBe(255);
  await expect(pill(page)).toHaveText('Solid Color');
  await pin(page).click();
  await expect.poll(() => previewRed(page)).toBe(51);
});

test('@core deleting the pinned node drops the pin with it', async ({ page }) => {
  await page.goto('/?role=nodes');
  await openFixture(page);
  await select(page, 'dim');
  await expect.poll(() => previewRed(page)).toBe(51);
  await pin(page).click();
  await expect(pin(page)).toHaveAttribute('aria-pressed', 'true');
  await select(page, 'meter');
  await expect.poll(() => previewRed(page)).toBe(51);
  // Delete the pinned node: the pin goes with it instead of drawing a node that
  // no longer exists, and the window follows the selection again.
  await select(page, 'dim');
  await page.getByLabel('Graph workspace').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-node-id=dim]')).toHaveCount(0);
  await expect(pin(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(pill(page)).toHaveCount(0);
  await select(page, 'meter');
  await expect(page.getByTestId('node-preview')).toHaveCount(0);
});

test('@core a pin whose remembered image node left the graph falls back to the Output', async ({ page }) => {
  await page.goto('/?role=nodes');
  await openFixture(page);
  // A node created from the palette is selected (and therefore remembered)…
  await page.getByRole('button', { name: '+ Color', exact: true }).dragTo(page.getByLabel('Graph workspace'));
  const created = await page.locator('.nodes-node[data-primary=true]').getAttribute('data-node-id');
  // …then a signal node is selected and undo takes the created node away again.
  await select(page, 'meter');
  await page.keyboard.press('Control+z');
  await expect(page.locator(`[data-node-id=${created}]`)).toHaveCount(0);
  await expect(page.getByTestId('node-preview')).toHaveCount(0);
  // Pin still works: the forgotten node is never a target, so the window pins the
  // Output it would fall back to, and the heading pill names it.
  await pin(page).click();
  await expect(pin(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(pill(page)).toHaveText('Output');
  await expect.poll(() => previewRed(page)).toBe(51);
});

test('@core the pin is editor state, not a draft edit: saving writes the same file', async ({ page }) => {
  await page.goto('/?role=nodes');
  await openFixture(page);
  const before = await readFixture(page);
  await select(page, 'red');
  await pin(page).click();
  await expect(pin(page)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.nodes-disk-error')).toHaveCount(0);
  await expect.poll(() => readFixture(page)).toBe(before);
  // The pin itself survives the write; it is the window's own state.
  await expect(pin(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => previewRed(page)).toBe(255);
});
