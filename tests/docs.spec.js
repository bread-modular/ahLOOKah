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

// The guide is a linear chain of static pages: every page carries the same
// sidebar, marks only itself active, and (except the first/last) links to its
// neighbours in the pager. Screenshots are asserted to actually load so a
// renamed/removed shot fails the suite instead of shipping a broken figure.
const GUIDE = [
  ['/docs/', 'Introduction', null, null],
  ['/docs/getting-started.html', 'Getting Started', '/docs/', '/docs/interface.html'],
  ['/docs/interface.html', 'The Interface', '/docs/getting-started.html', '/docs/patterns.html'],
  ['/docs/patterns.html', 'Patterns & Parameters', '/docs/interface.html', '/docs/media.html'],
  ['/docs/media.html', 'Media Patterns', '/docs/patterns.html', '/docs/slots.html'],
  ['/docs/slots.html', 'Slots & Shortcuts', '/docs/media.html', '/docs/blending.html'],
  ['/docs/blending.html', 'Blending Two Patterns', '/docs/slots.html', '/docs/post-processing.html'],
  ['/docs/post-processing.html', 'Post-processing', '/docs/blending.html', '/docs/eq-noise.html'],
  ['/docs/eq-noise.html', 'EQ & Noise', '/docs/post-processing.html', '/docs/cue-mode.html'],
  ['/docs/cue-mode.html', 'Cue Mode', '/docs/eq-noise.html', '/docs/screen-mapping.html'],
  ['/docs/screen-mapping.html', 'Screen Mapping', '/docs/cue-mode.html', '/docs/projection-mapping.html'],
  ['/docs/projection-mapping.html', 'Projection Mapping', '/docs/screen-mapping.html', '/docs/devices.html'],
  ['/docs/devices.html', 'Devices & Setup', '/docs/projection-mapping.html', '/docs/'],
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('docs guide navigation', () => {
  for (const [url, title, prev, next] of GUIDE) {
    test(`${url} is the ${title} page in the chain`, async ({ page }) => {
      await page.goto(url);

      await expect(page).toHaveTitle(new RegExp(`ahLOOKah — Docs: ${escapeRegExp(title)}$`));
      await expect(page.locator('#root')).toHaveCount(0);

      // The sidebar lists the whole guide and marks exactly this page active.
      await expect(page.locator('.sidebar__nav a')).toHaveCount(GUIDE.length);
      await expect(page.locator('.sidebar__nav a.is-active')).toHaveAttribute('href', url);
      await expect(page.locator('.sidebar__nav a.is-active')).toHaveAttribute('aria-current', 'page');

      const pager = page.locator('.pager');
      if (next) {
        if (prev) await expect(pager.locator(`a[href="${prev}"]`)).toBeVisible();
        await expect(pager.locator('.next')).toHaveAttribute('href', next);
      } else {
        // The Introduction is the only page with no prev/next footer.
        await expect(pager).toHaveCount(0);
      }

      // Every figure's screenshot exists and decodes.
      const images = page.locator('.article img');
      for (let i = 0; i < await images.count(); i += 1) {
        const image = images.nth(i);
        await expect(image).toHaveJSProperty('complete', true);
        expect(await image.evaluate((node) => node.naturalWidth)).toBeGreaterThan(0);
      }
    });
  }
});
