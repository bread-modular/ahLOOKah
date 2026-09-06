import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { registerProjectionSketches, surfaceEdgeBlur, surfaceMappingValues, validProjectionPatch } from '../src/projection/projection-registry.js';

test.setTimeout(90000);
test.use({ launchOptions: { args: [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
] } });


// Limit fixture draw frequency, not rendering quality or production timing.
// SwiftShader readbacks should not starve the separate audio owner heartbeat.
test.beforeEach(async ({ context }) => {
  for (const file of ['solid_color', 'media_pattern', 'color_bars']) {
    await context.route(`**/src/sketches/${file}.js`, async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      await route.fulfill({ response, body: source.replace('p.setup = () => {', 'p.setup = () => { p.frameRate(15);') });
    });
  }
});

const ID = 'projection-test';
const META = { id: ID, name: 'Stage walls', surfaces: [
  { id: 'sleft', name: 'Left wall', patternId: 'solid-color' },
  { id: 'sright', name: 'Right wall', patternId: 'solid-color' },
] };
const GLOBAL = [{ x: .2, y: .1 }, { x: .8, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }];
const rectangle = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
function geometry(id, quad) {
  return Object.fromEntries(quad.flatMap((point, i) => ['x', 'y'].map((axis) => [`${id}:${i}${axis}`, point[axis]])));
}
const VALUES = {
  ...geometry('sleft', rectangle(.05, .2, .45, .8)), ...geometry('sright', rectangle(.55, .2, .95, .8)),
  'sleft:hue': 0, 'sleft:saturation': 1, 'sleft:brightness': 1, 'sleft:pulse': 0,
  'sright:hue': 1 / 3, 'sright:saturation': 1, 'sright:brightness': 1, 'sright:pulse': 0,
};
async function seed(context, { live = ID, meta = META, values = VALUES, global = GLOBAL, edgeBlur = 0 } = {}) {
  await context.addInitScript(({ live, meta, values, global, edgeBlur }) => {
    if (!location.protocol.startsWith('http')) return;
    if (localStorage.getItem('projection-test-seeded')) return;
    localStorage.setItem('projection-test-seeded', '1');
    localStorage.setItem('viz2_projection_patterns', JSON.stringify([meta]));
    localStorage.setItem('viz2_params', JSON.stringify({ [meta.id]: values }));
    localStorage.setItem('viz2_slot_order', JSON.stringify([live, live === meta.id ? 'solid-color' : meta.id]));
    localStorage.setItem('viz2_screen_mapping_enabled', '1');
    localStorage.setItem('viz2_screen_mapping_edge_blur', String(edgeBlur));
    localStorage.setItem('viz2_screen_mapping', JSON.stringify({ v: 1, quad: global }));
  }, { live, meta, values, global, edgeBlur });
}
async function open(context, page, size = { width: 480, height: 360 }) {
  await page.setViewportSize(size);
  await page.goto('/?role=screen');
  await page.waitForFunction(() => window.__viz?.runtimeCounts?.live > 0);
  const control = await context.newPage();
  await control.setViewportSize({ width: 1280, height: 800 });
  await control.goto('/?role=control');
  await expect(control.locator('#config-panel')).toBeVisible();
  await expect.poll(() => control.evaluate(() => window.__viz?.screenOnline), { timeout: 15000 }).toBe(true);
  return control;
}
async function send(page, message) {
  await page.evaluate((message) => {
    const channel = new BroadcastChannel('viz2_channel');
    if (message.type === 'media-patterns') message.metas = JSON.parse(localStorage.getItem('viz2_media_patterns') || '[]');
    channel.postMessage(message);
    channel.close();
  }, message);
}
async function colors(page, points = [[.25, .5], [.75, .5], [.5, .5], [.5, .15]]) {
  const shot = await page.screenshot();
  return page.evaluate(async ({ b64, points }) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    return points.map(([x, y]) => [...ctx.getImageData(Math.floor(x * img.width), Math.floor(y * img.height), 1, 1).data].slice(0, 3));
  }, { b64: shot.toString('base64'), points });
}
async function expectWalls(page) {
  await expect.poll(() => colors(page)).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 0], [0, 0, 0]]);
}
async function editMapping(control, name) {
  await control.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
  const dialog = control.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}
async function closeMapping(control) {
  await control.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(control.getByRole('dialog')).toHaveCount(0);
}
async function expandMapping(control, name) {
  const row = control.getByRole('region', { name: `${name} mapping`, exact: true });
  const toggle = row.locator('.projection-surface-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  return row;
}
async function slider(control, key, value) {
  const row = control.locator(`.projection-surface[data-surface-id="${key.split(':')[0]}"]`);
  if (await row.locator('.projection-surface-toggle').getAttribute('aria-expanded') === 'false') await row.locator('.projection-surface-toggle').click();
  await control.locator(`input[type="range"][data-key="${key}"]`).evaluate((input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('create named mapping patterns and surfaces, assign sources, rename and remove', async ({ context, page }) => {
  const control = await open(context, page);
  const errors = []; control.on('pageerror', (error) => errors.push(error.message));
  control.once('dialog', (dialog) => dialog.accept('  Main stage  '));
  await control.getByRole('button', { name: 'Add projection mapping pattern' }).click();
  await expect(control.locator('.projection-panel')).toContainText('Main stage');
  const id = await control.locator('.projection-panel').getAttribute('data-projection-id');
  await expect.poll(() => page.evaluate(() => window.__viz.patternId), { timeout: 20000 }).toBe(id);
  for (const name of ['Left wall', 'Ceiling']) {
    await control.getByRole('button', { name: 'Add mapping', exact: true }).click();
    await control.getByRole('dialog').getByRole('textbox', { name: 'Mapping name', exact: true }).fill(name);
    await expect(control.getByRole('dialog').getByRole('slider', { name: 'Edge smoothing' })).toBeVisible();
    await expect(control.getByRole('dialog').locator('.param-row')).toHaveCount(1);
    await closeMapping(control);
    await expect(control.getByRole('region', { name: `${name} mapping`, exact: true })).toBeVisible();
  }
  await expect(page.locator('.program-layer-live .projection-sources canvas')).toHaveCount(2, { timeout: 15000 });
  const ceiling = control.getByRole('region', { name: 'Ceiling mapping', exact: true });
  await expect(ceiling.locator('.projection-surface-params')).toBeHidden();
  const editor = await editMapping(control, 'Ceiling');
  await editor.getByLabel('Source pattern').selectOption('color-bars');
  await expect(editor.locator('option[value^="projection-"]')).toHaveCount(0);
  await editor.getByLabel('Mapping name', { exact: true }).fill('Roof');
  await closeMapping(control);
  await expect(control.getByRole('region', { name: 'Roof mapping', exact: true })).toBeVisible();
  control.once('dialog', (dialog) => dialog.accept());
  await control.getByRole('button', { name: 'Remove Roof', exact: true }).click();
  await expect(control.locator('.projection-surface')).toHaveCount(1);
  control.once('dialog', (dialog) => dialog.accept());
  await control.getByRole('button', { name: 'Remove projection pattern', exact: true }).click();
  await expect(control.locator(`.library-btn[data-id="${id}"]`)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__viz.screenMapping.bypassed)).toBe(false);
  expect(errors).toEqual([]);
});

test('renders independent duplicate patterns, bypasses global warp, persists >16 fields and resizes', async ({ context, page }, testInfo) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  expect(await page.evaluate(() => window.__viz.screenMapping.bypassed)).toBe(true);
  await expect(page.locator('#screen-wrap')).toHaveCSS('transform', 'none');
  await expect(control.locator('.projection-surface')).toHaveCount(2);
  await slider(control, 'sleft:hue', .67);
  await expect.poll(() => page.evaluate(() => window.__viz.params['sleft:hue'])).toBe(.67);
  expect(await page.evaluate(() => window.__viz.params['sright:hue'])).toBeCloseTo(1 / 3);
  await slider(control, 'sleft:hue', 0);
  await expectWalls(page);
  await editMapping(control, 'Left wall');
  await control.getByRole('dialog').locator('summary').click();
  await control.getByRole('spinbutton', { name: 'Left wall TL X', exact: true }).fill('10');
  await closeMapping(control);
  await expect.poll(() => page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(.1);
  await page.setViewportSize({ width: 1024, height: 720 });
  await expectWalls(page);
  await control.screenshot({ path: testInfo.outputPath('projection-controls.png') });
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__viz?.params?.['sleft:0x'])).toBe(.1);
  await expectWalls(page);
  expect(await page.evaluate(() => Object.keys(window.__viz.params).length)).toBe(26); // 9 mapping + 4 source values per surface.
  expect(await page.evaluate(() => window.__viz.params['sleft:mappingEdgeBlur'])).toBe(0);
  await control.reload();
  await expect(control.locator('.projection-surface')).toHaveCount(2);
  await expect(control.locator('#screen-mapping')).toContainText('Bypassed');
});

test('CUE corners and child params stay isolated; TAKE switches bypass and switching back restores calibration', async ({ context, page }) => {
  await seed(context, { live: 'solid-color' });
  const control = await open(context, page);
  await expect.poll(() => page.evaluate(() => window.__viz.screenMapping.antialiasing)).toBe('supersample-4x4');
  const initial = await page.locator('#screen-wrap').evaluate((el) => el.style.transform);
  const pattern = control.locator(`.library-btn[data-id="${ID}"]`);
  await pattern.click({ modifiers: ['Shift'] });
  await expect.poll(() => page.evaluate(() => window.__viz.cue?.phase)).toBe('ready');
  expect(await page.evaluate(() => window.__viz.screenMapping.bypassed)).toBe(false);
  await expect(control.getByRole('button', { name: 'Add mapping', exact: true })).toBeDisabled();
  await slider(control, 'sleft:hue', .5);
  await expect.poll(() => page.evaluate(() => window.__viz.cueParams?.['projection-test']?.['sleft:hue'])).toBe(.5);
  await control.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__viz.cue)).toBe(null);
  await expect(page.locator('#screen-wrap')).toHaveCSS('transform', initial);
  await pattern.click({ modifiers: ['Shift'] });
  await expect.poll(() => page.evaluate(() => window.__viz.cue?.phase)).toBe('ready');
  await control.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__viz.patternId)).toBe(ID);
  await expectWalls(page);
  await pattern.click({ modifiers: ['Shift'] });
  await expect(control.locator('#config-panel')).toHaveClass(/cue-active/);
  await expect(control.locator('input[data-key="sleft:hue"]')).toHaveAttribute('id', /param-cue-/);
  await slider(control, 'sleft:hue', .5);
  await expect.poll(() => page.evaluate(() => window.__viz.cue?.phase)).toBe('ready');
  await expectWalls(page); // Same-pattern staging must not mutate LIVE's bank.
  await editMapping(control, 'Left wall');
  await control.getByRole('dialog').locator('summary').click();
  await control.getByRole('spinbutton', { name: 'Left wall TL X', exact: true }).fill('15');
  await closeMapping(control);
  await expect.poll(() => page.evaluate(() => window.__viz.cueParams['projection-test']['sleft:0x'])).toBe(.15);
  expect(await page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(.05);
  await control.keyboard.press('Escape');
  await expectWalls(page);
  await pattern.click({ modifiers: ['Shift'] });
  await expect(control.locator('input[data-key="sleft:hue"]')).toHaveAttribute('id', /param-cue-/);
  await editMapping(control, 'Left wall');
  await control.getByRole('dialog').locator('summary').click();
  await control.getByRole('spinbutton', { name: 'Left wall TL X', exact: true }).fill('15');
  await closeMapping(control);
  await expect.poll(() => page.evaluate(() => window.__viz.cue?.phase)).toBe('ready');
  await control.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(.15);
  await control.locator('.library-btn[data-id="solid-color"]').click();
  await expect.poll(() => page.evaluate(() => window.__viz.patternId)).toBe('solid-color');
  await expect.poll(() => page.evaluate(() => window.__viz.screenMapping.bypassed)).toBe(false);
  await expect(page.locator('#screen-wrap')).toHaveCSS('transform', initial);
  expect(await page.evaluate(() => window.__viz.screenMapping.quad)).toEqual(GLOBAL);
  await expect.poll(() => page.evaluate(() => window.__viz.runtimeCounts.total)).toBe(1);
});

test('GPU loss retains calibrated CSS fallback and validates malformed topology and quads', async ({ context, page }) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  await page.locator('.program-layer-live .projection-output').evaluate((canvas) => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await expect(page.locator('.program-layer-live .projection-layer')).toHaveAttribute('data-fallback', 'true');
  await expectWalls(page);
  await send(control, { type: 'projection-edit', action: 'save', id: ID, pattern: { ...META, surfaces: [{ ...META.surfaces[0], patternId: ID }] } });
  await send(control, { type: 'params', id: ID, values: geometry('sleft', [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }]) });
  await expectWalls(page);
  expect(await page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(.05);
  expect(await control.evaluate(() => JSON.parse(localStorage.getItem('viz2_projection_patterns'))[0].surfaces)).toEqual(META.surfaces);
});

test('image and video mappings expose all media controls, render real files, and survive missing sources', async ({ context, page }) => {
  await seed(context);
  const control = await open(context, page);
  // Tiny deterministic VP8 fixture avoids MediaRecorder scheduling races under software GL.
  const videoBase64 = readFileSync(new URL('./fixtures/green.webm', import.meta.url)).toString('base64');
  await control.evaluate(async (videoBase64) => {
    const { putMediaRecord } = await import('/src/media/media-store.js');
    const { addMediaPattern } = await import('/src/media/media-registry.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const image = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'], 'red.svg', { type: 'image/svg+xml' });
    const video = new File([Uint8Array.from(atob(videoBase64), (c) => c.charCodeAt(0))], 'green.webm', { type: 'video/webm' });
    for (const [id, kind, file] of [['test-image', 'image', image], ['test-video', 'video', video]]) {
      const meta = { id, kind, name: kind === 'image' ? 'Red image' : 'Green video' };
      await putMediaRecord({ ...meta, file });
      addMediaPattern(SKETCHES, meta);
    }
  }, videoBase64);
  await send(control, { type: 'media-patterns' });
  await expect(control.locator('.library-btn[data-id="media-test-video"]')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await import('/src/sketch-registry.js')).SKETCHES.some(s => s.id === 'media-test-video'))).toBe(true);
  const left = control.getByRole('region', { name: 'Left wall mapping' });
  const right = control.getByRole('region', { name: 'Right wall mapping' });
  await editMapping(control, 'Left wall');
  await control.getByRole('dialog').getByLabel('Source pattern').selectOption('media-test-image');
  await closeMapping(control);
  await expandMapping(control, 'Left wall');
  await expect(left.locator('select[data-key="sleft:scaleMode"]')).toBeVisible();
  await editMapping(control, 'Right wall');
  await control.getByRole('dialog').getByLabel('Source pattern').selectOption('media-test-video');
  await closeMapping(control);
  await expandMapping(control, 'Right wall');
  await expect(right.locator('input[data-key="sright:speed"]')).toBeVisible();
  await left.locator('select[data-key="sleft:scaleMode"]').selectOption('3');
  await right.locator('select[data-key="sright:scaleMode"]').selectOption('3');
  await expect.poll(() => page.locator('video').first().evaluate(v => v.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await colors(page)).map((rgb) => rgb.map((v) => v < 5 ? 0 : v > 250 ? 255 : v))).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 0], [0, 0, 0]]);
  await expect.poll(() => page.evaluate(() => window.__viz.programs.live.children), { timeout: 15000 }).toEqual(['media-test-image', 'media-test-video']);
  await expect.poll(() => page.evaluate(() => window.__viz.runtimeCounts.total)).toBe(2);
  await slider(control, 'sright:speed', 1.5);
  await expect.poll(() => page.locator('video').first().evaluate((video) => video.playbackRate)).toBe(1.5);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__viz?.params?.['sright:speed'])).toBe(1.5);
  await expect.poll(() => page.locator('video').first().evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(2);
  const beforeRemoval = await page.evaluate(() => window.__viz.programs.live.generation);
  await send(control, { type: 'media-remove', id: 'media-test-image' });
  await expect(left).toContainText('This pattern was removed');
  await expect.poll(() => page.evaluate(() => window.__viz.programs.live.children), { timeout: 15000 }).toEqual(['solid-color', 'media-test-video']);
  expect(await page.evaluate(() => window.__viz.programs.live.generation)).toBeGreaterThan(beforeRemoval);
  await expect.poll(async () => (await colors(page))[0]).toEqual([0, 0, 0]);
  await expect.poll(() => page.evaluate(() => window.__viz.runtimeCounts.total)).toBe(2);
});

test('projection/ordinary merge keeps one composited input per pattern and restores mapping after exit', async ({ context, page }) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  // Pad slots 1/2 are projection and solid-color respectively.
  await control.keyboard.down('1'); await control.keyboard.down('2');
  await control.keyboard.up('2'); await control.keyboard.up('1');
  await expect.poll(() => page.evaluate(() => window.__viz.merge)).toEqual([0, 1]);
  await expect(page.locator('.program-layer-live > .projection-layer')).toHaveCount(1);
  await expect(page.locator('.program-layer-live > canvas')).toHaveCount(1);
  await expect(control.locator('.projection-surface')).toHaveCount(2);
  await send(control, { type: 'params', id: '__merge', values: { mix: 0 } });
  await expectWalls(page);
  await send(control, { type: 'params', id: '__merge', values: { mix: 1 } });
  await expect.poll(async () => {
    const rgb = await colors(page); return JSON.stringify(rgb[0]) === JSON.stringify(rgb[1]) && JSON.stringify(rgb[1]) === JSON.stringify(rgb[2]);
  }).toBe(true);
  expect(await page.evaluate(() => window.__viz.screenMapping.bypassed)).toBe(true);
  await control.keyboard.press('2');
  await expect.poll(() => page.evaluate(() => window.__viz.screenMapping.bypassed)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__viz.runtimeCounts.total)).toBe(1);
});

test('maximum surface count uses independent audio slots beyond the old eight-slot plan limit', async ({ context, page }) => {
  const meta = { ...META, surfaces: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `Surface ${i + 1}`, patternId: 'solid-color' })) };
  await seed(context, { meta, values: {} });
  // Exercise the maximum LIVE+CUE audio topology without SwiftShader starving
  // the audio heartbeat; dedicated tests above exercise GPU pixel output.
  await context.addInitScript(() => { const create = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(type, ...args) { if (type === 'webgl2' && this.classList.contains('projection-output')) return null; return create.call(this, type, ...args); }; });
  const control = await open(context, page, { width: 320, height: 240 });
  await expect(control.locator('.projection-surface')).toHaveCount(8);
  await expect(control.getByRole('button', { name: 'Add mapping', exact: true })).toBeDisabled();
  await control.locator(`.library-btn[data-id="${ID}"]`).click({ modifiers: ['Shift'] });
  await expect(control.locator('input[data-key="s0:hue"]')).toHaveAttribute('id', /param-cue-/);
  await slider(control, 's0:hue', .1);
  await expect.poll(() => page.evaluate(() => window.__viz.cue?.phase), { timeout: 15000 }).toBe('ready');
  expect(await page.evaluate(() => window.__viz.runtimeCounts.live)).toBe(8);
  expect(await page.evaluate(() => window.__viz.runtimeCounts.cue)).toBe(8);
  const old = await control.evaluate(() => localStorage.getItem('viz2_projection_patterns'));
  await send(control, { type: 'projection-edit', action: 'save', id: ID, pattern: { ...meta, name: 'Must stay locked' } });
  expect(await control.evaluate(() => localStorage.getItem('viz2_projection_patterns'))).toBe(old);
  await control.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__viz.cue)).toBe(null);
  await expect.poll(() => page.evaluate(() => window.__viz.params['s0:hue'])).toBe(.1);
  await expect.poll(() => page.evaluate(() => window.__viz.runtimeCounts.total)).toBe(8);
});

test('delayed structural edits preserve the complete old LIVE layout until replacement readiness', async ({ context, page }) => {
  await seed(context);
  await context.addInitScript(() => {
    if (location.protocol.startsWith('http')) localStorage.setItem('viz2_media_patterns', JSON.stringify([{ id: 'delayed', name: 'Delayed media', kind: 'image' }]));
  });
  await context.route('**/src/sketches/media_pattern.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.slice(0, source.indexOf('export default')) + `
      export default () => (_audio, _device, _params, runtime) => p => {
        p.setup = () => { p.createCanvas(p.windowWidth, p.windowHeight); p.frameRate(15); };
        p.draw = () => { runtime.audioControls?.read(); p.background(0, 0, 255); };
        window.__releaseMappedMedia = () => runtime.reportMediaReady();
      };
    ` });
  });
  const control = await open(context, page);
  await expectWalls(page);
  const before = await page.evaluate(() => window.__viz.programs.live.generation);
  await send(control, { type: 'projection-edit', action: 'save', id: ID, pattern: { ...META, surfaces: [{ ...META.surfaces[0], patternId: 'media-delayed' }] } });
  await expect.poll(() => page.evaluate(() => window.__viz.programs.incoming?.children)).toEqual(['media-delayed']);
  await expectWalls(page); // Removed right-hand keys must NOT reset it to full frame.
  expect(await page.evaluate(() => window.__viz.programs.live.generation)).toBe(before);
  expect(await page.evaluate(() => window.__viz.programs.incoming.ready)).toBe(false);
  await page.evaluate(() => window.__releaseMappedMedia());
  await expect.poll(() => page.evaluate(() => window.__viz.programs.live.children), { timeout: 10000 }).toEqual(['media-delayed']);
  await expect.poll(() => colors(page)).toEqual([[0, 0, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  await expect.poll(() => page.evaluate(() => window.__viz.runtimeCounts.total)).toBe(1);
});

test('transparent WebGL surfaces flatten against black in both GPU and CSS fallback', async ({ context, page }) => {
  await seed(context, { meta: { ...META, surfaces: [META.surfaces[0], { ...META.surfaces[1], patternId: 'color-bars' }] },
    values: { ...VALUES, ...geometry('sright', rectangle(.05, .2, .45, .8)) } });
  await context.route('**/src/sketches/color_bars.js', async (route) => {
    const response = await route.fetch(); const source = await response.text();
    await route.fulfill({ response, body: source.slice(0, source.indexOf('export default')) + `
      export default (_audio, _device, _params, runtime) => p => {
        p.setup = () => { p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL); p.frameRate(15); };
        p.draw = () => { runtime.audioControls?.read(); p.clear(); p.background(0, 0, 255, 128); };
      };
    ` });
  });
  await open(context, page);
  const check = async () => {
    await expect.poll(async () => {
      const [left] = await colors(page);
      return left[0] < 4 && left[1] < 4 && Math.abs(left[2] - 128) < 4;
    }).toBe(true);
  };
  await check();
  await page.locator('.program-layer-live .projection-output').evaluate((canvas) => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await expect(page.locator('.program-layer-live .projection-layer')).toHaveAttribute('data-fallback', 'true');
  await check();
});

test('fresh-frame gate latches rendered audio before awaiting projection composition', async ({ page }) => {
  await page.goto('/?role=control');
  const result = await page.evaluate(async () => {
    const { ProgramRuntime } = await import('/src/program-runtime.js');
    const original = window.requestAnimationFrame;
    const queue = [];
    window.requestAnimationFrame = (callback) => { queue.push(callback); return queue.length; };
    try {
      let controlsFresh = true;
      let complete = false;
      const layer = { captureRevision: 3, presentedRevision: 2 };
      const runtime = Object.assign(Object.create(ProgramRuntime.prototype), {
        disposed: false, instances: [{}], drawCounts: [2], projectionLayers: [layer],
        freshWaiter: { state: 'waiting-for-draw', before: [1], audioControls: [{ binding: { hasRenderedAfter: () => controlsFresh }, paramsRevision: 1, marker: 0 }] },
        _completeFreshWaiter: () => { complete = true; },
      });
      runtime._checkFreshFrame();
      const latched = runtime.freshWaiter.state;
      controlsFresh = false; // A newer audio packet arrives between draw and composition.
      queue.shift()();
      const beforeComposite = complete;
      layer.presentedRevision = 3;
      queue.shift()();
      queue.shift()();
      return { latched, beforeComposite, complete };
    } finally { window.requestAnimationFrame = original; }
  });
  expect(result).toEqual({ latched: 'awaiting-compositor', beforeComposite: false, complete: true });
});

test('camera merge preview never opens capture; failed structural changes retain LIVE and can retry', async ({ context, page }) => {
  await seed(context);
  // Deny output camera until explicitly released, and count all control requests.
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__videoRequests = 0;
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints.video) {
        window.__videoRequests += 1;
        if (location.search.includes('role=screen') && !window.__allowProjectionCamera) {
          return Promise.reject(new DOMException('Test camera denied', 'NotAllowedError'));
        }
      }
      return get(constraints);
    };
  });
  const control = await open(context, page);
  await expectWalls(page);
  const editor = await editMapping(control, 'Left wall');
  await editor.getByLabel('Source pattern').selectOption('video-pixelate');
  await expect(editor.getByRole('alert')).toContainText('Output kept the previous layout');
  await expectWalls(page);
  await expect.poll(() => page.evaluate(() => window.__viz.programs.incoming)).toBe(null);
  await page.evaluate(() => { window.__allowProjectionCamera = true; });
  await editor.getByRole('button', { name: 'Retry output' }).click();
  await expect.poll(() => page.evaluate(() => window.__viz.programs.live.children), { timeout: 15000 }).toEqual(['video-pixelate', 'solid-color']);
  await expect(editor.getByRole('alert')).toHaveCount(0);
  await closeMapping(control);
  // Include a top-level camera as merge input B, in addition to the mapped one.
  await control.evaluate(async () => { const { saveSlotOrder } = await import('/src/sketch-registry.js'); saveSlotOrder(['projection-test', 'video-pixelate', 'circles', 'bars', 'techno3d', 'character3d', 'neon-spectrum', 'pulse-rings', 'particle-storm', 'waveform-tunnel']); });
  await send(control, { type: 'merge', a: 0, b: 1 });
  await expect.poll(() => page.evaluate(() => window.__viz.merge)).toEqual([0, 1]);
  await expect.poll(() => page.evaluate(() => window.__viz.programs.live.children)).toEqual(['video-pixelate', 'solid-color', 'video-pixelate']);
  expect(await control.evaluate(() => window.__videoRequests)).toBe(0);
  expect(await page.evaluate(() => window.__videoRequests)).toBeGreaterThan(0);
});

test('mapping popup autosaves while sidebar parameters stay independently collapsed', async ({ context, page }, testInfo) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  const left = control.getByRole('region', { name: 'Left wall mapping', exact: true });
  const right = control.getByRole('region', { name: 'Right wall mapping', exact: true });
  await expect(left.locator('.projection-surface-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(right.locator('.projection-surface-params')).toBeHidden();
  await expect(control.locator('#params-list .projection-source, #params-list .projection-quad-editor')).toHaveCount(0);
  await expandMapping(control, 'Left wall');
  await expect(left.locator('input[data-key="sleft:hue"]')).toBeVisible();
  await expect(right.locator('.projection-surface-params')).toBeHidden();
  await left.locator('.projection-surface-toggle').click();
  await control.locator('#controls-pane').screenshot({ path: testInfo.outputPath('mapping-sidebar.png') });

  let editor = await editMapping(control, 'Left wall');
  await expect(editor.locator('.param-row')).toHaveCount(1);
  expect((await editor.boundingBox()).width).toBeGreaterThan(800);
  expect((await editor.boundingBox()).width).toBeLessThan(1000);
  await editor.getByLabel('Mapping name', { exact: true }).fill('Front wall');
  await editor.getByLabel('Source pattern').selectOption('color-bars');
  // Name/source and corner edits autosave while the popup stays open.
  const canvas = await editor.locator('.projection-quad-editor').boundingBox();
  const handle = await editor.locator('[data-corner-index="0"]').boundingBox();
  await control.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await control.mouse.down();
  await control.mouse.move(canvas.x + canvas.width * .12, canvas.y + canvas.height * .25, { steps: 4 });
  await control.mouse.up();
  await editor.locator('summary').click();
  await expect(editor.getByRole('spinbutton', { name: 'Front wall TL X', exact: true })).toHaveValue('12');
  await expect.poll(() => page.evaluate(() => window.__viz.params['sleft:0x'])).toBeCloseTo(.12, 5);
  await expect(editor.locator('.projection-editor-footer')).toContainText('All changes saved');
  await control.screenshot({ path: testInfo.outputPath('mapping-editor-desktop.png') });
  await closeMapping(control);
  await expect(control.getByRole('dialog')).toHaveCount(0);
  await expect(control.getByRole('button', { name: 'Edit Front wall', exact: true })).toBeFocused();
  expect(await control.evaluate(() => JSON.parse(localStorage.getItem('viz2_projection_patterns'))[0].surfaces[0])).toMatchObject({ name: 'Front wall', patternId: 'color-bars' });
  await expect(control.locator('.projection-surface-toggle').first()).toHaveAttribute('aria-expanded', 'false');

  await control.getByRole('button', { name: 'Add mapping', exact: true }).click();
  editor = control.getByRole('dialog');
  await expect(editor.getByRole('button', { name: /Save mapping|Cancel/, exact: true })).toHaveCount(0);
  await editor.getByLabel('Source pattern').selectOption('color-bars'); // Still unnamed: no phantom mapping.
  await control.keyboard.press('Escape');
  await expect(control.locator('.projection-surface')).toHaveCount(2);
  await expect(control.getByRole('button', { name: 'Add mapping', exact: true })).toBeFocused();

  await control.getByRole('button', { name: 'Add mapping', exact: true }).click();
  editor = control.getByRole('dialog');
  await editor.getByLabel('Mapping name', { exact: true }).fill('Ceiling');
  await editor.getByLabel('Source pattern').selectOption('color-bars');
  await editor.locator('summary').click();
  await editor.getByRole('spinbutton', { name: 'Ceiling TL X', exact: true }).fill('10');
  await closeMapping(control);
  const ceiling = control.getByRole('region', { name: 'Ceiling mapping', exact: true });
  await expect(ceiling.locator('.projection-surface-params')).toBeHidden();
  await expect(ceiling.locator('.projection-surface-label')).toContainText('Color Bars');
  const surfaceId = await ceiling.getAttribute('data-surface-id');
  await expect.poll(() => page.evaluate((key) => window.__viz.params[key], `${surfaceId}:0x`)).toBe(.1);

  // Dialog remains usable independently of the narrow sidebar and viewport.
  editor = await editMapping(control, 'Ceiling');
  for (const width of [720, 420]) {
    await control.setViewportSize({ width, height: 780 });
    const bounds = await editor.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.width).toBeLessThanOrEqual(width);
    expect(await editor.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
  }
  await control.screenshot({ path: testInfo.outputPath('mapping-editor-mobile.png') });
  await control.keyboard.press('Escape');
});

test('mapping dialog isolates keyboard shortcuts and stages only geometry during CUE', async ({ context, page }) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  await control.locator(`.library-btn[data-id="${ID}"]`).click({ modifiers: ['Shift'] });
  await expect.poll(() => page.evaluate(() => window.__viz.cue?.phase)).toBe('same');
  const session = await page.evaluate(() => window.__viz.cue.sessionId);
  let editor = await editMapping(control, 'Left wall');
  await expect(editor.getByLabel('Mapping name', { exact: true })).toBeDisabled();
  await expect(editor.getByLabel('Source pattern')).toBeDisabled();
  await editor.locator('[data-corner-index="0"]').focus();
  await control.keyboard.press('2');
  await control.keyboard.press('Shift+ArrowRight');
  await control.keyboard.press('Tab');
  expect(await control.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
  await control.keyboard.press('Escape');
  await expect(control.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.__viz.cue.sessionId)).toBe(session);
  expect(await page.evaluate(() => window.__viz.cue.selection.ids)).toEqual([ID]);
  expect(await page.evaluate(() => window.__viz.cueParams['projection-test']?.['sleft:0x'] ?? window.__viz.params['sleft:0x'])).toBeCloseTo(.06, 6);
  await expectWalls(page);

  editor = await editMapping(control, 'Left wall');
  await editor.locator('summary').click();
  await editor.getByRole('spinbutton', { name: 'Left wall TL X', exact: true }).fill('15');
  await control.keyboard.press('Enter'); // Never TAKE the CUE or close the editor.
  await expect(control.getByRole('dialog')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__viz.cueParams['projection-test']['sleft:0x'])).toBe(.15);
  expect(await page.evaluate(() => window.__viz.cue.sessionId)).toBe(session);
  expect(await page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(.05);
  await closeMapping(control);
  await control.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__viz.cue)).toBe(null);
});

test('invalid or stale modal saves are rejected atomically, and missing confirmation stays visible', async ({ context, page }) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  const before = await control.evaluate(() => ({ meta: localStorage.getItem('viz2_projection_patterns'), params: localStorage.getItem('viz2_params') }));
  const changed = { ...META, surfaces: [{ ...META.surfaces[0], patternId: 'color-bars' }, META.surfaces[1]] };
  // Invalid corners must not persist even the otherwise-valid new source.
  await send(control, { type: 'projection-edit', action: 'save', id: ID, pattern: changed,
    geometry: geometry('sleft', [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }]) });
  await send(control, { type: 'projection-edit', action: 'save', id: ID, pattern: changed,
    expectedPattern: { ...META, name: 'Outdated layout' }, geometry: geometry('sleft', rectangle(.1, .2, .4, .8)) });
  await expectWalls(page);
  expect(await control.evaluate(() => ({ meta: localStorage.getItem('viz2_projection_patterns'), params: localStorage.getItem('viz2_params') }))).toEqual(before);

  const editor = await editMapping(control, 'Left wall');
  // Simulate a dropped autosave request. Do not claim acceptance; allow retry.
  await control.evaluate(() => {
    const post = BroadcastChannel.prototype.postMessage;
    window.__restoreProjectionBus = () => { BroadcastChannel.prototype.postMessage = post; };
    BroadcastChannel.prototype.postMessage = function(message) {
      if (message.type !== 'projection-edit') return post.call(this, message);
    };
  });
  await editor.getByLabel('Mapping name', { exact: true }).fill('Renamed wall');
  await expect(editor.getByRole('alert')).toContainText('Automatic saving was not confirmed', { timeout: 7000 });
  await expectWalls(page);
  await control.evaluate(() => window.__restoreProjectionBus());
  await editor.getByRole('button', { name: 'Retry autosave' }).click();
  await closeMapping(control);
  await expect(control.getByRole('region', { name: 'Renamed wall mapping', exact: true })).toBeVisible();
});

test('fractional corner drags save with coordinates collapsed or expanded in LIVE and CUE', async ({ context, page }) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  for (const scope of ['live', 'cue']) {
    if (scope === 'cue') {
      await control.locator(`.library-btn[data-id="${ID}"]`).click({ modifiers: ['Shift'] });
      await expect.poll(() => page.evaluate(() => window.__viz.cue?.phase)).toBe('same');
    }
    const liveBefore = await page.evaluate(() => window.__viz.params['sleft:0x']);
    for (const expanded of [false, true]) {
      const x = expanded ? .1535 : .1235;
      const editor = await editMapping(control, 'Left wall');
      const canvas = await editor.locator('.projection-quad-editor').boundingBox();
      const handle = await editor.locator('[data-corner-index="0"]').boundingBox();
      await control.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await control.mouse.down();
      await control.mouse.move(canvas.x + canvas.width * x, canvas.y + canvas.height * .2345, { steps: 3 });
      await control.mouse.up();
      if (expanded) await editor.locator('summary').click();
      // Fractional coordinates autosave even with the numeric fields collapsed.
      const input = editor.locator('input[aria-label="Left wall TL X"]');
      await expect(input).toHaveValue(expanded ? '15.35' : '12.35');
      await expect.poll(() => page.evaluate(({scope, x}) => (scope === 'cue' ? window.__viz.cueParams['projection-test'] : window.__viz.params)['sleft:0x'], {scope, x})).toBeCloseTo(x, 5);
      await closeMapping(control);
      const value = await page.evaluate((scope) => scope === 'cue'
        ? window.__viz.cueParams['projection-test']['sleft:0x']
        : window.__viz.params['sleft:0x'], scope);
      expect(value).toBeCloseTo(x, 5);
      if (scope === 'cue') expect(await page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(liveBefore);
      else expect(await control.evaluate(() => JSON.parse(localStorage.getItem('viz2_params'))['projection-test']['sleft:0x'])).toBe(value);
    }
  }
  await control.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__viz.cue)).toBe(null);
  expect(await control.evaluate(() => JSON.parse(localStorage.getItem('viz2_params'))['projection-test']['sleft:0x'])).toBeCloseTo(.1535, 5);
});

test('dragging updates output pixels before release without recreating renderers; Close persists', async ({ context, page }) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  const before = await page.evaluate(() => {
    window.__originalProjectionCanvases = [...document.querySelectorAll('.program-layer-live canvas')];
    return window.__viz.programs.live.generation;
  });
  const editor = await editMapping(control, 'Left wall');
  await expect(editor.getByRole('button', { name: /Save mapping|Cancel/, exact: true })).toHaveCount(0);
  await expect.poll(() => colors(page, [[.09, .3]])).toEqual([[255, 0, 0]]);
  const canvas = await editor.locator('.projection-quad-editor').boundingBox();
  const handle = await editor.locator('[data-corner-index="0"]').boundingBox();
  await control.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await control.mouse.down();
  for (const [x, y] of [[.15, .28], [.23, .37]]) {
    await control.mouse.move(canvas.x + canvas.width * x, canvas.y + canvas.height * y, { steps: 4 });
    await expect.poll(() => page.evaluate(() => window.__viz.params['sleft:0x'])).toBeCloseTo(x, 5);
    await expect.poll(() => colors(page, [[.09, .3], [.4, .65], [.75, .5]])).toEqual([[0, 0, 0], [255, 0, 0], [0, 255, 0]]);
    await expect(editor.locator('[data-corner-index="0"]')).toHaveAttribute('aria-disabled', 'false');
  }
  // The real screen has changed twice while the mouse is still held down.
  expect(await page.evaluate(() => window.__viz.programs.live.generation)).toBe(before);
  expect(await page.evaluate(() => window.__originalProjectionCanvases.every((canvas) => canvas.isConnected))).toBe(true);
  await control.mouse.up();
  await control.keyboard.press('Escape');
  await expect(control.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__viz?.params?.['sleft:0x'])).toBeCloseTo(.23, 5);
  await expect.poll(() => colors(page, [[.09, .3], [.4, .65]])).toEqual([[0, 0, 0], [255, 0, 0]]);
  await control.reload();
  const reopened = await editMapping(control, 'Left wall');
  await reopened.getByRole('button', { name: 'Reset mapping to full frame' }).click();
  await expect.poll(() => page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(0);
  await expect.poll(() => colors(page, [[.09, .3]])).toEqual([[255, 0, 0]]);
});

test('delayed geometry echoes never rewind the handle or close before latest acceptance', async ({ context, page }) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  await page.evaluate(() => {
    const post = BroadcastChannel.prototype.postMessage;
    window.__geometryEchoes = [];
    window.__flushGeometryEcho = () => window.__geometryEchoes.shift()?.();
    BroadcastChannel.prototype.postMessage = function(message) {
      if (message.type === 'live-params' && message.id === 'projection-test') window.__geometryEchoes.push(() => post.call(this, message));
      else post.call(this, message);
    };
  });
  const editor = await editMapping(control, 'Left wall');
  await editor.locator('summary').click();
  const input = editor.getByRole('spinbutton', { name: 'Left wall TL X', exact: true });
  await input.fill('12.35');
  await expect.poll(() => page.evaluate(() => window.__geometryEchoes.length)).toBe(1);
  await input.fill('15.35');
  await expect(input).toBeEnabled();
  await page.evaluate(() => window.__flushGeometryEcho());
  await expect.poll(() => page.evaluate(() => window.__geometryEchoes.length)).toBe(1);
  await expect(input).toHaveValue('15.35');
  await expect(editor.locator('.projection-editor-footer')).toContainText('Saving changes');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toBeVisible();
  await page.evaluate(() => window.__flushGeometryEcho());
  await expect(control.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(.1535);
});

test('rapid autosaved names and sources serialize while keeping the newest geometry', async ({ context, page }) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  await page.evaluate(() => {
    const post = BroadcastChannel.prototype.postMessage;
    window.__metadataEchoes = [];
    window.__flushMetadataEcho = () => window.__metadataEchoes.shift()?.();
    BroadcastChannel.prototype.postMessage = function(message) {
      if (message.type === 'projection-patterns') window.__metadataEchoes.push(() => post.call(this, message));
      else post.call(this, message);
    };
  });
  const editor = await editMapping(control, 'Left wall');
  await smoothing(editor, 8.5);
  await expect.poll(() => page.evaluate(() => window.__viz.params['sleft:mappingEdgeBlur'])).toBe(8.5);
  await editor.getByLabel('Source pattern').selectOption('color-bars');
  await expect.poll(() => page.evaluate(() => window.__metadataEchoes.length)).toBe(1);
  await editor.getByLabel('Mapping name', { exact: true }).fill('Final wall');
  await editor.getByLabel('Source pattern').selectOption('solid-color');
  // New geometry remains interactive while an earlier source change is unacknowledged.
  await editor.locator('summary').click();
  await editor.getByRole('spinbutton', { name: 'Final wall TL X', exact: true }).fill('12.35');
  await expect.poll(() => page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(.1235);
  await page.evaluate(() => window.__flushMetadataEcho());
  await expect.poll(() => page.evaluate(() => window.__metadataEchoes.length)).toBe(1);
  await editor.getByRole('spinbutton', { name: 'Final wall TL X', exact: true }).fill('15.35');
  await expect.poll(() => page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(.1535);
  await page.evaluate(() => window.__flushMetadataEcho());
  await expect(editor.getByLabel('Source pattern')).toHaveValue('solid-color');
  await expect(editor.getByRole('spinbutton', { name: 'Final wall TL X', exact: true })).toHaveValue('15.35');
  await closeMapping(control);
  expect(await control.evaluate(() => JSON.parse(localStorage.getItem('viz2_projection_patterns'))[0].surfaces)).toEqual([
    { id: 'sleft', name: 'Final wall', patternId: 'solid-color' }, META.surfaces[1],
  ]);
  expect(await page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(.1535);
  expect(await page.evaluate(() => window.__viz.params['sleft:mappingEdgeBlur'])).toBe(8.5);
});

test('unnamed geometry waits for a name, creates once, and flushes the latest edits on Close', async ({ context, page }) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  await control.getByRole('button', { name: 'Add mapping', exact: true }).click();
  const editor = control.getByRole('dialog');
  await smoothing(editor, 6);
  await editor.locator('summary').click();
  await editor.getByRole('spinbutton', { name: 'New mapping TL X', exact: true }).fill('12.35');
  await control.waitForTimeout(5100); // An unnamed local mapping is not a failed autosave.
  await expect(editor.getByRole('alert')).toHaveCount(0);
  expect(await control.evaluate(() => JSON.parse(localStorage.getItem('viz2_projection_patterns'))[0].surfaces.length)).toBe(2);
  await editor.getByLabel('Mapping name', { exact: true }).fill('Ceiling');
  await editor.getByRole('spinbutton', { name: 'Ceiling TL X', exact: true }).fill('15.35');
  await smoothing(editor, 12.5);
  await control.keyboard.press('Escape'); // Also flushes a newly named surface before its ACK.
  await expect(control.getByRole('dialog')).toHaveCount(0);
  const row = control.getByRole('region', { name: 'Ceiling mapping', exact: true });
  await expect(row).toBeVisible();
  await expect(control.locator('.projection-surface')).toHaveCount(3);
  const id = await row.getAttribute('data-surface-id');
  expect(await page.evaluate((id) => window.__viz.params[`${id}:0x`], id)).toBe(.1535);
  expect(await page.evaluate((id) => window.__viz.params[`${id}:mappingEdgeBlur`], id)).toBe(12.5);
  const reopened = await editMapping(control, 'Ceiling');
  await expect(reopened.getByRole('slider', { name: 'Edge smoothing' })).toHaveValue('12.5');
  await closeMapping(control);
  await page.reload();
  await expect.poll(() => page.evaluate((id) => window.__viz?.params?.[`${id}:mappingEdgeBlur`], id)).toBe(12.5);
});

test('closing after autosave failure is explicit and external topology is not overwritten', async ({ context, page }) => {
  await seed(context);
  const control = await open(context, page);
  await expectWalls(page);
  const editor = await editMapping(control, 'Left wall');
  await send(control, { type: 'projection-edit', action: 'save', id: ID,
    pattern: { ...META, surfaces: [{ ...META.surfaces[0], name: 'Other operator' }, META.surfaces[1]] } });
  await expect(editor.getByRole('alert')).toContainText('layout changed elsewhere');
  await expect(editor.getByLabel('Mapping name', { exact: true })).toBeDisabled();
  control.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(control.getByRole('dialog')).toHaveCount(0);
  await expect(control.getByRole('region', { name: 'Other operator mapping', exact: true })).toBeVisible();
});

for (const scope of ['live', 'cue']) {
  test(`returning A→B→A before acknowledgement keeps the final ${scope} geometry on Close`, async ({ context, page }) => {
    await seed(context);
    const control = await open(context, page);
    await expectWalls(page);
    if (scope === 'cue') {
      await control.locator(`.library-btn[data-id="${ID}"]`).click({ modifiers: ['Shift'] });
      await expect.poll(() => page.evaluate(() => window.__viz.cue?.phase)).toBe('same');
    }
    await page.evaluate((scope) => {
      const post = BroadcastChannel.prototype.postMessage;
      const echoes = [];
      window.__restoreMappingEchoes = () => {
        BroadcastChannel.prototype.postMessage = post;
        echoes.forEach((flush) => flush());
      };
      BroadcastChannel.prototype.postMessage = function(message) {
        if ((scope === 'live' && message.type === 'live-params') || (scope === 'cue' && message.type === 'cue-state')) {
          echoes.push(() => post.call(this, message));
        } else post.call(this, message);
      };
    }, scope);
    const editor = await editMapping(control, 'Left wall');
    await editor.locator('summary').click();
    const input = editor.getByRole('spinbutton', { name: 'Left wall TL X', exact: true });
    await input.fill('15');
    await expect.poll(() => page.evaluate((scope) => (scope === 'cue' ? window.__viz.cueParams['projection-test'] : window.__viz.params)['sleft:0x'], scope)).toBe(.15);
    await input.fill('5');
    await control.keyboard.press('Escape');
    // The mirror still says A, but B was sent. Closing must wait for correction.
    await expect(editor).toBeVisible();
    await page.evaluate(() => window.__restoreMappingEchoes());
    await expect(control.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => page.evaluate((scope) => (scope === 'cue' ? window.__viz.cueParams['projection-test'] : window.__viz.params)['sleft:0x'], scope)).toBe(.05);
    expect(await page.evaluate(() => window.__viz.params['sleft:0x'])).toBe(.05);
    if (scope === 'cue') {
      await control.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => window.__viz.cue)).toBe(null);
    }
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.__viz?.params?.['sleft:0x'])).toBe(.05);
    await expectWalls(page);
  });
}

test('mapping titles highlight only text and parameter headings omit the mapping name', async ({ context, page }, testInfo) => {
  await seed(context);
  const control = await open(context, page);
  const row = control.getByRole('region', { name: 'Left wall mapping', exact: true });
  const toggle = row.locator('.projection-surface-toggle');
  const edit = row.getByRole('button', { name: 'Edit Left wall', exact: true });
  const remove = row.getByRole('button', { name: 'Remove Left wall', exact: true });
  const params = row.locator('.projection-surface-params');
  const transparent = 'rgba(0, 0, 0, 0)';
  const highlight = await row.locator('.projection-param-heading').evaluate((el) => getComputedStyle(el).color);
  const assertHighlighted = async () => {
    await expect(toggle).toHaveCSS('background-color', transparent);
    for (const selector of ['strong', 'small', '.projection-chevron']) {
      await expect(toggle.locator(selector)).toHaveCSS('color', highlight);
    }
  };

  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle.locator('strong')).toHaveText('1. Left wall');
  await expect(toggle).toHaveCSS('background-color', transparent);
  const initialColors = await toggle.locator('strong, small, .projection-chevron').evaluateAll(
    (els) => els.map((el) => getComputedStyle(el).color));
  expect(initialColors.every((color) => color !== highlight)).toBe(true);
  await toggle.hover();
  await assertHighlighted();
  await toggle.click();
  await expect(params).toBeVisible();
  await expect(row.locator('.projection-param-heading')).toHaveText('Solid Color parameters');
  await assertHighlighted();
  await row.screenshot({ path: testInfo.outputPath('mapping-title-hover.png') });

  // Moving to the adjacent actions removes the text-only highlight; those
  // actions retain their standard button hover fill and borders.
  for (const action of [edit, remove]) {
    await action.hover();
    await expect(action).toHaveCSS('background-color', 'rgb(34, 34, 34)');
    await expect(action).toHaveCSS('border-top-width', '1px');
  }
  expect(await toggle.locator('strong, small, .projection-chevron').evaluateAll(
    (els) => els.map((el) => getComputedStyle(el).color))).toEqual(initialColors);

  // Keyboard focus remains visible, with no filled rectangle, in both states.
  await edit.focus();
  await control.keyboard.press('Shift+Tab');
  await expect(toggle).toBeFocused();
  await assertHighlighted();
  await expect(toggle).toHaveCSS('outline-style', 'solid');
  await expect(toggle).toHaveCSS('outline-width', '1px');
  await control.keyboard.press('Space');
  await expect(params).toBeHidden();
  await assertHighlighted();
  await control.keyboard.press('Space');
  await expect(params).toBeVisible();
  await expect(control.getByRole('region', { name: 'Right wall mapping', exact: true })
    .locator('.projection-surface-params')).toBeHidden();
});

for (const global of [null, GLOBAL]) {
  test(`projection bypasses global edge blur and restores it for ordinary patterns (${global ? 'warped' : 'full-frame'})`, async ({ context, page }) => {
    await seed(context, { global, edgeBlur: 25 });
    const control = await open(context, page);
    const wrap = page.locator('#screen-wrap');
    const globalOutput = page.locator('#screen-mapping-output canvas');
    const assertBypass = async () => {
      await expect(globalOutput).toHaveCount(0);
      await expect(wrap).toHaveCSS('transform', 'none');
      await expect(wrap).toHaveCSS('mask-image', 'none');
      await expect(wrap).not.toHaveClass(/has-edge-blur/);
      await expectWalls(page);
      // These points lie within the global feather region but are fully lit
      // by their own projection surfaces in both GPU and CSS presentation.
      await expect.poll(() => colors(page, [[.1, .5], [.9, .5]])).toEqual([[255, 0, 0], [0, 255, 0]]);
    };
    await assertBypass();
    await send(control, { type: 'screen-mapping', enabled: true, quad: global, edgeBlur: 12.5 });
    await expect.poll(() => page.evaluate(() => window.__viz.screenMapping.edgeBlur)).toBe(12.5);
    await assertBypass();

    await control.locator('.library-btn[data-id="solid-color"]').click();
    await expect.poll(() => page.evaluate(() => window.__viz.patternId)).toBe('solid-color');
    await expect(page.locator('#screen-mapping-output')).toHaveClass('is-active');
    await expect(wrap).toHaveClass(/has-edge-blur/);
    expect(await page.evaluate(() => window.__viz.screenMapping.quad)).toEqual(global);
    expect(await page.evaluate(() => window.__viz.screenMapping.edgeBlur)).toBe(12.5);

    const projection = control.locator(`.library-btn[data-id="${ID}"]`);
    await projection.click({ modifiers: ['Shift'] });
    await expect.poll(() => page.evaluate(() => window.__viz.cue?.phase)).toBe('ready');
    // Staging a projection must not remove feathering from ordinary LIVE output.
    await expect(page.locator('#screen-mapping-output')).toHaveClass('is-active');
    await control.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__viz.patternId)).toBe(ID);
    await assertBypass();

    await page.locator('.program-layer-live .projection-output').evaluate((canvas) => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await expect(page.locator('.program-layer-live .projection-layer')).toHaveAttribute('data-fallback', 'true');
    await assertBypass();
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.__viz?.screenMapping?.edgeBlur)).toBe(12.5);
    await assertBypass();
  });
}

async function smoothing(editor, value) {
  await editor.getByRole('slider', { name: 'Edge smoothing' }).fill(String(value));
}

test('mapping editor shares Media dropdown chrome and has neutral focus at desktop, portrait and short sizes', async ({ context, page }, testInfo) => {
  await seed(context);
  const control = await open(context, page, { width: 405, height: 819 });
  const editor = await editMapping(control, 'Left wall');
  const source = editor.getByLabel('Source pattern');
  await expect(source).toHaveClass(/control-select/);
  await expect(source.locator('optgroup')).not.toHaveCount(0);
  await expect(source.locator('option[value^="projection-"]')).toHaveCount(0);
  await expect(source).toHaveCSS('appearance', 'none');
  await expect(source).toHaveCSS('background-repeat', 'no-repeat');
  await expect(source).toHaveCSS('background-size', '12px');
  await expect(source).toHaveCSS('background-image', /data:image\/svg\+xml/);
  await source.hover();
  await expect(source).toHaveCSS('background-image', /data:image\/svg\+xml/);
  await expect(editor.getByLabel('Mapping name', { exact: true })).toBeFocused();
  await control.keyboard.press('Tab'); // Establish keyboard focus-visible modality.
  for (const input of [editor.getByLabel('Mapping name', { exact: true }), source,
    editor.getByRole('button', { name: 'Close mapping editor', exact: true }),
    editor.getByRole('slider', { name: 'Edge smoothing' })]) {
    await input.focus();
    await expect(input).toHaveCSS('outline-color', 'rgb(176, 176, 176)');
    await expect(input).toHaveCSS('outline-style', 'solid');
  }
  const close = editor.getByRole('button', { name: 'Close mapping editor', exact: true });
  await close.hover();
  await expect(close).toHaveCSS('border-top-color', 'rgb(119, 119, 119)');
  await editor.locator('summary').click();
  const coordinate = editor.getByRole('spinbutton', { name: 'Left wall TL X', exact: true });
  await coordinate.focus();
  await expect(coordinate).toHaveCSS('outline-color', 'rgb(176, 176, 176)');
  await editor.locator('summary').click();
  await smoothing(editor, 10);
  await expect(editor.locator('.projection-editor-footer')).toContainText('All changes saved');
  for (const [width, height, name] of [[1280, 800, 'desktop-portrait'], [420, 780, 'mobile'], [920, 460, 'short']]) {
    await control.setViewportSize({ width, height });
    const bounds = await editor.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    expect(await editor.locator('.projection-editor-body').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
    await control.screenshot({ path: testInfo.outputPath(`clean-editor-${name}.png`) });
    const reset = editor.getByRole('button', { name: 'Reset mapping to full frame' });
    await reset.scrollIntoViewIfNeeded();
    await expect(reset).toBeInViewport();
    await editor.getByLabel('Mapping name', { exact: true }).scrollIntoViewIfNeeded();
  }
  await closeMapping(control);
});

test('per-surface smoothing feathers all four edges and overlaps identically in GPU and CSS, including static sources', async ({ context, page }, testInfo) => {
  await context.route('**/src/sketches/solid_color.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.slice(0, source.indexOf('export default')) + `
      export default (audio, videoDeviceId, params) => (p) => {
        p.setup = () => { p.createCanvas(p.windowWidth, p.windowHeight); p.noLoop(); };
        p.draw = () => { p.background(params.hue < 0.1 ? '#ff0000' : '#00ff00'); };
        p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
      };
    ` });
  });
  await seed(context, { values: { ...VALUES,
    ...geometry('sleft', rectangle(0, 0, 1, 1)), ...geometry('sright', rectangle(.25, .25, .75, .75)),
  } });
  const control = await open(context, page, { width: 400, height: 400 });
  const points = [[.5, .5], [.3125, .5], [.6875, .5], [.5, .3125], [.5, .6875], [.3125, .3125], [.1, .5]];
  await expect.poll(() => colors(page, points)).toEqual([
    [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0], [255, 0, 0],
  ]);
  const editor = await editMapping(control, 'Right wall');
  await expect(editor.getByRole('slider', { name: 'Edge smoothing' })).toHaveValue('0');
  await smoothing(editor, 25);
  await expect.poll(() => page.evaluate(() => window.__viz.params['sright:mappingEdgeBlur'])).toBe(25);
  await expect.poll(async () => (await colors(page, points))[1][0]).toBeGreaterThan(100);
  const gpu = await colors(page, points);
  expect(gpu[0]).toEqual([0, 255, 0]);
  for (const edge of gpu.slice(1, 5)) {
    expect(edge[0]).toBeGreaterThan(110); expect(edge[0]).toBeLessThan(145);
    expect(edge[1]).toBeGreaterThan(110); expect(edge[1]).toBeLessThan(145);
  }
  expect(gpu[5][0]).toBeGreaterThan(175); expect(gpu[5][1]).toBeLessThan(80);
  expect(gpu[6]).toEqual([255, 0, 0]);
  await page.screenshot({ path: testInfo.outputPath('edge-smoothing-gpu.png') });
  await page.locator('.program-layer-live .projection-output').evaluate((canvas) => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await expect(page.locator('.program-layer-live .projection-layer')).toHaveAttribute('data-fallback', 'true');
  const fallback = await colors(page, points);
  fallback.forEach((pixel, i) => pixel.forEach((channel, c) => expect(Math.abs(channel - gpu[i][c])).toBeLessThan(8)));
  await page.screenshot({ path: testInfo.outputPath('edge-smoothing-css.png') });
  await smoothing(editor, 0);
  await expect.poll(() => colors(page, points)).toEqual([
    [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0], [255, 0, 0],
  ]);
  await closeMapping(control);
});

for (const scope of ['live', 'cue']) {
  test(`edge smoothing A→B→A waits for the latest ${scope} acknowledgement`, async ({ context, page }) => {
    await seed(context, { values: { ...VALUES, 'sleft:mappingEdgeBlur': 5 } });
    const control = await open(context, page);
    if (scope === 'cue') {
      await control.locator(`.library-btn[data-id="${ID}"]`).click({ modifiers: ['Shift'] });
      await expect.poll(() => page.evaluate(() => window.__viz.cue?.phase)).toBe('same');
    }
    const editor = await editMapping(control, 'Left wall');
    await page.evaluate((scope) => {
      const post = BroadcastChannel.prototype.postMessage;
      const echoes = [];
      window.__restoreSmoothingEchoes = () => {
        BroadcastChannel.prototype.postMessage = post;
        echoes.forEach((flush) => flush());
      };
      BroadcastChannel.prototype.postMessage = function(message) {
        if ((scope === 'live' && message.type === 'live-params') || (scope === 'cue' && message.type === 'cue-state')) {
          echoes.push(() => post.call(this, message));
        } else post.call(this, message);
      };
    }, scope);
    await smoothing(editor, 15);
    const accepted = () => page.evaluate((scope) => (scope === 'cue' ? window.__viz.cueParams['projection-test'] : window.__viz.params)['sleft:mappingEdgeBlur'], scope);
    await expect.poll(accepted).toBe(15);
    if (scope === 'cue') expect(await page.evaluate(() => window.__viz.params['sleft:mappingEdgeBlur'])).toBe(5);
    await smoothing(editor, 5);
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(editor).toBeVisible();
    await page.evaluate(() => window.__restoreSmoothingEchoes());
    await expect(control.getByRole('dialog')).toHaveCount(0);
    await expect.poll(accepted).toBe(5);
    const reopened = await editMapping(control, 'Left wall');
    await smoothing(reopened, 12.5);
    await closeMapping(control);
    if (scope === 'cue') {
      expect(await page.evaluate(() => window.__viz.params['sleft:mappingEdgeBlur'])).toBe(5);
      await control.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => window.__viz.cue)).toBe(null);
    }
    await expect.poll(() => page.evaluate(() => window.__viz.params['sleft:mappingEdgeBlur'])).toBe(12.5);
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.__viz?.params?.['sleft:mappingEdgeBlur'])).toBe(12.5);
  });
}


test('mapping smoothing defaults to off and validates independently of source controls', () => {
  const sketches = [{ id: 'solid-color', params: [{ key: 'hue', min: 0, max: 1, default: 0 }] }];
  registerProjectionSketches(sketches, [META]);
  const sketch = sketches.find((entry) => entry.id === ID);
  expect(sketch.params.find((def) => def.key === 'sleft:mappingEdgeBlur')).toMatchObject({
    geometry: true, default: 0, min: 0, max: 25, step: 0.5,
  });
  expect(surfaceEdgeBlur(META.surfaces[0], VALUES)).toBe(0);
  expect(surfaceEdgeBlur(META.surfaces[0], { 'sright:mappingEdgeBlur': 20 })).toBe(0);
  for (const invalid of [-1, 26, NaN, Infinity, '5', null]) {
    expect(validProjectionPatch(sketch, VALUES, { 'sleft:mappingEdgeBlur': invalid })).toBe(false);
  }
  expect(validProjectionPatch(sketch, VALUES, { 'sleft:mappingEdgeBlur': 12.5 })).toBe(true);
  const patch = surfaceMappingValues('sleft', rectangle(.1, .1, .9, .9), 15);
  expect(patch['sleft:mappingEdgeBlur']).toBe(15);
  expect(Object.keys(patch)).toHaveLength(9);
  expect(patch).not.toHaveProperty('sleft:hue');
});
