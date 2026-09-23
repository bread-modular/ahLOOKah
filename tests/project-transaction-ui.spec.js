import { test, expect } from '@playwright/test';

const upload = (page, payload) => page.locator('#project-open-input').setInputFiles({
  name: 'fault-project.json', mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify({ app: 'ahlookah', kind: 'ahlookah-project', version: 2, storage: {}, media: [], ...payload })),
});

test('failed Open shows an error, leaves old settings after reload, and sends no peer reload @core', async ({ context, page }) => {
  await context.addInitScript(() => {
    window.__projectReloadMessages = 0;
    const native = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (value) {
      if (value?.type === 'settings-imported') window.__projectReloadMessages += 1;
      return native.call(this, value);
    };
  });
  await page.goto('/?role=control');
  const peer = await context.newPage();
  await peer.goto('/?role=screen');
  await expect(page.locator('#config-panel')).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('viz2_params', 'old-params');
    localStorage.setItem('viz2_video_device_id', 'old-camera');
    const native = Storage.prototype.setItem;
    window.__restoreStorage = () => { Storage.prototype.setItem = native; };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'viz2_params' && value === 'new-params') throw new DOMException('quota', 'QuotaExceededError');
      return native.call(this, key, value);
    };
  });
  await page.locator('#app-menu-btn').click();
  await upload(page, { storage: { viz2_params: 'new-params', viz2_video_device_id: 'new-camera' } });
  await expect(page.locator('#notice-modal')).toContainText('Open Project failed');
  await expect(page.locator('#notice-modal')).not.toContainText('Project opened');
  await expect(page.locator('#notice-modal-reload')).toHaveCount(0);
  await page.evaluate(() => window.__restoreStorage());
  const values = () => page.evaluate(() => [localStorage.getItem('viz2_params'), localStorage.getItem('viz2_video_device_id')]);
  expect(await values()).toEqual(['old-params', 'old-camera']);
  // The screen peer should not be sent the normal imported-settings reload.
  expect(await page.evaluate(() => window.__projectReloadMessages)).toBe(0);
  expect(peer.url()).toContain('role=screen');
  await page.reload();
  expect(await values()).toEqual(['old-params', 'old-camera']);
});

test('a second Open while the first file is still reading is rejected @core', async ({ page }) => {
  await page.goto('/?role=control');
  await expect(page.locator('#config-panel')).toBeVisible();
  await page.evaluate(() => {
    window.__reads = 0;
    File.prototype.text = function () {
      window.__reads += 1;
      return new Promise(resolve => { window.__completeRead = resolve; });
    };
  });
  await page.locator('#app-menu-btn').click();
  await upload(page, { storage: { viz2_screen_mapping_edge_blur: 'first' } });
  await expect.poll(() => page.evaluate(() => window.__reads)).toBe(1);
  await upload(page, { storage: { viz2_screen_mapping_edge_blur: 'second' } });
  expect(await page.evaluate(() => window.__reads)).toBe(1);
  await page.evaluate(() => window.__completeRead(JSON.stringify({ app: 'ahlookah', kind: 'ahlookah-project', version: 2, storage: { viz2_screen_mapping_edge_blur: 'first' }, media: [] })));
  await expect(page.locator('#notice-modal')).toContainText('Project opened');
  expect(await page.evaluate(() => localStorage.getItem('viz2_screen_mapping_edge_blur'))).toBe('first');
});

test('Save aborts on unreadable localStorage instead of downloading an incomplete project @core', async ({ page }) => {
  await page.goto('/?role=control');
  await expect(page.locator('#config-panel')).toBeVisible();
  await page.evaluate(() => {
    const native = Storage.prototype.getItem;
    window.__restoreStorage = () => { Storage.prototype.getItem = native; };
    Storage.prototype.getItem = function (key) {
      if (key === 'viz2_screen_mapping_edge_blur') throw new Error('unreadable setting');
      return native.call(this, key);
    };
    window.showSaveFilePicker = async () => ({ name: 'never.json', createWritable: async () => { throw Error('must not write'); } });
  });
  try {
    await page.locator('#app-menu-btn').click();
    await page.locator('#app-menu-save-project').click();
    await expect(page.locator('#notice-modal')).toContainText('Save Project failed');
    await expect(page.locator('#notice-modal-reload')).toHaveCount(0);
  } finally { await page.evaluate(() => window.__restoreStorage()); }
});

test('Save reports an unreadable media store instead of silently exporting no media @core', async ({ page }) => {
  await page.goto('/?role=control');
  await expect(page.locator('#config-panel')).toBeVisible();
  await page.evaluate(() => {
    const native = IDBDatabase.prototype.transaction;
    window.__restoreIdb = () => { IDBDatabase.prototype.transaction = native; };
    IDBDatabase.prototype.transaction = function (store, mode, ...rest) {
      if (this.name === 'viz2_media' && mode === 'readonly') throw new DOMException('media read denied', 'UnknownError');
      return native.call(this, store, mode, ...rest);
    };
    window.showSaveFilePicker = async () => ({ name: 'never.json', createWritable: async () => { throw Error('must not write'); } });
  });
  try {
    await page.locator('#app-menu-btn').click();
    await page.locator('#app-menu-save-project').click();
    await expect(page.locator('#notice-modal')).toContainText('Save Project failed');
  } finally { await page.evaluate(() => window.__restoreIdb()); }
});

test('New reports a failed media IndexedDB clear and rolls back project settings @core', async ({ page }) => {
  await page.goto('/?role=control');
  await expect(page.locator('#config-panel')).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('viz2_screen_mapping_edge_blur', 'old');
    const native = IDBDatabase.prototype.transaction;
    let denied = false;
    window.__restoreIdb = () => { IDBDatabase.prototype.transaction = native; };
    IDBDatabase.prototype.transaction = function (store, mode, ...rest) {
      if (this.name === 'viz2_media' && mode === 'readwrite' && !denied) {
        denied = true;
        throw new DOMException('media write denied', 'UnknownError');
      }
      return native.call(this, store, mode, ...rest);
    };
  });
  page.once('dialog', dialog => dialog.accept());
  try {
    await page.locator('#app-menu-btn').click();
    await page.locator('#app-menu-new-project').click();
    await expect(page.locator('#notice-modal')).toContainText('New Project failed');
    await expect(page.locator('#notice-modal-reload')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('viz2_screen_mapping_edge_blur'))).toBe('old');
  } finally { await page.evaluate(() => window.__restoreIdb()); }
});

test('New reports a failed settings removal rather than announcing an empty project @core', async ({ page }) => {
  await page.goto('/?role=control');
  await expect(page.locator('#config-panel')).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('viz2_screen_mapping_edge_blur', 'old');
    const native = Storage.prototype.removeItem;
    window.__restoreStorage = () => { Storage.prototype.removeItem = native; };
    Storage.prototype.removeItem = function (key) {
      if (key === 'viz2_screen_mapping_edge_blur') throw new Error('remove denied');
      return native.call(this, key);
    };
  });
  page.once('dialog', dialog => dialog.accept());
  try {
    await page.locator('#app-menu-btn').click();
    await page.locator('#app-menu-new-project').click();
    await expect(page.locator('#notice-modal')).toContainText('New Project failed');
    await expect(page.locator('#notice-modal-reload')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('viz2_screen_mapping_edge_blur'))).toBe('old');
  } finally { await page.evaluate(() => window.__restoreStorage()); }
});
