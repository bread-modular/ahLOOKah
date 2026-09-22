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
  await seed(page);
  await linkAll(page);
  await addMediaFromFolder(page, 'one.PNG');
  await addMediaFromFolder(page, 'two.PNG');
  await openScript(page);
  await expect(page.locator('.library-btn[data-id="custom-dir-demo"]')).toBeVisible();

  const project = await projectFor(page);
  for (const s of SECTIONS) expect(project.folders[s.key].folderId, s.key).toBeTruthy();
  expect(project.folders.media.files.map(f => f.fileName)).toContain('one.PNG');
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
