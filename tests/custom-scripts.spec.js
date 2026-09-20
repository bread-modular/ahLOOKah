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

  test('filesystem create/reload rollback/remove/disk delete, persistence and permission failure', async ({ page }) => {
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async (valid) => {
      const { CustomScripts } = await import('/src/custom-scripts/service.js');
      const { SKETCHES } = await import('/src/sketch-registry.js');
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts', { create: true });
      const write = async (name, text) => { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(text); await w.close(); };
      const service = new CustomScripts();
      await service.start(); service.handle = dir;
      await service.storage('folder', dir);
      await write('demo.viz.js', valid);
      await service.reload();
      const before = SKETCHES.find((s) => s.id === 'custom-demo');
      await write('demo.viz.js', 'api.requireVersion(1); broken(');
      try { await service.reload(); } catch {}
      const rollback = SKETCHES.find((s) => s.id === 'custom-demo') === before;
      await write('demo.viz.js', valid.replace('Demo', 'Changed externally'));
      const explicit = SKETCHES.find((s) => s.id === 'custom-demo').name;
      await service.reload();
      const updated = SKETCHES.find((s) => s.id === 'custom-demo').name;
      await service.remove('demo.viz.js');
      const removed = !SKETCHES.some((s) => s.id === 'custom-demo');
      const diskRetained = !!await dir.getFileHandle('demo.viz.js');
      await service.reload();
      let refused = false;
      try { await service.deleteFile('demo.viz.js'); } catch { refused = true; }
      await service.deleteFile('demo.viz.js', true);
      let diskDeleted = false;
      try { await dir.getFileHandle('demo.viz.js'); } catch (e) { diskDeleted = e.name === 'NotFoundError'; }
      await write('external.viz.js', valid.replace('Demo', 'Not yet activated'));
      const filename = await service.create('New script');
      const createDidNotReloadExternal = !SKETCHES.some((s) => s.id === 'custom-demo');
      const createdText = await (await (await dir.getFileHandle(filename)).getFile()).text();
      const persisted = await service.storage('active');
      const handle = await service.storage('folder');
      service.handle = { queryPermission: async () => 'denied' };
      let denied;
      try { await service.reload(); } catch (e) { denied = e.message; }
      service.close();
      return { rollback, explicit, updated, removed, diskRetained, refused, diskDeleted, createdText, persisted: persisted.sources.length, createDidNotReloadExternal, handle: handle.name, denied };
    }, source());
    expect(result).toMatchObject({ rollback: true, explicit: 'Demo', updated: 'Changed externally', removed: true, diskRetained: true, refused: true, diskDeleted: true, persisted: 1, createDidNotReloadExternal: true, handle: 'scripts' });
    expect(result.createdText).toContain('api.requireVersion(1)');
    expect(result.denied).toContain('Reconnect');
  });

  test('failed folder switch cannot delete same-named last-good registrations from another folder', async ({ page }) => {
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async (valid) => {
      const { CustomScripts } = await import('/src/custom-scripts/service.js');
      const { SKETCHES } = await import('/src/sketch-registry.js');
      const root = await navigator.storage.getDirectory();
      const a = await root.getDirectoryHandle('folder-a', { create: true });
      const b = await root.getDirectoryHandle('folder-b', { create: true });
      const filename = 'demo.viz.js';
      const broken = 'api.requireVersion(1); broken(';
      for (const [dir, text] of [[a, valid], [b, broken]]) {
        const writer = await (await dir.getFileHandle(filename, { create: true })).createWritable();
        await writer.write(text); await writer.close();
      }
      const service = new CustomScripts();
      await service.start();
      const originalPicker = window.showDirectoryPicker;
      try {
        window.showDirectoryPicker = async () => a;
        await service.choose();
        const before = SKETCHES.find((s) => s.id === 'custom-demo');
        const revision = service.active.revision;
        window.showDirectoryPicker = async () => b;
        let reloadError;
        try { await service.choose(); } catch (e) { reloadError = e.message; }
        let deleteError;
        try { await service.deleteFile(filename, true); } catch (e) { deleteError = e.message; }
        const preserved = {
          registry: SKETCHES.find((s) => s.id === 'custom-demo') === before,
          revision: service.active.revision === revision,
          persistedRevision: (await service.storage('active')).revision === revision,
          activeFolder: await service.active.folder.isSameEntry(a),
          chosenFolder: await service.handle.isSameEntry(b),
          aText: await (await (await a.getFileHandle(filename)).getFile()).text(),
          bText: await (await (await b.getFileHandle(filename)).getFile()).text(),
        };
        // A distinct handle for the same directory must still permit deletion.
        service.handle = await root.getDirectoryHandle('folder-a');
        await service.deleteFile(filename, true);
        let aDeleted = false;
        try { await a.getFileHandle(filename); } catch (e) { aDeleted = e.name === 'NotFoundError'; }
        return { reloadError, deleteError, preserved, aDeleted,
          unregistered: !SKETCHES.some((s) => s.id === 'custom-demo') };
      } finally {
        window.showDirectoryPicker = originalPicker;
        service.close();
      }
    }, source());
    expect(result.reloadError).toContain('demo.viz.js: syntax/import check:');
    expect(result.deleteError).toContain('demo.viz.js: the selected folder has not activated successfully');
    expect(result.deleteError).toContain('Fix its errors and Reload');
    expect(result.preserved).toEqual({ registry: true, revision: true, persistedRevision: true,
      activeFolder: true, chosenFolder: true, aText: source(), bText: 'api.requireVersion(1); broken(' });
    expect(result.aDeleted).toBe(true);
    expect(result.unregistered).toBe(true);
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

test('Custom Scripts @core multiwindow reload cancels cue, disposes preview/output and late output restores snapshot', async ({ page, context }) => {
  const text = source('Demo', "setup(){window.customStarts=(window.customStarts||0)+1;},dispose(){window.customStops=(window.customStops||0)+1;}");
  await seedFolder(page, text);
  await page.goto('/?role=control');
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
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
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.locator('#cue-preview-controls')).toBeHidden();
  await expect.poll(() => output.evaluate(() => window.customStops || 0)).toBeGreaterThan(0);
  await expect.poll(() => output.evaluate(() => window.customStarts || 0)).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Remove registrations', exact: true }).click();
  await expect.poll(() => output.evaluate(() => window.__viz?.patternId)).toBe('circles');
  await expect.poll(() => output.evaluate(async () => (await import('/src/sketch-registry.js')).SKETCHES.some((s) => s.id === 'custom-demo'))).toBe(false);
});

for (const name of ['drawing', 'mesh', 'shader', 'audio', 'image', 'video', 'camera', 'crud-lifecycle']) {
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
      const controls = controller.update({ shared: { getByteFrequencies: () => ({ left: new Uint8Array(256).fill(128) }) }, params, deltaSeconds: 0.25 });
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

test('Custom Scripts @core folder picker UI writes actual handle, cancels deletion, and validates external edits', async ({ page }) => {
  await page.goto('/?role=control');
  await page.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('chosen', { create: true });
  });
  const dialogs = [];
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); if (dialog.type() === 'prompt') await dialog.accept('From UI'); else await dialog.accept(); });
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
  await expect(page.locator('.custom-scripts-panel')).toContainText('Folder: chosen');
  await page.getByRole('button', { name: 'Create script', exact: true }).click();
  await expect(page.locator('.custom-scripts-panel li')).toHaveCount(1);
  const filename = await page.locator('.custom-scripts-panel li code').textContent();
  expect(filename).toMatch(/^custom-from-ui-.*\.viz\.js$/);
  await page.getByRole('button', { name: 'Edit guidance' }).click();
  await expect(page.locator('.custom-scripts-panel')).toContainText(`chosen/${filename}`);
  await page.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('chosen');
    const w = await (await dir.getFileHandle(name)).createWritable(); await w.write('api.requireVersion(1);syntax('); await w.close();
  }, filename);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.locator('.custom-scripts-panel')).toContainText(`${filename}: syntax/import check`);
  await expect(page.locator('.library-btn', { hasText: 'From UI' })).toBeVisible();
  page.removeAllListeners('dialog');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Delete file…', exact: true }).click();
  await expect(page.locator('.custom-scripts-panel li')).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete file…', exact: true }).click();
  await expect(page.locator('.custom-scripts-panel li')).toHaveCount(0);
  await expect(page.locator('.library-btn', { hasText: 'From UI' })).toHaveCount(0);
  expect(dialogs[0]).toContain('not in a sandbox');
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
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
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
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
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
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
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
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  const output = await context.newPage(); await output.goto('/?role=screen');
  await page.waitForFunction(() => window.__viz?.screenOnline);
  await page.locator('[data-id="projection-custom"]').click();
  await expect.poll(() => output.evaluate(() => window.__viz.programs.live?.children)).toEqual(['custom-demo']);
  const update = async (text) => page.evaluate(async (text) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('scripts');
    const w = await (await dir.getFileHandle('demo.viz.js')).createWritable(); await w.write(text); await w.close();
  }, text);
  await update(text.replace("max:100", "max:20").replace('default:50', 'default:10'));
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect.poll(() => output.evaluate(async () => (await import('/src/sketch-registry.js')).SKETCHES.find((s) => s.id === 'projection-custom').params.find((p) => p.label === 'Size')?.max)).toBe(20);
  await expect.poll(() => output.evaluate(() => window.__viz.programs.live?.children)).toEqual(['custom-demo']);
  await page.getByRole('button', { name: 'Remove registrations', exact: true }).click();
  await expect.poll(() => output.evaluate(() => window.__viz.programs.live?.children)).toEqual(['solid-color']);
});
