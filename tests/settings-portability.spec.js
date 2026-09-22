import fs from 'node:fs';
import { test, expect } from '@playwright/test';

// E2E: the project menu (Save Project / Open Project / New Project).
//
// Save Project writes every persisted setting plus media *metadata* (id, name,
// kind, mime, size, addedAt, file name) and the identity of each linked directory
// to a file the operator picks (File System Access save picker; a download when
// the browser has no picker). Open Project replaces this browser's project; a
// linked directory it already knows by identity resumes without a re-link, and one
// it has never seen is linked from the blocking relink dialog. New Project clears
// everything project-scoped. Media files are never copied, so a media pattern
// without a local file is marked red and re-pointed with the parameters panel's
// Relink File button (stubbed FS Access picker here).

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

// Save Project asks the browser for a location and a file name. Chromium really
// has that picker, so it is stubbed here to record what would be written instead
// of opening a native dialog (the fallback test removes it explicitly).
const SAVE_PICKER_STUB = `
  (() => {
    window.savedProject = { name: null, text: null, closed: false, aborted: false };
    window.showSaveFilePicker = async ({ suggestedName }) => {
      window.savedProject.name = suggestedName;
      return {
        name: suggestedName,
        async createWritable() {
          return {
            async write(text) { window.savedProject.text = text; },
            async close() { window.savedProject.closed = true; },
            async abort() { window.savedProject.aborted = true; },
          };
        },
      };
    };
  })();
`;

test.describe('project save / open / new', () => {
  test('saves persisted settings and media references to a chosen project file', async ({ context }) => {
    test.setTimeout(45_000);
    await context.addInitScript(PICKER_STUB);
    await context.addInitScript(SAVE_PICKER_STUB);
    const control = await context.newPage();
    await control.goto('/?role=control');
    await expect(control.locator('#config-panel')).toBeVisible();

    // A setting to look for in the saved file.
    await control.evaluate(() => localStorage.setItem('viz2_screen_mapping_edge_blur', '7'));

    // A media pattern so the file has media metadata to carry.
    await control.locator('.media-add-btn').click();
    const addedMedia = control.locator('.pattern-btn[data-id^="media-"]');
    await expect(addedMedia).toHaveCount(1);

    // The file is present, so no Relink File affordance is offered.
    await addedMedia.click();
    await expect(control.locator('#media-relink-btn')).toBeHidden();

    await control.locator('#app-menu-btn').click();
    await control.locator('#app-menu-save-project').click();

    // The save is acknowledged in-app once the file has been written.
    const notice = control.locator('#notice-modal');
    await expect(notice).toContainText('Project saved');
    await expect(control.locator('#notice-modal-reload')).toHaveCount(0);

    const saved = await control.evaluate(() => window.savedProject);
    expect(saved.name).toMatch(/^ahlookah-project-\d{4}-\d{2}-\d{2}\.json$/);
    expect(saved.closed).toBe(true);
    expect(saved.aborted).toBe(false);
    const payload = JSON.parse(saved.text);

    expect(payload.app).toBe('ahlookah');
    expect(payload.kind).toBe('ahlookah-project');
    expect(payload.version).toBe(2);
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

  test('falls back to a download when the browser has no save picker', async ({ context }) => {
    test.setTimeout(45_000);
    await context.addInitScript('window.showSaveFilePicker = undefined;');
    const control = await context.newPage();
    await control.goto('/?role=control');
    await expect(control.locator('#config-panel')).toBeVisible();

    await control.locator('#app-menu-btn').click();
    const [download] = await Promise.all([
      control.waitForEvent('download'),
      control.locator('#app-menu-save-project').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^ahlookah-project-\d{4}-\d{2}-\d{2}\.json$/);
    const payload = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    expect(payload.kind).toBe('ahlookah-project');
  });

  test('New Project clears settings, media and linked directories but keeps device choices', async ({ context }) => {
    test.setTimeout(60_000);
    await context.addInitScript(PICKER_STUB);
    const control = await context.newPage();
    await control.goto('/?role=control');
    await expect(control.locator('#config-panel')).toBeVisible();

    // Project content, a linked directory identity, and two machine choices.
    await control.evaluate(() => {
      localStorage.setItem('viz2_screen_mapping_edge_blur', '9');
      localStorage.setItem('viz2_device_setup_done', '1');
      localStorage.setItem('viz2_audio_device_id', 'mic-1');
      localStorage.setItem('viz2_project_folders', JSON.stringify({ media: { id: 'f1', name: 'media' } }));
    });
    await control.locator('.media-add-btn').click();
    await expect(control.locator('.pattern-btn[data-id^="media-"]')).toHaveCount(1);

    // Canceling keeps everything.
    const dialogs = [];
    control.once('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await control.locator('#app-menu-btn').click();
    await control.locator('#app-menu-new-project').click();
    expect(dialogs[0]).toContain('Start a new project');
    expect(await control.evaluate(() => localStorage.getItem('viz2_screen_mapping_edge_blur'))).toBe('9');
    await expect(control.locator('#notice-modal')).toHaveCount(0);

    let confirmed = false;
    control.on('dialog', async (dialog) => { confirmed = true; await dialog.accept(); });
    await control.locator('#app-menu-btn').click();
    await control.locator('#app-menu-new-project').click();

    const notice = control.locator('#notice-modal');
    await expect(notice).toContainText('New project');
    expect(confirmed).toBe(true);
    const after = await control.evaluate(async () => ({
      blur: localStorage.getItem('viz2_screen_mapping_edge_blur'),
      media: localStorage.getItem('viz2_media_patterns'),
      identities: localStorage.getItem('viz2_project_folders'),
      audio: localStorage.getItem('viz2_audio_device_id'),
      setup: localStorage.getItem('viz2_device_setup_done'),
      records: (await (await import('/src/media/media-store.js')).listMediaRecords()).length,
    }));
    expect(after.blur).toBeNull();
    expect(after.media).toBeNull();
    expect(after.identities).toBeNull();
    expect(after.records).toBe(0);
    expect(after.audio).toBe('mic-1');
    expect(after.setup).toBe('1');

    await control.locator('#notice-modal-reload').click();
    await expect(control.locator('.pattern-btn[data-id^="media-"]')).toHaveCount(0);
  });

  test('a saved project replaces settings, restores media metadata, and relinks a file', async ({ context, page }) => {
    test.setTimeout(60_000);
    await context.addInitScript(PICKER_STUB);
    const control = await context.newPage();
    await control.goto('/?role=control');
    await expect(control.locator('#config-panel')).toBeVisible();

    // Destination state that the save must replace.
    await control.evaluate(() => localStorage.setItem('viz2_screen_mapping_enabled', '1'));

    // A pre-project file (kind ahlookah-settings, version 1) still loads: it simply
    // carries no directory identities, so nothing is resolved by identity.
    const settingsFile = test.info().outputPath('ahlookah-legacy-settings.json');
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
    await control.locator('#project-open-input').setInputFiles(settingsFile);

    // The result is an in-app dialog (not a native alert) that names the media
    // files which still need re-linking; the reload only happens on acknowledge.
    const notice = control.locator('#notice-modal');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Project opened');
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

  test('a malformed project file is reported and changes nothing', async ({ context }) => {
    test.setTimeout(45_000);
    const control = await context.newPage();
    await control.goto('/?role=control');
    await expect(control.locator('#config-panel')).toBeVisible();
    await control.evaluate(() => localStorage.setItem('viz2_screen_mapping_edge_blur', '3'));

    const bogus = test.info().outputPath('not-ahlookah-project.json');
    fs.writeFileSync(bogus, JSON.stringify({ hello: 'world' }));

    await control.locator('#app-menu-btn').click();
    await control.locator('#project-open-input').setInputFiles(bogus);

    const notice = control.locator('#notice-modal');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Open Project failed');
    // No reload button on failure — the app keeps running on the old project.
    await expect(control.locator('#notice-modal-reload')).toHaveCount(0);
    expect(await control.evaluate(() => localStorage.getItem('viz2_screen_mapping_edge_blur'))).toBe('3');

    await control.locator('#notice-modal-dismiss').click();
    await expect(notice).toHaveCount(0);
  });

  test('a fingerprint a project already recorded survives a save that cannot verify it', async ({ context }) => {
    const control = await context.newPage();
    await control.goto('/?role=control');
    await expect(control.locator('#config-panel')).toBeVisible();

    // No scripts folder is linked here (nothing readable to re-hash), so the code
    // fingerprint the project already carried must be kept, not dropped — dropping
    // it would make the project unable to reopen that script anywhere. This covers
    // both an unopened file and one that is currently loaded (a loaded entry has no
    // fingerprint of its own).
    const digest = 'a'.repeat(64);
    const collected = await control.evaluate(async (hash) => {
      const { importFolderReferences } = await import('/src/platform/folderReferences.js');
      const { collectSettings } = await import('/src/platform/settings-portability.js');
      const { scriptStorage } = await import('/src/custom-scripts/storage.js');
      importFolderReferences({
        scripts: { folderName: 'scripts', folderId: null, files: [{ fileName: 'ghost.viz.js', linked: true, sha256: hash }] },
        nodes: { folderName: null, folderId: null, files: [] },
        media: { folderName: null, folderId: null, files: [] },
      });
      const unopened = (await collectSettings()).folders.scripts.files.find(file => file.fileName === 'ghost.viz.js');
      // Now the same file is loaded in this browser (its source is in the snapshot).
      await scriptStorage('active', { selectionVersion: 1, revision: Date.now(), sources: [{ name: 'ghost.viz.js', text: 'api.requireVersion(1);' }], files: [], folder: null, changed: [] });
      const opened = (await collectSettings()).folders.scripts.files.find(file => file.fileName === 'ghost.viz.js');
      return { unopened, opened };
    }, digest);
    expect(collected.unopened).toEqual({ fileName: 'ghost.viz.js', linked: true, sha256: digest });
    expect(collected.opened).toEqual({ fileName: 'ghost.viz.js', linked: true, sha256: digest });
  });

  test('the app menu offers Save, Open and New Project', async ({ context }) => {
    const control = await context.newPage();
    await control.goto('/?role=control');
    await expect(control.locator('#config-panel')).toBeVisible();
    await control.locator('#app-menu-btn').click();
    await expect(control.locator('#app-menu-save-project')).toHaveText('Save Project');
    await expect(control.locator('#app-menu-open-project')).toHaveText('Open Project');
    await expect(control.locator('#app-menu-new-project')).toHaveText('New Project');
    await expect(control.locator('#app-menu-export-project')).toHaveCount(0);
    await expect(control.locator('#app-menu-export-settings')).toHaveCount(0);
    await expect(control.locator('#app-menu-import-settings')).toHaveCount(0);
  });
});
