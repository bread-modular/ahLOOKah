import { test, expect } from '@playwright/test';
import { folderDetails } from './fixtures/folder-controls.js';

const sections = [
  // `open` is the one control that opens the category picker; `buttons` is the
  // exact header action set, so a duplicated control fails the suite.
  { key: 'scripts', label: 'Custom Scripts', panel: '.custom-scripts-panel', open: 'Open Script', title: 'Open Script', file: 'demo.viz.js', buttons: ['OPEN'] },
  { key: 'nodes', label: 'Node Patterns', panel: '.node-patterns-panel', open: 'Open Pattern', title: 'Open Pattern', file: 'demo.nodes.json', buttons: ['ADD', 'OPEN'] },
  { key: 'media', label: 'Media', panel: '.media-folder-panel', open: 'Add media', title: 'Open Media', file: 'demo.PNG', buttons: ['ADD'] },
];
async function seed(page) {
  await page.evaluate(async () => {
    const { serializeGraph, manifestFor } = await import('/src/nodes/portability.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const graph = { version: 1, name: 'Directory demo', nodes: [
      { id: 'p', type: 'pattern', patternId: 'solid-color', x: 0, y: 0, params: {} },
      { id: 'o', type: 'output', x: 300, y: 0 },
    ], edges: [{ from: 'p', to: 'o', port: 'image' }] };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    const png = await new Promise(resolve => canvas.toBlob(resolve));
    const root = await navigator.storage.getDirectory();
    const contents = {
      scripts: ['demo.viz.js', "window.scriptRuns = (window.scriptRuns || 0) + 1; api.requireVersion(1); api.create({ id: 'custom-dir-demo', name: 'Directory script', draw({p}) { p.background(24); } });"],
      nodes: ['demo.nodes.json', serializeGraph(graph, manifestFor(graph, SKETCHES))],
      media: ['demo.PNG', png],
    };
    for (const [folder, [name, data]] of Object.entries(contents)) {
      const dir = await root.getDirectoryHandle(folder, { create: true });
      for (const [file, value] of [[name, data], ['ignore.txt', 'not supported']]) {
        const writer = await (await dir.getFileHandle(file, { create: true })).createWritable(); await writer.write(value); await writer.close();
      }
      await dir.getDirectoryHandle(`nested-${name}`, { create: true });
    }
    window.showDirectoryPicker = async ({ id }) => root.getDirectoryHandle(id.includes('custom') ? 'scripts' : id.includes('node') ? 'nodes' : 'media');
    window.nativeFilePicks = 0;
    window.showOpenFilePicker = async () => { window.nativeFilePicks++; throw Error('Native picker must not run when linked'); };
  });
}
async function linkAll(page) {
  for (const s of sections) await page.locator(s.panel).getByRole('button', { name: 'Link Folder', exact: true }).click();
}
async function openSelected(page, s) {
  await page.locator(s.panel).getByRole('button', { name: s.open, exact: true }).click();
  const picker = page.getByRole('dialog', { name: s.title, exact: true });
  await picker.getByRole('combobox').selectOption(s.file);
  await picker.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(picker).toHaveCount(0);
}

async function fileDigests(page) {
  return page.evaluate(async sections => {
    const root = await navigator.storage.getDirectory();
    return Promise.all(sections.map(async ({ key, file }) => {
      const data = await (await (await root.getDirectoryHandle(key)).getFileHandle(file)).getFile();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await data.arrayBuffer())));
    }));
  }, sections);
}

for (const s of sections) {
  test(`${s.label}: shared linked picker, text actions, dropdown and clean details @core`, async ({ page }) => {
    await page.goto('/'); await seed(page);
    const panel = page.locator(s.panel);
    await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
    await expect(panel.locator('.library-add-btn')).toHaveText(s.buttons);
    await expect(panel.getByRole('link', { name: /Tutorial|API/ })).toHaveCount(0);
    await expect(panel.locator('.library-add-btn svg')).toHaveCount(0);
    const details = await folderDetails(page, s.label);
    await expect(details.getByRole('button', { name: /Copy/ })).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Relink Folder', exact: true })).toBeVisible();
    await expect(details).toContainText('Same-name folders');
    await page.keyboard.press('Escape');
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await panel.getByRole('button', { name: s.open, exact: true }).click();
    const picker = page.getByRole('dialog', { name: s.title, exact: true });
    await expect(picker).toHaveClass(/directory-picker/);
    const select = picker.getByRole('combobox');
    await expect(select.locator('option')).toHaveText(['Select a file…', s.file]);
    await expect(select).toHaveClass('control-select');
    await expect(select).toHaveCSS('appearance', 'none');
    expect(await select.evaluate(el => getComputedStyle(el).backgroundImage)).toContain('svg');
    expect(await select.evaluate(el => getComputedStyle(el).backgroundPosition)).toBe('calc(100% - 10px) 50%');
    if (s.key === 'scripts') await expect(picker).toContainText('not in a sandbox');
    await select.selectOption(s.file);
    await picker.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(picker).toHaveCount(0);
    if (s.key === 'media') {
      await panel.getByRole('button', { name: 'Add media', exact: true }).click();
      await expect(picker).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(panel.getByRole('button', { name: 'Add media', exact: true })).toBeFocused();
    }
    expect(await page.evaluate(() => window.nativeFilePicks)).toBe(0);
    expect(errors).toEqual([]);
  });

  test(`${s.label}: shared loading, empty, permission and deleted-file feedback @core`, async ({ page }) => {
    await page.goto('/'); await seed(page);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const panel = page.locator(s.panel);
    await panel.getByRole('button', { name: 'Link Folder', exact: true }).click();
    await expect(panel.getByRole('button', { name: s.open, exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const entries = FileSystemDirectoryHandle.prototype.entries;
      window.finishScan = null;
      FileSystemDirectoryHandle.prototype.entries = async function* () {
        await new Promise(resolve => { window.finishScan = resolve; });
        yield* entries.call(this);
      };
      window.restoreEntries = () => { FileSystemDirectoryHandle.prototype.entries = entries; };
    });
    await panel.getByRole('button', { name: s.open, exact: true }).click();
    const picker = page.getByRole('dialog', { name: s.title, exact: true });
    await expect(picker.getByRole('status')).toHaveText('Reading files…');
    await expect(picker.getByRole('button', { name: 'Open', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => !!window.finishScan)).toBe(true);
    await page.evaluate(() => { window.restoreEntries(); window.finishScan(); });
    await picker.getByRole('combobox').selectOption(s.file);
    await page.evaluate(async ({ key, file }) => { await (await (await navigator.storage.getDirectory()).getDirectoryHandle(key)).removeEntry(file); }, s);
    await picker.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(picker.getByRole('alert')).toBeVisible();
    await page.keyboard.press('Escape');
    await panel.getByRole('button', { name: s.open, exact: true }).click();
    await expect(picker.getByRole('status')).toContainText('No supported files');
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      FileSystemHandle.prototype.queryPermission = async () => 'denied';
      FileSystemHandle.prototype.requestPermission = async () => 'denied';
    });
    await panel.getByRole('button', { name: s.open, exact: true }).click();
    await expect(picker.getByRole('alert')).toContainText(/denied/i);
    expect(await page.evaluate(() => window.nativeFilePicks)).toBe(0);
    expect(errors).toEqual([]);
  });
}

test('project export roundtrip: all references, wrong-folder blocking, relink and stable IDs @core', async ({ page }) => {
  await page.goto('/'); await seed(page); await linkAll(page);
  await openSelected(page, sections[0]);
  const originalFiles = await fileDigests(page);
  const exported = await page.evaluate(async () => (await import('/src/platform/settings-portability.js')).collectSettings());
  for (const s of sections) {
    expect(exported.folders[s.key].folderName).toBe(s.key);
    expect(exported.folders[s.key].files.map(f => f.fileName)).toContain(s.file);
  }
  expect(exported.media[0].folderName).toBe('media');
  const text = JSON.stringify(exported);
  expect(text).not.toMatch(/"handle"|"blob"|"sources"|scriptRuns/);
  const imported = await page.evaluate(async text => {
    const { parseSettingsFile, applySettings, collectSettings } = await import('/src/platform/settings-portability.js');
    const parsed = parseSettingsFile(text); if (!parsed.ok) throw Error(parsed.error);
    await applySettings(parsed.payload);
    const roundtrip = await collectSettings();
    const { createHandleStorage } = await import('/src/platform/handleStorage.js');
    const wrong = await (await navigator.storage.getDirectory()).getDirectoryHandle('wrong-folder', { create: true });
    const scripts = createHandleStorage('viz2-custom-scripts');
    await scripts('active', { ...await scripts('active'), folder: wrong });
    const nodes = createHandleStorage('viz2-node-patterns');
    await nodes('handles', { ...await nodes('handles'), folder: { id: 'wrong-id', handle: wrong } });
    await createHandleStorage('viz2-media-folder')('folder', wrong);
    return roundtrip;
  }, text);
  expect(imported.folders).toEqual(exported.folders);
  await page.reload();
  await expect(page.locator('[data-id="custom-dir-demo"]')).toHaveCount(0);
  for (const s of sections) await expect(page.locator(s.panel)).toContainText(`expected folder “${s.key}”, found “wrong-folder”`);
  await expect(page.locator('.library-btn[data-id^="nodes-"]')).toHaveCount(0);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    window.showDirectoryPicker = async () => root.getDirectoryHandle('wrong-folder');
  });
  for (const s of sections) {
    const details = await folderDetails(page, s.label);
    await details.getByRole('button', { name: 'Relink Folder', exact: true }).click();
    await expect(details.getByRole('alert')).toContainText(`expected folder “${s.key}”`);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    window.showDirectoryPicker = async ({ id }) => root.getDirectoryHandle(id.includes('custom') ? 'scripts' : id.includes('node') ? 'nodes' : 'media');
  });
  for (const s of sections) {
    const details = await folderDetails(page, s.label);
    await details.getByRole('button', { name: 'Relink Folder', exact: true }).click();
    await expect(details.locator('.folder-details-name')).toHaveText(s.key);
    await expect(details.getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
  // Relinking is not permission to execute JavaScript.
  expect(await page.evaluate(() => window.scriptRuns || 0)).toBe(0);
  await openSelected(page, sections[0]);
  await expect(page.locator('[data-id="custom-dir-demo"]')).toHaveCount(1);
  const restored = await page.evaluate(async () => (await import('/src/platform/settings-portability.js')).collectSettings());
  expect(restored.folders).toEqual(exported.folders);
  expect(restored.media.map(m => m.id)).toEqual(exported.media.map(m => m.id));
  expect(await fileDigests(page)).toEqual(originalFiles);
  await expect(page.locator(`.library-btn[data-id="${exported.folders.nodes.files[0].id}"]`)).toHaveCount(1);
  await page.reload();
  for (const s of sections) await expect(page.locator(s.panel)).not.toContainText('expected folder');
});

test('reference validation: legacy, hostile fields, missing files, permission and same-name confirmation @core', async ({ page }) => {
  await page.goto('/tests/fixtures/render.html'); await seed(page);
  const result = await page.evaluate(async () => {
    const { parseSettingsFile, applySettings, collectSettings } = await import('/src/platform/settings-portability.js');
    const { importFolderReferences, assertFolderReference, missingFolderFiles } = await import('/src/platform/folderReferences.js');
    const { MediaFolder } = await import('/src/media/folderService.js');
    const { NodePatterns } = await import('/src/nodes/repository.js');
    const { CustomScripts } = await import('/src/custom-scripts/service.js');
    const refs = Object.fromEntries(['scripts', 'nodes', 'media'].map(key => [key, { folderName: key, files: [{ fileName: key === 'scripts' ? 'missing.viz.js' : key === 'nodes' ? 'missing.nodes.json' : 'missing.png', linked: true }] }]));
    importFolderReferences(refs);
    const root = await navigator.storage.getDirectory();
    const messages = [];
    for (const key of ['scripts', 'nodes', 'media']) {
      try { assertFolderReference(key, await root.getDirectoryHandle(key)); } catch (e) { messages.push(e.message); }
    }
    const scripts = new CustomScripts(); await scripts.start(); await scripts.choose();
    const nodes = new NodePatterns(); await nodes.link();
    const media = new MediaFolder(); await media.start(); await media.link();
    const missing = [scripts.status.errors, nodes.errors, media.status.errors];
    FileSystemHandle.prototype.queryPermission = async () => 'denied';
    FileSystemHandle.prototype.requestPermission = async () => 'denied';
    const denied = [];
    for (const service of [scripts, nodes, media]) { try { await service.browse(); } catch (e) { denied.push(e.message); } }
    const exportDenied = await collectSettings();
    const base = { app: 'ahlookah', kind: 'ahlookah-settings', version: 1, storage: {}, media: [] };
    const legacy = parseSettingsFile(JSON.stringify(base));
    const malicious = structuredClone(refs); malicious.nodes.files[0].fileName = '../outside.nodes.json';
    const bad = parseSettingsFile(JSON.stringify({ ...base, folders: malicious }));
    const extras = parseSettingsFile(JSON.stringify({ ...base, folders: { ...refs, scripts: { ...refs.scripts, handle: { name: 'native' }, sources: ['evil'] } } }));
    await applySettings(legacy.payload);
    scripts.close(); media.close();
    return { messages, missing, denied, legacy: legacy.ok, bad: bad.ok, extras: extras.payload.folders, exportDenied: exportDenied.folders, remaining: localStorage.getItem('viz2_folder_references') };
  });
  expect(result.messages).toHaveLength(3);
  for (const m of result.messages) expect(m).toContain('names alone cannot identify');
  for (const errors of result.missing) expect(errors.join(' ')).toContain('missing');
  for (const error of result.denied) expect(error).toMatch(/denied/i);
  expect(result.denied).toHaveLength(3);
  expect(result.legacy).toBe(true); expect(result.bad).toBe(false); expect(result.remaining).toBeNull();
  expect(result.extras.scripts).not.toHaveProperty('handle');
  expect(result.extras.scripts).not.toHaveProperty('sources');
  expect(result.exportDenied.nodes.files.some(f => f.fileName === 'missing.nodes.json')).toBe(true);
});

test('linked library screenshots @core', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto('/'); await seed(page); await linkAll(page);
  for (const toggle of await page.locator('.library-group-toggle').all()) {
    const label = (await toggle.textContent()).trim();
    if (!sections.some(s => s.label === label) && await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
  }
  await page.locator('.custom-scripts-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/hello-nodes-linked.png' });
  await page.getByRole('button', { name: 'Open Script', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('combobox').locator('option')).toHaveCount(2);
  await page.screenshot({ path: '/tmp/hello-nodes-picker.png' });
  await page.keyboard.press('Escape');
  await folderDetails(page, 'Media');
  await page.screenshot({ path: '/tmp/hello-nodes-details.png' });
});


test('main project import in a fresh browser requires relink; missing handles never open a native file picker @core', async ({ page, browser }) => {
  await page.goto('/'); await seed(page); await linkAll(page); await openSelected(page, sections[0]);
  const payload = await page.evaluate(async () => (await import('/src/platform/settings-portability.js')).collectSettings());
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: { cookies: [], origins: [{ origin: new URL(page.url()).origin, localStorage: [{ name: 'viz2_device_setup_done', value: '1' }] }] } });
  try {
    const destination = await context.newPage(); await destination.goto('/');
    await destination.locator('#app-menu-btn').click();
    await destination.locator('#settings-import-input').setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
    await expect(destination.locator('#notice-modal')).toContainText('Relink each imported folder');
    await destination.locator('#notice-modal-reload').click();
    for (const s of sections) {
      await expect(destination.locator(s.panel)).toContainText(`expected folder “${s.key}”, found no linked folder`);
      await expect(destination.locator(s.panel).getByRole('button', { name: 'Relink Folder', exact: true })).toBeVisible();
    }
    await seed(destination);
    for (const s of sections) await destination.locator(s.panel).getByRole('button', { name: 'Relink Folder', exact: true }).click();
    await expect(destination.locator('.library-btn[data-id^="nodes-"]')).toHaveAttribute('data-id', payload.folders.nodes.files[0].id);
    await expect(destination.locator('.library-btn[data-id^="media-"]')).toHaveAttribute('data-id', `media-${payload.media[0].id}`);
    expect(await destination.evaluate(() => window.scriptRuns || 0)).toBe(0);
    await openSelected(destination, sections[0]);
    expect(await destination.evaluate(() => window.nativeFilePicks)).toBe(0);
    const restored = await destination.evaluate(async () => (await import('/src/platform/settings-portability.js')).collectSettings());
    expect(restored.folders).toEqual(payload.folders);
  } finally { await context.close(); }
});


test('node palette scrollbar has a stable themed gutter, separated from items @core', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?role=nodes');
  const list = page.locator('.nodes-pattern-list');
  await expect(list.locator('.btn').first()).toBeVisible();
  await expect(list).toHaveCSS('padding-inline-end', '8px');
  await expect(list).toHaveCSS('scrollbar-gutter', 'stable');
  await expect(list).toHaveCSS('scrollbar-width', 'thin');
  const metrics = await list.evaluate(el => {
    const item = el.querySelector('.btn').getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { gap: box.right - item.right, overflows: el.scrollHeight > el.clientHeight, horizontal: el.scrollWidth > el.clientWidth, colors: style.scrollbarColor };
  });
  expect(metrics.gap).toBeGreaterThanOrEqual(8);
  expect(metrics.overflows).toBe(true); expect(metrics.horizontal).toBe(false);
  expect(metrics.colors).not.toBe('auto');
  await list.locator('.btn').last().scrollIntoViewIfNeeded();
  await expect(list.locator('.btn').last()).toBeVisible();
  await list.locator('.btn').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/hello-nodes-scrollbar.png' });
});
