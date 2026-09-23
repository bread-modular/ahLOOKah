// Audit probes: record observed behavior without changing application sources.
// Run from the repository root: node .design/node-editor-audit.probes.mjs
// Uses isolated Chromium profiles, OPFS fixtures and a private Vite port.
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const port = Number(process.env.AUDIT_PORT || 5199);
const origin = `http://127.0.0.1:${port}`;
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), probes: {} };
const output = { id: 'output', type: 'output', x: 630, y: 80 };
const pattern = (id, x = 30, y = 70) => ({ id, type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: .8, pulse: 0 }, x, y });
const script = (id, x, y) => ({ id, type: 'script', language: 'body', source: 'return x;', inputX: 0, inputY: 0, x, y });
const graph = nodes => ({ version: 1, name: 'Audit fixture', nodes: [...nodes, output], edges: [] });

async function probe(name, run) {
  const context = await browser.newContext({ viewport: { width: 1536, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('viz2_device_setup_done', '1');
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  try { report.probes[name] = { result: await run(page), pageErrors: errors }; }
  catch (e) { report.probes[name] = { probeError: String(e), pageErrors: errors }; }
  console.log(name, JSON.stringify(report.probes[name]));
  await context.close();
}
async function openGraph(page, data) {
  await page.goto(`${origin}/?role=nodes`);
  await expect(page.getByLabel('Graph name')).toBeVisible();
  const id = await page.evaluate(async data => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { serializeGraph, manifestFor } = await import('/src/nodes/portability.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('audit-fixture', { create: true });
    const file = await dir.getFileHandle('audit.nodes.json', { create: true });
    const writer = await file.createWritable();
    await writer.write(serializeGraph(data, manifestFor(data, SKETCHES))); await writer.close();
    window.showDirectoryPicker = async () => dir;
    await nodePatterns.link();
    return nodePatterns.records[0].id;
  }, data);
  await page.goto(`${origin}/?role=nodes&graph=${id}`);
  await expect(page.getByLabel('Graph name')).toHaveValue(data.name);
}

try {
  await probe('empty-name-embedded-editor', async page => {
    await page.goto(origin);
    await page.getByRole('button', { name: 'New Node Pattern', exact: true }).click();
    await expect(page.getByLabel('Graph name')).toHaveValue('Untitled graph');
    await page.getByLabel('Graph name').fill('');
    await page.waitForFunction(() => document.querySelector('#root').childElementCount === 0);
    return { rootChildren: await page.locator('#root').evaluate(el => el.childElementCount) };
  });
  await probe('script-drafts-overwrite-each-other', async page => {
    await openGraph(page, graph([script('a', 30, 70), script('b', 290, 270)]));
    await page.locator('[data-node-id=a] .nodes-node-title').click();
    await page.getByLabel('Script source').fill('return 111;');
    await page.locator('[data-node-id=b] .nodes-node-title').click();
    await page.getByLabel('Script source').fill('return 222;');
    await page.locator('[data-node-id=a] .nodes-node-title').click();
    return { expectedUnappliedText: 'return 111;', actualText: await page.getByLabel('Script source').inputValue() };
  });
  await probe('single-parameter-recreates-every-source', async page => {
    const g = graph([pattern('a'), pattern('b', 300, 300)]);
    g.edges = [{ from: 'a', to: 'output', port: 'image' }];
    await openGraph(page, g);
    await page.locator('[data-node-id=a] .nodes-node-title').click();
    await expect.poll(() => page.getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(10, 10, 1, 1).data[0])).toBe(204);
    await page.evaluate(async () => {
      const { GraphRuntime } = await import('/src/nodes/runtime.js');
      const { ProgramRuntime } = await import('/src/program-runtime.js');
      window.auditCounts = { graphDisposals: 0, sourcePreparations: 0 };
      const dispose = GraphRuntime.prototype.dispose, prepare = ProgramRuntime.prototype.prepare;
      GraphRuntime.prototype.dispose = function(...args) { window.auditCounts.graphDisposals++; return dispose.apply(this, args); };
      ProgramRuntime.prototype.prepare = function(...args) { window.auditCounts.sourcePreparations++; return prepare.apply(this, args); };
    });
    await page.getByLabel('Brightness', { exact: true }).fill('0.7');
    await page.waitForFunction(() => window.auditCounts.sourcePreparations >= 2);
    return page.evaluate(() => window.auditCounts);
  });
  await probe('connection-error-only-in-data-attribute', async page => {
    await openGraph(page, graph([script('a', 30, 70)]));
    await page.getByLabel('a output', { exact: true }).click();
    await page.getByLabel('output input image', { exact: true }).click();
    const message = await page.getByLabel('Graph workspace').getAttribute('data-status');
    return { message, visibleInPageText: (await page.locator('body').innerText()).includes(message) };
  });
  await probe('unreachable-sources-are-prepared-and-drawn', async page => {
    await page.goto(`${origin}/?role=nodes`);
    return page.evaluate(async () => {
      const { GraphRuntime } = await import('/src/nodes/runtime.js');
      let setups = 0, draws = 0;
      const leaf = { id: 'audit-leaf', name: 'Leaf', params: [], factory: () => p => {
        p.setup = () => { setups++; p.createCanvas(16, 16); };
        p.draw = () => { draws++; p.background(255, 0, 0); };
      } };
      const nodes = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, type: 'pattern', patternId: leaf.id, params: {}, x: 0, y: i * 50 }));
      const graph = { version: 1, name: 'Unreachable', nodes: [...nodes, { id: 'out', type: 'output', x: 1, y: 1 }], edges: [{ from: 'p0', to: 'out', port: 'image' }] };
      const runtime = new GraphRuntime({ graph, sketches: [leaf], width: 16, height: 16, preview: false });
      await runtime.ready;
      const result = { sources: runtime.sources.size, setups, draws, neededSourcesForOutput: 1 };
      runtime.dispose(); return result;
    });
  });
  await probe('unconnected-invalid-pattern-blocks-healthy-output', async page => {
    await page.goto(`${origin}/?role=nodes`);
    return page.evaluate(async () => {
      const { GraphRuntime } = await import('/src/nodes/runtime.js');
      const leaf = { id: 'audit-leaf', name: 'Leaf', params: [], factory: () => p => {
        p.setup = () => p.createCanvas(16, 16); p.draw = () => p.background(255, 0, 0);
      } };
      const nodes = [{ id: 'good', type: 'pattern', patternId: leaf.id, params: {}, x: 0, y: 0 }, { id: 'orphan', type: 'pattern', patternId: 'deleted-pattern', params: {}, x: 0, y: 0 }, { id: 'out', type: 'output', x: 1, y: 1 }];
      const runtime = new GraphRuntime({ graph: { version: 1, name: 'Broken orphan', nodes, edges: [{ from: 'good', to: 'out', port: 'image' }] }, sketches: [leaf], width: 16, height: 16, preview: false });
      await runtime.ready;
      const canvas = await runtime.renderFrame();
      const result = { sources: runtime.sources.size, pixel: [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data], diagnostics: runtime.getDiagnostics() };
      runtime.dispose(); return result;
    });
  });
  await probe('same-name-folders-rebind-saved-project', async page => {
    await page.goto(`${origin}/?role=nodes`);
    return page.evaluate(async () => {
      const { ensureProjectFolder, recallProjectFolder } = await import('/src/platform/project-folders.js');
      const { applyFolderReferences } = await import('/src/platform/folder-portability.js');
      const { sanitizeFolderReferences } = await import('/src/platform/folderReferences.js');
      const root = await navigator.storage.getDirectory();
      const a = await (await root.getDirectoryHandle('project-a', { create: true })).getDirectoryHandle('nodes', { create: true });
      const b = await (await root.getDirectoryHandle('project-b', { create: true })).getDirectoryHandle('nodes', { create: true });
      const first = await ensureProjectFolder('nodes', a);
      const second = await ensureProjectFolder('nodes', b);
      const recalled = await recallProjectFolder(first.id);
      const references = sanitizeFolderReferences({ scripts: { folderName: null, files: [] }, nodes: { folderName: 'nodes', folderId: first.id, files: [] }, media: { folderName: null, files: [] } });
      const applied = await applyFolderReferences(references);
      return { sameIdentity: first.id === second.id, originalNowResolvesToA: await recalled.handle.isSameEntry(a), originalNowResolvesToB: await recalled.handle.isSameEntry(b), resolved: applied.resolved, pending: applied.pending };
    });
  });
  await probe('new-project-retains-individually-opened-node-files', async page => {
    await page.goto(origin);
    await page.waitForFunction(() => !!window.__viz);
    const before = await page.evaluate(async () => {
      const { nodePatterns } = await import('/src/nodes/repository.js');
      const { serializeGraph } = await import('/src/nodes/portability.js');
      const dir = await navigator.storage.getDirectory();
      const file = await dir.getFileHandle('individual.nodes.json', { create: true });
      const writer = await file.createWritable();
      await writer.write(serializeGraph({ version: 1, name: 'Old project individual', nodes: [{ id: 'output', type: 'output', x: 1, y: 1 }], edges: [] }, [])); await writer.close();
      window.showOpenFilePicker = async () => [file];
      await nodePatterns.open();
      return nodePatterns.records.map(r => r.graph.name);
    });
    // Use the real public New Project UI rather than only its storage helper.
    await page.locator('#app-menu-btn').click();
    await page.locator('#app-menu-new-project').click();
    await expect(page.getByRole('heading', { name: 'New project', exact: true })).toBeVisible();
    const after = await page.evaluate(async () => {
      const { nodePatterns } = await import('/src/nodes/repository.js');
      await nodePatterns.refresh();
      return { opened: nodePatterns.state.opened.length, records: nodePatterns.records.map(r => r.graph.name) };
    });
    await page.reload();
    await page.waitForFunction(() => !!window.__viz);
    const afterReload = await page.evaluate(async () => {
      const { nodePatterns } = await import('/src/nodes/repository.js');
      await nodePatterns.refresh();
      return nodePatterns.records.map(r => r.graph.name);
    });
    return { before, after, afterReload };
  });
  await probe('project-import-swallows-quota-failure', async page => {
    await page.goto(`${origin}/?role=nodes`);
    return page.evaluate(async () => {
      const { applySettings } = await import('/src/platform/settings-portability.js');
      const { STORAGE } = await import('/src/platform/constants.js');
      localStorage.setItem(STORAGE.params, '{"oldProject":{}}');
      localStorage.setItem(STORAGE.video, 'old-camera');
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === STORAGE.params) throw new DOMException('audit injected quota error', 'QuotaExceededError');
        return original.call(this, key, value);
      };
      try {
        const result = await applySettings({ storage: { [STORAGE.params]: '{"newProject":{}}', [STORAGE.video]: 'new-camera' }, media: [] });
        return { returnedNormally: true, params: localStorage.getItem(STORAGE.params), camera: localStorage.getItem(STORAGE.video), summary: result };
      } finally { Storage.prototype.setItem = original; }
    });
  });
  await probe('nonstandard-output-id-initially-previews-nothing', async page => {
    const g = graph([pattern('a')]);
    g.nodes[g.nodes.length - 1].id = 'final';
    g.edges = [{ from: 'a', to: 'final', port: 'image' }];
    await openGraph(page, g);
    const pixel = () => page.getByTestId('node-preview').evaluate(c => [...c.getContext('2d').getImageData(10, 10, 1, 1).data]);
    // Let the editor process a render opportunity. The stronger evidence is the
    // missing selected ID plus pixels appearing only after selecting the real Output.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await pixel();
    const selectedBefore = await page.locator('[data-node-id][data-primary=true]').count();
    await page.getByRole('button', { name: 'Select Output', exact: true }).click();
    await expect.poll(pixel).toEqual([204, 0, 0, 255]);
    return { before, selectedBefore, after: await pixel() };
  });
  await probe('input-range-overflow-throws-without-visible-error', async page => {
    const g = graph([pattern('a'), script('s', 290, 270)]);
    g.modulations = [{ from: 's', to: 'a', param: 'brightness', min: 0, max: 1 }];
    await openGraph(page, g);
    await page.locator('[data-node-id=a] .nodes-node-title').click();
    await page.getByRole('button', { name: 'Brightness mapping settings' }).click();
    await page.getByLabel('Brightness Signal in max', { exact: true }).fill('1000001');
    return { field: await page.getByLabel('Brightness Signal in max', { exact: true }).inputValue(), status: await page.getByLabel('Graph workspace').getAttribute('data-status') };
  });
} finally {
  await writeFile('.design/node-editor-audit-evidence.json', JSON.stringify(report, null, 2) + '\n');
  // Findings are observations, not passing regression assertions. Only a broken
  // probe is a harness failure; future fixes should update expected observations.
  if (Object.values(report.probes).some(probe => probe.probeError)) process.exitCode = 1;
  await browser.close();
  await server.close();
}
