import { test, expect } from '@playwright/test';
import { folderAction } from './fixtures/folder-controls.js';

// E2E: projects (Menu → Save Project / Open Project / New Project) and their linked
// directories.
//
// A project file carries the identity of each linked directory (Custom Scripts,
// Node Patterns, Media) — never a native handle. On the computer the project was
// saved from, that identity resolves to the directory that is already linked, so
// switching between projects never asks to re-link anything. On another computer
// the blocking relink dialog appears and the open does not complete until every
// directory is linked. Missing *files* inside a linked directory never block: the
// affected patterns are marked red in the library instead, and scripts reopen by
// code fingerprint (see the script tests below).

const SCRIPT_SOURCE = "window.scriptRuns = (window.scriptRuns || 0) + 1; api.requireVersion(1); api.create({ id: 'custom-dir-demo', name: 'Directory script', draw({p}) { p.background(24); } });";
const EDITED_SOURCE = "window.scriptRuns = (window.scriptRuns || 0) + 1; api.requireVersion(1); api.create({ id: 'custom-dir-demo-edited', name: 'Edited script', draw({ p }) { p.background(24); } });";

const SECTIONS = [
  { key: 'scripts', label: 'Custom Scripts', panel: '.custom-scripts-panel', title: 'Open Script', file: 'demo.viz.js' },
  { key: 'nodes', label: 'Node Patterns', panel: '.node-patterns-panel', title: 'Open Pattern', file: 'demo.nodes.json' },
  { key: 'media', label: 'Media', panel: '.media-folder-panel', title: 'Open Media' },
];

// One seeded "computer": three real directories in OPFS plus a stubbed picker, so
// directory handles are structured-cloneable exactly like desktop Chrome's.
async function seed(page, mediaFiles = ['one.PNG', 'two.PNG'], scriptSource = SCRIPT_SOURCE) {
  await page.evaluate(async ({ media, source }) => {
    const { serializeGraph, manifestFor } = await import('/src/nodes/portability.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const graph = { version: 1, name: 'Directory demo', nodes: [
      { id: 'p', type: 'pattern', patternId: 'solid-color', x: 0, y: 0, params: {} },
      { id: 'o', type: 'output', x: 300, y: 0 },
    ], edges: [{ from: 'p', to: 'o', port: 'image' }] };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    const png = await new Promise(resolve => canvas.toBlob(resolve));
    const contents = {
      scripts: [['demo.viz.js', source]],
      nodes: [['demo.nodes.json', serializeGraph(graph, manifestFor(graph, SKETCHES))]],
      media: media.map(name => [name, png]),
    };
    const root = await navigator.storage.getDirectory();
    for (const [folder, entries] of Object.entries(contents)) {
      const dir = await root.getDirectoryHandle(folder, { create: true });
      for (const [name, data] of [...entries, ['ignore.txt', 'not supported']]) {
        const writer = await (await dir.getFileHandle(name, { create: true })).createWritable(); await writer.write(data); await writer.close();
      }
      await dir.getDirectoryHandle(`nested-${folder}`, { create: true });
    }
    window.showDirectoryPicker = async ({ id }) => root.getDirectoryHandle(id.includes('custom') ? 'scripts' : id.includes('node') ? 'nodes' : 'media');
    window.nativeFilePicks = 0;
    window.showOpenFilePicker = async () => { window.nativeFilePicks++; throw Error('Native picker must not run when linked'); };
  }, { media: mediaFiles, source: scriptSource });
}

// Rewrite the seeded script on this "computer" (as an external editor would).
async function writeScript(page, text) {
  await page.evaluate(async (source) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('scripts');
    const writer = await (await dir.getFileHandle('demo.viz.js')).createWritable();
    await writer.write(source);
    await writer.close();
  }, text);
}

async function addNodePattern(page, name = 'demo.nodes.json') {
  await page.evaluate(async name => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    await nodePatterns.open(name);
  }, name);
}

// A second .nodes.json in the same directory that this browser never added: the
// library must not list it just because it is there.
async function writeExtraNodePattern(page) {
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('nodes');
    const text = await (await (await dir.getFileHandle('demo.nodes.json')).getFile()).text();
    const writer = await (await dir.getFileHandle('extra.nodes.json', { create: true })).createWritable();
    await writer.write(text); await writer.close();
  });
}

async function linkAll(page) {
  for (const s of SECTIONS) await page.locator(s.panel).getByRole('button', { name: 'Link Folder', exact: true }).click();
}

async function addMediaFromFolder(page, file) {
  await page.locator('.media-folder-panel').getByRole('button', { name: 'Add media', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Open Media', exact: true });
  await picker.getByRole('combobox').selectOption(file);
  await picker.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(picker).toHaveCount(0);
}

async function saveProject(page, project, name = 'project.json') {
  await page.locator('#app-menu-btn').click();
  await page.locator('#project-open-input').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
}

function projectFor(page) {
  return page.evaluate(async () => (await import('/src/platform/settings-portability.js')).collectSettings());
}

// OPEN → pick “demo.viz.js” from the linked folder (the explicit trust gesture).
async function openScript(page) {
  await page.locator('.custom-scripts-panel').getByRole('button', { name: 'Open Script', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Open Script', exact: true });
  await picker.getByRole('combobox').selectOption('demo.viz.js');
  await picker.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(picker).toHaveCount(0);
}

test('the same computer resumes every linked directory of a saved project without relinking @core', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await seed(page, ['one.PNG', 'two.PNG', 'extra.PNG']);
  await writeExtraNodePattern(page);
  await linkAll(page);
  // Linking a directory loads nothing: files are added one by one.
  await addMediaFromFolder(page, 'one.PNG');
  await addMediaFromFolder(page, 'two.PNG');
  await openScript(page);
  await addNodePattern(page);
  await expect(page.locator('.library-btn[data-id="custom-dir-demo"]')).toBeVisible();

  const project = await projectFor(page);
  for (const s of SECTIONS) expect(project.folders[s.key].folderId, s.key).toBeTruthy();
  expect(project.folders.media.files.map(f => f.fileName)).toContain('one.PNG');
  expect(project.folders.nodes.files.map(f => f.fileName)).toEqual(['demo.nodes.json']);
  expect(project.folders.scripts.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  const mediaId = project.media.find(m => m.fileName === 'one.PNG').id;

  await saveProject(page, project);

  // Identity resolution means nothing is asked: no relink dialog at all.
  await expect(page.locator('#project-relink-modal')).toHaveCount(0);
  const notice = page.locator('#notice-modal');
  await expect(notice).toContainText('Project opened');
  await expect(notice).toContainText('Linked directories resumed on this computer: Custom Scripts, Node Patterns, Media.');
  await page.locator('#notice-modal-reload').click();

  for (const s of SECTIONS) await expect(page.locator(s.panel)).toContainText('Linked');
  await expect(page.locator(`.library-btn[data-id="media-${mediaId}"]`)).toBeVisible();
  await expect(page.locator(`.library-btn[data-id="${project.folders.nodes.files[0].id}"]`)).toBeVisible();
  // …and it restores exactly what the project recorded. The linked directories
  // hold extra.PNG and extra.nodes.json, which the project never had: a project
  // open is a mirror of the file, not a directory listing.
  await expect(page.locator('.library-btn[data-id^="media-"]')).toHaveCount(2);
  await expect(page.locator('.library-btn[data-id^="nodes-"]')).toHaveCount(1);
  await expect(page.locator('.library-btn[data-id^="media-"]', { hasText: 'extra' })).toHaveCount(0);
  // The script came back by itself: the project recorded a fingerprint of its code
  // and the linked folder still holds those exact bytes.
  await expect(page.locator('.library-btn[data-id="custom-dir-demo"]')).toBeVisible();
  await expect(page.locator('.custom-scripts-panel')).toContainText('Reopened with this project: demo.viz.js');
  expect(await page.evaluate(() => window.scriptRuns || 0)).toBe(1);
  // The media file came back with its directory: no pattern is marked red and the
  // panel never offers Relink File for it.
  await expect(page.locator('.library-btn.is-missing-file')).toHaveCount(0);
  await page.locator(`.library-btn[data-id="media-${mediaId}"]`).click();
  await expect(page.locator('#media-relink-btn')).toBeHidden();
});

test('a project restores its own files even when the linked directories hold more files than the picker caps @core', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await seed(page);
  await linkAll(page);
  // Add this project's own files first: the OPEN/ADD pickers are the ones bounded
  // by the folder caps (64 node patterns, 256 media files), so a directory past
  // them can no longer be listed — but a project reopen must not be affected.
  await addMediaFromFolder(page, 'one.PNG');
  await openScript(page);
  await addNodePattern(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const nodes = await root.getDirectoryHandle('nodes');
    const graph = await (await (await nodes.getFileHandle('demo.nodes.json')).getFile()).text();
    for (let i = 0; i < 70; i++) {
      const writer = await (await nodes.getFileHandle(`filler-${i}.nodes.json`, { create: true })).createWritable();
      await writer.write(graph); await writer.close();
    }
    const media = await root.getDirectoryHandle('media');
    const image = await (await (await media.getFileHandle('one.PNG')).getFile()).arrayBuffer();
    for (let i = 0; i < 260; i++) {
      const writer = await (await media.getFileHandle(`filler-${i}.PNG`, { create: true })).createWritable();
      await writer.write(image); await writer.close();
    }
  });
  const project = await projectFor(page);
  // The project records the files it has, never the 330 files it does not.
  expect(project.folders.nodes.files.map(f => f.fileName)).toEqual(['demo.nodes.json']);
  expect(project.media.map(m => m.fileName)).toEqual(['one.PNG']);
  await saveProject(page, project);
  await expect(page.locator('#project-relink-modal')).toHaveCount(0);
  await page.locator('#notice-modal-reload').click();
  await expect(page.locator(`.library-btn[data-id="${project.folders.nodes.files[0].id}"]`)).toHaveCount(1);
  await expect(page.locator('.library-btn[data-id^="nodes-"]')).toHaveCount(1);
  await expect(page.locator('.library-btn[data-id^="media-"]')).toHaveCount(1);
  await expect(page.locator('.library-btn[data-id^="media-"]', { hasText: 'filler' })).toHaveCount(0);
  await expect(page.locator('.library-btn[data-id="custom-dir-demo"]')).toBeVisible();
  expect(await page.evaluate(() => window.scriptRuns || 0)).toBe(1);
});

test('a project from another computer blocks on its directories, and a missing file is marked red instead @core', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await seed(page);
  await linkAll(page);
  await addMediaFromFolder(page, 'one.PNG');
  await addMediaFromFolder(page, 'two.PNG');
  await openScript(page);
  const project = await projectFor(page);
  const presentId = project.media.find(m => m.fileName === 'one.PNG').id;
  const missingId = project.media.find(m => m.fileName === 'two.PNG').id;

  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    storageState: { cookies: [], origins: [{ origin: new URL(page.url()).origin, localStorage: [{ name: 'viz2_device_setup_done', value: '1' }] }] },
  });
  try {
    const destination = await context.newPage();
    await destination.goto('/');
    await seed(destination);
    // This computer has no “two.PNG”.
    await destination.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      await (await root.getDirectoryHandle('media')).removeEntry('two.PNG');
    });

    await saveProject(destination, project);

    // Blocking dialog: every directory of the project is listed, nothing dismisses
    // the dialog, and the save has not completed.
    const modal = destination.locator('#project-relink-modal');
    await expect(modal).toBeVisible();
    for (const s of SECTIONS) await expect(modal.locator(`[data-section="${s.key}"]`)).toContainText(s.label);
    for (const s of SECTIONS) await expect(modal.locator(`[data-section="${s.key}"]`)).toContainText(`Expected folder: ${s.key}`);
    await expect(destination.locator('#notice-modal')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Close' })).toHaveCount(0);
    await destination.keyboard.press('Escape');
    await expect(modal).toBeVisible();

    // Linking one directory leaves the project incomplete.
    await modal.locator('#project-relink-link-media').click();
    await expect(modal.locator('[data-section="media"]')).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(destination.locator('#notice-modal')).toHaveCount(0);

    await modal.locator('#project-relink-link-scripts').click();
    await modal.locator('#project-relink-link-nodes').click();

    // The last link completes the save even though “two.PNG” is not here.
    await expect(modal).toHaveCount(0);
    const notice = destination.locator('#notice-modal');
    await expect(notice).toContainText('Project opened');
    await destination.locator('#notice-modal-reload').click();

    // The file that is missing here is marked red in the library (and on the pad),
    // while the file that is present is untouched.
    const missingItem = destination.locator(`.library-btn[data-id="media-${missingId}"]`);
    await expect(missingItem).toHaveClass(/is-missing-file/);
    await expect(missingItem.locator('.missing-file-badge')).toBeVisible();
    const presentItem = destination.locator(`.library-btn[data-id="media-${presentId}"]`);
    await expect(presentItem).toBeVisible();
    await expect(presentItem).not.toHaveClass(/is-missing-file/);

    // Selecting the red pattern still works and offers Relink File.
    await missingItem.click();
    await expect(destination.locator('#media-relink-btn')).toBeVisible();
    await expect(destination.locator('#params-list')).toContainText('Relink File');

    // Every directory is linked now, and the project identity travelled intact.
    for (const s of SECTIONS) await expect(destination.locator(s.panel)).toContainText('Linked');
    const restored = await projectFor(destination);
    expect(restored.folders).toEqual(project.folders);
    // The project listed “demo.viz.js” with a fingerprint of its code, and this
    // computer's linked folder holds the same bytes: it reopened by itself.
    expect(await destination.evaluate(() => window.scriptRuns || 0)).toBe(1);
    await expect(destination.locator('.library-btn[data-id="custom-dir-demo"]')).toBeVisible();
    expect(await destination.evaluate(() => window.nativeFilePicks || 0)).toBe(0);
  } finally {
    await context.close();
  }
});

test('OPFS directory identities survive same-named and differently-named relinks in all sections @core', async ({ page }) => {
  await page.goto('/');
  const cases = await page.evaluate(async () => {
    const folders = await import('/src/platform/project-folders.js');
    const { applyFolderReferences } = await import('/src/platform/folder-portability.js');
    const { createHandleStorage } = await import('/src/platform/handleStorage.js');
    const { scriptStorage } = await import('/src/custom-scripts/storage.js');
    const root = await navigator.storage.getDirectory();
    const sections = ['scripts', 'nodes', 'media'];
    const results = [];
    for (const variant of ['same-name', 'different-name']) {
      folders.clearProjectFolders();
      const baseA = await root.getDirectoryHandle(`f03-${variant}-a`, { create: true });
      const baseB = await root.getDirectoryHandle(`f03-${variant}-b`, { create: true });
      const originals = {}, replacements = {}, first = {}, second = {};
      for (const section of sections) {
        const a = await baseA.getDirectoryHandle(section, { create: true });
        const b = await baseB.getDirectoryHandle(variant === 'same-name' ? section : `${section}-other`, { create: true });
        originals[section] = a;
        replacements[section] = b;
        first[section] = (await folders.ensureProjectFolder(section, a)).id;
        const anotherHandleForA = await baseA.getDirectoryHandle(section);
        if ((await folders.ensureProjectFolder(section, anotherHandleForA)).id !== first[section]) throw Error('same handle changed identity');
        second[section] = (await folders.ensureProjectFolder(section, b)).id;
        if (first[section] === second[section]) throw Error('different handles shared identity');
        if (await folders.rememberProjectFolder(first[section], section, b)) throw Error('remember overwrote a different handle');
        try { await folders.ensureProjectFolder(section, b, first[section]); throw Error('explicit adoption overwrote a different handle'); }
        catch (error) { if (!/already belongs/.test(error.message)) throw error; }
        if (!await (await folders.recallProjectFolder(first[section])).handle.isSameEntry(a)) throw Error('old handle was replaced');
        if (!await (await folders.recallProjectFolder(second[section])).handle.isSameEntry(b)) throw Error('new handle was lost');
      }
      // Relink the first directory after the second was current. The bounded
      // remembered registry, not its basename, finds the original identity.
      for (const section of sections) {
        if ((await folders.ensureProjectFolder(section, originals[section])).id !== first[section]) throw Error('old handle got a new identity');
      }
      const reference = (which, handles) => Object.fromEntries(sections.map(section => [section, {
        folderName: handles[section].name, folderId: which[section], files: [],
      }]));
      const aOpen = await applyFolderReferences(reference(first, originals));
      const scriptA = (await scriptStorage('active')).folder;
      const nodeA = (await createHandleStorage('viz2-node-patterns')('handles')).folder.handle;
      const mediaA = await createHandleStorage('viz2-media-folder')('folder');
      const bOpen = await applyFolderReferences(reference(second, replacements));
      const scriptB = (await scriptStorage('active')).folder;
      const nodeB = (await createHandleStorage('viz2-node-patterns')('handles')).folder.handle;
      const mediaB = await createHandleStorage('viz2-media-folder')('folder');
      results.push({
        variant, first, second,
        aOpen: { resolved: aOpen.resolved, pending: aOpen.pending },
        bOpen: { resolved: bOpen.resolved, pending: bOpen.pending },
        adoptedA: [await scriptA.isSameEntry(originals.scripts), await nodeA.isSameEntry(originals.nodes), await mediaA.isSameEntry(originals.media)],
        adoptedB: [await scriptB.isSameEntry(replacements.scripts), await nodeB.isSameEntry(replacements.nodes), await mediaB.isSameEntry(replacements.media)],
      });
    }
    return results;
  });
  for (const result of cases) {
    for (const section of ['scripts', 'nodes', 'media']) expect(result.second[section], result.variant).not.toBe(result.first[section]);
    expect(result.aOpen).toEqual({ resolved: ['scripts', 'nodes', 'media'], pending: [] });
    expect(result.bOpen).toEqual({ resolved: ['scripts', 'nodes', 'media'], pending: [] });
    expect(result.adoptedA).toEqual([true, true, true]);
    expect(result.adoptedB).toEqual([true, true, true]);
  }
});

test('ordinary Relink Folder in each service keeps older same-named project handles @core', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const location of ['old', 'new']) {
      const parent = await root.getDirectoryHandle(`f03-service-${location}`, { create: true });
      for (const section of ['scripts', 'nodes', 'media']) await parent.getDirectoryHandle(section, { create: true });
    }
    const media = await (await root.getDirectoryHandle('f03-service-old')).getDirectoryHandle('media');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    const image = await new Promise(resolve => canvas.toBlob(resolve));
    const writer = await (await media.getFileHandle('one.PNG', { create: true })).createWritable();
    await writer.write(image); await writer.close();
    window.f03Location = 'old';
    window.showDirectoryPicker = async ({ id }) => {
      const section = id.includes('custom') ? 'scripts' : id.includes('node') ? 'nodes' : 'media';
      return (await root.getDirectoryHandle(`f03-service-${window.f03Location}`)).getDirectoryHandle(section);
    };
  });
  await linkAll(page);
  await addMediaFromFolder(page, 'one.PNG');
  const older = await projectFor(page);
  expect(older.folders.media.files.find(file => file.fileName === 'one.PNG').linked).toBe(true);
  await page.evaluate(() => { window.f03Location = 'new'; });
  for (const section of SECTIONS) await folderAction(page, section.label, 'Relink Folder');
  const newer = await projectFor(page);
  expect(newer.folders.media.files.find(file => file.fileName === 'one.PNG')?.linked).toBe(false);
  for (const section of SECTIONS) {
    expect(newer.folders[section.key].folderName).toBe(older.folders[section.key].folderName);
    expect(newer.folders[section.key].folderId).not.toBe(older.folders[section.key].folderId);
  }
  await saveProject(page, older);
  await expect(page.locator('#project-relink-modal')).toHaveCount(0);
  await expect(page.locator('#notice-modal')).toContainText('Project opened');
  const physical = await page.evaluate(async (saved) => {
    const { createHandleStorage } = await import('/src/platform/handleStorage.js');
    const { scriptStorage } = await import('/src/custom-scripts/storage.js');
    const { recallProjectFolder } = await import('/src/platform/project-folders.js');
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle('f03-service-old');
    const current = {
      scripts: (await scriptStorage('active')).folder,
      nodes: (await createHandleStorage('viz2-node-patterns')('handles')).folder.handle,
      media: await createHandleStorage('viz2-media-folder')('folder'),
    };
    return Promise.all(['scripts', 'nodes', 'media'].map(async section => {
      const expected = await parent.getDirectoryHandle(section);
      const remembered = (await recallProjectFolder(saved.folders[section].folderId)).handle;
      return await current[section].isSameEntry(expected) && await remembered.isSameEntry(expected);
    }));
  }, older);
  expect(physical).toEqual([true, true, true]);
});

test('after opening a project, an ordinary different-name relink retires old references but not its handle @core', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await seed(page);
  await linkAll(page);
  const older = await projectFor(page);
  await saveProject(page, older);
  await expect(page.locator('#project-relink-modal')).toHaveCount(0);
  await page.locator('#notice-modal-reload').click();
  // Re-picking the actual old handles (new JS handle objects) keeps both ids and
  // file references, unlike replacing them with another same/different name.
  await seed(page);
  for (const section of SECTIONS) await folderAction(page, section.label, 'Relink Folder');
  const sameEntry = await projectFor(page);
  for (const section of SECTIONS) {
    expect(sameEntry.folders[section.key].folderId).toBe(older.folders[section.key].folderId);
    if (section.key !== 'media') expect(sameEntry.folders[section.key].files).toEqual(older.folders[section.key].files);
  }
  // The Media service may discover additional files on a subsequent scan;
  // that does not change the directory identity.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const section of ['scripts', 'nodes', 'media']) await root.getDirectoryHandle(`${section}-next`, { create: true });
    window.showDirectoryPicker = async ({ id }) => root.getDirectoryHandle(
      `${id.includes('custom') ? 'scripts' : id.includes('node') ? 'nodes' : 'media'}-next`);
  });
  for (const section of SECTIONS) await folderAction(page, section.label, 'Relink Folder');
  const newer = await projectFor(page);
  for (const section of SECTIONS) {
    expect(newer.folders[section.key].folderName).toBe(`${section.key}-next`);
    expect(newer.folders[section.key].folderId).not.toBe(older.folders[section.key].folderId);
  }
  expect(newer.folders.scripts.files).toEqual([]);
  expect(newer.folders.nodes.files).toEqual([]);
  await saveProject(page, older);
  await expect(page.locator('#project-relink-modal')).toHaveCount(0);
  await expect(page.locator('#notice-modal')).toContainText('Linked directories resumed on this computer: Custom Scripts, Node Patterns, Media.');
  const retained = await page.evaluate(async (saved) => {
    const { recallProjectFolder } = await import('/src/platform/project-folders.js');
    const root = await navigator.storage.getDirectory();
    return Promise.all(['scripts', 'nodes', 'media'].map(async section =>
      (await recallProjectFolder(saved.folders[section].folderId)).handle.isSameEntry(await root.getDirectoryHandle(section))));
  }, older);
  expect(retained).toEqual([true, true, true]);
});

test('an unresolved imported id binds only after confirmation and cannot claim an old handle @core', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { ensureProjectFolder, recallProjectFolder, projectFolderId } = await import('/src/platform/project-folders.js');
    const { applyFolderReferences, collectFolderReferences } = await import('/src/platform/folder-portability.js');
    const { folderReference, confirmFolderReference } = await import('/src/platform/folderReferences.js');
    const { createHandleStorage } = await import('/src/platform/handleStorage.js');
    const { scriptStorage } = await import('/src/custom-scripts/storage.js');
    const root = await navigator.storage.getDirectory();
    const old = await root.getDirectoryHandle('f03-import-old', { create: true });
    const next = await root.getDirectoryHandle('f03-import-new', { create: true });
    const sections = ['scripts', 'nodes', 'media'];
    const oldIds = {}, remoteIds = {}, handles = {};
    for (const section of sections) {
      const previous = await old.getDirectoryHandle(section, { create: true });
      const incoming = await next.getDirectoryHandle(section, { create: true });
      oldIds[section] = (await ensureProjectFolder(section, previous)).id;
      remoteIds[section] = `remote-f03-${section}`;
      handles[section] = incoming;
      if (section === 'scripts') await scriptStorage('active', { selectionVersion: 1, revision: Date.now(), folder: previous, sources: [], files: [], changed: [] });
      if (section === 'nodes') await createHandleStorage('viz2-node-patterns')('handles', { folder: { handle: previous, id: 'old-node-files' }, opened: [] });
      if (section === 'media') await createHandleStorage('viz2-media-folder')('folder', previous);
    }
    const refs = Object.fromEntries(sections.map(section => [section, {
      folderName: section, folderId: remoteIds[section], files: [],
    }]));
    const opened = await applyFolderReferences(refs);
    // Old native handles are still linked in the section stores until the picker
    // confirms the imported directory. Even a matching basename is not proof.
    const before = await collectFolderReferences([]);
    const unconfirmed = sections.map(section => ({
      id: before[section].folderId,
      needsRelink: folderReference(section).needsRelink,
      stored: projectFolderId(section),
    }));
    for (const section of sections) {
      const ordinary = await ensureProjectFolder(section, handles[section]);
      if (ordinary.id === remoteIds[section]) throw Error('ordinary relink adopted an unresolved id');
      await ensureProjectFolder(section, handles[section], remoteIds[section]); // confirmed picker/adoption path
      confirmFolderReference(section);
    }
    const confirmed = sections.map(section => ({ id: projectFolderId(section), needsRelink: folderReference(section).needsRelink }));
    const preserved = await Promise.all(sections.map(async section =>
      (await recallProjectFolder(oldIds[section])).handle.isSameEntry(await old.getDirectoryHandle(section))));
    const adopted = await Promise.all(sections.map(async section =>
      (await recallProjectFolder(remoteIds[section])).handle.isSameEntry(handles[section])));
    // A known id with a different name is remapped to a fresh pending id rather
    // than risking the known directory when the operator later links it.
    const collision = await applyFolderReferences({
      scripts: { folderName: 'not-the-old-scripts', folderId: oldIds.scripts, files: [] },
      nodes: { folderName: null, folderId: null, files: [] },
      media: { folderName: null, folderId: null, files: [] },
    });
    const remapped = folderReference('scripts').folderId;
    return { opened: { resolved: opened.resolved, pending: opened.pending.map(p => p.section) },
      unconfirmed, confirmed, preserved, adopted,
      collision: { pending: collision.pending.map(p => p.reason), remapped, original: oldIds.scripts } };
  });
  expect(result.opened).toEqual({ resolved: [], pending: ['scripts', 'nodes', 'media'] });
  for (let i = 0; i < 3; i++) {
    const section = ['scripts', 'nodes', 'media'][i];
    expect(result.unconfirmed[i]).toEqual({ id: `remote-f03-${section}`, needsRelink: true, stored: `remote-f03-${section}` });
    expect(result.confirmed[i]).toEqual({ id: `remote-f03-${section}`, needsRelink: false });
  }
  expect(result.preserved).toEqual([true, true, true]);
  expect(result.adopted).toEqual([true, true, true]);
  expect(result.collision.pending).toEqual(['changed']);
  expect(result.collision.remapped).not.toBe(result.collision.original);
});

test('a script edited after the project was saved stays closed until OPEN @core', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await seed(page);
  await linkAll(page);
  await openScript(page);
  await expect(page.locator('.library-btn[data-id="custom-dir-demo"]')).toBeVisible();
  expect(await page.evaluate(() => window.scriptRuns || 0)).toBe(1);

  const project = await projectFor(page);
  expect(project.folders.scripts.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);

  // The source file changes after the project was saved.
  await writeScript(page, EDITED_SOURCE);

  await saveProject(page, project);
  await page.locator('#notice-modal-reload').click();

  // The fingerprint no longer matches, so the app does not claim this is the code
  // the project was saved with: it says so, and the explicit trust gesture is
  // required again.
  await expect(page.locator('.custom-scripts-panel')).toContainText('Changed since this project was saved: demo.viz.js');
  await expect(page.locator('.custom-scripts-panel')).toContainText('Open trusted script: demo.viz.js');
  await expect(page.locator('.library-btn[data-id^="custom-"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.scriptRuns || 0)).toBe(0);

  // Putting the fingerprinted code back and renewing folder access (Linked →
  // Refresh) completes the reopen — the gesture that grants permission is enough,
  // no second save or reload needed.
  await writeScript(page, SCRIPT_SOURCE);
  await folderAction(page, 'Custom Scripts', 'Refresh folder');
  await expect(page.locator('.library-btn[data-id="custom-dir-demo"]')).toBeVisible();
  await expect(page.locator('.custom-scripts-panel')).toContainText('Reopened with this project: demo.viz.js');

  // A project file that recorded no fingerprint at all (an older file) must fail
  // closed too: a filename alone is not a claim about the code behind it.
  const withoutDigest = structuredClone(project);
  delete withoutDigest.folders.scripts.files[0].sha256;
  await saveProject(page, withoutDigest);
  await page.locator('#notice-modal-reload').click();
  await expect(page.locator('.custom-scripts-panel')).toContainText('Open trusted script: demo.viz.js (this project recorded no code fingerprint for it)');
  await expect(page.locator('.library-btn[data-id^="custom-"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.scriptRuns || 0)).toBe(0);
});
