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
    await page.evaluate(() => { window.showDirectoryPicker = undefined; });
    await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
    await expect(panel).toContainText('File System Access');
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

test('Media: filtered folder scan, disk playback, refresh dedup, persistence, individual open and unlink @core', async ({ page, context }) => {
  await page.goto('/'); await seedMedia(page);
  const panel = page.locator('.media-folder-panel');
  await panel.getByRole('button', { name: 'Add media', exact: true }).click();
  await expect(page.locator('.library-btn[data-id^="media-"]')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
  const media = page.locator('.library-btn[data-id^="media-"]');
  await expect(media).toHaveCount(2); // ignores audio, text, subfolders and existing individual handle
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
  await folderAction(page, 'Media', 'Refresh folder'); await expect(media).toHaveCount(3);
  await folderAction(page, 'Media', 'Unlink folder');
  await expect.poll(() => other.evaluate(() => window.linkStatus.folder)).toBe('');
  await expect(media).toHaveCount(3); // unlink deliberately retains loaded file references
  await page.reload(); await expect(media).toHaveCount(3);
  await expect(panel.getByRole('button', { name: 'Link Folder', exact: true })).toBeVisible();
  await seedMedia(page);
  await panel.getByRole('button', { name: 'Add media', exact: true }).click();
  await expect(media).toHaveCount(4); // ADD covers both the folder picker and standalone files
  await other.close();
});

test('Media backend: no background permission prompts, storage rollback and scan limit @core', async ({ page }) => {
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
    window.showDirectoryPicker = async () => ({ name: 'large', queryPermission: async () => 'granted', async *entries() { for (let i = 0; i < 257; i++) yield [`${i}.png`, { kind: 'file' }]; } });
    let limit; try { await service.link(); } catch (e) { limit = e.message; }
    service.close(); return { background, denied, storageError, retained, limit, calls };
  });
  expect(result.background).toEqual({ requests: 0, calls: 0, permission: 'prompt' });
  expect(result.denied).toContain('Permission denied'); expect(result.storageError).toBe('storage full');
  expect(result.retained).toBe('held'); expect(result.limit).toContain('maximum 256'); expect(result.calls).toBe(0);
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
  await expect(page.locator('.library-btn[data-id^="media-"]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Add media', exact: true })).toBeEnabled();
  await page.screenshot({ path: '/tmp/folder-linked.png' });
  await folderDetails(page, 'Media'); await page.screenshot({ path: '/tmp/folder-details.png' });
});
