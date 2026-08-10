import { test, expect } from '@playwright/test';

const CONTROL_URL = '/?role=control';
const SCREEN_URL = '/?role=screen';

test.describe('singleton per-browser: one control + one screen', () => {
  test('second control direct-tab is blocked, first stays live, reload re-owns lease', async ({ context }) => {
    const first = await context.newPage();
    await first.goto(CONTROL_URL);
    await expect(first.locator('#config-panel')).toBeVisible();
    await expect(first.locator('#singleton-error')).toHaveCount(0);

    const second = await context.newPage();
    await second.goto(CONTROL_URL);
    await expect(second.locator('#singleton-error')).toBeVisible({ timeout: 7000 });
    await expect(second.locator('#singleton-error')).toContainText('Control Panel Already Open');
    await expect(second.locator('#singleton-error')).toContainText('direct URL');
    await expect(second.locator('#config-panel')).toHaveCount(0);
    await expect(second.locator('#preview-stage canvas')).toHaveCount(0);
    await expect(second.locator('body')).toHaveClass(/singleton-blocked/);

    // First remains fully functional
    await expect(first.locator('#config-panel')).toBeVisible();
    await first.locator('#pattern-pad [data-index="2"]').click();
    await expect(first.locator('#pattern-pad [data-index="2"]')).toHaveClass(/active/);

    // Control URL param variant also blocked (direct URL requirement)
    const third = await context.newPage();
    await third.goto('/?role=control');
    await expect(third.locator('#singleton-error')).toBeVisible();

    // Closing first frees singleton; second (same tab ID reloaded) can now boot
    await first.close();
    await second.reload();
    await expect(second.locator('#config-panel')).toBeVisible({ timeout: 7000 });
    await expect(second.locator('#singleton-error')).toHaveCount(0);
  });

  test('second screen direct-tab is blocked and does not render stage', async ({ context }) => {
    const screen = await context.newPage();
    await screen.goto(SCREEN_URL);
    await expect(screen.locator('body')).toHaveClass(/is-screen/);
    await expect(screen.locator('canvas')).toBeVisible();

    const secondScreen = await context.newPage();
    await secondScreen.goto(SCREEN_URL);
    await expect(secondScreen.locator('#singleton-error')).toBeVisible({ timeout: 7000 });
    await expect(secondScreen.locator('#singleton-error')).toContainText('Screen Already Open');
    await expect(secondScreen.locator('#singleton-error')).toContainText('direct URL');
    await expect(secondScreen.locator('#singleton-error')).toContainText('Close the other window');
    await expect(secondScreen.locator('canvas')).toHaveCount(0);
    await expect(secondScreen.locator('#screen-toolbar')).toHaveCount(0);
    await expect(secondScreen.locator('body')).toHaveClass(/singleton-blocked/);

    await screen.close();
    await secondScreen.reload();
    await expect(secondScreen.locator('body')).toHaveClass(/is-screen/, { timeout: 7000 });
    await expect(secondScreen.locator('canvas')).toBeVisible();
  });

  test('root URL is treated as control singleton (blocks second ?role=control)', async ({ context }) => {
    const root = await context.newPage();
    await root.goto('/');
    await expect(root.locator('body')).toHaveClass(/is-control/);
    await expect(root.locator('#config-panel')).toBeVisible();

    const second = await context.newPage();
    await second.goto(CONTROL_URL);
    await expect(second.locator('#singleton-error')).toBeVisible({ timeout: 7000 });
  });
});
