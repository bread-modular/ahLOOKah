import { folderDetails, folderAction } from './fixtures/folder-controls.js';
import { test, expect } from '@playwright/test';

const source = (name = 'Demo', extra = '') => `api.requireVersion(1); api.create({id:'custom-demo',name:${JSON.stringify(name)},draw({p}){p.background(24);},${extra}});`;

test.describe('Custom Scripts @core', () => {
  test('all syntax checked before execution, imports rejected with filename and line', async ({ page }) => {
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async () => {
      const { stageSources } = await import('/src/custom-scripts/compiler.js');
      window.executed = 0;
      const messages = [];
      for (const bad of ['api.requireVersion(1);\nconst = ;', "import './other.js';", "api.requireVersion(1); import('./other.js');"]) {
        try { stageSources([{ name: 'a.viz.js', text: 'window.executed++; api.requireVersion(1);' }, { name: 'b.viz.js', text: bad }]); }
        catch (e) { messages.push(e.message); }
      }
      return { executed: window.executed, messages };
    });
    expect(result.executed).toBe(0);
    expect(result.messages).toHaveLength(3);
    for (const message of result.messages) expect(message).toContain('b.viz.js: syntax/import check:');
    expect(result.messages[0]).toContain('(2:');
  });

  test('schema validation, CRUD, ownership, duplicates and built-in protection', async ({ page }) => {
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async (valid) => {
      const { stageSources } = await import('/src/custom-scripts/compiler.js');
      const errors = [];
      const bad = [
        valid.replace("'custom-demo'", "'circles'"),
        valid.replace('draw({p}){p.background(24);}', 'draw:42'),
        valid.replace('draw({p}){p.background(24);}', 'draww(){}'),
        valid.replace('name:"Demo"', 'name:5'),
        valid.replace('draw({p})', 'async draw({p})'),
        valid.replace('api.requireVersion(1);', 'api.requireVersion(2);'),
        valid.replace('api.requireVersion(1);', ''),
        valid.replace('draw({p})', 'renderer:"svg",draw({p})'),
        valid.replace('draw({p})', 'params:[{key:"a",label:"a",min:1,max:0,step:1,default:0}],draw({p})'),
        valid.replace('draw({p})', 'audio:{schema:{continuous:{x:{min:0,max:1,neutral:9}}},update(){}},draw({p})'),
        valid.replace('draw({p})', 'audio:{schema:{continuous:false},update(){}},draw({p})'),
        valid.replace('draw({p})', 'audio:{schema:{arrays:{x:{min:0,max:1,minLength:8,maxLength:4}}},update(){}},draw({p})'),
        valid + valid,
      ];
      for (const text of bad) {
        try { stageSources([{ name: 'bad.viz.js', text }], ['circles']); errors.push('NO ERROR'); }
        catch (e) { errors.push(e.message); }
      }
      let collision, ownership;
      try { stageSources([{ name: 'one.viz.js', text: valid }, { name: 'two.viz.js', text: valid }]); } catch (e) { collision = e.message; }
      try { stageSources([{ name: 'one.viz.js', text: valid }, { name: 'two.viz.js', text: "api.requireVersion(1);api.delete('custom-demo');" }]); } catch (e) { ownership = e.message; }
      const crud = stageSources([{ name: 'crud.viz.js', text: valid + `api.update('custom-demo',{name:'Updated'}); const copy=api.get('custom-demo'); api.create({...copy,id:'custom-copy'}); api.delete('custom-demo'); if(api.list().length!==1)throw Error('list');` }]);
      return { errors, collision, ownership, crud: crud.map((v) => ({ id: v.definition.id, name: v.definition.name })) };
    }, source());
    expect(result.errors).not.toContain('NO ERROR');
    expect(result.errors).toHaveLength(13);
    expect(result.collision).toContain('ID collision');
    expect(result.ownership).toContain('not created by this file');
    expect(result.crud).toEqual([{ id: 'custom-copy', name: 'Updated' }]);
  });

  test('selected-only loading, rollback, Delete persistence and permission failure', async ({ page }) => {
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async (valid) => {
      const { CustomScripts } = await import('/src/custom-scripts/service.js');
      const { SKETCHES } = await import('/src/sketch-registry.js');
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts', { create: true });
      const write = async (name, text) => { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(text); await w.close(); };
      await write('demo.viz.js', valid);
      await write('unopened.viz.js', "window.unopenedExecuted=true; throw Error('UNSELECTED EXECUTION');");
      await write('syntax.viz.js', 'const = ;');
      window.showDirectoryPicker = async () => dir;
      const service = new CustomScripts(); await service.start(); await service.choose();
      await service.reload();
      const initiallyEmpty = service.active.sources.length === 0;
      await service.open('demo.viz.js');
      const before = SKETCHES.find((s) => s.id === 'custom-demo');
      await write('demo.viz.js', 'api.requireVersion(1); broken(');
      try { await service.reload(); } catch {}
      const syntaxRollback = SKETCHES.find((s) => s.id === 'custom-demo') === before;
      await write('demo.viz.js', valid.replace('name:"Demo"', 'name:null'));
      try { await service.reload('demo.viz.js'); } catch {}
      const definitionRollback = SKETCHES.find((s) => s.id === 'custom-demo') === before;
      await write('demo.viz.js', valid.replace('Demo', 'Changed externally'));
      const explicit = SKETCHES.find((s) => s.id === 'custom-demo').name;
      await service.reload();
      const updated = SKETCHES.find((s) => s.id === 'custom-demo').name;
      await service.remove('demo.viz.js'); await service.reload();
      const staysRemoved = !SKETCHES.some((s) => s.id === 'custom-demo');
      const diskRetained = !!await dir.getFileHandle('demo.viz.js');
      const persisted = await service.storage('active');
      service.close();
      const restored = new CustomScripts(); await restored.start();
      const restoreEmpty = restored.active.sources.length === 0;
      restored.handle = { queryPermission: async () => 'denied' };
      let denied; try { await restored.reload(); } catch (e) { denied = e.message; }
      restored.close();
      return { initiallyEmpty, syntaxRollback, definitionRollback, explicit, updated, staysRemoved, diskRetained, persisted: persisted.sources.length, restoreEmpty, unopenedExecuted: !!window.unopenedExecuted, denied };
    }, source());
    expect(result).toMatchObject({ initiallyEmpty: true, syntaxRollback: true, definitionRollback: true, explicit: 'Demo', updated: 'Changed externally', staysRemoved: true, diskRetained: true, persisted: 0, restoreEmpty: true, unopenedExecuted: false });
    expect(result.denied).toContain('permission denied');
  });

  test('link/switch/unlink never executes folder contents; storage failure preserves link and patterns', async ({ page }) => {
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async (valid) => {
      const { CustomScripts } = await import('/src/custom-scripts/service.js');
      const { SKETCHES } = await import('/src/sketch-registry.js');
      const root = await navigator.storage.getDirectory();
      const a = await root.getDirectoryHandle('folder-a', { create: true });
      const b = await root.getDirectoryHandle('folder-b', { create: true });
      for (const [dir, text] of [[a, valid], [b, 'window.bad=true; broken(']]) {
        const writer = await (await dir.getFileHandle('demo.viz.js', { create: true })).createWritable();
        await writer.write(text); await writer.close();
      }
      const service = new CustomScripts(); await service.start();
      window.showDirectoryPicker = async () => a; await service.choose(); await service.open('demo.viz.js');
      const before = SKETCHES.find((s) => s.id === 'custom-demo');
      const storage = service.storage;
      service.storage = async () => { throw Error('Quota exceeded'); };
      window.showDirectoryPicker = async () => b;
      try { await service.choose(); } catch {}
      const retained = service.handle.name === 'folder-a' && SKETCHES.find((s) => s.id === 'custom-demo') === before;
      service.storage = storage;
      await service.choose();
      const switchedEmpty = service.active.sources.length === 0 && !SKETCHES.some((s) => s.id === 'custom-demo');
      await service.unlink(); service.close();
      const next = new CustomScripts(); await next.start();
      const unlinked = next.handle === null && next.active.sources.length === 0;
      const sourcesKept = !!await a.getFileHandle('demo.viz.js') && !!await b.getFileHandle('demo.viz.js');
      next.close(); return { retained, switchedEmpty, unlinked, sourcesKept, bad: !!window.bad };
    }, source());
    expect(result).toEqual({ retained: true, switchedEmpty: true, unlinked: true, sourcesKept: true, bad: false });
  });

  test('real renderer cleanup, controls, audio schema errors and runtime errors are file-specific', async ({ page }) => {
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async () => {
      const { stageSources } = await import('/src/custom-scripts/compiler.js');
      const { adaptPattern } = await import('/src/custom-scripts/adapter.js');
      const { default: VizCore } = await import('/src/core/index.js');
      window.cleanupLog = [];
      const [entry] = stageSources([{ name: 'lifecycle.viz.js', text: `api.requireVersion(1); api.create({id:'custom-life',name:'Life', setup({onCleanup}){onCleanup(()=>window.cleanupLog.push('cleanup'));},draw({p}){p.background(30);},dispose(){window.cleanupLog.push('dispose');},audio:{schema:{continuous:{level:{min:0,max:1,neutral:0}}},update(){return {continuous:{level:2},events:[]};},dispose(){window.cleanupLog.push('audio');}}});` }]);
      const errors = [];
      const sketch = adaptPattern(entry, (m) => errors.push(m));
      const controller = sketch.createAudioController();
      controller.update({}); controller.dispose();
      const inst = new VizCore(sketch.factory({}, null, {}, {}));
      await inst.whenReady();
      await inst.remove(); await inst.remove();
      const count = document.querySelectorAll('canvas').length;
      return { log: window.cleanupLog, errors, count };
    });
    expect(result.log).toEqual(['audio', 'dispose', 'cleanup']);
    expect(result.count).toBe(0);
    expect(result.errors[0]).toContain('lifecycle.viz.js: custom-life.audio.update');
  });
});

async function seedFolder(page, text) {
  await page.goto('/tests/fixtures/render.html');
  await page.evaluate(async (text) => {
    const { scriptStorage } = await import('/src/custom-scripts/storage.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts', { create: true });
    const w = await (await dir.getFileHandle('demo.viz.js', { create: true })).createWritable();
    await w.write(text); await w.close();
    await scriptStorage('folder', dir);
  }, text);
}

async function openScript(page, file = 'demo.viz.js') {
  await page.getByRole('button', { name: 'Open Script', exact: true }).click();
  await page.getByLabel('Script in scripts', { exact: true }).selectOption(file);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test('Custom Scripts @core multiwindow reload cancels cue, disposes preview/output and late output restores snapshot', async ({ page, context }) => {
  const text = source('Demo', "setup(){window.customStarts=(window.customStarts||0)+1;},dispose(){window.customStops=(window.customStops||0)+1;}");
  await seedFolder(page, text);
  await page.goto('/?role=control');
  await openScript(page);
  // Use the same semantic pattern-id message as clicking a library pattern.
  await expect.poll(() => page.evaluate(async () => (await import('/src/sketch-registry.js')).SKETCHES.some((s) => s.id === 'custom-demo'))).toBe(true);
  const output = await context.newPage();
  await output.goto('/?role=screen');
  await page.waitForFunction(() => window.__viz?.screenOnline);
  // Locate by existing library data attribute, not a private runtime API.
  await page.locator('[data-id="custom-demo"]').first().click();
  await expect.poll(() => output.evaluate(() => window.__viz?.patternId)).toBe('custom-demo');
  await expect.poll(() => page.evaluate(() => window.customStarts || 0)).toBeGreaterThan(0);
  await page.keyboard.press('Shift+1');
  await expect(page.locator('#cue-preview-controls')).toBeVisible();
  await folderAction(page, 'Custom Scripts', 'Refresh folder');
  await expect(page.locator('#cue-preview-controls')).toBeHidden();
  await expect.poll(() => output.evaluate(() => window.customStops || 0)).toBeGreaterThan(0);
  await expect.poll(() => output.evaluate(() => window.customStarts || 0)).toBeGreaterThan(1);
  await page.locator('[data-id="custom-demo"]').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#params-list').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => output.evaluate(() => window.__viz?.patternId)).toBe('circles');
  await expect.poll(() => output.evaluate(async () => (await import('/src/sketch-registry.js')).SKETCHES.some((s) => s.id === 'custom-demo'))).toBe(false);
});

for (const name of ['drawing', 'mesh', 'shader', 'audio', 'audio-advanced', 'image', 'video', 'camera', 'crud-lifecycle']) {
  test(`Custom Scripts @core example ${name} renders and disposes`, async ({ page }) => {
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async (name) => {
      const { stageSources } = await import('/src/custom-scripts/compiler.js');
      const { adaptPattern } = await import('/src/custom-scripts/adapter.js');
      const { default: VizCore } = await import('/src/core/index.js');
      const filename = `${name}.viz.js`;
      const text = await (await fetch(`/docs/custom-script-examples/${filename}`)).text();
      const [entry] = stageSources([{ name: filename, text }]);
      const errors = [];
      const assets = async (filename) => {
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 64, 64);
        if (filename.endsWith('.png')) return new Promise((resolve) => canvas.toBlob(resolve));
        const stream = canvas.captureStream(15);
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks = [];
        const blob = new Promise((resolve) => {
          recorder.ondataavailable = (event) => chunks.push(event.data);
          recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
        });
        recorder.start(); await new Promise((r) => setTimeout(r, 200)); recorder.stop();
        const output = await blob; stream.getTracks().forEach((t) => t.stop()); return output;
      };
      const pattern = adaptPattern(entry, (e) => errors.push(e), assets);
      const params = Object.fromEntries(pattern.params.map((p) => [p.key, p.default]));
      const controller = pattern.createAudioController();
      const { SharedAudioAnalysisView } = await import('/src/pattern-audio-engine.js');
      const frame = { left: new Float32Array(1024).fill(-60), sampleRate: 48000, fftSize: 2048, rms: .1 };
      const controls = controller.update({ frame, shared: new SharedAudioAnalysisView(frame), params, deltaSeconds: 1 / 30 });
      if (name === 'audio' && !(controls.continuous.bass > 0)) throw Error('default reactive transport missing');
      if (name === 'audio-advanced' && !(controls.continuous.level > 0 && controls.arrays.spectrum.length === 32)) throw Error('advanced reactive/raw transport missing');
      let consumed = false;
      const inst = new VizCore(pattern.factory({}, null, params, { audioControls: {
        read: () => controls, consumeEvents: () => { const events = consumed ? [] : controls.events; consumed = true; return events; },
      } }));
      await inst.whenReady();
      await inst.redraw();
      if (name === 'camera') await new Promise((r) => setTimeout(r, 500));
      const before = { width: inst.width, height: inst.height, frame: inst.frameCount, mode: inst._rendererMode };
      const video = document.querySelector('video');
      const tracks = [...(video?.srcObject?.getTracks() || [])];
      await inst.remove(); controller.dispose();
      return { before, errors, canvases: document.querySelectorAll('canvas').length, videos: document.querySelectorAll('video').length, tracks: tracks.map((t) => t.readyState) };
    }, name);
    expect(result.errors).toEqual([]);
    expect(result.before.width).toBeGreaterThan(0);
    expect(result.before.frame).toBeGreaterThan(0);
    expect(result.before.mode).toBe(['mesh', 'shader'].includes(name) ? 'gl' : '2d');
    expect(result.canvases).toBe(0);
    expect(result.videos).toBe(0);
    for (const state of result.tracks) expect(state).toBe('ended');
  });
}

test('Custom Scripts @core selection modal, parameter actions, folder details, path copy and unlink', async ({ page, context }, testInfo) => {
  await seedFolder(page, source());
  // Start unlinked; picker is the only mocked native UI. Handles/bytes are real OPFS.
  await page.evaluate(async () => { const { scriptStorage } = await import('/src/custom-scripts/storage.js'); await scriptStorage('folder', null); });
  await page.goto('/?role=control');
  await page.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('scripts');
  });
  const panel = page.locator('.custom-scripts-panel');
  await expect(panel.getByRole('button')).toHaveCount(3);
  await expect(panel.getByRole('button', { name: 'Link Folder' })).toBeVisible();
  await panel.locator('..').screenshot({ path: testInfo.outputPath('unlinked.png') });
  await page.locator('.custom-scripts-panel').getByRole('button', { name: 'Link Folder', exact: true }).click();
  await expect(page.locator('[data-id="custom-demo"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Script' })).toBeEnabled();
  const details = await folderDetails(page, 'Custom Scripts');
  await expect(details).toContainText('does not expose its full path');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await details.getByRole('button', { name: 'Copy folder name: scripts' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('scripts');
  await details.getByRole('button', { name: 'Close folder details' }).click();
  await page.getByRole('button', { name: 'Open Script', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('not in a sandbox');
  await page.getByLabel('Script in scripts', { exact: true }).selectOption('demo.viz.js');
  await expect(page.locator('[data-id="custom-demo"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('selection-modal.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open Script', exact: true })).toBeFocused();
  await openScript(page);
  await page.locator('[data-id="custom-demo"]').click();
  const params = page.locator('#params-list');
  await expect(params.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(params.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  const row = await panel.locator('..').boundingBox();
  const folderName = await panel.locator('.folder-linked').boundingBox();
  const close = await panel.getByRole('button', { name: 'Open Script', exact: true }).boundingBox();
  expect(folderName.width).toBeLessThan(row.width / 2);
  expect(Math.abs(close.x + close.width - row.x - row.width)).toBeLessThan(2);
  await expect(panel.locator('.folder-linked')).toHaveCSS('text-transform', 'none');
  await page.screenshot({ path: testInfo.outputPath('linked-parameters.png') });
  await panel.locator('..').screenshot({ path: '/tmp/refined-custom-scripts.png' });
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts');
    const w = await (await dir.getFileHandle('demo.viz.js')).createWritable(); await w.write('api.requireVersion(1);syntax('); await w.close();
  });
  await params.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(params).toContainText('syntax/import check');
  await expect(page.locator('[data-id="custom-demo"]')).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await params.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('[data-id="custom-demo"]')).toBeVisible();
  page.once('dialog', (dialog) => { expect(dialog.message()).toContain('source file is kept'); return dialog.accept(); });
  await params.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('[data-id="custom-demo"]')).toHaveCount(0);
  await folderAction(page, 'Custom Scripts', 'Refresh folder');
  await expect(panel.getByRole('alert')).toHaveCount(0); // broken but no longer selected
  await folderAction(page, 'Custom Scripts', 'Unlink folder');
  await expect(panel.getByRole('button')).toHaveCount(3);
  expect(await page.evaluate(async () => !!await (await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts')).getFileHandle('demo.viz.js'))).toBe(true);
  await page.reload();
  await expect(panel.getByRole('button', { name: 'Link Folder' })).toBeVisible();
});

test('Custom Scripts @core reload is all-or-nothing for malformed definitions, duplicates and storage errors', async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async (text) => {
    const { CustomScripts } = await import('/src/custom-scripts/service.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const memory = new Map(); let fail = false;
    const service = new CustomScripts({ storage: async function(k, v) { if (arguments.length === 1) return memory.get(k); if (fail) throw Error('Quota exceeded'); memory.set(k,v); } });
    const good = [{ name: 'a.viz.js', text }];
    await service.commit(good);
    const previous = SKETCHES.find((s) => s.id === 'custom-demo');
    const outcomes = [];
    for (const sources of [[{ name: 'a.viz.js', text: text.replace('name:"Demo"', 'name:null') }], [...good, { name: 'b.viz.js', text }]]) {
      try { await service.commit(sources); } catch {}
      outcomes.push(SKETCHES.find((s) => s.id === 'custom-demo') === previous);
    }
    fail = true;
    try { await service.commit([{ name: 'a.viz.js', text: text.replace('Demo', 'new') }]); } catch {}
    outcomes.push(SKETCHES.find((s) => s.id === 'custom-demo') === previous);
    return outcomes;
  }, source());
  expect(result).toEqual([true, true, true]);
});

test('Custom Scripts @core missing filesystem support and revoked permissions are actionable', async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { CustomScripts } = await import('/src/custom-scripts/service.js');
    const { supportError } = await import('/src/custom-scripts/storage.js');
    const original = window.showDirectoryPicker;
    window.showDirectoryPicker = undefined;
    const missing = supportError();
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    const insecure = supportError();
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    window.showDirectoryPicker = original;
    let permission = 'denied'; let requests = 0;
    const service = new CustomScripts();
    service.handle = { name: 'revoked', queryPermission: async () => permission, requestPermission: async () => { requests++; return permission; } };
    let denied;
    try { await service.reconnect(); } catch (e) { denied = e.message; }
    permission = 'granted'; await service.reconnect();
    const screen = new CustomScripts({ role: 'screen' });
    screen.handle = { removeEntry() { throw new Error('SHOULD NOT REACH DISK'); } };
    let screenDenied;
    try { await screen.permission(); } catch (e) { screenDenied = e.message; }
    return { missing, insecure, denied, permission: service.status.permission, requests, screenDenied };
  });
  expect(result.missing).toContain('desktop Chrome');
  expect(result.insecure).toContain('HTTPS or localhost');
  expect(result.denied).toContain('Reconnect was denied');
  expect(result.permission).toBe('granted');
  expect(result.requests).toBe(2);
  expect(result.screenDenied).toContain('Only the control window');
});

test('Custom Scripts @core stale TAKE cannot promote after reload; external deletion falls back', async ({ page, context }) => {
  await seedFolder(page, source());
  await page.goto('/?role=control');
  await openScript(page);
  await expect(page.locator('[data-id="custom-demo"]')).toBeVisible();
  const output = await context.newPage(); await output.goto('/?role=screen');
  await page.waitForFunction(() => window.__viz?.screenOnline);
  await output.evaluate(() => {
    const original = requestAnimationFrame; const cancel = cancelAnimationFrame;
    const callbacks = new Map(); let id = 1;
    window.holdFrames = { original, callbacks, cancel };
    window.requestAnimationFrame = (fn) => { const next = id++; callbacks.set(next, fn); return next; };
    window.cancelAnimationFrame = (id) => callbacks.delete(id);
  });
  await page.locator('[data-id="custom-demo"]').click({ modifiers: ['Shift'] });
  await expect(page.locator('#cue-preview-controls')).toBeVisible();
  await page.locator('#library-pane h3').click();
  await page.keyboard.press('Enter');
  await expect.poll(() => output.evaluate(() => window.__viz.cue?.takePending)).toBe(true);
  await folderAction(page, 'Custom Scripts', 'Refresh folder');
  await expect.poll(() => output.evaluate(() => window.__viz.cue)).toBeNull();
  await output.evaluate(() => {
    const { original, callbacks, cancel } = window.holdFrames;
    window.requestAnimationFrame = original; window.cancelAnimationFrame = cancel;
    callbacks.forEach((fn) => original(fn)); delete window.holdFrames;
  });
  await expect.poll(() => output.evaluate(() => window.__viz.patternId)).toBe('circles');
  await page.locator('[data-id="custom-demo"]').click();
  await expect.poll(() => output.evaluate(() => window.__viz.patternId)).toBe('custom-demo');
  await page.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts'); await d.removeEntry('demo.viz.js'); });
  await folderAction(page, 'Custom Scripts', 'Refresh folder');
  await expect.poll(() => output.evaluate(() => window.__viz.patternId)).toBe('circles');
});

test('Custom Scripts @core parameter schema changes and projection children reconcile across reload', async ({ page, context }) => {
  const text = source('Demo', "params:[{key:'size',label:'Size',min:0,max:100,step:1,default:50}]");
  await seedFolder(page, text);
  await page.evaluate(async () => {
    const { saveProjectionMeta } = await import('/src/projection/projection-registry.js');
    saveProjectionMeta([{ id: 'projection-custom', name: 'Custom mapping', surfaces: [{ id: 's1', name: 'Surface', patternId: 'custom-demo' }] }]);
  });
  await page.goto('/?role=control');
  await openScript(page);
  const output = await context.newPage(); await output.goto('/?role=screen');
  await page.waitForFunction(() => window.__viz?.screenOnline);
  await page.locator('[data-id="projection-custom"]').click();
  await expect.poll(() => output.evaluate(() => window.__viz.programs.live?.children)).toEqual(['custom-demo']);
  const update = async (text) => page.evaluate(async (text) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts');
    const w = await (await dir.getFileHandle('demo.viz.js')).createWritable(); await w.write(text); await w.close();
  }, text);
  await update(text.replace("max:100", "max:20").replace('default:50', 'default:10'));
  await folderAction(page, 'Custom Scripts', 'Refresh folder');
  await expect.poll(() => output.evaluate(async () => (await import('/src/sketch-registry.js')).SKETCHES.find((s) => s.id === 'projection-custom').params.find((p) => p.label === 'Size')?.max)).toBe(20);
  await expect.poll(() => output.evaluate(() => window.__viz.programs.live?.children)).toEqual(['custom-demo']);
  await page.locator('[data-id="custom-demo"]').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#params-list').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('[data-id="projection-custom"]').click();
  await expect.poll(() => output.evaluate(() => window.__viz.programs.live?.children)).toEqual(['solid-color']);
});

test('Custom Scripts @core per-file reload/Delete do not evaluate other selected files; closed and screen roles cannot mutate', async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async (valid) => {
    const { CustomScripts } = await import('/src/custom-scripts/service.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts', { create: true });
    for (const [name, text] of [['demo.viz.js', 'window.demoRuns=(window.demoRuns||0)+1;' + valid], ['other.viz.js', 'window.otherRuns=(window.otherRuns||0)+1;' + valid.replace('custom-demo', 'custom-other')]]) {
      const writer = await (await dir.getFileHandle(name, { create: true })).createWritable(); await writer.write(text); await writer.close();
    }
    window.showDirectoryPicker = async () => dir;
    const service = new CustomScripts(); await service.start(); await service.choose();
    await service.open('demo.viz.js'); await service.open('other.viz.js');
    const other = SKETCHES.find((s) => s.id === 'custom-other');
    await service.reload('demo.viz.js'); await service.remove('demo.viz.js');
    const kept = other === SKETCHES.find((s) => s.id === 'custom-other');
    const screen = new CustomScripts({ role: 'screen' });
    let denied = 0;
    for (const fn of [() => screen.choose(), () => screen.open('other.viz.js'), () => screen.reload(), () => screen.remove('other.viz.js'), () => screen.unlink()]) {
      try { await fn(); } catch (e) { if (e.message.includes('Only the control window')) denied++; }
    }
    service.close(); await service.unlink();
    return { demoRuns: window.demoRuns, otherRuns: window.otherRuns, kept, denied, closedKept: service.active.sources.length === 1 };
  }, source());
  expect(result).toEqual({ demoRuns: 2, otherRuns: 1, kept: true, denied: 5, closedKept: true });
});

test('Custom Scripts @core unlink disposes live and preview in all windows and late output stays empty', async ({ page, context }) => {
  await seedFolder(page, source('Demo', 'dispose(){window.stops=(window.stops||0)+1;}'));
  await page.goto('/?role=control'); await openScript(page);
  const output = await context.newPage(); await output.goto('/?role=screen');
  await page.waitForFunction(() => window.__viz?.screenOnline);
  await page.locator('[data-id="custom-demo"]').click();
  await expect.poll(() => output.evaluate(() => window.__viz?.patternId)).toBe('custom-demo');
  await folderAction(page, 'Custom Scripts', 'Unlink folder');
  await expect.poll(() => output.evaluate(() => window.__viz?.patternId)).toBe('circles');
  await expect.poll(() => output.evaluate(() => window.stops || 0)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.stops || 0)).toBeGreaterThan(0);
  await output.reload();
  await expect.poll(() => output.evaluate(async () => (await import('/src/sketch-registry.js')).SKETCHES.filter((s) => s.customScript).length)).toBe(0);
  await page.reload();
  await expect(page.locator('.custom-scripts-panel').getByRole('button', { name: 'Link Folder' })).toBeVisible();
});

test('Custom Scripts @core failed Open stays in modal, preserves selection and supports retry', async ({ page }) => {
  await seedFolder(page, source());
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts');
    const w = await (await dir.getFileHandle('bad.viz.js', { create: true })).createWritable(); await w.write('window.syntaxRan=true; const = ;'); await w.close();
  });
  await page.goto('/?role=control'); await openScript(page);
  await page.getByRole('button', { name: 'Open Script', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await page.getByLabel('Script in scripts', { exact: true }).selectOption('bad.viz.js');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('syntax/import check');
  await expect(page.locator('[data-id="custom-demo"]')).toBeAttached();
  expect(await page.evaluate(() => !!window.syntaxRan)).toBe(false);
  await page.evaluate(async (text) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts');
    const w = await (await dir.getFileHandle('bad.viz.js')).createWritable(); await w.write(text.replace('custom-demo', 'custom-fixed')); await w.close();
  }, source('Fixed'));
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-id="custom-demo"]')).toBeVisible();
  await expect(page.locator('[data-id="custom-fixed"]')).toBeVisible();
});

test('Custom Scripts @core legacy autoload snapshots do not execute; long folder names stay bounded and truthful', async ({ page }) => {
  await seedFolder(page, source());
  const name = 'scripts-with-a-very-long-folder-name-that-must-not-overflow-the-library-pane';
  await page.evaluate(async ({ name, text }) => {
    const { scriptStorage } = await import('/src/custom-scripts/storage.js');
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    await scriptStorage('active', { revision: 1, folder, sources: [{ name: 'demo.viz.js', text: 'window.legacyExecuted=true;' + text }] });
  }, { name, text: source() });
  await page.goto('/?role=control');
  const dialog = await folderDetails(page, 'Custom Scripts');
  await expect(dialog.locator('.folder-details-name')).toHaveText(name);
  await expect(dialog).toContainText('does not expose its full path');
  expect(await page.evaluate(() => !!window.legacyExecuted)).toBe(false);
  await expect(page.locator('[data-id="custom-demo"]')).toHaveCount(0);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Unlink folder', exact: true }).click();
  await page.reload();
  await expect(page.locator('.custom-scripts-panel').getByRole('button', { name: 'Link Folder' })).toBeVisible();
});
