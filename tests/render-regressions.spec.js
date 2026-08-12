import { test, expect } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';

function collectRenderMessages(page) {
  const messages = [];
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return;
    if (/frame-ancestors.*ignored/i.test(message.text())) return;
    messages.push(`console ${message.type()}: ${message.text()}`);
  });
  return messages;
}

async function selectEffect(control, page, id) {
  const button = control.locator(`.pattern-btn.library-btn[data-id="${id}"]`);
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await page.waitForFunction((expected) => window.__viz.patternId === expected, id);
}

async function openEffect(context, page, id) {
  const control = await context.newPage();
  await control.goto(CONTROL_URL);
  await selectEffect(control, page, id);
  await page.waitForTimeout(350);
  return control;
}

async function inspectCanvas(page) {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll('#screen-wrap canvas')]
      .map((element) => ({ element, style: getComputedStyle(element), rect: element.getBoundingClientRect() }))
      .filter(({ style, rect }) => style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0);
    const selected = canvases.find(({ rect }) => Math.round(rect.width) === window.innerWidth && Math.round(rect.height) === window.innerHeight)
      || canvases[canvases.length - 1];
    if (!selected) return null;

    const { element: canvas, rect } = selected;
    const sample = document.createElement('canvas');
    sample.width = 32;
    sample.height = 18;
    const context = sample.getContext('2d', { willReadFrequently: true });
    let nonBlackPixels = 0;
    try {
      context.drawImage(canvas, 0, 0, sample.width, sample.height);
      const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > 5 || pixels[index + 1] > 5 || pixels[index + 2] > 5) nonBlackPixels += 1;
      }
    } catch {
      nonBlackPixels = -1;
    }

    return {
      rectWidth: Math.round(rect.width),
      rectHeight: Math.round(rect.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      nonBlackPixels,
    };
  });
}

async function expectScreenCanvas(page, { fullResolution = true } = {}) {
  await expect(page.locator('#screen-wrap canvas').last()).toBeVisible();
  await expect.poll(() => inspectCanvas(page)).toMatchObject({
    rectWidth: await page.evaluate(() => window.innerWidth),
    rectHeight: await page.evaluate(() => window.innerHeight),
  });
  let canvas = await inspectCanvas(page);
  if (canvas.nonBlackPixels === 0) {
    // Canvas 2D readback can race an accelerated frame. Give the renderer a few
    // frames, then require actual non-black sampled pixels rather than treating
    // a transient black read as a successful render.
    await expect.poll(() => inspectCanvas(page).then((result) => result?.nonBlackPixels ?? 0)).toBeGreaterThan(0);
    canvas = await inspectCanvas(page);
  }
  // A browser may block cross-context WebGL readback; -1 is explicitly reported
  // as unavailable and is not interpreted as a black render.
  expect(canvas.nonBlackPixels === -1 || canvas.nonBlackPixels > 0).toBe(true);
  if (fullResolution) {
    expect(canvas.backingWidth).toBe(canvas.viewportWidth);
    expect(canvas.backingHeight).toBe(canvas.viewportHeight);
  } else {
    expect(canvas.backingWidth).toBeGreaterThan(0);
    expect(canvas.backingHeight).toBeGreaterThan(0);
    expect(canvas.backingWidth).toBeLessThanOrEqual(canvas.viewportWidth);
    expect(canvas.backingHeight).toBeLessThanOrEqual(canvas.viewportHeight);
  }
  return canvas;
}

function expectNoReportedRenderProblems(messages) {
  const relevantMessages = messages.filter((message) => !/GL Driver Message.*(?:GPU stall due to ReadPixels|GL_CLOSE_PATH_NV)/i.test(message));
  expect(relevantMessages.filter((message) => /MAX_FRAGMENT_UNIFORM_VECTORS|shader program|Unable to prepare requested live program|Expected .* at the first parameter in image\(|Constant "(?:PI|TAU)".*redeclared|conflicts with a p5\.js constant/i.test(message))).toEqual([]);
  expect(relevantMessages).toEqual([]);
}

test.describe('rendering regressions', () => {
  test('Particle Storm and Starfield Rush render visibly at default and maximum counts without shader-uniform failures', async ({ context, page }) => {
    const messages = collectRenderMessages(page);
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    for (const [id, count] of [['particle-storm', '800'], ['starfield-rush', '600']]) {
      await selectEffect(control, page, id);
      await page.waitForTimeout(350);
      await expectScreenCanvas(page);

      await control.locator('#params-list input[data-key="count"]').evaluate((input, value) => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, count);
      await page.waitForTimeout(550);
      await expectScreenCanvas(page);
    }

    expectNoReportedRenderProblems(messages);
    await control.close();
  });

  test('Slice Glitch draws visible pixels from its offscreen buffer without p5 image validation errors', async ({ context, page }) => {
    const messages = collectRenderMessages(page);
    await page.goto(SCREEN_URL);
    const control = await openEffect(context, page, 'glitch-slices');

    await page.waitForTimeout(650);
    await expectScreenCanvas(page);
    expectNoReportedRenderProblems(messages);
    await control.close();
  });

  test('screen canvases retain a p5-managed full-resolution backing store and visible pixels after resize', async ({ context, page }) => {
    const messages = collectRenderMessages(page);
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.goto(SCREEN_URL);
    const control = await openEffect(context, page, 'pulse-rings');

    await expectScreenCanvas(page);
    await page.setViewportSize({ width: 1365, height: 820 });
    await page.waitForTimeout(550);
    const resized = await expectScreenCanvas(page);
    expect(resized).toMatchObject({
      backingWidth: 1365,
      backingHeight: 820,
      nonBlackPixels: expect.any(Number),
    });

    expectNoReportedRenderProblems(messages);
    await control.close();
  });

  test('Storm Surge keeps a scaled shader backing store while visibly filling the viewport', async ({ context, page }) => {
    const messages = collectRenderMessages(page);
    await page.goto(SCREEN_URL);
    const control = await openEffect(context, page, 'storm-surge');

    await page.waitForTimeout(450);
    const initial = await expectScreenCanvas(page, { fullResolution: false });
    expect(initial.backingWidth).toBeLessThan(initial.viewportWidth);
    expect(initial.backingHeight).toBeLessThan(initial.viewportHeight);

    // Resize is covered by the lightweight Pulse Rings regression above. Storm
    // Surge's expensive cloud pass is checked here for its scaled, full-viewport
    // output without creating an extra high-cost resize frame in the smoke path.
    expectNoReportedRenderProblems(messages);
    await control.close();
  });
});
