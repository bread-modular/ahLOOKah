import { test, expect } from '@playwright/test';

// E2E: user-loaded media patterns (local images / videos).
// The app persists only a path-equivalent FileSystemFileHandle (File System
// Access API) and reads the file from disk when the pattern is activated.
// Playwright cannot drive the real picker, so a Media folder is linked from OPFS
// (seedOpfsMediaFolder below): the linked directory is the one ADD path the panel
// has, and the handle works for the session — exactly the add → activate flow a
// user performs. Persistence of the pattern metadata across reloads is verified via
// localStorage/IndexedDB records (OPFS handles are cloneable, real OS handles are
// covered by Chrome's own API tests).
//
// Covers: adding from the linked folder, playing it live, param surfacing, metadata
// persistence across reloads, and removal.

// 1x1 red PNG.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Write the PNG into an OPFS `media` folder and stub the directory picker with it:
// ADD only opens the linked folder, so a folder has to exist before anything can be
// added. Runs on the control window, which is where the Media group lives.
async function seedOpfsMediaFolder(control) {
  await control.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('media', { create: true });
    const writer = await (await dir.getFileHandle('my_test_image.png', { create: true })).createWritable();
    await writer.write(new Blob([bytes], { type: 'image/png' }));
    await writer.close();
    window.showDirectoryPicker = async () => dir;
  }, TINY_PNG_B64);
}

test.describe('media patterns', () => {
  test('add from the linked folder, play live, persist metadata across reload, and remove', { tag: ['@core', '@smoke'] }, async ({ context, page }) => {
    test.setTimeout(45_000);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/?role=screen');
    const control = await context.newPage();
    await control.goto('/?role=control');
    await seedOpfsMediaFolder(control);

    // --- Add an image through the Media group's linked-folder picker ---------
    const mediaPanel = control.locator('.media-folder-panel');
    const addMediaBtn = control.locator('.media-add-btn');
    // The Media group's own header row (the panel renders as display: contents).
    const mediaHeader = mediaPanel.locator('..');
    await expect(addMediaBtn).toHaveText('ADD');
    await expect(addMediaBtn).toBeDisabled();
    await mediaPanel.getByRole('button', { name: 'Link Folder', exact: true }).click();
    await expect(addMediaBtn).toBeEnabled();
    const [addButtonBox, headerBox] = await Promise.all([
      addMediaBtn.boundingBox(),
      mediaHeader.boundingBox(),
    ]);
    expect(addButtonBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(addButtonBox.width).toBeLessThan(headerBox.width);
    // ADD is the Media group's only action and sits at the header's right edge.
    expect(addButtonBox.x + addButtonBox.width).toBeGreaterThanOrEqual(headerBox.x + headerBox.width - 2);
    await expect(mediaHeader.locator('.media-add-btn')).toHaveCount(1);
    await expect(mediaHeader.locator('.library-add-btn')).toHaveCount(1);
    await addMediaBtn.click();
    const picker = control.getByRole('dialog', { name: 'Open Media', exact: true });
    await picker.getByRole('combobox').selectOption('my_test_image.png');
    await picker.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(picker).toHaveCount(0);

    const mediaBtn = control.locator('.pattern-btn[data-id^="media-"]').first();
    await expect(mediaBtn).toBeVisible();
    await expect(mediaBtn).toContainText('my_test_image');

    // --- Play it live on the output -----------------------------------------
    await mediaBtn.click();
    await page.waitForFunction(() =>
      typeof window.__viz?.patternId === 'string' && window.__viz.patternId.startsWith('media-'),
    );
    await page.waitForTimeout(500);
    await expect(page.locator('canvas:visible').first()).toBeVisible();

    // --- Scaling params surface in the parameter panel ----------------------
    await expect(control.locator('#config-panel')).toContainText('Scaling');

    // Scaling renders as a dropdown (def.options) — switch modes and confirm
    // the pattern keeps playing and the shown label follows.
    const scalingSelect = control.locator('select.param-select[data-key="scaleMode"]');
    await expect(scalingSelect).toHaveClass(/control-select/);
    await expect(scalingSelect).toHaveCSS('appearance', 'none');
    await expect(scalingSelect).toHaveCSS('background-image', /data:image\/svg\+xml/);
    await expect(scalingSelect).toHaveCSS('height', '26px');
    await scalingSelect.hover();
    await expect(scalingSelect).toHaveCSS('background-image', /data:image\/svg\+xml/);
    await expect(scalingSelect).toBeVisible();
    await expect(scalingSelect).toHaveValue('2');
    await scalingSelect.selectOption({ label: 'Fit Width' });
    await expect(scalingSelect).toHaveValue('0');
    await expect(control.locator('.param-value[data-value="scaleMode"]')).toHaveText('Fit Width');
    await page.waitForFunction(() =>
      typeof window.__viz?.patternId === 'string' && window.__viz.patternId.startsWith('media-'),
    );

    // The control preview reads the picked file from disk (in-session source
    // cache) and paints it — the 1x1 red PNG fills the whole canvas. The
    // preview pane renders at reduced brightness, so accept a strong red tint.
    const previewShowsMedia = () => control.evaluate(() => {
      const canvas = document.querySelector('#preview-stage canvas');
      if (!canvas) return false;
      const ctx = canvas.getContext('2d');
      const d = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      return d[0] > 100 && d[1] === 0 && d[2] === 0;
    });
    await expect.poll(previewShowsMedia, { timeout: 8000, intervals: [250, 500, 1000] }).toBe(true);

    // --- Rename via the params-panel Rename button (prompt dialog) -----------
    // The media pattern is the editing selection, so the manage row sits at
    // the bottom of the params list.
    const renameBtn = control.locator('.media-manage-row .btn:not(.btn--danger)');
    await expect(renameBtn).toBeVisible();
    control.once('dialog', async (dialog) => {
      await dialog.accept('Encore Visual');
    });
    await renameBtn.click();
    await expect(mediaBtn).toContainText('Encore Visual');

    // The IndexedDB record keeps the new name while kind/mime/addedAt survive
    // untouched (picker files record size as null — only the <input> fallback
    // carries a byte size).
    const recordAfterRename = await control.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('viz2_media', 2);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('media', 'readonly');
        const getAll = tx.objectStore('media').getAll();
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      };
    }));
    expect(recordAfterRename).toHaveLength(1);
    expect(recordAfterRename[0].name).toBe('Encore Visual');
    expect(recordAfterRename[0].kind).toBe('image');
    expect(recordAfterRename[0].mime).toBe('image/png');
    expect(recordAfterRename[0].size).toBeNull();
    expect(typeof recordAfterRename[0].addedAt).toBe('number');

    // --- Persistence: reload the control window -----------------------------
    await control.reload();
    const mediaBtnAfterReload = control.locator('.pattern-btn[data-id^="media-"]').first();
    await expect(mediaBtnAfterReload).toBeVisible();
    await expect(mediaBtnAfterReload).toContainText('Encore Visual');

    // The screen window re-registered from the same storage too. Wait until it
    // has finished booting and restored its own default pattern before
    // selecting — a click broadcast during boot races loadSketch().
    await page.reload();
    await page.waitForFunction(() =>
      typeof window.__viz?.patternId === 'string' && window.__viz.patternId.length > 0,
    );
    await control.locator('.pattern-btn[data-id^="media-"]').first().click();
    await page.waitForFunction(() =>
      typeof window.__viz?.patternId === 'string' && window.__viz.patternId.startsWith('media-'),
    );

    // --- Removal via the params-panel Remove button --------------------------
    // Confirm dialog: dismiss keeps, accept removes.
    const removeBtn = control.locator('.media-manage-row .btn--danger');
    await expect(removeBtn).toBeVisible();
    control.once('dialog', async (dialog) => {
      await dialog.dismiss();
    });
    await removeBtn.click();
    await expect(control.locator('.pattern-btn[data-id^="media-"]')).toHaveCount(1);

    control.once('dialog', async (dialog) => {
      await dialog.accept();
    });
    await removeBtn.click();
    await expect(control.locator('.pattern-btn[data-id^="media-"]')).toHaveCount(0);

    await control.reload();
    await expect(control.locator('.pattern-btn[data-id^="media-"]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});