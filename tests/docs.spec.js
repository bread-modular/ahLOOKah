import { test, expect } from '@playwright/test';

const DOCS_TITLE = /ahLOOKah — Docs: Introduction/;

test.describe('docs static page', () => {
  test('/docs renders the docs page, not the app', async ({ page }) => {
    await page.goto('/docs');

    // The static docs title (the React app would set a different one).
    await expect(page).toHaveTitle(DOCS_TITLE);

    // Static HTML page — no React root and no control panel.
    await expect(page.locator('#root')).toHaveCount(0);
    await expect(page.locator('#config-panel')).toHaveCount(0);

    // The walkthrough video is embedded.
    const iframe = page.locator('.video-frame iframe');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('src', /UZ4wlbPm_kk/);
  });

  test('/docs/ and /docs/index.html serve the same docs page', async ({ page }) => {
    for (const url of ['/docs/', '/docs/index.html']) {
      await page.goto(url);
      await expect(page).toHaveTitle(DOCS_TITLE);
      await expect(page.locator('#config-panel')).toHaveCount(0);
      await expect(page.locator('.video-frame iframe')).toHaveAttribute('src', /UZ4wlbPm_kk/);
    }
  });

  test('docs page carries the shared OG image and links back to the app', async ({ page }) => {
    await page.goto('/docs');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /ahlookah-in-action\.png/);
    await expect(page.locator('a[href="/"]').first()).toBeVisible();
  });

  test('docs site has a sidebar that navigates to a sub-page', async ({ page }) => {
    await page.goto('/docs');

    // Sidebar navigation is present and marks the current page.
    const nav = page.locator('.sidebar__nav');
    await expect(nav.locator('a[href="/docs/getting-started.html"]')).toBeVisible();
    await expect(nav.locator('a.is-active')).toHaveAttribute('href', '/docs/');

    // Follow a sidebar link to a sub-page (static HTML, its own title + active state).
    await nav.locator('a[href="/docs/cue-mode.html"]').click();
    await expect(page).toHaveTitle(/ahLOOKah — Docs: Cue Mode/);
    await expect(page.locator('#root')).toHaveCount(0);
    await expect(page.locator('.sidebar__nav a.is-active')).toHaveAttribute('href', '/docs/cue-mode.html');
  });
});
