import { test, expect } from '@playwright/test';
import { validateGraph, mapSignal } from '../src/nodes/model.js';

// Undo/redo is a keyboard-only feature: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y
// over the editor's draft. These tests drive the real shortcuts in the editor and
// check the two things that make a history usable — that one gesture is one step,
// and that everything the draft owns (the graph *and* its dependency manifest)
// comes back exactly as it was.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    window.__permission = 'granted'; window.__requestPermission = 'granted';
    FileSystemHandle.prototype.queryPermission = async () => window.__permission;
    FileSystemHandle.prototype.requestPermission = async () => { window.__permission = window.__requestPermission; return window.__permission; };
  });
  // Reload from Disk and collision confirmations are accepted, as in nodes.spec.js.
  context.on('page', page => page.on('dialog', dialog => dialog.accept()));
});

const graph = () => ({ version: 1, name: 'Neon composite', nodes: [
  { id: 'red', type: 'pattern', patternId: 'solid-color', x: 40, y: 60, params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 } },
  { id: 'green', type: 'pattern', patternId: 'solid-color', x: 40, y: 290, params: { hue: 1 / 3, saturation: 1, brightness: 1, pulse: 0 } },
  { id: 'mix', type: 'blend', x: 330, y: 170, mode: 'Screen', opacity: 1 },
  { id: 'output', type: 'output', x: 620, y: 170 },
], edges: [{ from: 'red', to: 'mix', port: 'base' }, { from: 'green', to: 'mix', port: 'layer' }, { from: 'mix', to: 'output', port: 'image' }] });

async function seedFixture(page, data = graph()) {
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
}
async function openFixture(page, data = graph()) {
  await seedFixture(page, data);
  const id = await page.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    await nodePatterns.link(); return (await nodePatterns.open('neon.nodes.json')).id;
  });
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue(data.name);
}

const nodeTitle = (page, id) => page.locator(`[data-node-id="${id}"] .nodes-node-title`);
const nodeIds = page => page.locator('.nodes-node').evaluateAll(nodes => nodes.map(n => n.dataset.nodeId).sort());
const selectedIds = page => page.locator('.nodes-node.is-selected').evaluateAll(nodes => nodes.map(n => n.dataset.nodeId).sort());
const wireCount = page => page.locator('.nodes-wires path').count();
const positions = page => page.locator('.nodes-node').evaluateAll(nodes => Object.fromEntries(nodes.map(n => [n.dataset.nodeId, { x: parseFloat(n.style.left), y: parseFloat(n.style.top) }])));
const diskText = page => page.evaluate(async () => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('node-patterns');
  return (await (await dir.getFileHandle('neon.nodes.json')).getFile()).text();
});
// The editor has no dirty badge, so its draft is read the way the browser reads
// it: the beforeunload guard it installs while the draft differs from disk.
const leavingBlocked = page => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
async function deleteSelected(page) {
  await page.getByLabel('Graph workspace').focus();
  await page.keyboard.press('Delete');
}

test('draft history core coalesces gestures, seals no-op gestures, bounds the stack and drops the redo branch', async ({ page }) => {
  await page.goto('/?role=nodes');
  const seen = await page.evaluate(async () => {
    const { createDraftHistory } = await import('/src/nodes/history.js');
    const draft = name => ({ graph: { version: 1, name, nodes: [], edges: [] }, dependencies: [{ id: name, signature: null }] });
    const nameOf = entry => entry?.graph.name ?? null;
    let clock = 0;
    const history = createDraftHistory({ limit: 2, now: () => clock });
    const seen = {};
    seen.fresh = { canUndo: history.canUndo, canRedo: history.canRedo, undo: nameOf(history.undo(draft('none'))) };
    history.record(draft('one'));
    seen.single = { undo: nameOf(history.undo(draft('two'))), canRedo: history.canRedo, canUndo: history.canUndo };
    seen.redo = { redo: nameOf(history.redo(draft('one'))), canRedo: history.canRedo };
    // A new edit after an undo replaces the future instead of stacking onto it.
    history.undo(draft('two'));
    history.record(draft('one'));
    seen.invalidated = { canRedo: history.canRedo, canUndo: history.canUndo };
    // Same key inside the window is one step; the window closing starts a new one.
    history.reset();
    history.record(draft('a'), { merge: 'g' });
    clock = 100; history.record(draft('b'), { merge: 'g' });
    clock = 200; history.record(draft('c'), { merge: 'g' });
    seen.merged = nameOf(history.undo(draft('d')));
    history.reset();
    history.record(draft('a'), { merge: 'g' });
    clock = 5000; history.record(draft('b'), { merge: 'g' });
    seen.window = nameOf(history.undo(draft('c')));
    // A gesture that ends exactly where it started leaves no step behind.
    history.reset();
    history.record(draft('a'), { merge: 'g' });
    seen.sealDropped = history.seal(draft('a'));
    seen.sealAgain = history.seal(draft('a'));
    seen.afterNoopSeal = history.canUndo;
    history.record(draft('a'), { merge: 'g' });
    seen.sealKept = history.seal(draft('b'));
    seen.keptUndo = nameOf(history.undo(draft('b')));
    // Two drags are two steps even back to back; the frames inside one are one.
    history.reset();
    history.record(draft('a'), { merge: 'move:1', windowMs: Infinity });
    clock = 1; history.record(draft('b'), { merge: 'move:2', windowMs: Infinity });
    clock = 2; history.record(draft('c'), { merge: 'move:2', windowMs: Infinity });
    seen.gestures = [nameOf(history.undo(draft('d'))), nameOf(history.undo(draft('a')))];
    // Bounded stack: the oldest entries go, and peek never consumes one.
    history.reset();
    for (const name of ['a', 'b', 'c']) history.record(draft(name));
    seen.peek = [nameOf(history.peek('undo')), history.canUndo];
    seen.bounded = [nameOf(history.undo(draft('d'))), nameOf(history.undo(draft('x'))), history.canUndo];
    return seen;
  });
  expect(seen.fresh).toEqual({ canUndo: false, canRedo: false, undo: null });
  expect(seen.single).toEqual({ undo: 'one', canRedo: true, canUndo: false });
  expect(seen.redo).toEqual({ redo: 'two', canRedo: false });
  expect(seen.invalidated).toEqual({ canRedo: false, canUndo: true });
  expect(seen.merged).toBe('a');
  expect(seen.window).toBe('b');
  expect(seen.sealDropped).toBe(true);
  expect(seen.sealAgain).toBe(false);
  expect(seen.afterNoopSeal).toBe(false);
  expect(seen.sealKept).toBe(false);
  expect(seen.keptUndo).toBe('a');
  expect(seen.gestures).toEqual(['b', 'a']);
  expect(seen.peek).toEqual(['c', true]);
  expect(seen.bounded).toEqual(['c', 'b', false]);
});

test('Ctrl+Z undoes an edit and Ctrl+Shift+Z / Ctrl+Y redo it, with the manifest restored and no added UI', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/?role=nodes'); await openFixture(page);
  // The shortcut is the whole feature: no button and no menu entry was added.
  expect(await page.getByRole('button', { name: /undo|redo/i }).count()).toBe(0);
  await page.keyboard.press('Control+a');
  await expect.poll(() => selectedIds(page)).toEqual(['green', 'mix', 'red']);
  await deleteSelected(page);
  await expect.poll(() => nodeIds(page)).toEqual(['output']);
  expect(await wireCount(page)).toBe(0);
  // The manifest followed the graph: no Pattern source is referenced any more.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(JSON.parse(await diskText(page)).dependencies).toEqual([]);
  // Ctrl+Z restores the graph *and* its dependency manifest, not just the nodes.
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'mix', 'output', 'red']);
  expect(await wireCount(page)).toBe(3);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  const restored = JSON.parse(await diskText(page));
  expect(restored.graph).toEqual(validateGraph(graph()));
  expect(restored.dependencies.map(d => d.id)).toEqual(['solid-color']);
  // Redo puts the edit back; both redo shortcuts are honoured.
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => nodeIds(page)).toEqual(['output']);
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'mix', 'output', 'red']);
  await page.keyboard.press('Control+y');
  await expect.poll(() => nodeIds(page)).toEqual(['output']);
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'mix', 'output', 'red']);
  expect(await wireCount(page)).toBe(3);
});

test('a node drag is exactly one undo step, and a parameter gesture is one step per control', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/?role=nodes'); await openFixture(page);
  const before = await positions(page);
  const box = await nodeTitle(page, 'red').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 70, { steps: 10 });
  await page.mouse.up();
  const dragged = await positions(page);
  expect(dragged.red).not.toEqual(before.red);
  // One step for the whole drag: the first undo is already the pre-drag position,
  // and a second undo has nothing of that gesture left to replay.
  await page.keyboard.press('Control+z');
  await expect.poll(() => positions(page)).toEqual(before);
  await page.keyboard.press('Control+z');
  await expect.poll(() => positions(page)).toEqual(before);
  // Slider frames belong to the control that produced them: many input events,
  // one step, and a single undo restores the value the node was opened with.
  await nodeTitle(page, 'red').click();
  const brightness = page.getByLabel('Brightness', { exact: true });
  await expect(brightness).toHaveValue('1');
  await brightness.evaluate(el => { for (const value of ['0.9', '0.8', '0.7']) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); } });
  await expect(brightness).toHaveValue('0.7');
  await page.keyboard.press('Control+z');
  await expect(brightness).toHaveValue('1');
  expect(await wireCount(page)).toBe(3);
  // A real drag on the slider is one step per gesture, not one for the whole
  // session: two separate drags need two undos, newest first.
  const track = await brightness.boundingBox();
  const dragTrack = async fraction => {
    const y = track.y + track.height / 2;
    await page.mouse.move(track.x + track.width * fraction, y);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * fraction, y, { steps: 4 });
    await page.mouse.up();
  };
  await dragTrack(.3);
  const firstDrag = await brightness.inputValue();
  expect(firstDrag).not.toBe('1');
  await dragTrack(.7);
  const secondDrag = await brightness.inputValue();
  expect(secondDrag).not.toBe(firstDrag);
  await page.keyboard.press('Control+z');
  await expect(brightness).toHaveValue(firstDrag);
  await page.keyboard.press('Control+z');
  await expect(brightness).toHaveValue('1');
});

test('a new edit drops the redo branch', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/?role=nodes'); await openFixture(page);
  await nodeTitle(page, 'mix').click();
  await deleteSelected(page);
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'output', 'red']);
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'mix', 'output', 'red']);
  await nodeTitle(page, 'green').click();
  await deleteSelected(page);
  await expect.poll(() => nodeIds(page)).toEqual(['mix', 'output', 'red']);
  // The redo branch belonged to the older edit and is gone: the deleted 'mix' must
  // not come back, and 'green' must stay deleted.
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => nodeIds(page)).toEqual(['mix', 'output', 'red']);
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'mix', 'output', 'red']);
});

test('a focused field keeps the browser\'s own undo and never rewinds the graph', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/?role=nodes'); await openFixture(page);
  await nodeTitle(page, 'mix').click();
  await deleteSelected(page);
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'output', 'red']);
  // With a graph step available, Ctrl+Z inside the name field must belong to the
  // field: the browser undoes the typed text and the graph is left untouched.
  const name = page.getByLabel('Graph name');
  await name.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' v2');
  await expect(name).toHaveValue('Neon composite v2');
  await page.keyboard.press('Control+z');
  await expect(name).toHaveValue('Neon composite');
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'output', 'red']);
  // The canvas still owns the shortcut once focus leaves the field again.
  await page.getByLabel('Graph workspace').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'mix', 'output', 'red']);
});

test('the draft is clean again once undo returns it to the loaded state', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/?role=nodes'); await openFixture(page);
  expect(await leavingBlocked(page)).toBe(false);
  await nodeTitle(page, 'red').click();
  await deleteSelected(page);
  expect(await leavingBlocked(page)).toBe(true);
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'mix', 'output', 'red']);
  expect(await leavingBlocked(page)).toBe(false);
  await page.keyboard.press('Control+y');
  expect(await leavingBlocked(page)).toBe(true);
  await page.keyboard.press('Control+z');
  expect(await leavingBlocked(page)).toBe(false);
});

test('Reload from Disk starts a fresh history', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/?role=nodes'); await openFixture(page);
  await nodeTitle(page, 'red').click();
  await deleteSelected(page);
  await nodeTitle(page, 'green').click();
  await deleteSelected(page);
  await expect.poll(() => nodeIds(page)).toEqual(['mix', 'output']);
  await page.getByRole('button', { name: 'Reload from Disk', exact: true }).click();
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'mix', 'output', 'red']);
  // Nothing before the reload is undoable any more: the disk state is the start.
  await page.getByLabel('Graph workspace').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'mix', 'output', 'red']);
  expect(await leavingBlocked(page)).toBe(false);
});

test('a mapping range drag is one undo step, and two drags are two steps', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  // A Color node whose Brightness is driven by an Audio band: the mapped slider
  // shows the violet range overlay whose box is dragged to rescale the mapping.
  const mapped = mapSignal({ version: 1, name: 'Mapped range', nodes: [
    { id: 'tint', type: 'color', x: 120, y: 60, params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 } },
    { id: 'audio', type: 'audio', band: 'bass', x: 40, y: 420 },
    { id: 'output', type: 'output', x: 620, y: 60 },
  ], edges: [{ from: 'tint', to: 'output', port: 'image' }] }, 'audio', 'tint', 'brightness', .2, .8);
  await page.goto('/?role=nodes'); await openFixture(page, mapped);
  await page.locator('[data-node-id=tint] .nodes-node-title').click();
  const box = page.getByTestId('mapping-box-brightness');
  const range = () => box.evaluate(el => ({ left: el.style.left, width: el.style.width }));
  await expect(box).toBeVisible();
  const start = await range();
  expect(start.left).toMatch(/^\d+(\.\d+)?%$/);
  const drag = async dx => {
    const rect = await box.boundingBox();
    const y = rect.y + rect.height / 2, x = rect.x + rect.width / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 8 });
    await page.mouse.up();
  };
  await drag(60);
  const afterFirst = await range();
  expect(afterFirst).not.toEqual(start);
  await drag(40);
  const afterSecond = await range();
  expect(afterSecond).not.toEqual(afterFirst);
  // One undo per drag: the whole range gesture is a single step even though every
  // pointer move rewrote the mapping, and the endpoints come back exactly.
  await page.keyboard.press('Control+z');
  await expect.poll(range).toEqual(afterFirst);
  await page.keyboard.press('Control+z');
  await expect.poll(range).toEqual(start);
  // The undos restored the draft exactly: the image wire and the terminal
  // modulation wire are both still drawn.
  expect(await wireCount(page)).toBe(2);
});

test('typed mapping endpoints are separate undo steps, while one typed value stays one step', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  const mapped = mapSignal({ version: 1, name: 'Typed range', nodes: [
    { id: 'tint', type: 'color', x: 120, y: 60, params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 } },
    { id: 'audio', type: 'audio', band: 'bass', x: 40, y: 420 },
    { id: 'output', type: 'output', x: 620, y: 60 },
  ], edges: [{ from: 'tint', to: 'output', port: 'image' }] }, 'audio', 'tint', 'brightness', .2, .8);
  await page.goto('/?role=nodes'); await openFixture(page, mapped);
  await page.locator('[data-node-id=tint] .nodes-node-title').click();
  await page.getByRole('button', { name: 'Brightness mapping settings' }).click();
  const maxField = page.getByLabel('Brightness Mapping max', { exact: true });
  await expect(maxField).toHaveValue('0.8');
  // A typed value groups its own keystrokes into one step...
  await maxField.focus();
  await maxField.fill('0.3');
  await expect(maxField).toHaveValue('0.3');
  // ...but a second typed value, long after the first, is its own step. Focus goes
  // to the canvas rather than another field, so no pointer release can be what
  // separates them: only the grouping window does.
  await page.waitForTimeout(700);
  await maxField.fill('0.6');
  await expect(maxField).toHaveValue('0.6');
  await page.getByLabel('Graph workspace').focus();
  await page.keyboard.press('Control+z');
  await expect(maxField).toHaveValue('0.3');
  await page.keyboard.press('Control+z');
  await expect(maxField).toHaveValue('0.8');
  // Nothing else was recorded: the field and its mapping are back at the start.
  await page.keyboard.press('Control+z');
  await expect(maxField).toHaveValue('0.8');
  // Two fields are two controls: editing max and min back to back, well inside the
  // keystroke grouping window, is still two steps — one undo restores only min.
  const minField = page.getByLabel('Brightness Mapping min', { exact: true });
  await expect(minField).toHaveValue('0.2');
  await maxField.focus();
  await maxField.fill('0.5');
  await minField.focus();
  await minField.fill('0.4');
  await page.getByLabel('Graph workspace').focus();
  await page.keyboard.press('Control+z');
  await expect(minField).toHaveValue('0.2');
  await expect(maxField).toHaveValue('0.5');
  await page.keyboard.press('Control+z');
  await expect(maxField).toHaveValue('0.8');
  await expect(minField).toHaveValue('0.2');
});

test('a saved rename survives undoing a graph edit', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/?role=nodes'); await openFixture(page);
  await nodeTitle(page, 'mix').click();
  await deleteSelected(page);
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'output', 'red']);
  // The name field commits on Save, so the rename is part of the saved pattern
  // while the delete is the only graph edit in the history.
  const name = page.getByLabel('Graph name');
  await name.click();
  await name.fill('Renamed graph');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(JSON.parse(await diskText(page)).graph.name).toBe('Renamed graph');
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'mix', 'output', 'red']);
  await expect(name).toHaveValue('Renamed graph');
  // Saving the restored graph keeps the rename with it.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  const saved = JSON.parse(await diskText(page));
  expect(saved.graph.name).toBe('Renamed graph');
  expect(saved.graph.nodes.map(n => n.id).sort()).toEqual(['green', 'mix', 'output', 'red']);
});

test('a deleted connection is restored by undo, and the selection follows the restored graph', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/?role=nodes'); await openFixture(page);
  await page.locator('[data-connection-from="mix"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('selected-connection')).toHaveText(/Blend → Output image/);
  await page.getByRole('button', { name: 'Delete connection', exact: true }).click();
  expect(await wireCount(page)).toBe(2);
  await page.keyboard.press('Control+z');
  expect(await wireCount(page)).toBe(3);
  // The restored wire is a real connection again, not a stray path.
  await page.locator('[data-connection-from="mix"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('selected-connection')).toHaveText(/Blend → Output image/);
  // Undoing a node whose wire was selected: the wire selection is dropped rather
  // than pointing at a connection the restored graph does not contain.
  await page.keyboard.press('Escape');
  await nodeTitle(page, 'mix').click();
  await deleteSelected(page);
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'output', 'red']);
  await page.keyboard.press('Control+z');
  await expect.poll(() => nodeIds(page)).toEqual(['green', 'mix', 'output', 'red']);
  await expect(page.getByTestId('selected-connection')).toHaveCount(0);
  expect(await wireCount(page)).toBe(3);
});
