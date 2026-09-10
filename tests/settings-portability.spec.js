import fs from 'node:fs';
import { test, expect } from '@playwright/test';

// E2E: settings export / import (Menu → Export Settings / Import Settings).
//
// Export writes every persisted setting plus media *metadata* (id, name, kind,
// mime, size, addedAt, file name) to a JSON download. Import replaces the
// destination's settings, restores media patterns as file-less entries and
// reloads every window. Media files are never copied, so an imported pattern is
// re-pointed at a local file with the parameters panel's Relink File button
// (stubbed FS Access picker here).

// 1x1 red PNG.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Stub window.showOpenFilePicker before app modules run so media add/relink
// behave like Desktop Chrome without a real picker dialog.
const PICKER_STUB = `
  (() => {
    const bin = atob(${JSON.stringify(TINY_PNG_B64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'my_test_image.png', { type: 'image/png' });
    const handle = {
      kind: 'file',
      name: 'my_test_image.png',
      async getFile() { return file; },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
    };
    window.showOpenFilePicker = async () => [handle];
  })();
`;

test.describe('settings export / import', () => {
  test('exports persisted settings and media references to a JSON file', async ({ context, page }) => {
    test.setTimeout(45_000);
    await context.addInitScript(PICKER_STUB);
    const control = await context.newPage();
    await control.goto('/?role=control');
    await expect(control.locator('#config-panel')).toBeVisible();

    // A setting to look for in the export.
    await control.evaluate(() => localStorage.setItem('viz2_screen_mapping_edge_blur', '7'));

    // A media pattern so the export has media metadata to carry.
    await control.locator('.media-add-btn').click();
    const addedMedia = control.locator('.pattern-btn[data-id^="media-"]');
    await expect(addedMedia).toHaveCount(1);

    // The file is present, so no Relink File affordance is offered.
    await addedMedia.click();
    await expect(control.locator('#media-relink-btn')).toBeHidden();

    await control.locator('#app-menu-btn').click();
    const [download] = await Promise.all([
      control.waitForEvent('download'),
      control.locator('#app-menu-export-settings').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^ahlookah-settings-\d{4}-\d{2}-\d{2}\.json$/);
    const payload = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));

    expect(payload.app).toBe('ahlookah');
    expect(payload.kind).toBe('ahlookah-settings');
    expect(payload.version).toBe(1);
    expect(typeof payload.exportedAt).toBe('string');
    expect(payload.storage['viz2_screen_mapping_edge_blur']).toBe('7');
    expect(payload.storage['viz2_media_patterns']).toContain('my_test_image');
    // Session/coordination keys never travel.
    expect(payload.storage).not.toHaveProperty('viz2_tab_id');
    expect(payload.storage).not.toHaveProperty('viz2_audio_capture_lease');

    // Media travels as metadata only — the file name, never a handle or bytes.
    expect(payload.media).toHaveLength(1);
    expect(payload.media[0].kind).toBe('image');
    expect(payload.media[0].fileName).toBe('my_test_image.png');
    expect(payload.media[0]).not.toHaveProperty('handle');
    expect(payload.media[0]).not.toHaveProperty('blob');
  });

  test('import replaces settings, restores media metadata, and relinks a file', async ({ context, page }) => {
    test.setTimeout(60_000);
    await context.addInitScript(PICKER_STUB);
    const control = await context.newPage();
    await control.goto('/?role=control');
    await expect(control.locator('#config-panel')).toBeVisible();

    // Destination state that the import must replace.
    await control.evaluate(() => localStorage.setItem('viz2_screen_mapping_enabled', '1'));

    const settingsFile = test.info().outputPath('ahlookah-settings-import.json');
    fs.writeFileSync(settingsFile, JSON.stringify({
      app: 'ahlookah',
      kind: 'ahlookah-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      storage: {
        viz2_device_setup_done: '1',
        viz2_screen_mapping_edge_blur: '12',
        viz2_media_patterns: JSON.stringify([{ id: 'mimported1', name: 'Imported Loop', kind: 'image' }]),
      },
      media: [{
        id: 'mimported1',
        name: 'Imported Loop',
        kind: 'image',
        mime: 'image/png',
        size: null,
        addedAt: 1700000000000,
        fileName: 'imported.png',
      }],
    }));

    const dialogs = [];
    control.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });

    await control.locator('#app-menu-btn').click();
    await control.locator('#settings-import-input').setInputFiles(settingsFile);

    // The result is an in-app dialog (not a native alert) that names the media
    // files which still need re-linking; the reload only happens on acknowledge.
    const notice = control.locator('#notice-modal');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Settings imported');
    await expect(notice).toContainText('Imported Loop');
    await expect(notice).toContainText('Relink File');
    expect(dialogs).toEqual([]);
    expect(await control.evaluate(() => localStorage.getItem('viz2_screen_mapping_edge_blur'))).toBe('12');

    await control.locator('#notice-modal-reload').click();

    // The reload re-reads the new settings; the restored media pattern proves it.
    const mediaBtn = control.locator('.pattern-btn[data-id="media-mimported1"]');
    await expect(mediaBtn).toBeVisible({ timeout: 20_000 });
    await expect(mediaBtn).toContainText('Imported Loop');

    // Replace semantics: the key the file omitted is gone, the imported one
    // landed, and the media record kept its metadata without a file handle.
    const restored = await control.evaluate(() => ({
      enabled: localStorage.getItem('viz2_screen_mapping_enabled'),
      edgeBlur: localStorage.getItem('viz2_screen_mapping_edge_blur'),
    }));
    expect(restored.enabled).toBeNull();
    expect(restored.edgeBlur).toBe('12');

    const record = await control.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('viz2_media', 2);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('media', 'readonly');
        const get = tx.objectStore('media').get('mimported1');
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      };
    }));
    expect(record.name).toBe('Imported Loop');
    expect(record.kind).toBe('image');
    expect(record.fileName).toBe('imported.png');
    expect(record.handle).toBeNull();

    // Select the imported pattern: it renders the "not linked" placeholder until
    // the file is re-pointed.
    await mediaBtn.click();
    const relinkBtn = control.locator('#media-relink-btn');
    await expect(relinkBtn).toBeVisible();
    await expect(control.locator('#params-list')).toContainText('Relink File');

    await relinkBtn.click();

    // Once the file is reachable again the affordance goes away.
    await expect(relinkBtn).toBeHidden();

    // The stubbed picker supplies the 1x1 red PNG; the live preview then paints
    // it full-frame, which only happens once the record has a usable handle.
    const previewShowsMedia = () => control.evaluate(() => {
      const canvas = document.querySelector('#preview-stage canvas');
      if (!canvas) return false;
      const ctx = canvas.getContext('2d');
      const d = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      return d[0] > 100 && d[1] === 0 && d[2] === 0;
    });
    await expect.poll(previewShowsMedia, { timeout: 10_000, intervals: [250, 500, 1000] }).toBe(true);

    const relinked = await control.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('viz2_media', 2);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('media', 'readonly');
        const get = tx.objectStore('media').get('mimported1');
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      };
    }));
    expect(relinked.name).toBe('Imported Loop');
    expect(relinked.fileName).toBe('my_test_image.png');
    // The Playwright mock handle is not structured-cloneable, so the persisted
    // record falls back to metadata only (real Chrome handles survive the
    // clone). The live preview above proves the in-session source is wired up.
    expect(relinked.handle).toBeNull();
  });

  test('a malformed settings file is reported and changes nothing', async ({ context }) => {
    test.setTimeout(45_000);
    const control = await context.newPage();
    await control.goto('/?role=control');
    await expect(control.locator('#config-panel')).toBeVisible();
    await control.evaluate(() => localStorage.setItem('viz2_screen_mapping_edge_blur', '3'));

    const bogus = test.info().outputPath('not-ahlookah-settings.json');
    fs.writeFileSync(bogus, JSON.stringify({ hello: 'world' }));

    await control.locator('#app-menu-btn').click();
    await control.locator('#settings-import-input').setInputFiles(bogus);

    const notice = control.locator('#notice-modal');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Import failed');
    // No reload button on failure — the app keeps running on the old settings.
    await expect(control.locator('#notice-modal-reload')).toHaveCount(0);
    expect(await control.evaluate(() => localStorage.getItem('viz2_screen_mapping_edge_blur'))).toBe('3');

    await control.locator('#notice-modal-dismiss').click();
    await expect(notice).toHaveCount(0);
  });
});
