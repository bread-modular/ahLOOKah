import { test, expect } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';

// Drive a post-fx slider in the control panel (setting .value + firing the
// input event is the same end state as a drag, minus the intermediate steps).
async function setPostFx(control, key, value) {
  await control.evaluate(({ key, value }) => {
    const input = document.querySelector(`#post-fx-list input[data-key="${key}"]`);
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { key, value });
}

test.describe('post processing section', () => {
  test('renders above Band Split EQ with natural defaults and collapses like it', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    const section = control.locator('#post-fx');
    await expect(section).toHaveAttribute('open', '');

    // Section order in the controls pane
    const order = await control.evaluate(() =>
      [...document.querySelectorAll('#controls-pane > details')].map((s) => s.id)
    );
    expect(order).toEqual(['post-fx', 'band-eq', 'device-setup']);

    // Three offset sliders at the natural level
    for (const key of ['brightness', 'contrast', 'saturation']) {
      const input = control.locator(`#post-fx-list input[data-key="${key}"]`);
      await expect(input).toHaveValue('0');
      await expect(input).toHaveAttribute('min', '-100');
      await expect(input).toHaveAttribute('max', '100');
    }
    await expect(control.locator('#post-fx-list .param-value').first()).toHaveText('0');

    // Collapsing persists across reloads (same behaviour as the other sections)
    await section.locator('summary').click();
    await expect(section).not.toHaveAttribute('open', '');
    await control.reload();
    await expect(control.locator('#post-fx')).not.toHaveAttribute('open', '');
  });

  test('sliders trim the screen output via the stage wrapper filter', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    await page.waitForSelector('#screen-wrap canvas');

    // Natural level: no filter pass at all
    await expect(page.locator('#screen-wrap')).toHaveCSS('filter', 'none');

    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await setPostFx(control, 'brightness', 25);
    await setPostFx(control, 'contrast', -50);
    await setPostFx(control, 'saturation', 100);

    // The screen's stage wrapper carries the trim (offset 0 -> 1.0, so
    // +25 -> brightness(1.25), -50 -> contrast(0.5), +100 -> saturate(2))
    await page.waitForFunction(() => {
      const wrap = document.getElementById('screen-wrap');
      return wrap && wrap.style.filter.includes('brightness(1.25)');
    });
    const filter = await page.evaluate(() => document.getElementById('screen-wrap').style.filter);
    expect(filter).toContain('brightness(1.25)');
    expect(filter).toContain('contrast(0.5)');
    expect(filter).toContain('saturate(2)');

    // The stage canvas actually lives inside the filtered wrapper
    await expect(page.locator('#screen-wrap canvas')).toBeVisible();

    // Persisted under the reserved POSTFX id in the shared param store
    await page.waitForFunction(() => {
      const stored = JSON.parse(localStorage.getItem('viz2_params') || '{}');
      return (
        stored.__postfx &&
        stored.__postfx.brightness === 25 &&
        stored.__postfx.contrast === -50 &&
        stored.__postfx.saturation === 100
      );
    });
  });

  test('Reset to Natural restores the untouched output', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    await page.waitForSelector('#screen-wrap canvas');

    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await setPostFx(control, 'brightness', -40);
    await setPostFx(control, 'saturation', 60);
    await page.waitForFunction(() => {
      const wrap = document.getElementById('screen-wrap');
      return wrap && wrap.style.filter.includes('brightness(0.6)');
    });

    await control.locator('#post-fx-reset-btn').click();

    // Sliders snap back to the natural level on the panel…
    await expect(control.locator('#post-fx-list input[data-key="brightness"]')).toHaveValue('0');
    await expect(control.locator('#post-fx-list input[data-key="contrast"]')).toHaveValue('0');
    await expect(control.locator('#post-fx-list input[data-key="saturation"]')).toHaveValue('0');
    // …and the screen drops the filter entirely
    await expect(page.locator('#screen-wrap')).toHaveCSS('filter', 'none');
  });

  test('a tuned trim survives a reload on both windows', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Seed a tuned trim the way a slider drag would persist it
    await control.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('viz2_params') || '{}');
      stored.__postfx = { brightness: 30, contrast: 10, saturation: -25 };
      localStorage.setItem('viz2_params', JSON.stringify(stored));
    });

    // Screen: the trim is applied on boot
    await page.reload();
    await page.waitForSelector('#screen-wrap canvas');
    await page.waitForFunction(() => {
      const wrap = document.getElementById('screen-wrap');
      return wrap && wrap.style.filter.includes('brightness(1.3)');
    });
    const filter = await page.evaluate(() => document.getElementById('screen-wrap').style.filter);
    expect(filter).toContain('brightness(1.3)');
    expect(filter).toContain('contrast(1.1)');
    expect(filter).toContain('saturate(0.75)');

    // Panel: the sliders reflect the stored values
    await control.reload();
    await expect(control.locator('#post-fx-list input[data-key="brightness"]')).toHaveValue('30');
    await expect(control.locator('#post-fx-list input[data-key="contrast"]')).toHaveValue('10');
    await expect(control.locator('#post-fx-list input[data-key="saturation"]')).toHaveValue('-25');
  });

  test('the trim applies on top of a live merge (dual-canvas blend)', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Start a merge exactly like merge-mode.spec.js: keys 1+2 together
    await control.keyboard.down('1');
    await control.keyboard.down('2');
    await control.keyboard.up('1');
    await control.keyboard.up('2');

    await expect(page.locator('canvas.merge-canvas')).toHaveCount(2);
    // Both merge canvases live inside the (single) filtered wrapper
    await expect(page.locator('#screen-wrap canvas.merge-canvas')).toHaveCount(2);

    await setPostFx(control, 'brightness', -20);
    await page.waitForFunction(() => {
      const wrap = document.getElementById('screen-wrap');
      return wrap && wrap.style.filter.includes('brightness(0.8)');
    });
    // The trim must NOT be applied per-canvas (that would double-filter the blend)
    const perCanvas = await page.evaluate(() =>
      [...document.querySelectorAll('canvas.merge-canvas')].map((c) => c.style.filter)
    );
    expect(perCanvas).toEqual(['', '']);
  });
});
