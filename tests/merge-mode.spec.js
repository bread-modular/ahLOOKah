import { test, expect } from '@playwright/test';

const SCREEN_URL = '/';
const CONTROL_URL = '/?role=control';

// Dual-effect merge mode: holding two number keys (1-9/0) on the control panel
// selects BOTH effects and blends them on the screen. The params list switches
// from the individual effect sliders to the global blend sliders.

test.describe('dual-effect merge mode', () => {
  test('merging latches after release; a single key press ends the blend', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // First key held -> plain single selection
    await control.keyboard.down('1');
    await page.waitForFunction(() => window.__viz.pattern === 0);
    expect(await page.evaluate(() => window.__viz.merge)).toBeNull();
    await expect(page.locator('canvas.merge-canvas')).toHaveCount(0);

    // Second key held while the first is down -> merge of both effects
    await control.keyboard.down('3');
    await page.waitForFunction(() => JSON.stringify(window.__viz.merge) === '[0,2]');

    // Both effects run: base + overlay canvases stacked (DOM compositing)
    await expect(page.locator('canvas.merge-canvas')).toHaveCount(2);

    // Release BOTH keys — the blend latches and keeps running
    await control.keyboard.up('3');
    await control.keyboard.up('1');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => JSON.stringify(window.__viz.merge))).toBe('[0,2]');
    await expect(page.locator('canvas.merge-canvas')).toHaveCount(2);

    // A single key press ends the blend
    await control.keyboard.press('5');
    await page.waitForFunction(() => window.__viz.pattern === 4 && window.__viz.merge === null);
    await expect(page.locator('canvas.merge-canvas')).toHaveCount(0);

    // Two overlapping presses again -> a new latched blend
    await control.keyboard.down('5');
    await control.keyboard.down('7');
    await page.waitForFunction(() => JSON.stringify(window.__viz.merge) === '[4,6]');
    await control.keyboard.up('7');
    await control.keyboard.up('5');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => JSON.stringify(window.__viz.merge))).toBe('[4,6]');
  });

  test('merge mode shows blend params instead of individual params', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.keyboard.down('1');
    await control.keyboard.down('3');

    // Blend header + mode toggle + ONE level slider (default Blend @ 0.5)
    await expect(control.locator('#params-list .blend-header')).toBeVisible();
    await expect(control.locator('#params-list .blend-names')).toContainText('+');
    await expect(control.locator('.blend-mode-btn[data-mode="blend"]')).toHaveClass(/active/);
    await expect(control.locator('.blend-mode-btn[data-mode="additive"]')).toBeVisible();
    // The selected mode button must have a solid fill (not the generic #111)
    const bg = await control
      .locator('.blend-mode-btn[data-mode="blend"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(168, 85, 247)');
    await expect(control.locator('#params-list input[data-key="mix"]')).toHaveValue('0.5');
    await expect(control.locator('#params-list input[type="range"]')).toHaveCount(1);

    // Individual effect sliders are NOT shown while merging
    await expect(control.locator('#params-list input[data-key="bass"]')).toHaveCount(0);

    // Both buttons highlight as the merge pair
    await expect(control.locator('.pattern-btn[data-index="0"]')).toHaveClass(/merge-active/);
    await expect(control.locator('.pattern-btn[data-index="2"]')).toHaveClass(/merge-active/);
    await expect(control.locator('.pattern-btn.active')).toHaveCount(0);

    // Back to single -> individual sliders return
    await control.keyboard.up('1');
    await control.keyboard.up('3');
    await control.keyboard.down('1');
    await expect(control.locator('#params-list input[data-key="bass"]')).toBeVisible();
    await control.keyboard.up('1');
  });

  test('blend slider changes reach the screen live', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.keyboard.down('1');
    await control.keyboard.down('3');
    await page.waitForFunction(() => window.__viz.merge !== null);

    // Crossfade to the overlay: mix=1 -> overlay opacity 1
    await control.locator('#params-list input[data-key="mix"]').evaluate((el) => {
      el.value = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => window.__viz.blend.mix === 1);
    await page.waitForFunction(() => {
      const canvases = [...document.querySelectorAll('canvas.merge-canvas')];
      return canvases.length === 2 && canvases[1].style.opacity === '1';
    });

    await control.keyboard.up('1');
    await control.keyboard.up('3');
  });

  test('+ and - keys adjust the blend level', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.keyboard.down('1');
    await control.keyboard.down('3');
    await page.waitForFunction(() => window.__viz.merge !== null);

    // Default Blend @ 0.5 -> '+' steps up 0.05, '-' steps down
    await control.keyboard.press('+');
    await page.waitForFunction(() => window.__viz.blend.mix === 0.55);
    await control.keyboard.press('='); // unshifted '+' on many layouts
    await page.waitForFunction(() => window.__viz.blend.mix === 0.6);
    await control.keyboard.press('-');
    await control.keyboard.press('-');
    await page.waitForFunction(() => window.__viz.blend.mix === 0.5);

    // Clamps at the edges
    for (let i = 0; i < 30; i++) await control.keyboard.press('+');
    await page.waitForFunction(() => window.__viz.blend.mix === 1);
    for (let i = 0; i < 30; i++) await control.keyboard.press('-');
    await page.waitForFunction(() => window.__viz.blend.mix === 0);

    // In Additive mode +/- moves the add level instead
    await control.keyboard.press('Tab');
    await page.waitForFunction(() => window.__viz.blend.mode === 1);
    await control.keyboard.press('+');
    await page.waitForFunction(() => window.__viz.blend.add === 0.55);

    await control.keyboard.up('1');
    await control.keyboard.up('3');
  });

  test('Tab toggles between Blend and Additive modes', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.keyboard.down('1');
    await control.keyboard.down('3');
    await page.waitForFunction(() => window.__viz.merge !== null);

    // Default: Blend mode, crossfade slider
    expect(await page.evaluate(() => window.__viz.blend.mode)).toBe(0);
    await expect(control.locator('.blend-mode-btn[data-mode="blend"]')).toHaveClass(/active/);
    await expect(control.locator('#params-list input[data-key="mix"]')).toBeVisible();

    // Tab -> Additive: slider becomes the add level, overlay is screened
    await control.keyboard.press('Tab');
    await page.waitForFunction(() => window.__viz.blend.mode === 1);
    await expect(control.locator('.blend-mode-btn[data-mode="additive"]')).toHaveClass(/active/);
    await expect(control.locator('#params-list input[data-key="add"]')).toHaveValue('0.5');
    await page.waitForFunction(() => {
      const canvases = [...document.querySelectorAll('canvas.merge-canvas')];
      return (
        canvases.length === 2 &&
        canvases[1].style.mixBlendMode === 'screen' &&
        canvases[1].style.opacity === '0.5'
      );
    });

    // Tab again -> back to Blend
    await control.keyboard.press('Tab');
    await page.waitForFunction(() => window.__viz.blend.mode === 0);
    await expect(control.locator('.blend-mode-btn[data-mode="blend"]')).toHaveClass(/active/);
    await expect(control.locator('#params-list input[data-key="mix"]')).toBeVisible();

    await control.keyboard.up('1');
    await control.keyboard.up('3');
  });

  test('extra held keys are ignored (merge caps at two effects)', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.keyboard.down('1');
    await control.keyboard.down('3');
    await page.waitForFunction(() => JSON.stringify(window.__viz.merge) === '[0,2]');

    // A third key while two are held does not change the merge
    await control.keyboard.down('5');
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => JSON.stringify(window.__viz.merge))).toBe('[0,2]');

    await control.keyboard.up('1');
    await control.keyboard.up('3');
    await control.keyboard.up('5');
  });

  test('a control panel opened during a merge syncs to blend mode', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.keyboard.down('1');
    await control.keyboard.down('3');
    await page.waitForFunction(() => JSON.stringify(window.__viz.merge) === '[0,2]');

    // A second control panel boots and picks up the live merge state
    const control2 = await context.newPage();
    await control2.goto(CONTROL_URL);
    await expect(control2.locator('#params-list input[data-key="mix"]')).toBeVisible();
    await expect(control2.locator('.pattern-btn[data-index="0"]')).toHaveClass(/merge-active/);
    await expect(control2.locator('.pattern-btn[data-index="2"]')).toHaveClass(/merge-active/);

    await control.keyboard.up('1');
    await control.keyboard.up('3');
  });

  test('number shortcuts still work while a param slider has focus', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Focus the first param slider (bass on Circles)
    const slider = control.locator('#params-list input[type="range"]').first();
    await slider.focus();
    await expect(slider).toBeFocused();

    // A single key press still switches effects
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.pattern === 2);

    // Two-key merge still works with the slider focused
    await control.keyboard.down('3');
    await control.keyboard.down('5');
    await page.waitForFunction(() => JSON.stringify(window.__viz.merge) === '[2,4]');
    await control.keyboard.up('5');
    await control.keyboard.up('3');
  });

  test('merging a WebGL shader effect with a 2D effect renders without errors', async ({ context, page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // '1' = Circles (2D), '5' = Character 3D (WEBGL) — index 4
    await control.keyboard.down('1');
    await control.keyboard.down('5');
    await page.waitForFunction(() => JSON.stringify(window.__viz.merge) === '[0,4]');

    await expect(page.locator('canvas.merge-canvas')).toHaveCount(2);
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);

    await control.keyboard.up('1');
    await control.keyboard.up('5');
  });
});
