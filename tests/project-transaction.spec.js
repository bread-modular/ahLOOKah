import { test, expect } from '@playwright/test';

// Patch only one targeted storage operation; the app can still use unrelated
// localStorage keys (leases, UI state) while an import is being tested.
test('Open rolls back early/middle/late writes and a removal failure, without a success notice or peer reload @core', async ({ page }) => {
  await page.goto('/?role=control');
  await expect(page.locator('#config-panel')).toBeVisible();
  const result = await page.evaluate(async () => {
    const { applySettings, SETTINGS_STORAGE_KEYS } = await import('/src/platform/settings-portability.js');
    const keys = [SETTINGS_STORAGE_KEYS[0], SETTINGS_STORAGE_KEYS[8], SETTINGS_STORAGE_KEYS.at(-1)];
    const old = Object.fromEntries(keys.map((key, i) => [key, `old-${i}`]));
    const incoming = Object.fromEntries(keys.map((key, i) => [key, `new-${i}`]));
    const outcomes = [];
    for (const [key, operation] of [...keys.map(key => [key, 'set']), [keys[2], 'remove']]) {
      for (const [name, value] of Object.entries(old)) localStorage.setItem(name, value);
      const before = keys.map(name => localStorage.getItem(name));
      const native = Storage.prototype[operation === 'set' ? 'setItem' : 'removeItem'];
      let failures = 0;
      Storage.prototype[operation === 'set' ? 'setItem' : 'removeItem'] = function (name, ...args) {
        if (name === key && ++failures === 1) throw new DOMException('quota', 'QuotaExceededError');
        return native.call(this, name, ...args);
      };
      let error;
      try {
        await applySettings(projectFor(operation === 'remove' ? Object.fromEntries(Object.entries(incoming).filter(([name]) => name !== key)) : incoming));
      } catch (e) { error = { message: e.message, rollbackFailures: e.rollbackFailures }; }
      finally { Storage.prototype[operation === 'set' ? 'setItem' : 'removeItem'] = native; }
      outcomes.push({ key, operation, before, after: keys.map(name => localStorage.getItem(name)), error });
    }
    return outcomes;
    function projectFor(storage) { return { storage, media: [] }; }
  });
  for (const outcome of result) {
    expect(outcome.error?.message).toContain('Project storage failed');
    expect(outcome.error?.rollbackFailures).toEqual([]);
    expect(outcome.after).toEqual(outcome.before);
  }
  await expect(page.locator('#notice-modal')).toHaveCount(0);
});

test('Open rolls back on a later IndexedDB write failure and keeps full old media records @core', async ({ page }) => {
  await page.goto('/?role=control');
  const outcome = await page.evaluate(async () => {
    const { applySettings } = await import('/src/platform/settings-portability.js');
    const { putMediaRecord, listMediaRecords } = await import('/src/media/media-store.js');
    localStorage.setItem('viz2_screen_mapping_edge_blur', 'old-blur');
    await putMediaRecord({ id: 'old-media', name: 'Old media', kind: 'image', file: new File(['old'], 'old.png', { type: 'image/png' }) });
    const original = IDBDatabase.prototype.transaction;
    let thrown = false;
    IDBDatabase.prototype.transaction = function (name, mode, ...args) {
      if (this.name === 'viz2_media' && mode === 'readwrite' && !thrown) {
        thrown = true; throw new DOMException('IDB denied', 'UnknownError');
      }
      return original.call(this, name, mode, ...args);
    };
    let error;
    try { await applySettings({ storage: { viz2_screen_mapping_edge_blur: 'new-blur' }, media: [] }); }
    catch (e) { error = { message: e.message, rollbackFailures: e.rollbackFailures }; }
    finally { IDBDatabase.prototype.transaction = original; }
    return { error, thrown, blur: localStorage.getItem('viz2_screen_mapping_edge_blur'), media: (await listMediaRecords()).map(r => ({ id: r.id, blob: !!r.blob })) };
  });
  expect(outcome.thrown).toBe(true);
  expect(outcome.error?.rollbackFailures).toEqual([]);
  expect(outcome.blur).toBe('old-blur');
  expect(outcome.media).toEqual([{ id: 'old-media', blob: true }]);
  await page.reload();
  expect(await page.evaluate(async () => ({ blur: localStorage.getItem('viz2_screen_mapping_edge_blur'), media: (await (await import('/src/media/media-store.js')).listMediaRecords()).map(r => r.id) })))
    .toEqual({ blur: 'old-blur', media: ['old-media'] });
});

test('a failed node IndexedDB commit restores old handles, references, and settings @core', async ({ page }) => {
  await page.goto('/?role=control');
  const outcome = await page.evaluate(async () => {
    const { applySettings } = await import('/src/platform/settings-portability.js');
    const { createHandleStorage } = await import('/src/platform/handleStorage.js');
    const store = createHandleStorage('viz2-node-patterns');
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('old.nodes.json', { create: true });
    await store('handles', { folder: null, opened: [{ id: 'nodes-old', handle }], hidden: ['old-hidden.nodes.json'], references: [{ fileName: 'old.nodes.json', id: 'nodes-old', linked: false }] });
    localStorage.setItem('viz2_folder_references', JSON.stringify({ old: true }));
    localStorage.setItem('viz2_screen_mapping_edge_blur', 'old');
    const refs = Object.fromEntries(['scripts', 'nodes', 'media'].map(section => [section, { folderName: null, folderId: null, files: [] }]));
    const original = IDBDatabase.prototype.transaction;
    let denied = false;
    IDBDatabase.prototype.transaction = function (name, mode, ...rest) {
      if (this.name === 'viz2-node-patterns' && mode === 'readwrite' && !denied) {
        denied = true; throw new DOMException('node write denied', 'UnknownError');
      }
      return original.call(this, name, mode, ...rest);
    };
    let error;
    try { await applySettings({ storage: { viz2_screen_mapping_edge_blur: 'new' }, media: [], folders: refs }); }
    catch (e) { error = { message: e.message, rollbackFailures: e.rollbackFailures }; }
    finally { IDBDatabase.prototype.transaction = original; }
    const state = await store('handles');
    return { denied, error, opened: state.opened.map(item => item.id), hidden: state.hidden, references: state.references,
      refs: localStorage.getItem('viz2_folder_references'), blur: localStorage.getItem('viz2_screen_mapping_edge_blur') };
  });
  expect(outcome.denied).toBe(true);
  expect(outcome.error?.rollbackFailures).toEqual([]);
  expect(outcome.opened).toEqual(['nodes-old']);
  expect(outcome.hidden).toEqual(['old-hidden.nodes.json']);
  expect(outcome.references).toHaveLength(1);
  expect(outcome.refs).toBe('{"old":true}');
  expect(outcome.blur).toBe('old');
  await page.reload();
  expect(await page.evaluate(async () => (await (await import('/src/platform/handleStorage.js')).createHandleStorage('viz2-node-patterns')('handles')).opened.map(item => item.id))).toEqual(['nodes-old']);
});

test('preflight IndexedDB read failure aborts before the first project write @core', async ({ page }) => {
  await page.goto('/?role=control');
  const result = await page.evaluate(async () => {
    const { applySettings } = await import('/src/platform/settings-portability.js');
    localStorage.setItem('viz2_screen_mapping_edge_blur', 'old');
    const native = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (name, mode, ...rest) {
      if (this.name === 'viz2-node-patterns' && mode === 'readonly') throw new DOMException('preflight denied', 'UnknownError');
      return native.call(this, name, mode, ...rest);
    };
    let error;
    try { await applySettings({ storage: { viz2_screen_mapping_edge_blur: 'new' }, media: [] }); }
    catch (e) { error = e.message; }
    finally { IDBDatabase.prototype.transaction = native; }
    return { error, value: localStorage.getItem('viz2_screen_mapping_edge_blur') };
  });
  expect(result.error).toContain('preflight denied');
  expect(result.value).toBe('old');
});

test('a simultaneous import cannot commit over another in-flight project change @core', async ({ page }) => {
  await page.goto('/?role=control');
  const outcome = await page.evaluate(async () => {
    const { applySettings } = await import('/src/platform/settings-portability.js');
    localStorage.setItem('viz2_screen_mapping_edge_blur', 'old');
    let unlock, entered;
    const held = new Promise(resolve => { unlock = resolve; });
    const acquired = new Promise(resolve => { entered = resolve; });
    const owner = navigator.locks.request('viz2-project-import', async () => { entered(); await held; });
    await acquired;
    let message;
    try { await applySettings({ storage: { viz2_screen_mapping_edge_blur: 'new' }, media: [] }); }
    catch (error) { message = error.message; }
    unlock(); await owner;
    return { message, value: localStorage.getItem('viz2_screen_mapping_edge_blur') };
  });
  expect(outcome).toEqual({ message: 'Another project import is already in progress.', value: 'old' });
});

test('invalid imported settings and media are rejected before writes @core', async ({ page }) => {
  await page.goto('/?role=control');
  const result = await page.evaluate(async () => {
    const { applySettings } = await import('/src/platform/settings-portability.js');
    localStorage.setItem('viz2_screen_mapping_edge_blur', 'old');
    const errors = [];
    for (const candidate of [{ storage: { viz2_screen_mapping_edge_blur: 42 }, media: [] },
      { storage: { viz2_screen_mapping_edge_blur: 'new' }, media: [{ id: 'duplicate' }, { id: 'duplicate' }] }]) {
      try { await applySettings(candidate); }
      catch (e) { errors.push(e.message); }
    }
    return { errors, value: localStorage.getItem('viz2_screen_mapping_edge_blur') };
  });
  expect(result.errors).toHaveLength(2);
  expect(result.value).toBe('old');
});

test('a persistent rollback failure stays explicit and can be recovered in the same tab @core', async ({ page }) => {
  await page.goto('/?role=control');
  const outcome = await page.evaluate(async () => {
    const { applySettings, recoverProjectState } = await import('/src/platform/settings-portability.js');
    const key = 'viz2_screen_mapping_edge_blur';
    const earlier = 'viz2_params';
    localStorage.setItem(key, 'old');
    localStorage.setItem(earlier, 'old-params');
    const native = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key || (name === earlier && value === 'old-params')) throw new DOMException('persistently denied', 'QuotaExceededError');
      return native.call(this, name, value);
    };
    let failure, blocked;
    try { await applySettings({ storage: { [key]: 'new', [earlier]: 'new-params' }, media: [] }); }
    catch (e) { failure = { recoveryAvailable: e.recoveryAvailable, rollbackFailures: e.rollbackFailures }; }
    try { await applySettings({ storage: {}, media: [] }); }
    catch (e) { blocked = e.message; }
    Storage.prototype.setItem = native;
    const recovery = await recoverProjectState();
    return { failure, blocked, recovery, value: localStorage.getItem(key) };
  });
  expect(outcome.failure.recoveryAvailable).toBe(true);
  expect(outcome.failure.rollbackFailures).toContain('viz2_params: persistently denied');
  expect(outcome.blocked).toContain('Recover the previous project');
  expect(outcome.recovery).toEqual({ ok: true, recovered: true, failures: [] });
  expect(outcome.value).toBe('old');
});

test('New Project removes a separately opened, valid node pattern from the library across reload @core', async ({ page }) => {
  await page.goto('/?role=control');
  await expect(page.locator('#config-panel')).toBeVisible();
  await page.evaluate(async () => {
    const { serializeGraph, manifestFor } = await import('/src/nodes/portability.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('individual.nodes.json', { create: true });
    const graph = { version: 1, name: 'Individual pattern', nodes: [{ id: 'output', type: 'output', x: 0, y: 0 }], edges: [] };
    const writer = await handle.createWritable();
    await writer.write(serializeGraph(graph, manifestFor(graph, SKETCHES)));
    await writer.close();
    window.showOpenFilePicker = async () => [handle];
    await nodePatterns.open();
  });
  await expect(page.locator('.library-btn[data-id^="nodes-"]')).toContainText('Individual pattern');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#app-menu-btn').click();
  await page.locator('#app-menu-new-project').click();
  await expect(page.locator('#notice-modal')).toContainText('New project');
  await page.locator('#notice-modal-reload').click();
  await expect(page.locator('.library-btn[data-id^="nodes-"]')).toHaveCount(0);
  const state = await page.evaluate(async () => (await (await import('/src/platform/handleStorage.js')).createHandleStorage('viz2-node-patterns')('handles')));
  expect(state).toEqual({ folder: null, opened: [], hidden: [], references: [] });
});

test('New Project clears linked, opened, hidden, and referenced node files, while Unlink keeps them and older folder identities @core', async ({ page }) => {
  await page.goto('/?role=control');
  await expect(page.locator('#config-panel')).toBeVisible();
  const initial = await page.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const { createHandleStorage } = await import('/src/platform/handleStorage.js');
    const { ensureProjectFolder } = await import('/src/platform/project-folders.js');
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('older-node-folder', { create: true });
    const opened = await dir.getFileHandle('opened.nodes.json', { create: true });
    const store = createHandleStorage('viz2-node-patterns');
    await store('handles', { folder: { id: 'older-folder-id', handle: dir }, opened: [{ id: 'nodes-opened', handle: opened }], hidden: ['hidden.nodes.json'], references: [{ fileName: 'linked.nodes.json', id: 'nodes-linked', linked: true }] });
    const identity = await ensureProjectFolder('nodes', dir);
    await nodePatterns.unlink();
    const afterUnlink = await store('handles');
    await store('handles', { ...afterUnlink, folder: { id: 'older-folder-id', handle: dir } });
    return { afterUnlink: { folder: afterUnlink.folder, opened: afterUnlink.opened.length, hidden: afterUnlink.hidden.length, references: afterUnlink.references.length }, id: identity.id };
  });
  expect(initial.afterUnlink).toEqual({ folder: null, opened: 1, hidden: 1, references: 1 });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#app-menu-btn').click();
  await page.locator('#app-menu-new-project').click();
  await expect(page.locator('#notice-modal')).toContainText('New project');
  const state = () => page.evaluate(async id => {
    const { createHandleStorage } = await import('/src/platform/handleStorage.js');
    const { recallProjectFolder } = await import('/src/platform/project-folders.js');
    return { nodes: await createHandleStorage('viz2-node-patterns')('handles'), identity: localStorage.getItem('viz2_project_folders'), remembered: (await recallProjectFolder(id))?.handle?.name };
  }, initial.id);
  expect(await state()).toEqual({ nodes: { folder: null, opened: [], hidden: [], references: [] }, identity: null, remembered: 'older-node-folder' });
  await page.locator('#notice-modal-reload').click();
  await expect(page.locator('#config-panel')).toBeVisible();
  expect(await state()).toEqual({ nodes: { folder: null, opened: [], hidden: [], references: [] }, identity: null, remembered: 'older-node-folder' });
});
