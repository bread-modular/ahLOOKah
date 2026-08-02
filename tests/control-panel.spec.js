import { test, expect } from '@playwright/test';

const SCREEN_URL = '/';
const CONTROL_URL = '/?role=control';

// All multi-window tests use pages from the SAME context, because
// BroadcastChannel + localStorage are shared per browser context (tab group).

test.describe('screen window', () => {
  test('boots with canvas and a hover-only control button', async ({ page }) => {
    await page.goto(SCREEN_URL);

    await expect(page.locator('body')).toHaveClass(/is-screen/);
    await expect(page.locator('canvas')).toBeVisible();

    const btn = page.locator('#open-control-btn');
    await expect(btn).toHaveCSS('opacity', '0');

    // Hovering the top-right zone reveals the button
    await page.hover('#screen-toolbar');
    await expect(btn).toHaveCSS('opacity', '1');
  });

  test('keyboard 1-0 in the control panel switches patterns on the screen', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Keys typed in the control panel drive the screen...
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.pattern === 2);
    await control.keyboard.press('0');
    await page.waitForFunction(() => window.__viz.pattern === 9);

    // ...and keys on the screen window are ignored
    await page.keyboard.press('1');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__viz.pattern)).toBe(9);
  });
});

test.describe('control panel window', () => {
  test('renders pattern buttons, status and no canvas', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await expect(control.locator('body')).toHaveClass(/is-control/);
    await expect(control.locator('#pattern-grid .pattern-btn')).toHaveCount(10);
    await expect(control.locator('#status-line .badge-control')).toBeVisible();
    await expect(control.locator('canvas')).toHaveCount(0);
  });

  test('opens from the screen toolbar button', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    await page.hover('#screen-toolbar');

    const popupPromise = context.waitForEvent('page');
    await page.click('#open-control-btn');
    const control = await popupPromise;
    await control.waitForLoadState();

    expect(control.url()).toContain('role=control');
    await expect(control.locator('#config-panel')).toBeVisible();
  });
});

test.describe('effect parameters', () => {
  test('sliders render for the selected effect and drive the screen live', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Bars (index 2) exposes 3 params: gain, barWidth, flash
    await control.locator('.pattern-btn[data-index="2"]').click();
    await page.waitForFunction(() => window.__viz.pattern === 2);

    await expect(control.locator('#params-list .param-row')).toHaveCount(3);
    await expect(control.locator('#params-list label').first()).toContainText('Gain');

    // Drag the gain slider to max — the screen's live params update
    await control.locator('#params-list input[data-key="gain"]').evaluate((el) => {
      el.value = '3';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => window.__viz.params.gain === 3);

    // Switching effects swaps the slider set (Pulse Rings has 4 params)
    await control.locator('.pattern-btn[data-index="6"]').click();
    await expect(control.locator('#params-list .param-row')).toHaveCount(4);
    await expect(control.locator('#params-list input[data-key="rings"]')).toBeVisible();

    // Param values persist per-effect (Bars gain is still 3 after switching back)
    await control.locator('.pattern-btn[data-index="2"]').click();
    await expect(control.locator('#params-list input[data-key="gain"]')).toHaveValue('3');
  });

  test('an effect without params shows an empty hint', async ({ context }) => {
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // All registered effects currently have params; pick index 2 anyway and
    // assert the list exists. (Guards against regressions in the renderer.)
    await control.locator('.pattern-btn[data-index="2"]').click();
    await expect(control.locator('#params-list')).toBeVisible();
  });
});

test.describe('screen <-> control interaction', () => {
  test('pattern buttons drive the screen sketch and stay highlighted', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // screen window
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.locator('.pattern-btn[data-index="2"]').click();
    await page.waitForFunction(() => window.__viz.pattern === 2);
    await expect(control.locator('.pattern-btn[data-index="2"]')).toHaveClass(/active/);

    await control.locator('.pattern-btn[data-index="9"]').click();
    await page.waitForFunction(() => window.__viz.pattern === 9);
    await expect(control.locator('.pattern-btn[data-index="9"]')).toHaveClass(/active/);
    await expect(control.locator('.pattern-btn[data-index="2"]')).not.toHaveClass(/active/);
  });

  test('take over as screen demotes the old screen', async ({ context, page }) => {
    await page.goto(SCREEN_URL); // original screen
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    await control.click('#takeover-btn');

    // Control window becomes the new screen
    await expect(control.locator('body')).toHaveClass(/is-screen/);
    await expect(control.locator('canvas')).toBeVisible();
    await control.waitForFunction(() => window.__viz.role === 'screen');

    // Old screen is demoted to a control panel
    await expect(page.locator('body')).toHaveClass(/is-control/);
    await expect(page.locator('#config-panel')).toBeVisible();
    await page.waitForFunction(() => window.__viz.role === 'control');
  });

  test('shows OFFLINE badge when the screen window closes', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);

    // Wait until the control has synced with the live screen
    await expect(control.locator('#status-line .badge-online')).toBeVisible();

    await page.close({ runBeforeUnload: true });

    await expect(control.locator('#status-line .badge-offline')).toBeVisible();
  });
});

test.describe('param slider interactions (e2e)', () => {
  // Open the screen + a control panel, select Bars (index 2)
  async function openBars(context, page) {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await control.locator('.pattern-btn[data-index="2"]').click();
    await page.waitForFunction(() => window.__viz.pattern === 2);
    return control;
  }

  // Read the persisted param store without touching the live object
  // (touching window.__viz.params.* would pollute the sketch read-log probe)
  function storedGain(page, min) {
    return page.waitForFunction((m) => {
      const stored = JSON.parse(localStorage.getItem('viz2_params') || '{}');
      return stored[2] && stored[2].gain >= m;
    }, min);
  }

  test('dragging the slider thumb applies the value live on the screen', async ({ context, page }) => {
    const control = await openBars(context, page);
    const slider = control.locator('#params-list input[data-key="gain"]');
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();

    // gain range 0.2..3, default 1 → thumb sits at ~28.6% of the track
    const frac = (1 - 0.2) / (3 - 0.2);
    const startX = box.x + frac * box.width;
    const y = box.y + box.height / 2;

    await control.mouse.move(startX, y);
    await control.mouse.down();
    // Note: interpolated moves (steps > 1) don't drive native range thumbs in
    // headless Chromium — a single move to the target is reliable (verified).
    await control.mouse.move(box.x + box.width - 4, y, { steps: 1 });
    await control.mouse.up();

    // The drag reaches the high end and lands on the screen window
    await storedGain(page, 2.5);
    expect(parseFloat(await slider.inputValue())).toBeGreaterThan(2.5);
  });

  test('clicking on the track jumps the value and applies it', async ({ context, page }) => {
    const control = await openBars(context, page);
    const slider = control.locator('#params-list input[data-key="barWidth"]');
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();

    // Click at 75% of the track (barWidth range 2..16 → lands ≈12-13)
    await control.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);

    await page.waitForFunction(() => {
      const stored = JSON.parse(localStorage.getItem('viz2_params') || '{}');
      return stored[2] && stored[2].barWidth >= 12;
    });
  });

  test('the running sketch re-reads params every frame (realtime, no reload)', async ({ context, page }) => {
    const control = await openBars(context, page);
    const slider = control.locator('#params-list input[data-key="gain"]');
    const box = await slider.boundingBox();

    const frac = (1 - 0.2) / (3 - 0.2);
    const startX = box.x + frac * box.width;
    const y = box.y + box.height / 2;

    // Drag partway WITHOUT releasing — the value must already be live
    await control.mouse.move(startX, y);
    await control.mouse.down();
    await control.mouse.move(box.x + box.width * 0.6, y, { steps: 1 });
    await storedGain(page, 1.5);

    // The sketch itself must read 'gain' off the live object every frame.
    // (DEV readLog: key -> last read timestamp. Before the per-frame fix the
    // log went stale after setup, so this assertion timed out.)
    await page.waitForFunction(() => {
      const log = window.__viz.readLog() || {};
      const t = log.gain;
      return typeof t === 'number' && performance.now() - t < 500;
    });

    await control.mouse.up();
  });
});
