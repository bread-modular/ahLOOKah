import { test, expect } from '@playwright/test';

const QUAD = [
  { x: 0.12, y: 0.06 }, { x: 0.88, y: 0.02 },
  { x: 0.96, y: 0.94 }, { x: 0.04, y: 0.98 },
];
const KEY = 'viz2_screen_mapping_edge_blur';

async function broadcast(page, fields) {
  await page.evaluate((fields) => {
    const channel = new BroadcastChannel('viz2_channel');
    channel.postMessage({ type: 'screen-mapping', enabled: true, quad: null, ...fields });
    channel.close();
  }, fields);
}

// Real p5 noLoop source exercises synchronous capture, cached-texture changes,
// CSS fallback and activation when a static frame was drawn before mapping.
async function installStaticPattern(context) {
  await context.addInitScript(() => localStorage.setItem('viz2_slot_order', '["color-bars"]'));
  await context.route('**/src/sketches/color_bars.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.slice(0, source.indexOf('export default')) + `
      export default () => (p) => {
        p.setup = () => { p.createCanvas(p.windowWidth, p.windowHeight); p.noLoop(); };
        p.draw = () => { p.background(180, 100, 60); };
        p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
      };
    ` });
  });
}

async function sampleOutput(page, points, path) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const shot = await page.screenshot(path ? { path } : {});
  return page.evaluate(async ({ b64, points }) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const matrix = new DOMMatrix(getComputedStyle(document.getElementById('screen-wrap')).transform);
    return points.map(([u, v]) => {
      const point = matrix.transformPoint(new DOMPoint(u * innerWidth, v * innerHeight));
      const x = Math.floor(point.x / point.w * img.width / innerWidth);
      const y = Math.floor(point.y / point.w * img.height / innerHeight);
      return [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
    });
  }, { b64: shot.toString('base64'), points });
}

function expectColor(actual, expected, tolerance = 3) {
  expected.forEach((value, i) => expect(Math.abs(actual[i] - value), JSON.stringify({ actual, expected })).toBeLessThanOrEqual(tolerance));
}

// All four source edges plus all corners; corners multiply the two axis fades.
const FADE_POINTS = [
  [0.125, 0.5], [0.875, 0.5], [0.5, 0.125], [0.5, 0.875],
  [0.125, 0.125], [0.875, 0.125], [0.875, 0.875], [0.125, 0.875],
  [0.5, 0.5],
];

test('edge blur validation and storage default safely, clamp numbers, and retain missing legacy fields', async ({ page }) => {
  await page.goto('/docs/');
  const result = await page.evaluate(async (key) => {
    const { normalizeMappingEdgeBlur: normalize, loadStoredMappingEdgeBlur: load, storeMappingEdgeBlur: save, mappingEdgeMask } = await import('/src/screen-mapping.js');
    const values = [undefined, null, '', '20', {}, NaN, Infinity, -Infinity, -3, 0, 7.5, 100];
    const normalized = values.map((value) => normalize(value, 9));
    localStorage.removeItem(key);
    const missing = load();
    const stored = ['garbage', 'null', '"20"', '-8', '200', '12.5'].map((raw) => {
      localStorage.setItem(key, raw); return load();
    });
    save(14.5);
    const saved = load();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('unavailable'); };
    try { save(18); } finally { Storage.prototype.setItem = original; }
    return { normalized, missing, stored, saved, zeroMask: mappingEdgeMask(0) };
  }, KEY);
  expect(result).toEqual({
    normalized: [9, 9, 9, 9, 9, 9, 9, 9, 0, 0, 7.5, 25],
    missing: 0, stored: [0, 0, 0, 0, 25, 12.5], saved: 14.5, zeroMask: 'none',
  });
});

for (const [name, quad, dpr] of [['identity', null, 1], ['trapezoid', QUAD, 1], ['high-DPI trapezoid', QUAD, 2]]) {
  test(`edge blur feathers all sides and corners after merge/post-FX: ${name}`, async ({ page }) => {
    await page.goto('/docs/');
    const result = await page.evaluate(async ({ quad, dpr, points }) => {
      const { ScreenMappingRenderer } = await import('/src/screen-mapping-renderer.js');
      const { IDENTITY_QUAD, quadToMatrix3d } = await import('/src/screen-mapping.js');
      const width = 640, height = 400;
      const source = document.createElement('canvas'); source.width = width; source.height = height;
      const ctx = source.getContext('2d');
      ctx.fillStyle = 'rgb(180, 100, 60)'; ctx.fillRect(0, 0, width, height);
      // Crisp centre detail must be bit-for-bit unchanged, not globally blurred.
      ctx.fillStyle = '#135'; ctx.fillRect(260, 160, 60, 80);
      const overlay = document.createElement('canvas'); overlay.width = width; overlay.height = height;
      const overlayCtx = overlay.getContext('2d');
      overlayCtx.fillStyle = 'rgba(20, 120, 200, 0.4)'; overlayCtx.fillRect(0, 0, width, height);
      const canvas = document.createElement('canvas');
      const renderer = new ScreenMappingRenderer(canvas);
      renderer.configure(quad || IDENTITY_QUAD, width, height, dpr);
      renderer.capture(source); renderer.capture(overlay);
      const matrix = new DOMMatrix(quadToMatrix3d(quad, width, height) || undefined);
      const coordinates = points.map(([u, v]) => {
        const p = matrix.transformPoint(new DOMPoint(u * width, v * height));
        return [Math.floor(p.x / p.w * dpr), Math.floor(p.y / p.w * dpr)];
      });
      const read = (options) => {
        renderer.render({ canvases: [source, overlay], blend: { mode: 1, add: 0.6 }, ...options });
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        renderer.gl.readPixels(0, 0, canvas.width, canvas.height, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const sample = (pixels) => coordinates.map(([x, y]) => {
        const start = ((canvas.height - y - 1) * canvas.width + x) * 4;
        return [...pixels.slice(start, start + 3)];
      });
      const checks = [{}, { brightness: 50, contrast: -35, saturation: -40 }].map((postFx) => {
        const baseline = read({ postFx });
        const blurred = read({ postFx, edgeBlur: 25 });
        const zero = read({ postFx, edgeBlur: 0 });
        const smaller = read({ postFx, edgeBlur: 12.5 });
        // Compare interior points straddling the sharp detail.
        const centralPoints = [[0.42, 0.45], [0.49, 0.5], [0.51, 0.5], [0.58, 0.55]];
        const centerUnchanged = centralPoints.every(([u, v]) => {
          const p = matrix.transformPoint(new DOMPoint(u * width, v * height));
          const x = Math.floor(p.x / p.w * dpr), y = Math.floor(p.y / p.w * dpr);
          const start = ((canvas.height - y - 1) * canvas.width + x) * 4;
          return baseline.slice(start, start + 4).every((value, i) => value === blurred[start + i]);
        });
        return { baseline: sample(baseline), blurred: sample(blurred), smaller: sample(smaller), zeroExact: baseline.every((v, i) => v === zero[i]), centerUnchanged };
      });
      renderer.dispose();
      return checks;
    }, { quad, dpr, points: FADE_POINTS });
    for (const check of result) {
      expect(check.zeroExact).toBe(true);
      expect(check.centerUnchanged).toBe(true);
      check.blurred.forEach((color, i) => expectColor(color, check.baseline[i].map((v) => v * (i < 4 ? 0.5 : i < 8 ? 0.25 : 1)), 4));
      check.smaller.forEach((color, i) => expectColor(color, check.baseline[i], 1));
    }
  });
}

test('slider updates static output live, persists, and survives legacy messages, reset and toggle', async ({ context }, testInfo) => {
  test.setTimeout(60_000);
  await installStaticPattern(context);
  const screen = await context.newPage();
  await screen.setViewportSize({ width: 640, height: 400 });
  await screen.goto('/?role=screen');
  await screen.waitForSelector('#screen-wrap canvas');
  const control = await context.newPage();
  await control.goto('/?role=control');
  const slider = control.getByRole('slider', { name: 'Edge blurring' });
  const enable = control.locator('#screen-mapping-enabled');
  const output = screen.locator('#screen-mapping-output');
  await expect(slider).toHaveValue('0');
  await expect(slider).toBeDisabled();
  await expect(slider).toHaveCSS('opacity', '0.5');
  await enable.check();
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveCSS('appearance', 'none');
  await expect(output.locator('canvas')).toHaveCount(0);
  await slider.focus();
  await slider.press('End'); // native range input, not a command shortcut
  await expect(slider).toHaveValue('25');
  await expect(control.locator('.screen-mapping-body [data-value="edgeBlur"]')).toHaveText('25%');
  await expect(output).toHaveClass('is-active');
  const pixels = await sampleOutput(screen, FADE_POINTS, testInfo.outputPath('edge-blur-full-frame.png'));
  pixels.forEach((pixel, i) => expectColor(pixel, [180, 100, 60].map((v) => v * (i < 4 ? 0.5 : i < 8 ? 0.25 : 1))));

  // Changes to the cached noLoop frame must be rendered without another draw.
  await slider.evaluate((input) => {
    input.value = '12.5'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => screen.evaluate(() => window.__viz.screenMapping.edgeBlur)).toBe(12.5);
  expectColor((await sampleOutput(screen, [[0.125, 0.5]]))[0], [180, 100, 60]);
  expect(await control.evaluate((key) => localStorage.getItem(key), KEY)).toBe('12.5');
  await broadcast(control, { quad: QUAD }); // legacy sender omits edgeBlur
  await expect(screen.locator('#screen-wrap')).not.toHaveCSS('transform', 'none');
  await expect(slider).toHaveValue('12.5');
  await control.locator('#screen-mapping-reset-btn').click();
  await expect(screen.locator('#screen-wrap')).toHaveCSS('transform', 'none');
  await expect(slider).toHaveValue('12.5');
  await expect(output).toHaveClass('is-active'); // full-frame reset keeps feather

  for (const raw of [null, '20', { bad: true }, NaN, Infinity]) {
    await broadcast(control, { edgeBlur: raw, quad: QUAD });
    await expect(screen.locator('#screen-wrap')).not.toHaveCSS('transform', 'none');
    await broadcast(control, { edgeBlur: raw, quad: null });
    await expect(screen.locator('#screen-wrap')).toHaveCSS('transform', 'none');
    await expect(slider).toHaveValue('12.5');
    expect(await screen.evaluate(() => window.__viz.screenMapping.edgeBlur)).toBe(12.5);
  }
  await broadcast(control, { edgeBlur: 500 });
  await expect(slider).toHaveValue('25');
  await expect.poll(() => screen.evaluate(() => window.__viz.screenMapping.edgeBlur)).toBe(25);
  await broadcast(control, { edgeBlur: -1 });
  await expect(slider).toHaveValue('0');
  await expect(output.locator('canvas')).toHaveCount(0);

  await slider.focus(); await slider.press('End');
  await expect(output).toHaveClass('is-active');
  await enable.uncheck();
  await expect(slider).toBeDisabled();
  await expect(slider).toHaveValue('25');
  await expect(output.locator('canvas')).toHaveCount(0);
  await expect(screen.locator('#screen-wrap')).toHaveCSS('mask-image', 'none');
  expectColor((await sampleOutput(screen, [[0.125, 0.5]]))[0], [180, 100, 60]);
  await enable.check();
  await expect(output).toHaveClass('is-active');
  await control.reload();
  await expect(slider).toHaveValue('25');
  await screen.reload();
  await expect(output).toHaveClass('is-active');
  expect(await screen.evaluate(() => window.__viz.screenMapping.edgeBlur)).toBe(25);
  await control.locator('.screen-mapping-body').screenshot({ path: testInfo.outputPath('edge-blur-control.png') });

  await slider.focus(); await slider.press('Home');
  await expect(slider).toHaveValue('0');
  await expect(control.locator('.screen-mapping-body [data-value="edgeBlur"]')).toHaveText('0% (off)');
  await expect(output.locator('canvas')).toHaveCount(0);
  await expect(screen.locator('#screen-wrap')).toHaveCSS('mask-image', 'none');
});

for (const quad of [null, QUAD]) {
  test(`CSS fallback retains edge blending after context loss (${quad ? 'trapezoid' : 'identity'})`, async ({ context }, testInfo) => {
    await installStaticPattern(context);
    const screen = await context.newPage();
    await screen.setViewportSize({ width: 640, height: 400 });
    await screen.goto('/?role=screen');
    await screen.waitForSelector('#screen-wrap canvas');
    const control = await context.newPage();
    await control.goto('/?role=control');
    await broadcast(control, { quad, edgeBlur: 25 });
    const output = screen.locator('#screen-mapping-output');
    await expect(output).toHaveClass('is-active');
    // Negative contrast lifts blacks: catches masks incorrectly applied BEFORE FX.
    await control.locator('#post-fx-list input[data-key="contrast"]').evaluate((input) => {
      input.value = '-50'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect.poll(() => screen.evaluate(() => window.__viz.postfx.contrast)).toBe(-50);
    const points = [...FADE_POINTS, [0.01, 0.5], [0.5, 0.01], [0.99, 0.5], [0.5, 0.99]];
    const gpu = await sampleOutput(screen, points);
    await output.locator('canvas').evaluate((canvas) => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await expect(output.locator('canvas')).toHaveCount(0);
    await expect(screen.locator('#screen-wrap')).toHaveCSS('opacity', '1');
    await expect(screen.locator('#screen-wrap')).not.toHaveCSS('mask-image', 'none');
    const css = await sampleOutput(screen, points, testInfo.outputPath('edge-blur-css-fallback.png'));
    css.forEach((color, i) => expectColor(color, gpu[i], 4));
    css.slice(-4).forEach((color) => color.forEach((v) => expect(v).toBeLessThan(4)));
    await broadcast(control, { quad, edgeBlur: 0 });
    await expect(screen.locator('#screen-wrap')).toHaveCSS('mask-image', 'none');
    expectColor((await sampleOutput(screen, [[0.125, 0.5]]))[0], [154, 114, 94]);
  });
}
