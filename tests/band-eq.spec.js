import { test, expect } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';

// Log-axis constants mirrored from sketches/audio-features.js
const EQ_MIN_HZ = 30;
const EQ_MAX_HZ = 16000;
const hzFrac = (hz) => Math.log(hz / EQ_MIN_HZ) / Math.log(EQ_MAX_HZ / EQ_MIN_HZ);

// Deterministic frame for the capture-owning control: swap its AudioManager
// source so the control -> screen broadcast runs without a real microphone.
async function injectToneFrame(page, { range = [40, 145], db = -20 } = {}) {
  await page.waitForFunction(() => window.__viz.audioOwner);
  await page.evaluate(({ range, db }) => {
    const sampleRate = 48000;
    const fftSize = 2048;
    const bins = fftSize / 2;
    const left = new Float32Array(bins).fill(-92);
    const right = new Float32Array(bins).fill(-92);
    const binHz = sampleRate / fftSize;
    const start = Math.ceil(range[0] / binHz);
    const end = Math.floor(range[1] / binHz);
    for (let i = start; i <= end; i++) left[i] = right[i] = db;
    const frame = { left, right, sampleRate, fftSize, rms: 0.2 };
    window.__viz.captureAudio.isStarted = true;
    window.__viz.captureAudio.getAnalysisFrame = () => frame;
  }, { range, db });
}

test.describe('band split EQ section', () => {
  test('renders with the default musical borders and collapses like the other sections', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    const eq = control.locator('#band-eq');
    await expect(eq).toHaveAttribute('open', '');

    // Sits directly below post-processing in the controls pane (post-processing
    // is the first collapsible section, above the EQ)
    const order = await control.evaluate(() =>
      [...document.querySelectorAll('#controls-pane > details')].map((s) => s.id)
    );
    expect(order).toEqual(['post-fx', 'band-eq']);

    // Coloured band legend showing the default MUSICAL_BANDS borders
    await expect(control.locator('.band-chip')).toHaveCount(3);
    await expect(control.locator('[data-eq-range="bass"]')).toHaveText('30–180 Hz');
    await expect(control.locator('[data-eq-range="mid"]')).toHaveText('180 Hz–2.8k');
    await expect(control.locator('[data-eq-range="high"]')).toHaveText('2.8k–16k');

    // No screen/audio yet -> the idle overlay is up
    await expect(control.locator('#band-eq-idle')).toBeVisible();

    // Collapsing works and persists across reloads (like the other sections)
    await eq.locator('summary').click();
    await expect(eq).not.toHaveAttribute('open', '');
    await expect(control.locator('#band-eq-canvas')).not.toBeVisible();
    await control.reload();
    await expect(control.locator('#band-eq')).not.toHaveAttribute('open', '');
    await control.locator('#band-eq summary').click();
    await expect(control.locator('#band-eq')).toHaveAttribute('open', '');
  });

  test('the control broadcasts live audio to the screen and draws its EQ spectrum', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Idle until the control has audio
    await expect(control.locator('#band-eq-idle')).toBeVisible();

    await injectToneFrame(control);

    // The local EQ receives the compact feed, while the output receives the
    // full frequency/waveform frame through its remote-audio facade.
    await control.waitForFunction(() => (window.__viz.eq?.drawn ?? 0) > 2);
    await page.waitForFunction(() => window.__viz.audio.isStarted && window.__viz.audio.getAnalysisFrame());
    await expect(control.locator('#band-eq-idle')).toBeHidden();
  });

  test('dragging a separator retunes the band split on every window', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await injectToneFrame(control);
    await control.waitForFunction(() => (window.__viz.eq?.drawn ?? 0) > 0);

    // The controls pane scrolls; make sure the canvas is in the viewport so
    // the raw mouse coordinates below actually land on it.
    await control.locator('#band-eq-canvas').scrollIntoViewIfNeeded();
    const box = await control.locator('#band-eq-canvas').boundingBox();
    expect(box).not.toBeNull();

    // Grab the bass|mid separator at 180 Hz and drag it right by 60px
    const x = box.x + hzFrac(180) * box.width;
    const y = box.y + box.height / 2;
    await control.mouse.move(x, y);
    await control.mouse.down();
    await control.mouse.move(x + 60, y, { steps: 4 });
    await control.mouse.up();

    // Persisted in the shared param store under the reserved BANDS_ID
    await page.waitForFunction(() => {
      const stored = JSON.parse(localStorage.getItem('viz2_params') || '{}');
      return stored.__bands && stored.__bands.low > 250;
    });

    // The screen's feature extractor follows the new crossover
    const screenSplit = await page.evaluate(async () => {
      const { getBandSplit } = await import('/src/sketches/audio-features.js');
      return getBandSplit();
    });
    expect(screenSplit.low).toBeGreaterThan(250);
    expect(screenSplit.high).toBe(2800);

    // Both windows agree on the live value, and the legend reflects it
    expect(await control.evaluate(() => window.__viz.bands.low)).toBe(screenSplit.low);
    await expect(control.locator('[data-eq-range="bass"]')).not.toHaveText('30–180 Hz');
    await expect(control.locator('[data-eq-range="mid"]')).toContainText(`${screenSplit.low} Hz–`);
  });

  test('the tuned band split survives a reload on both windows', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Seed a tuned crossover the way a drag would persist it
    await control.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('viz2_params') || '{}');
      stored.__bands = { low: 320, high: 2800 };
      localStorage.setItem('viz2_params', JSON.stringify(stored));
    });

    await page.reload();
    await control.reload();

    // The screen's feature extractor boots with the saved crossovers
    const screenSplit = await page.evaluate(async () => {
      const { getBandSplit } = await import('/src/sketches/audio-features.js');
      return getBandSplit();
    });
    expect(screenSplit.low).toBe(320);

    // And the panel legend shows them too
    await expect(control.locator('[data-eq-range="bass"]')).toHaveText('30–320 Hz');
  });

  test('separators respect the drag limits and keep the bands apart', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.locator('#band-eq-canvas').scrollIntoViewIfNeeded();
    const box = await control.locator('#band-eq-canvas').boundingBox();
    expect(box).not.toBeNull();

    // Slam the bass separator all the way to the right edge
    const x = box.x + hzFrac(180) * box.width;
    const y = box.y + box.height / 2;
    await control.mouse.move(x, y);
    await control.mouse.down();
    await control.mouse.move(box.x + box.width - 2, y, { steps: 4 });
    await control.mouse.up();

    const split = await control.evaluate(() => window.__viz.eq.split);
    expect(split.low).toBeLessThanOrEqual(1200);
    expect(split.high).toBe(2800);
    expect(split.high / split.low).toBeGreaterThanOrEqual(1.25);
  });
});
