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
  ['/docs/patterns.html', 'Patterns & Parameters', '/docs/interface.html', '/docs/custom-scripts.html'],
  ['/docs/custom-scripts.html', 'Custom Scripts', '/docs/patterns.html', '/docs/nodes.html'],
  ['/docs/nodes.html', 'Node Patterns', '/docs/custom-scripts.html', '/docs/media.html'],
  ['/docs/media.html', 'Media Patterns', '/docs/nodes.html', '/docs/slots.html'],
  ['/docs/slots.html', 'Slots & Shortcuts', '/docs/media.html', '/docs/blending.html'],
  ['/docs/blending.html', 'Blending Two Patterns', '/docs/slots.html', '/docs/post-processing.html'],
  ['/docs/post-processing.html', 'Post-processing', '/docs/blending.html', '/docs/eq-noise.html'],
  ['/docs/eq-noise.html', 'EQ & Noise', '/docs/post-processing.html', '/docs/cue-mode.html'],
  ['/docs/cue-mode.html', 'Cue Mode', '/docs/eq-noise.html', '/docs/screen-mapping.html'],
  ['/docs/screen-mapping.html', 'Screen Mapping', '/docs/cue-mode.html', '/docs/projection-mapping.html'],
  ['/docs/projection-mapping.html', 'Projection Mapping', '/docs/screen-mapping.html', '/docs/devices.html'],
  ['/docs/devices.html', 'Devices & Setup', '/docs/projection-mapping.html', '/docs/projects.html'],
  ['/docs/projects.html', 'Projects', '/docs/devices.html', '/docs/'],
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

      for (const [target] of GUIDE) await expect(page.locator(`.sidebar__nav a[href="${target}"]`)).toHaveCount(1);

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

// The two feature chapters after the projection chapters. Both are static pages, so
// this pins the operator-facing vocabulary (button names exactly as the app shows
// them) and the figures each page relies on; the guide loop above already proves
// every image decodes and that the sidebar/pager chain is complete.
test('Node Patterns guide documents the editor, its sources and its save path', async ({ page }) => {
  await page.goto('/docs/nodes.html');
  const article = page.locator('article');
  await expect(article.getByRole('heading', { name: 'Node Patterns', exact: true })).toHaveCount(1);
  for (const text of ['Link Folder', 'Edit Pattern', 'Back to Main', '+ Blend', '+ Color', '+ Script', '+ Audio', '+ MIDI', 'Learn CC', 'Enable MIDI', 'Ctrl+Enter', 'Connected signals', 'Mapping min', 'Remove mapping', 'Reload from Disk', '.nodes.json']) {
    await expect(article).toContainText(text);
  }
  await expect(article.locator('figure img')).toHaveCount(3);
  await expect(article.locator('.callout')).not.toHaveCount(0);
});

test('Projects guide documents save, open, relink and new project', async ({ page }) => {
  await page.goto('/docs/projects.html');
  const article = page.locator('article');
  await expect(article.getByRole('heading', { name: 'Projects', exact: true })).toHaveCount(1);
  for (const text of ['Save Project', 'Open Project', 'New Project', 'ahlookah-project-YYYY-MM-DD.json', 'Link Folder', 'Reconnect', 'Relink File', 'Unlink', 'IndexedDB']) {
    await expect(article).toContainText(text);
  }
  await expect(article.locator('figure img')).toHaveCount(3);
});

test('Custom Scripts reference and every complete example are inline with valid anchors', async ({ page, request }) => {
  await page.goto('/docs/custom-scripts.html');
  const article = page.locator('article');
  await expect(article).toContainText('Open Script');
  await expect(article).toContainText('Delete in Parameters');
  await expect(article).not.toContainText('Click Create script');
  await expect(article).not.toContainText('Delete file…');
  for (const heading of ['Synchronous registration API', 'Definition schema', 'Renderer context and cleanup', 'Audio controllers', 'Preferred reactive mapping (default)', 'Lifecycle, silence and compatibility', 'Reload, Delete and unlink']) {
    await expect(article.getByRole('heading', { name: heading, exact: true })).toHaveCount(1);
  }
  const blocks = await article.locator('pre code').allTextContents();
  const markdown = await (await request.get('/docs/custom-scripts-api.md')).text();
  for (const contract of ['optional ● image input', 'Source default', 'Camera default', 'generated sample clip, not real camera capture', 'runtime.inputMode']) {
    expect(markdown).toContain(contract);
  }
  expect(markdown).not.toContain('Add as FX');
  expect(markdown).not.toContain('choose **FX** in its inspector');
  for (const contract of ['createFeatureController()', 'response(value)', 'accent(value)', 'shared.getFeatures()', 'frame', 'within-band dB', 'No existing script must migrate']) {
    await expect(article).toContainText(contract);
    expect(markdown).toContain(contract);
  }
  for (const name of ['drawing', 'mesh', 'shader', 'audio', 'audio-advanced', 'image', 'video', 'camera', 'crud-lifecycle']) {
    const code = (await (await request.get(`/docs/custom-script-examples/${name}.viz.js`)).text()).trim();
    expect(blocks.map((text) => text.trim())).toContain(code);
    expect(markdown).toContain(code);
    await expect(article.getByRole('heading', { name: `${name}.viz.js`, exact: true })).toHaveCount(1);
  }
  const anchors = await article.locator('nav[aria-label="On this page"] a').evaluateAll((links) => links.map((a) => ({ href: a.getAttribute('href'), exists: !!document.getElementById(a.hash.slice(1)) })));
  expect(anchors.length).toBeGreaterThan(15);
  expect(anchors.every((a) => a.href.startsWith('#') && a.exists)).toBe(true);
  expect(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map((e) => e.id); return ids.length === new Set(ids).size; })).toBe(true);
});
