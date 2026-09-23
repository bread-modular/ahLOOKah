import { test, expect } from '@playwright/test';

// Second-pass regressions: real OPFS handles and real IDB transactions, with a
// fault only at the named operation (not a replacement storage implementation).
test.beforeEach(async ({ context, page }) => {
  await context.addInitScript(() => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
  });
  await page.goto('/?role=nodes');
  await expect(page.getByLabel('Graph name')).toBeVisible();
});

for (const fault of ['quota', 'abort']) test(`F04: media handle relink ${fault} must fail import and restore the old project @core`, async ({ page }) => {
  const result = await page.evaluate(async fault => {
    const { applySettings } = await import('/src/platform/settings-portability.js');
    const { ensureProjectFolder } = await import('/src/platform/project-folders.js');
    const { putMediaRecord, listMediaRecords } = await import('/src/media/media-store.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('incoming-media', { create: true });
    await dir.getFileHandle('image.png', { create: true });
    const { id } = await ensureProjectFolder('media', dir);
    await putMediaRecord({ id: 'old', name: 'Old', kind: 'image', file: new File(['old bytes'], 'old.png') });
    const key = 'viz2_screen_mapping_edge_blur';
    localStorage.setItem(key, 'old');
    const refs = Object.fromEntries(['scripts', 'nodes', 'media'].map(section => [section, { folderName: null, folderId: null, files: [] }]));
    refs.media = { folderName: dir.name, folderId: id, files: [{ id: 'incoming', fileName: 'image.png', linked: true }] };
    const beforeIds = localStorage.getItem('viz2_project_folders');
    const native = IDBObjectStore.prototype.put;
    let injected = 0;
    IDBObjectStore.prototype.put = function (record, ...args) {
      if (this.transaction.db.name === 'viz2_media' && record.id === 'incoming' && record.handle && !injected++) {
        if (fault === 'quota') throw new DOMException('relink quota', 'QuotaExceededError');
        const request = native.call(this, record, ...args);
        request.addEventListener('success', () => this.transaction.abort(), { once: true });
        return request;
      }
      return native.call(this, record, ...args);
    };
    let summary, error;
    try {
      summary = await applySettings({ storage: { [key]: 'new' }, folders: refs,
        media: [{ id: 'incoming', name: 'Incoming', kind: 'image', fileName: 'image.png', folderName: dir.name }] });
    } catch (e) { error = { message: e.message, rollbackFailures: e.rollbackFailures }; }
    finally { IDBObjectStore.prototype.put = native; }
    return { injected, summary, error, setting: localStorage.getItem(key),
      identitiesRestored: beforeIds === localStorage.getItem('viz2_project_folders'),
      media: await Promise.all((await listMediaRecords()).map(async r => ({ id: r.id, handle: !!r.handle, bytes: r.blob ? await r.blob.text() : null }))) };
  }, fault);
  expect(result.injected).toBe(1);
  expect(result.error?.message, JSON.stringify(result)).toContain('Project storage failed');
  expect(result.error.rollbackFailures).toEqual([]);
  expect(result.summary).toBeUndefined();
  expect(result.setting).toBe('old');
  expect(result.identitiesRestored).toBe(true);
  expect(result.media).toEqual([{ id: 'old', handle: false, bytes: 'old bytes' }]);
  await page.reload();
  expect(await page.evaluate(async () => (await (await import('/src/media/media-store.js')).listMediaRecords()).map(r => r.id))).toEqual(['old']);
});

test('F04: a failed remembered-folder read is a storage failure, not a missing-directory import @core', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { applySettings } = await import('/src/platform/settings-portability.js');
    const { ensureProjectFolder } = await import('/src/platform/project-folders.js');
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('known-nodes', { create: true });
    const { id } = await ensureProjectFolder('nodes', folder);
    const key = 'viz2_screen_mapping_edge_blur';
    localStorage.setItem(key, 'old');
    const folders = Object.fromEntries(['scripts', 'nodes', 'media'].map(section => [section, { folderName: null, folderId: null, files: [] }]));
    folders.nodes = { folderName: folder.name, folderId: id, files: [] };
    const before = localStorage.getItem('viz2_project_folders');
    const native = IDBObjectStore.prototype.get;
    let injected = false;
    IDBObjectStore.prototype.get = function (key) {
      if (this.transaction.db.name === 'viz2-project-folders' && key === id) {
        injected = true; throw new DOMException('registry unavailable', 'UnknownError');
      }
      return native.call(this, key);
    };
    let error, summary;
    try { summary = await applySettings({ storage: { [key]: 'new' }, media: [], folders }); }
    catch (e) { error = { message: e.message, rollbackFailures: e.rollbackFailures }; }
    finally { IDBObjectStore.prototype.get = native; }
    return { error, summary, injected, setting: localStorage.getItem(key), ids: localStorage.getItem('viz2_project_folders'), before };
  });
  expect(result.injected).toBe(true);
  expect(result.error?.message, JSON.stringify(result)).toContain('registry unavailable');
  expect(result.error.rollbackFailures).toEqual([]);
  expect(result.summary).toBeUndefined();
  expect(result.setting).toBe('old');
  expect(result.ids).toBe(result.before);
});

test('F03: media from a different same-named directory is not adopted by filename on project reopen @core', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { collectSettings, applySettings } = await import('/src/platform/settings-portability.js');
    const { relinkImportedMedia } = await import('/src/platform/folder-portability.js');
    const { createHandleStorage } = await import('/src/platform/handleStorage.js');
    const { ensureProjectFolder } = await import('/src/platform/project-folders.js');
    const { putMediaRecord, listMediaRecords } = await import('/src/media/media-store.js');
    const root = await navigator.storage.getDirectory();
    const folders = [];
    for (const parent of ['a', 'b']) {
      const dir = await (await root.getDirectoryHandle(parent, { create: true })).getDirectoryHandle('media', { create: true });
      const file = await dir.getFileHandle('same.png', { create: true });
      const writer = await file.createWritable(); await writer.write(parent); await writer.close();
      folders.push({ dir, file });
    }
    await createHandleStorage('viz2-media-folder')('folder', folders[0].dir);
    await ensureProjectFolder('media', folders[0].dir);
    await putMediaRecord({ id: 'external', name: 'External B', kind: 'image', folderName: 'media', handle: folders[1].file });
    const project = await collectSettings();
    const summary = await applySettings(project);
    const afterOpen = (await listMediaRecords()).map(r => ({ id: r.id, handle: !!r.handle }));
    const relinked = await relinkImportedMedia(folders[0].dir);
    return { exported: project.folders.media.files, unlinked: summary.unlinkedMedia, afterOpen, relinked,
      afterRelink: (await listMediaRecords()).map(r => ({ id: r.id, handle: !!r.handle })) };
  });
  expect(result.exported).toEqual([{ id: 'external', fileName: 'same.png', linked: false }]);
  expect(result.unlinked).toEqual(['External B']);
  expect(result.afterOpen).toEqual([{ id: 'external', handle: false }]);
  expect(result.relinked).toBe(0);
  expect(result.afterRelink).toEqual(result.afterOpen);
  // The real control service scans the linked folder on startup. Its separate
  // onFiles path must also keep B unlinked instead of silently assigning A.
  await page.goto('/?role=control');
  await expect(page.locator('#config-panel')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const records = await (await import('/src/media/media-store.js')).listMediaRecords();
    return { external: records.find(r => r.id === 'external')?.handle === null,
      importedA: records.some(r => r.id !== 'external' && !!r.handle) };
  })).toEqual({ external: true, importedA: true });
});

test('F04: a late media IDB failure is visible in Open UI and never broadcasts success @core', async ({ page }) => {
  await page.goto('/?role=control');
  await expect(page.locator('#config-panel')).toBeVisible();
  const payload = await page.evaluate(async () => {
    const { ensureProjectFolder } = await import('/src/platform/project-folders.js');
    const { putMediaRecord } = await import('/src/media/media-store.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('ui-media', { create: true });
    await dir.getFileHandle('incoming.png', { create: true });
    const { id } = await ensureProjectFolder('media', dir);
    await putMediaRecord({ id: 'old', name: 'Old', kind: 'image', file: new File(['old'], 'old.png') });
    localStorage.setItem('viz2_screen_mapping_edge_blur', 'old');
    const folders = Object.fromEntries(['scripts', 'nodes', 'media'].map(section => [section, { folderName: null, folderId: null, files: [] }]));
    folders.media = { folderName: dir.name, folderId: id, files: [{ id: 'incoming', fileName: 'incoming.png', linked: true }] };
    const put = IDBObjectStore.prototype.put, post = BroadcastChannel.prototype.postMessage;
    window.__successMessages = 0;
    window.__restoreFault = () => { IDBObjectStore.prototype.put = put; BroadcastChannel.prototype.postMessage = post; };
    IDBObjectStore.prototype.put = function (record, ...args) {
      if (this.transaction.db.name === 'viz2_media' && record.id === 'incoming' && record.handle) throw new DOMException('late UI relink quota', 'QuotaExceededError');
      return put.call(this, record, ...args);
    };
    BroadcastChannel.prototype.postMessage = function (message) {
      if (message?.type === 'settings-imported') window.__successMessages++;
      return post.call(this, message);
    };
    return { app: 'ahlookah', kind: 'ahlookah-project', version: 2, storage: { viz2_screen_mapping_edge_blur: 'new' }, folders,
      media: [{ id: 'incoming', name: 'Incoming', kind: 'image', folderName: dir.name, fileName: 'incoming.png' }] };
  });
  try {
    await page.locator('#app-menu-btn').click();
    await page.locator('#project-open-input').setInputFiles({ name: 'late-failure.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
    await expect(page.locator('#notice-modal')).toContainText('Open Project failed');
    await expect(page.locator('#notice-modal')).toContainText('late UI relink quota');
    await expect(page.locator('#notice-modal-reload')).toHaveCount(0);
    expect(await page.evaluate(() => window.__successMessages)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('viz2_screen_mapping_edge_blur'))).toBe('old');
    expect(await page.evaluate(async () => (await (await import('/src/media/media-store.js')).listMediaRecords()).map(r => r.id))).toEqual(['old']);
  } finally { await page.evaluate(() => window.__restoreFault()); }
});
