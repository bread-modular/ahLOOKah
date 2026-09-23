import { test, expect } from '@playwright/test';

// Real editor, repository, OPFS files and React event handlers; no runtime/model
// doubles. Each case gets its own browser context and an isolated linked folder.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
  });
});

const color = (id = 'red') => ({ id, type: 'pattern', patternId: 'solid-color', x: 40, y: 60,
  params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 } });
const output = (id = 'output') => ({ id, type: 'output', x: 650, y: 60 });
const script = (id, y) => ({ id, type: 'script', language: 'body', source: 'return x;', inputX: 1, inputY: 0, x: 40, y });
const base = (nodes, edges = [], modulations = []) => ({ version: 1, name: 'Audit editor', nodes, edges, modulations });
const select = (page, id) => page.locator(`[data-node-id="${id}"] .nodes-node-title`).click();
const errorsOf = page => { const errors = []; page.on('pageerror', error => errors.push(error.message)); return errors; };

async function openGraph(page, graph, mediaMeta = null) {
  await page.goto('/?role=nodes');
  const id = await page.evaluate(async ({ graph, mediaMeta }) => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    // Persisted media metadata (no blob needed) is enough for the registry to
    // expose that pattern's descriptor — including its option parameters.
    if (mediaMeta) {
      localStorage.setItem('viz2_media_patterns', JSON.stringify(mediaMeta));
      (await import('/src/media/media-registry.js')).registerMediaSketches(SKETCHES);
    }
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('editor-audit-regressions', { create: true });
    const file = await dir.getFileHandle('audit.nodes.json', { create: true });
    const writer = await file.createWritable();
    await writer.write(serializeGraph(graph, manifestFor(graph, SKETCHES))); await writer.close();
    window.showDirectoryPicker = async () => dir;
    await nodePatterns.link();
    // A link grants access; the file is added explicitly (as OPEN does).
    return (await nodePatterns.open('audit.nodes.json')).id;
  }, { graph, mediaMeta });
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue(graph.name);
  return id;
}

const diskGraph = (page, id) => page.evaluate(async id => (await import('/src/nodes/repository.js')).nodePatterns.records.find(r => r.id === id)?.graph, id);

test('F01: an empty/whitespace name is a guarded draft, never an embedded root crash', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New Node Pattern', exact: true }).click();
  const name = page.getByLabel('Graph name');
  await expect(name).toHaveValue('Untitled graph');
  await name.fill('');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#nodes-name-error')).toHaveText('Name must contain 1–80 characters');
  await expect(page.getByTestId('nodes-blocked')).toContainText('Name must contain 1–80 characters');
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.locator('#panel-main')).toHaveCount(1);
  const dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
  await page.getByRole('button', { name: 'Back to Main' }).click();
  await expect(name).toHaveValue('');
  expect(dialogs).toContain('Discard unsaved changes to this draft?');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.nodes-disk-error')).toContainText('Name must contain 1–80 characters');
  await name.fill('   ');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await name.fill('N');
  await expect(name).toHaveAttribute('aria-invalid', 'false');
  await expect(page.getByTestId('nodes-blocked')).toHaveCount(0);
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(errors).toEqual([]);
});

test('F01: an invalid loaded name keeps Reload and beforeunload guarded without throwing', async ({ page }) => {
  const errors = errorsOf(page);
  await openGraph(page, base([output()]));
  await page.getByLabel('Graph name').fill('  ');
  const warned = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event); return event.defaultPrevented;
  });
  expect(warned).toBe(true);
  const dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
  await page.getByRole('button', { name: 'Reload from Disk' }).click();
  await expect(page.getByLabel('Graph name')).toHaveValue('  ');
  expect(dialogs).toContain('Discard unsaved changes to this draft?');
  expect(errors).toEqual([]);
});

test('F02: Script drafts retain language/text per node; Apply B leaves A pending through Save and Reload', async ({ page }) => {
  const errors = errorsOf(page);
  const id = await openGraph(page, base([script('a', 60), script('b', 270), output()]));
  await select(page, 'a');
  await page.getByLabel('Script source').fill('return 111;');
  await select(page, 'b');
  await page.getByLabel('Script source').fill('return 222;');
  await select(page, 'a');
  await expect(page.getByLabel('Script source')).toHaveValue('return 111;');
  await page.getByLabel('Script language').selectOption('expression');
  await page.getByLabel('Script source').fill('x + 111');
  await select(page, 'b');
  await expect(page.getByLabel('Script source')).toHaveValue('return 222;');
  await page.getByRole('button', { name: 'Apply script' }).click();
  await select(page, 'a');
  await expect(page.getByLabel('Script language')).toHaveValue('expression');
  await expect(page.getByLabel('Script source')).toHaveValue('x + 111');
  const dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => diskGraph(page, id)).toMatchObject({ nodes: [
    { id: 'a', source: 'return x;', language: 'body' },
    { id: 'b', source: 'return 222;', language: 'body' },
    { id: 'output' },
  ] });
  expect(dialogs).toContain('Script text has not been applied. Save without it?');
  await expect(page.getByLabel('Script source')).toHaveValue('x + 111');
  // A pending draft survives B's Apply and even a Save that omitted A.
  await page.getByRole('button', { name: 'Reload from Disk' }).click();
  await select(page, 'a');
  await expect(page.getByLabel('Script source')).toHaveValue('return x;');
  expect(dialogs).toContain('Discard unapplied script text?');
  expect(errors).toEqual([]);
});

test('F02: deleting a pending Script asks before discarding only that node; other pending drafts still guard leaving', async ({ page }) => {
  const errors = errorsOf(page);
  await openGraph(page, base([script('a', 60), script('b', 270), output()]));
  await select(page, 'a'); await page.getByLabel('Script source').fill('return 111;');
  await select(page, 'b'); await page.getByLabel('Script source').fill('return 222;');
  const dialogs = [];
  let accept = false;
  page.on('dialog', dialog => { dialogs.push(dialog.message()); if (accept) dialog.accept(); else dialog.dismiss(); });
  await page.getByLabel('Graph workspace').focus(); await page.keyboard.press('Delete');
  await expect(page.locator('[data-node-id="b"]')).toHaveCount(1);
  expect(dialogs.at(-1)).toMatch(/discard unapplied script text/);
  accept = true;
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-node-id="b"]')).toHaveCount(0);
  await select(page, 'a');
  await expect(page.getByLabel('Script source')).toHaveValue('return 111;');
  accept = false;
  await page.getByRole('button', { name: 'Reload from Disk' }).click();
  await expect(page.locator('[data-node-id="b"]')).toHaveCount(0);
  expect(dialogs.at(-1)).toBe('Discard unapplied script text?');
  expect(errors).toEqual([]);
});

test('F02: hosted Back to Main keeps both pending Script drafts when the operator cancels', async ({ page }) => {
  const errors = errorsOf(page);
  const id = await openGraph(page, base([script('a', 60), script('b', 270), output()]));
  await page.goto('/');
  await page.locator(`.library-btn[data-id="${id}"]`).click();
  await page.getByRole('button', { name: 'Edit Pattern', exact: true }).click();
  await expect(page.locator('.app-editor-panel')).toBeVisible();
  await select(page, 'a'); await page.getByLabel('Script source').fill('return 111;');
  await select(page, 'b'); await page.getByLabel('Script source').fill('return 222;');
  const dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
  await page.getByRole('button', { name: 'Back to Main', exact: true }).click();
  await expect(page.locator('.app-editor-panel')).toBeVisible();
  expect(dialogs).toContain('Discard unapplied script text?');
  await select(page, 'a'); await expect(page.getByLabel('Script source')).toHaveValue('return 111;');
  await select(page, 'b'); await expect(page.getByLabel('Script source')).toHaveValue('return 222;');
  expect(errors).toEqual([]);
});

test('F09: invalid connections, cycles and protected Output explain failures accessibly without a success strip', async ({ page }) => {
  const errors = errorsOf(page);
  await openGraph(page, base([script('a', 270), { id: 'tint', type: 'color', x: 40, y: 60,
    params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 } }, output()]));
  await page.getByLabel('a output', { exact: true }).click();
  await page.getByLabel('output input image').click();
  await expect(page.getByTestId('nodes-action-error')).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('nodes-action-error')).toContainText('Scalar outputs connect');
  await page.getByLabel('tint output', { exact: true }).click();
  await page.getByLabel('output input image').click();
  await expect(page.getByTestId('nodes-action-error')).toHaveCount(0);
  await page.getByLabel('tint output', { exact: true }).click();
  await page.getByLabel('tint input image').click();
  await expect(page.getByTestId('nodes-action-error')).toContainText('cycle');
  await select(page, 'output');
  await page.getByLabel('Graph workspace').focus(); await page.keyboard.press('Delete');
  await expect(page.getByTestId('nodes-action-error')).toContainText('Output is required and cannot be deleted');
  await expect(page.locator('[data-node-id="output"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('F10: signal bounds clamp with field feedback, reject reversed inputs and keep reversed outputs', async ({ page }) => {
  const errors = errorsOf(page);
  const graph = base([color(), { id: 'audio', type: 'audio', band: 'bass', x: 50, y: 300 }, output()],
    [{ from: 'red', to: 'output', port: 'image' }],
    [{ from: 'audio', to: 'red', param: 'brightness', min: .2, max: .8, inputMin: 0, inputMax: 1 }]);
  const id = await openGraph(page, graph);
  await select(page, 'red');
  await page.getByRole('button', { name: 'Brightness mapping settings' }).click();
  const low = page.getByLabel('Brightness Signal in min', { exact: true });
  const high = page.getByLabel('Brightness Signal in max', { exact: true });
  await high.fill('1e6'); await high.blur();
  await expect(high).toHaveValue('1000000');
  await low.fill('-1e6'); await low.blur();
  await expect(low).toHaveValue('-1000000');
  await high.fill('1e9');
  await expect(page.getByText('Signal in max clamped to 1000000.')).toBeVisible();
  await high.blur(); await expect(high).toHaveValue('1000000');
  await low.fill('-1e9');
  await expect(page.getByText('Signal in min clamped to -1000000.')).toBeVisible();
  await low.blur(); await expect(low).toHaveValue('-1000000');
  await low.focus(); await low.press('ControlOrMeta+A'); await low.press('-');
  await low.blur(); await expect(low).toHaveValue('-1000000'); // partial negative is not committed
  await low.fill('0.5'); await low.blur();
  await high.fill('0.5');
  await expect(high).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Signal input range needs a max greater than its min.').first()).toBeVisible();
  await high.blur(); await expect(high).toHaveValue('1000000');
  await expect(page.getByTestId('nodes-action-error')).toContainText('Signal input range');
  await page.getByLabel('Brightness Mapping min').fill('0.8');
  await page.getByLabel('Brightness Mapping max').fill('0.2');
  page.once('dialog', dialog => dialog.accept()); // overwriting the seeded file
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => diskGraph(page, id)).toMatchObject({ modulations: [
    { from: 'audio', to: 'red', param: 'brightness', min: .8, max: .2, inputMin: .5, inputMax: 1000000 },
  ] });
  expect(errors).toEqual([]);
});

test('F11: an arbitrary Output ID is selected and renders on initial open, Reload and page reload', async ({ page }) => {
  const errors = errorsOf(page);
  await openGraph(page, base([color(), output('final')], [{ from: 'red', to: 'final', port: 'image' }]));
  const pixels = () => page.getByTestId('node-preview').evaluate(c => [...c.getContext('2d').getImageData(240, 135, 1, 1).data]);
  await expect(page.locator('[data-node-id="final"]')).toHaveAttribute('data-primary', 'true');
  await expect.poll(pixels).toEqual([255, 0, 0, 255]);
  await select(page, 'red');
  await page.getByRole('button', { name: 'Reload from Disk' }).click();
  await expect(page.locator('[data-node-id="final"]')).toHaveAttribute('data-primary', 'true');
  await expect.poll(pixels).toEqual([255, 0, 0, 255]);
  await page.reload();
  await expect(page.locator('[data-node-id="final"]')).toHaveAttribute('data-primary', 'true');
  await expect.poll(pixels).toEqual([255, 0, 0, 255]);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Reset to default (double click). Inspector parameters behave like a photo
// editor's sliders: double-clicking one parameter writes that parameter's own
// sketch default through the same onChange path a drag uses, so the edit reaches
// the draft, the live preview and the saved file — and nothing else moves.
// ---------------------------------------------------------------------------

// Solid Color's own defaults (hue .6, saturation .7, brightness .9) let each reset
// be proved by a value the parameter did not already hold.
const defaultColor = (id = 'red') => ({ id, type: 'pattern', patternId: 'solid-color', x: 40, y: 60,
  params: { hue: 0.6, saturation: 0.7, brightness: 0.9, pulse: 0 } });
const setSlider = (slider, value) => slider.evaluate((el, value) => {
  el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

test('F12: double-clicking a parameter resets only that parameter to its default', async ({ page }) => {
  const errors = errorsOf(page);
  const id = await openGraph(page, base([defaultColor(), output()], [{ from: 'red', to: 'output', port: 'image' }]));
  await select(page, 'red');
  const pixels = () => page.getByTestId('node-preview').evaluate(c => [...c.getContext('2d').getImageData(240, 135, 1, 1).data]);
  await expect.poll(async () => (await pixels())[3]).toBe(255);
  const hue = page.locator('#param-nodes-red-hue'), saturation = page.locator('#param-nodes-red-saturation'),
    brightness = page.locator('#param-nodes-red-brightness');
  const readout = key => page.locator(`[data-param-target=${key}] .param-value`);
  const baseline = await pixels();
  await expect(hue).toHaveValue('0.6');
  await expect(saturation).toHaveValue('0.7');
  await expect(brightness).toHaveValue('0.9');
  // Slider surface: both clicks land on the track near its left end, so the
  // parameter is only back at its default because the reset ran last.
  await setSlider(hue, '0');
  await expect(readout('hue')).toHaveText('0.00');
  await expect.poll(pixels).not.toEqual(baseline);
  await hue.dblclick({ position: { x: 4, y: 9 } });
  await expect(hue).toHaveValue('0.6');
  await expect(readout('hue')).toHaveText('0.60');
  await expect.poll(pixels).toEqual(baseline);
  // Name surface: the label resets its own parameter.
  await setSlider(saturation, '0.2');
  await page.locator('[data-param-target=saturation] .param-head label').dblclick();
  await expect(saturation).toHaveValue('0.7');
  // Value surface: the readout resets its parameter and leaves the others alone.
  await setSlider(brightness, '0');
  await expect(readout('brightness')).toHaveText('0.00');
  await readout('brightness').dblclick();
  await expect(brightness).toHaveValue('0.9');
  await expect(readout('brightness')).toHaveText('0.90');
  await expect(hue).toHaveValue('0.6');
  await expect(saturation).toHaveValue('0.7');
  await expect.poll(pixels).toEqual(baseline);
  // A reset is an ordinary edit: it is saved with the graph.
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await diskGraph(page, id);
  expect(saved.nodes.find(node => node.id === 'red').params).toMatchObject({ hue: 0.6, saturation: 0.7, brightness: 0.9 });
  expect(errors).toEqual([]);
});

test('F12: a mapped parameter resets only its saved base value and keeps its mapping', async ({ page }) => {
  const errors = errorsOf(page);
  const id = await openGraph(page, base([defaultColor(), { id: 'audio', type: 'audio', band: 'bass', x: 50, y: 300 }, output()],
    [{ from: 'red', to: 'output', port: 'image' }],
    [{ from: 'audio', to: 'red', param: 'brightness', min: .2, max: .8, inputMin: 0, inputMax: 1 }]));
  await select(page, 'red');
  const row = page.locator('[data-param-target=brightness]');
  const brightness = page.locator('#param-nodes-red-brightness');
  await expect(brightness).toBeDisabled();
  await expect(row).toHaveClass(/is-mapped/);
  await setSlider(brightness, '0.5');
  await expect(brightness).toHaveValue('0.5');
  await page.getByRole('button', { name: 'Brightness mapping settings' }).click();
  await expect(page.locator('.nodes-mapping-inline')).toContainText('Base: 0.5');
  // The mapping's own surfaces keep their gestures: neither the overlay (drag and
  // click to disclose) nor its number fields is a reset surface.
  await page.getByLabel('Brightness Mapping min').dblclick();
  await expect(brightness).toHaveValue('0.5');
  await row.locator('.nodes-mapping-overlay').dblclick();
  await expect(brightness).toHaveValue('0.5');
  // The parameter's own name resets the saved base value; the mapping itself is
  // left running, and the LIVE value still comes from the signal.
  await row.locator('.param-head .param-value').dblclick();
  await expect(brightness).toHaveValue('0.9');
  await expect(row.locator('.nodes-mapping-overlay')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await diskGraph(page, id);
  expect(saved.nodes.find(node => node.id === 'red').params.brightness).toBe(0.9);
  expect(saved.modulations).toEqual([{ from: 'audio', to: 'red', param: 'brightness', min: .2, max: .8, inputMin: 0, inputMax: 1 }]);
  expect(errors).toEqual([]);
});

test('F12: an option parameter resets from its name while its dropdown keeps its own clicks', async ({ page }) => {
  const errors = errorsOf(page);
  // Metadata alone is enough for the registry to expose a media pattern's
  // descriptor, and its Scaling parameter is an option list, not a slider. No blob
  // is stored: a missing file draws a placeholder instead of failing.
  const id = await openGraph(page, base([
    { id: 'clip', type: 'pattern', patternId: 'media-clip1', x: 40, y: 60, params: { scaleMode: 0, zoom: 0.5, panX: 0, panY: 0 } },
    output(),
  ], [{ from: 'clip', to: 'output', port: 'image' }]), [{ id: 'clip1', name: 'Stage Clips', kind: 'image' }]);
  await select(page, 'clip');
  const scaling = page.locator('[data-param-target=scaleMode] select.param-select');
  await expect(scaling).toHaveValue('0');
  await expect(page.locator('[data-param-target=scaleMode] .param-value')).toHaveText('Fit Width');
  await page.locator('[data-param-target=scaleMode] .param-head label').dblclick();
  await expect(scaling).toHaveValue('2');
  await expect(page.locator('[data-param-target=scaleMode] .param-value')).toHaveText('Fit Screen');
  // Only that parameter moved: the neighbouring sliders keep their values.
  await expect(page.locator('#param-nodes-clip-zoom')).toHaveValue('0.5');
  expect(errors).toEqual([]);
});

