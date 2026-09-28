import { test, expect } from '@playwright/test';
import { folderDetails, folderAction } from './fixtures/folder-controls.js';

const categories = [
  { name: 'Custom Scripts', panel: '.custom-scripts-panel', folder: 'scripts' },
  { name: 'Node Patterns', panel: '.node-patterns-panel', folder: 'nodes' },
  { name: 'Media', panel: '.media-folder-panel', folder: 'media' },
];

async function seed(page) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const name of ['scripts', 'nodes', 'media']) await root.getDirectoryHandle(name, { create: true });
    window.showDirectoryPicker = async ({ id }) => root.getDirectoryHandle(id.includes('custom') ? 'scripts' : id.includes('node') ? 'nodes' : 'media');
  });
}

for (const category of categories) {
  test(`${category.name}: link, adjacent badge, keyboard details, restore and unlink @core`, async ({ page }) => {
    await page.goto('/'); await seed(page);
    const panel = page.locator(category.panel);
    await expect(panel.getByRole('button', { name: 'Link Folder', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
    const badge = page.getByRole('button', { name: `${category.name}: Linked`, exact: true });
    await expect(badge).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Link Folder', exact: true })).toHaveCount(0);
    const header = panel.locator('..');
    const title = await header.locator('.library-group-toggle').boundingBox();
    const bubble = await badge.boundingBox();
    expect(bubble.x - title.x - title.width).toBeLessThan(12);
    expect(Math.abs(bubble.y + bubble.height / 2 - title.y - title.height / 2)).toBeLessThan(3);
    await badge.focus(); await page.keyboard.press('Enter');
    const details = page.getByRole('dialog', { name: `${category.name} folder details` });
    await expect(details.locator('.folder-details-name')).toHaveText(category.folder);
    await expect(details).toContainText('source files');
    await page.keyboard.press('Escape'); await expect(badge).toBeFocused();
    await header.locator('.library-group-toggle').click();
    await expect(badge).toBeVisible(); // not hidden with category contents
    await page.reload(); await expect(badge).toBeVisible();
    await folderAction(page, category.name, 'Unlink folder');
    await expect(badge).toHaveCount(0);
    await page.reload(); await expect(panel.getByRole('button', { name: 'Link Folder', exact: true })).toBeVisible();
    expect(await page.evaluate(async name => !!await (await navigator.storage.getDirectory()).getDirectoryHandle(name), category.folder)).toBe(true);
  });

  test(`${category.name}: cancel, unsupported and denied picker leave library unchanged @core`, async ({ page }) => {
    await page.goto('/');
    const panel = page.locator(category.panel);
    await page.evaluate(() => { window.showDirectoryPicker = async () => { throw new DOMException('Canceled', 'AbortError'); }; });
    await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
    await expect(panel).toContainText('Canceled. Library unchanged.');
    // A missing picker is a capability, not a canceled pick: Link Folder opens the
    // support modal instead of running a link() that can only fail.
    await page.evaluate(() => { window.showDirectoryPicker = undefined; });
    await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
    const support = page.getByRole('dialog', { name: `${category.name} unavailable` });
    await expect(support).toContainText('Chrome, Edge, Chromium or Opera');
    await page.keyboard.press('Escape');
    await expect(support).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Link Folder', exact: true })).toBeFocused();
    await page.evaluate(() => { window.showDirectoryPicker = async () => ({ queryPermission: async () => 'prompt', requestPermission: async () => 'denied' }); });
    await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
    await expect(panel).toContainText('Permission denied');
    await expect(panel.getByRole('button', { name: /: Linked$/ })).toHaveCount(0);
    await seed(page);
    await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
    await expect(panel.getByRole('button', { name: /: Linked$/ })).toBeVisible();
    await page.evaluate(() => {
      window.originalPermission = FileSystemHandle.prototype.queryPermission;
      FileSystemHandle.prototype.queryPermission = async () => 'denied';
      FileSystemHandle.prototype.requestPermission = async () => 'denied';
    });
    const details = await folderDetails(page, category.name);
    await details.getByRole('button', { name: 'Refresh folder', exact: true }).click();
    await expect(details.getByRole('alert')).toContainText(/denied/i);
    await expect(details.locator('.folder-details-name')).toHaveText(category.folder);
    await page.evaluate(() => { FileSystemHandle.prototype.queryPermission = window.originalPermission; });
    await details.getByRole('button', { name: 'Refresh folder', exact: true }).click();
    // Scripts explicitly request permission when their saved status was denied.
    if (category.name === 'Custom Scripts') {
      await page.evaluate(() => { FileSystemHandle.prototype.requestPermission = async () => 'granted'; });
      await details.getByRole('button', { name: 'Refresh folder', exact: true }).click();
    }
    await expect(details.getByRole('alert')).toHaveCount(0);
    await details.getByRole('button', { name: 'Unlink folder', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Link Folder', exact: true })).toBeVisible();
  });
}

// A missing picker is either the browser's own default (Brave ships File System
// Access off) or a browser without it at all. Each branch is asserted to name the
// real cause in ONE short actionable line, with the guidance behind the notice's
// "How to fix" affordance (and behind Link Folder) instead of in a paragraph on
// screen. Only Brave gets a flag link, and a page cannot open a `brave://` URL, so
// copying is the action that works.
const capabilityCases = [
  {
    name: 'Brave with File System Access off names Brave and offers the copyable flag',
    init: () => {
      window.showDirectoryPicker = undefined;
      Object.defineProperty(navigator, 'brave', { configurable: true, value: { isBrave: () => true } });
    },
    includes: ['Brave blocks', 'Enable File System Access, then relaunch Brave.'],
    excludes: ['desktop Chrome', 'brave://flags/#file-system-access-api'],
    flag: 'brave://flags/#file-system-access-api',
  },
  {
    name: 'a non-Brave browser without the picker gets the supported-browser line',
    init: () => { window.showDirectoryPicker = undefined; },
    includes: ['Chrome, Edge, Chromium or Opera'],
    excludes: ['desktop Chrome', 'Brave', 'brave://flags/#file-system-access-api'],
  },
  {
    name: 'an insecure context reports HTTPS or localhost first, even in Brave',
    init: () => {
      window.showDirectoryPicker = undefined;
      Object.defineProperty(navigator, 'brave', { configurable: true, value: { isBrave: () => true } });
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    },
    includes: ['HTTPS or localhost'],
    excludes: ['desktop Chrome', 'brave://flags/#file-system-access-api', 'Brave'],
  },
];

for (const capability of capabilityCases) {
  test(`folder support notice: ${capability.name} @core`, async ({ page }) => {
    await page.addInitScript(capability.init);
    await page.goto('/');
    for (const category of categories) {
      const panel = page.locator(category.panel);
      const notice = panel.getByRole('alert');
      await expect(notice).toHaveCount(1);
      for (const text of capability.includes) await expect(notice).toContainText(text);
      for (const text of capability.excludes) await expect(notice).not.toContainText(text);
      // The notice itself is one line: the guidance is one click away, never on load.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const fix = notice.getByRole('button', { name: 'How to fix', exact: true });
      await expect(fix).toBeVisible();
      await fix.click();
      const support = page.getByRole('dialog', { name: `${category.name} unavailable` });
      await expect(support).toBeVisible();
      for (const text of capability.includes) await expect(support).toContainText(text);
      if (capability.flag) {
        await expect(support).toContainText(capability.flag);
        const link = support.getByRole('link', { name: 'Try to open', exact: true });
        await expect(link).toHaveAttribute('href', capability.flag);
        await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async text => { window.__copied = text; }; });
        await support.getByRole('button', { name: 'Copy link', exact: true }).click();
        await expect(support.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.__copied)).toBe(capability.flag);
        // The one best-effort link attempt must never replace the running app with a
        // refused brave:// load; the modal is still there afterwards.
        const beforeURL = page.url();
        await link.click();
        expect(page.url()).toBe(beforeURL);
        await expect(support).toBeVisible();
      } else {
        // No flag, no invented action: the message and Close are all there is.
        await expect(support.getByRole('link')).toHaveCount(0);
        await expect(support.getByRole('button', { name: /Copy/ })).toHaveCount(0);
      }
      // Escape closes it and focus goes back to the affordance that opened it.
      await page.keyboard.press('Escape');
      await expect(support).toHaveCount(0);
      await expect(fix).toBeFocused();
      // Link Folder explains the same cause instead of failing on a dead picker.
      await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
      const fromLink = page.getByRole('dialog', { name: `${category.name} unavailable` });
      await expect(fromLink).toBeVisible();
      await fromLink.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(fromLink).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'Link Folder', exact: true })).toBeFocused();
    }
  });
}

test('folder support notice: a supported browser shows none and links normally @core', async ({ page }) => {
  await page.goto('/'); await seed(page);
  for (const category of categories) {
    const panel = page.locator(category.panel);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
    await expect(page.getByRole('button', { name: `${category.name}: Linked`, exact: true })).toBeVisible();
  }
});

test('Scripts: no create control, explicit trusted open, untouched source and restore @core', async ({ page }) => {
  await page.goto('/'); await seed(page);
  const panel = page.locator('.custom-scripts-panel');
  // Only Open exists: scripts are authored in an external editor, never created here.
  await expect(panel.getByRole('button', { name: 'Open Script', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
  await expect(panel.locator('.library-add-btn')).toHaveText(['OPEN']);
  await expect(panel.getByRole('button', { name: 'Open Script', exact: true })).toBeEnabled();
  const before = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts');
    const handle = await dir.getFileHandle('starter.viz.js', { create: true });
    const text = "api.requireVersion(1); api.create({ id: 'custom-starter', name: 'Starter', draw({ p }) { p.background(24); } });";
    const writer = await handle.createWritable(); await writer.write(text); await writer.close();
    return text;
  });
  await expect(page.locator('.library-btn[data-id^="custom-"]')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Open Script', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Open Script', exact: true });
  await picker.getByLabel('Script in scripts', { exact: true }).selectOption('starter.viz.js');
  await picker.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.library-btn[data-id^="custom-"]')).toHaveCount(1);
  await page.reload(); await expect(page.locator('.library-btn[data-id^="custom-"]')).toHaveCount(1);
  const read = () => page.evaluate(async () => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts')).getFileHandle('starter.viz.js')).getFile()).text());
  expect(await read()).toBe(before);
});

async function seedMedia(page) {
  await seed(page);
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('media');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 8, 8);
    const png = await new Promise(resolve => canvas.toBlob(resolve));
    for (const [name, data] of [['red.PNG', png], ['green.webm', await (await fetch('/tests/fixtures/green.webm')).blob()], ['ignore.txt', 'ignored'], ['ignore.mp3', 'ignored']]) {
      const writer = await (await dir.getFileHandle(name, { create: true })).createWritable(); await writer.write(data); await writer.close();
    }
    await dir.getDirectoryHandle('nested.png', { create: true });
    window.showOpenFilePicker = async () => [await dir.getFileHandle('red.PNG')];
  });
}

test('Media: explicit ADD only, disk playback, refresh dedup, persistence and unlink @core', async ({ page, context }) => {
  await page.goto('/'); await seedMedia(page);
  const panel = page.locator('.media-folder-panel');
  const add = panel.getByRole('button', { name: 'Add media', exact: true });
  // ADD has no unlinked path any more: a media pattern is a reference into the
  // linked folder, so the control waits for one.
  await expect(add).toBeDisabled();
  await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
  await expect(add).toBeEnabled();
  const media = page.locator('.library-btn[data-id^="media-"]');
  // Linking grants access; it never loads the directory.
  await expect(media).toHaveCount(0);
  const addFromFolder = async name => {
    await add.click();
    const picker = page.getByRole('dialog', { name: 'Open Media', exact: true });
    await picker.getByRole('combobox').selectOption(name);
    await picker.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(picker).toHaveCount(0);
  };
  // ADD is the only path that turns a file in the linked folder into a pattern; the
  // picker never offers audio, text or subfolders.
  await addFromFolder('red.PNG');
  await expect(media).toHaveCount(1);
  await addFromFolder('green.webm');
  await expect(media).toHaveCount(2);
  const ids = await media.evaluateAll(elements => elements.map(el => el.dataset.id).sort());
  await folderAction(page, 'Media', 'Refresh folder'); await expect(media).toHaveCount(2);
  await page.reload(); await expect(media).toHaveCount(2);
  expect(await media.evaluateAll(elements => elements.map(el => el.dataset.id).sort())).toEqual(ids);
  const pixels = channel => page.evaluate(channel => {
    const canvas = document.querySelector('#preview-stage canvas');
    if (!canvas) return false;
    const d = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
    return d[channel] > 90 && d[channel === 0 ? 1 : 0] < 30;
  }, channel);
  await media.filter({ hasText: 'red' }).click(); await expect.poll(() => pixels(0)).toBe(true);
  await media.filter({ hasText: 'green' }).click(); await expect.poll(() => pixels(1)).toBe(true);
  // Observe link/unlink changes from a separate tab without taking over control.
  const other = await context.newPage(); await other.goto('/tests/fixtures/render.html');
  await other.evaluate(async () => {
    const { MediaFolder } = await import('/src/media/folderService.js');
    window.observer = new MediaFolder({ onStatus: status => { window.linkStatus = status; } }); await window.observer.start();
  });
  await expect.poll(() => other.evaluate(() => window.linkStatus.folder)).toBe('media');
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('media');
    const writer = await (await dir.getFileHandle('new.png', { create: true })).createWritable();
    await writer.write(await (await dir.getFileHandle('red.PNG')).getFile()); await writer.close();
  });
  // A file dropped into the folder outside the app stays out of the library: a
  // refresh re-reads what is loaded, it does not adopt the directory.
  await folderAction(page, 'Media', 'Refresh folder'); await expect(media).toHaveCount(2);
  await addFromFolder('new.png'); await expect(media).toHaveCount(3);
  await folderAction(page, 'Media', 'Unlink folder');
  await expect.poll(() => other.evaluate(() => window.linkStatus.folder)).toBe('');
  await expect(media).toHaveCount(3); // unlink deliberately retains loaded file references
  await page.reload(); await expect(media).toHaveCount(3);
  await expect(panel.getByRole('button', { name: 'Link Folder', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Add media', exact: true })).toBeDisabled();
  await seedMedia(page);
  await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
  // Relinking is not an importer: the library still holds the three patterns the
  // operator added, and re-adding a file it already references is a duplicate.
  await expect(media).toHaveCount(3);
  await addFromFolder('green.webm');
  await expect(media).toHaveCount(3);
  await other.close();
});

// Media ADD mirrors Node Patterns: a new pattern is a reference into the linked
// folder, so the control waits for that link and offers no native picker or
// <input type="file"> in the meantime.
test('Media ADD is disabled until a folder is linked, then opens the linked picker @core', async ({ page }) => {
  await page.goto('/'); await seedMedia(page);
  const panel = page.locator('.media-folder-panel');
  const add = panel.getByRole('button', { name: 'Add media', exact: true });
  await expect(add).toBeDisabled();
  await expect(add).toHaveAttribute('title', 'Link Folder before adding media');
  await expect(panel).toContainText('Link Folder before adding media.');
  await expect(panel.locator('.media-file-input')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
  await expect(add).toBeEnabled();
  await expect(add).toHaveAttribute('title', 'Add media from the linked folder');
  await expect(panel).not.toContainText('Link Folder before adding media.');
  await add.click();
  const picker = page.getByRole('dialog', { name: 'Open Media', exact: true });
  await expect(picker.locator('option')).toHaveText(['Select a file…', 'green.webm', 'red.PNG']);
  await picker.getByRole('combobox').selectOption('red.PNG');
  await picker.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.library-btn[data-id^="media-"]')).toHaveCount(1);
});

test('Media backend: no background permission prompts, storage rollback and picker scan limit @core', async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { MediaFolder } = await import('/src/media/folderService.js');
    let requests = 0, calls = 0, fail = false;
    const folder = { name: 'held', queryPermission: async () => 'prompt', requestPermission: async () => { requests++; return 'denied'; } };
    let saved = folder;
    const service = new MediaFolder({ storage: async (...args) => {
      if (args.length > 1) { if (fail) throw Error('storage full'); saved = args[1]; }
      return saved;
    }, onFiles: async () => calls++ });
    await service.start();
    const background = { requests, calls, permission: service.status.permission };
    let denied; try { await service.refresh(); } catch (e) { denied = e.message; }
    window.showDirectoryPicker = async () => ({ name: 'replacement', queryPermission: async () => 'granted', async *entries() {} });
    fail = true; let storageError; try { await service.link(); } catch (e) { storageError = e.message; }
    const retained = service.status.folder;
    fail = false;
    // A directory larger than the picker cap is still linkable (nothing is loaded);
    // only the ADD/OPEN picker is bounded, because it has to list every file.
    window.showDirectoryPicker = async () => ({ name: 'large', queryPermission: async () => 'granted', async *entries() { for (let i = 0; i < 257; i++) yield [`${i}.png`, { kind: 'file' }]; } });
    let linked = 'ok'; try { await service.link(); } catch (e) { linked = e.message; }
    let limit; try { await service.browse(); } catch (e) { limit = e.message; }
    service.close(); return { background, denied, storageError, retained, linked, limit, calls };
  });
  expect(result.background).toEqual({ requests: 0, calls: 0, permission: 'prompt' });
  expect(result.denied).toContain('Permission denied'); expect(result.storageError).toBe('storage full');
  expect(result.retained).toBe('held'); expect(result.linked).toBe('ok');
  expect(result.limit).toContain('maximum 256'); expect(result.calls).toBe(0);
});

test('Folder headers visual verification @core', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/'); await seedMedia(page);
  await expect(page.locator('.library-group-toggle').first()).toBeVisible();
  // Collapse unrelated categories through their normal controls to frame the three headers.
  for (const toggle of await page.locator('.library-group-toggle').all()) {
    const name = (await toggle.textContent()).trim();
    if (!categories.some(c => c.name === name) && await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
  }
  await page.locator('.custom-scripts-panel').getByRole('button', { name: 'Link Folder', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/folder-unlinked.png' });
  for (const category of categories) await page.locator(category.panel).getByRole('button', { name: 'Link Folder', exact: true }).click();
  // Linking loads nothing: one media pattern is added explicitly so the linked
  // headers are captured with a populated library.
  const mediaPanel = page.locator('.media-folder-panel');
  await mediaPanel.getByRole('button', { name: 'Add media', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Open Media', exact: true });
  await picker.getByRole('combobox').selectOption('red.PNG');
  await picker.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.library-btn[data-id^="media-"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add media', exact: true })).toBeEnabled();
  await page.screenshot({ path: '/tmp/folder-linked.png' });
  await folderDetails(page, 'Media'); await page.screenshot({ path: '/tmp/folder-details.png' });
});
