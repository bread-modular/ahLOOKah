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
