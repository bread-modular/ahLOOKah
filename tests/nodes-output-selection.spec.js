import { test, expect } from '@playwright/test';

// Real OPFS files, IndexedDB handles, BroadcastChannel and both app windows.
// Gates make the independent disk/render queues deterministic, not time-based.
test.beforeEach(async ({ context }) => {
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  context.testPageErrors = errors;
  await context.addInitScript(() => {
    if (!globalThis.FileSystemHandle) return; // The initial about:blank is not a secure origin.
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
  });
});

test.afterEach(async ({ context }) => {
  expect(context.testPageErrors).toEqual([]);
});

async function boot(page, context) {
  await page.goto('/');
  const screen = await context.newPage();
  await screen.goto('/?role=screen');
  await expect.poll(() => screen.evaluate(() => window.__viz?.programs?.live?.ready)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__viz?.screenOnline)).toBe(true);
  await screen.evaluate(() => {
    window.selectionMessages = [];
    window.selectionObserver = new BroadcastChannel('viz2_channel');
    window.selectionObserver.onmessage = ({ data }) => {
      if (['pattern', 'pattern-id', 'merge'].includes(data.type)) window.selectionMessages.push(data);
    };
  });
  return screen;
}

async function savePattern(page, { fileName = 'red.nodes.json', brightness = 1, graph: suppliedGraph = null } = {}) {
  return page.evaluate(async ({ fileName, brightness, suppliedGraph }) => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const graph = suppliedGraph || { version: 1, name: fileName, nodes: [
      { id: 'red', type: 'pattern', patternId: 'solid-color', x: 0, y: 0,
        params: { hue: 0, saturation: 1, brightness, pulse: 0 } },
      { id: 'output', type: 'output', x: 300, y: 0 },
    ], edges: [{ from: 'red', to: 'output', port: 'image' }] };
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('selection-tests', { create: true });
    const file = await dir.getFileHandle(fileName, { create: true });
    const writer = await file.createWritable();
    await writer.write(serializeGraph(graph, manifestFor(graph, SKETCHES)));
    await writer.close();
    if (!nodePatterns.state.folder) {
      window.showDirectoryPicker = async () => dir;
      await nodePatterns.link();
    }
    // A link grants access; the file is added explicitly (as OPEN does), so the
    // pattern id is the file's — a scan never adopts a directory's contents.
    return (await nodePatterns.open(fileName)).id;
  }, { fileName, brightness, suppliedGraph });
}

async function holdDisk(screen) {
  await screen.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    await nodePatterns.queue;
    const gate = new Promise(resolve => { window.releaseDisk = resolve; });
    nodePatterns.queue = gate;
  });
}

async function releaseDisk(screen) {
  await screen.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    window.releaseDisk();
    await nodePatterns.queue;
  });
}

async function waitForRecord(screen, id) {
  await expect.poll(() => screen.evaluate(async id =>
    (await import('/src/nodes/repository.js')).nodePatterns.records.some(record => record.id === id), id)).toBe(true);
}

async function clickPattern(page, screen, id) {
  await page.locator(`.library-btn[data-id="${id}"]`).click();
  await expect.poll(() => screen.evaluate(id => window.selectionMessages.some(msg => msg.id === id), id)).toBe(true);
}

async function assignPad(page, id, index = 0) {
  const slot = page.locator('#pattern-pad .slot-btn').nth(index);
  await page.locator(`.library-btn[data-id="${id}"]`).dragTo(slot);
  await expect(slot).toHaveAttribute('data-id', id);
  return slot;
}

async function holdRender(screen, id) {
  await screen.evaluate(async id => {
    const { ProgramRuntime } = await import('/src/program-runtime.js');
    const prepare = ProgramRuntime.prototype.prepare;
    let held = false;
    ProgramRuntime.prototype.prepare = function (...args) {
      const ready = prepare.apply(this, args);
      if (this.preview || held || !this.selection.ids.includes(id)) return ready;
      held = true;
      return ready.then(() => new Promise(resolve => {
        window.heldRuntime = this;
        window.releaseRender = () => resolve(this);
      }));
    };
  }, id);
}

async function idleOutput(screen) {
  await screen.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(() => screen.evaluate(() => window.__viz.runtimeCounts.incoming + window.__viz.runtimeCounts.retiring)).toBe(0);
}

async function removePattern(page) {
  await page.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    await nodePatterns.state.folder.handle.removeEntry('red.nodes.json');
    await nodePatterns.refresh(); nodePatterns.changed();
  });
}

const pixel = (page, selector) => page.locator(selector).evaluateAll(canvases => {
  const canvas = canvases[0];
  return canvas ? [...canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data] : null;
});
const liveCanvas = id => `.program-layer-live[data-program-ids="${id}"] > canvas`;

for (const input of ['library', 'pad']) {
  test(`node ${input} selection survives a slower output disk refresh @core`, async ({ page, context }) => {
    const screen = await boot(page, context);
    await holdDisk(screen);
    const id = await savePattern(page);
    if (input === 'pad') {
      await (await assignPad(page, id)).click();
    } else await clickPattern(page, screen, id);
    await expect.poll(() => pixel(page, '#preview-stage > canvas')).toEqual([255, 0, 0, 255]);
    await releaseDisk(screen);
    await waitForRecord(screen, id);
    await expect.poll(() => screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual([id]);
    await expect.poll(() => pixel(screen, liveCanvas(id))).toEqual([255, 0, 0, 255]);
    await expect.poll(() => pixel(page, '#preview-stage > canvas')).toEqual([255, 0, 0, 255]);
    await idleOutput(screen);
  });
}

for (const changed of ['another pattern', 'selected pattern']) {
  test(`node selection warming during refresh of ${changed} is not lost @core`, async ({ page, context }) => {
    const screen = await boot(page, context);
    const id = await savePattern(page);
    await waitForRecord(screen, id);
    await holdRender(screen, id);
    await clickPattern(page, screen, id);
    await expect.poll(() => screen.evaluate(() => typeof window.releaseRender)).toBe('function');
    const otherId = await savePattern(page, changed === 'selected pattern'
      ? { brightness: .5 } : { fileName: 'other.nodes.json' });
    await waitForRecord(screen, otherId);
    if (changed === 'selected pattern') {
      await expect.poll(() => screen.evaluate(async id =>
        (await import('/src/nodes/repository.js')).nodePatterns.records.find(record => record.id === id)?.graph.nodes[0].params.brightness, id)).toBe(.5);
    }
    await expect.poll(() => screen.evaluate(() => window.heldRuntime.disposed)).toBe(true);
    await screen.evaluate(() => window.releaseRender());
    await expect.poll(() => screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual([id]);
    await expect.poll(() => pixel(screen, liveCanvas(id))).toEqual([changed === 'selected pattern' ? 128 : 255, 0, 0, 255]);
    await expect.poll(() => pixel(page, '#preview-stage > canvas')).toEqual([changed === 'selected pattern' ? 128 : 255, 0, 0, 255]);
    await idleOutput(screen);
  });
}

test('node merge uses stable IDs while output pad indices differ', async ({ page, context }) => {
  const screen = await boot(page, context);
  await holdDisk(screen);
  const id = await savePattern(page);
  await assignPad(page, id);
  const otherId = await page.locator('#pattern-pad .slot-btn').nth(1).getAttribute('data-id');
  await page.keyboard.down('1');
  await page.keyboard.down('2');
  await page.keyboard.up('2');
  await page.keyboard.up('1');
  await expect.poll(() => page.evaluate(() => window.__viz.liveSelection)).toEqual({ ids: [id, otherId], merge: true });
  await expect.poll(() => screen.evaluate(() => window.selectionMessages.some(msg => msg.type === 'merge'))).toBe(true);
  await releaseDisk(screen);
  await expect.poll(() => screen.evaluate(() => window.__viz.liveSelection)).toEqual({ ids: [id, otherId], merge: true });
  await expect.poll(() => pixel(screen, '.program-layer-live > canvas')).toEqual([255, 0, 0, 255]);
  await idleOutput(screen);
});

for (const newer of ['built-in', 'node']) {
  test(`a newer ${newer} selection supersedes an outstanding disk selection`, async ({ page, context }) => {
    const screen = await boot(page, context);
    await holdDisk(screen);
    const id = await savePattern(page);
    const nextId = newer === 'node' ? await savePattern(page, { fileName: 'other.nodes.json', brightness: .5 }) : 'bars';
    await clickPattern(page, screen, id);
    await expect.poll(() => pixel(page, '#preview-stage > canvas')).toEqual([255, 0, 0, 255]);
    await clickPattern(page, screen, nextId);
    await releaseDisk(screen);
    await waitForRecord(screen, id);
    await idleOutput(screen);
    await expect.poll(() => screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual([nextId]);
    await expect.poll(() => page.evaluate(() => window.__viz.liveSelection.ids)).toEqual([nextId]);
    expect(await screen.evaluate(id => window.__viz.cueTimings.some(t => t.name === 'role-visibility-swap' && t.ids.includes(id)), id)).toBe(false);
    if (newer === 'node') await expect.poll(() => pixel(screen, liveCanvas(nextId))).toEqual([128, 0, 0, 255]);
  });
}

test('CUE entry cancels a pending disk selection even after CUE is canceled', async ({ page, context }) => {
  const screen = await boot(page, context);
  const original = await screen.evaluate(() => window.__viz.liveSelection.ids);
  await holdDisk(screen);
  const id = await savePattern(page);
  await clickPattern(page, screen, id);
  await page.locator('.library-btn[data-id="bars"]').click({ modifiers: ['Shift'] });
  await expect.poll(() => screen.evaluate(() => window.__viz.cue?.selection.ids)).toEqual(['bars']);
  await page.keyboard.press('Escape');
  await expect.poll(() => screen.evaluate(() => window.__viz.cue)).toBeNull();
  await releaseDisk(screen);
  await waitForRecord(screen, id);
  await idleOutput(screen);
  expect(await screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual(original);
  await expect.poll(() => page.evaluate(() => window.__viz.liveSelection.ids)).toEqual(original);
});

for (const failure of ['deleted', 'invalid', 'permission denied']) {
  test(`${failure} disk selection stays on LIVE and cannot revive on a later refresh`, async ({ page, context }) => {
    const screen = await boot(page, context);
    const original = await screen.evaluate(() => window.__viz.liveSelection.ids);
    await holdDisk(screen);
    const id = await savePattern(page);
    await clickPattern(page, screen, id);
    await expect.poll(() => pixel(page, '#preview-stage > canvas')).toEqual([255, 0, 0, 255]);
    if (failure === 'deleted') await removePattern(page);
    else if (failure === 'invalid') {
      await page.evaluate(async () => {
        const { nodePatterns } = await import('/src/nodes/repository.js');
        const file = await nodePatterns.state.folder.handle.getFileHandle('red.nodes.json');
        const writer = await file.createWritable(); await writer.write('invalid json'); await writer.close();
      });
    } else {
      await screen.evaluate(() => {
        FileSystemHandle.prototype.queryPermission = async () => 'denied';
        FileSystemHandle.prototype.requestPermission = async () => { throw new Error('Must not prompt from background refresh'); };
      });
    }
    await releaseDisk(screen);
    await idleOutput(screen);
    expect(await screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual(original);
    await expect.poll(() => page.evaluate(() => window.__viz.liveSelection.ids)).toEqual(original);
    await screen.evaluate(() => { FileSystemHandle.prototype.queryPermission = async () => 'granted'; });
    await savePattern(page);
    await waitForRecord(screen, id);
    await idleOutput(screen);
    expect(await screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual(original);
  });
}

test('deleting a warming node selection disposes it without promoting or reviving it', async ({ page, context }) => {
  const screen = await boot(page, context);
  const original = await screen.evaluate(() => window.__viz.liveSelection.ids);
  const id = await savePattern(page);
  await waitForRecord(screen, id);
  await holdRender(screen, id);
  await clickPattern(page, screen, id);
  await expect.poll(() => screen.evaluate(() => typeof window.releaseRender)).toBe('function');
  await removePattern(page);
  await expect.poll(() => screen.evaluate(() => window.heldRuntime.disposed)).toBe(true);
  await screen.evaluate(() => window.releaseRender());
  await idleOutput(screen);
  expect(await screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual(original);
  await savePattern(page);
  await waitForRecord(screen, id);
  await idleOutput(screen);
  expect(await screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual(original);
});

test('editing an already LIVE node reloads output pixels as well as preview', async ({ page, context }) => {
  const screen = await boot(page, context);
  const id = await savePattern(page);
  await waitForRecord(screen, id);
  await clickPattern(page, screen, id);
  await expect.poll(() => pixel(screen, liveCanvas(id))).toEqual([255, 0, 0, 255]);
  await savePattern(page, { brightness: .5 });
  await expect.poll(() => pixel(screen, liveCanvas(id))).toEqual([128, 0, 0, 255]);
  await expect.poll(() => pixel(page, '#preview-stage > canvas')).toEqual([128, 0, 0, 255]);
  await idleOutput(screen);
});

test('a pending disk choice supersedes an older warming renderer immediately', async ({ page, context }) => {
  const screen = await boot(page, context);
  const original = await screen.evaluate(() => window.__viz.liveSelection.ids);
  const id = await savePattern(page);
  await waitForRecord(screen, id);
  await holdRender(screen, id);
  await clickPattern(page, screen, id);
  await expect.poll(() => screen.evaluate(() => typeof window.releaseRender)).toBe('function');
  await holdDisk(screen);
  const nextId = await savePattern(page, { fileName: 'other.nodes.json', brightness: .5 });
  await clickPattern(page, screen, nextId);
  await expect.poll(() => screen.evaluate(() => window.heldRuntime.disposed)).toBe(true);
  await screen.evaluate(() => window.releaseRender());
  await idleOutput(screen);
  expect(await screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual(original);
  await releaseDisk(screen);
  await expect.poll(() => pixel(screen, liveCanvas(nextId))).toEqual([128, 0, 0, 255]);
  await idleOutput(screen);
});

for (const mode of ['LIVE', 'CUE']) for (const kind of ['constant', 'time-modulated']) {
  test(`node ${kind} ${mode} switches after control packets catch up @core`, async ({ page, context }, testInfo) => {
    const screen = await boot(page, context);
    const source = 'time / 10';
    await page.evaluate(async source => (await import('/src/nodes/script-approval.js')).approveExpression(source), source);
    const graph = { version: 1, name: 'Animated red', nodes: [
      { id: 'red', type: 'pattern', patternId: 'solid-color', x: 0, y: 0,
        params: { hue: 0, saturation: 1, brightness: .8, pulse: 0 } },
      { id: 'clock', type: 'script', source, x: 0, y: 200 },
      { id: 'output', type: 'output', x: 300, y: 0 },
    ], edges: [{ from: 'red', to: 'output', port: 'image' }],
      modulations: kind === 'constant' ? [] : [{ from: 'clock', to: 'red', param: 'pulse', min: 0, max: 1 }] };
    const id = await savePattern(page, { graph });
    await waitForRecord(screen, id);
    // Delay only the incoming graph's controls (not frames or disk), like a
    // temporarily slow/busy capture owner. Do not change runtime behaviour.
    await screen.evaluate(async () => {
      const { PatternAudioControlStore } = await import('/src/pattern-audio-controls.js');
      const accept = PatternAudioControlStore.prototype.acceptPacket;
      window.holdGraphControls = true;
      PatternAudioControlStore.prototype.acceptPacket = function (packet) {
        if (window.holdGraphControls && packet?.slots) {
          packet = { ...packet, slots: packet.slots.filter(slot => !slot.runtimeId.startsWith('graph-')) };
        }
        return accept.call(this, packet);
      };
    });
    if (mode === 'LIVE') await clickPattern(page, screen, id);
    else await page.locator(`.library-btn[data-id="${id}"]`).click({ modifiers: ['Shift'] });
    await expect.poll(() => screen.evaluate(mode => window.__viz.programs[mode === 'LIVE' ? 'incoming' : 'cue']?.fresh, mode)).toBe(true);
    await expect.poll(() => pixel(page, '#preview-stage > canvas')).toEqual([204, 0, 0, 255]);
    // A regular heartbeat can advance modulated params while the gate waits.
    if (kind === 'time-modulated') {
      await expect.poll(() => screen.evaluate(() => Object.entries(window.__viz.patternAudio.store.slots)
        .some(([runtimeId, slot]) => runtimeId.startsWith('graph-') && slot.paramsRevision > 2))).toBe(true);
    }
    await screen.evaluate(() => { window.holdGraphControls = false; });
    try {
      if (mode === 'CUE') {
        await expect.poll(() => screen.evaluate(() => window.__viz.cue?.phase)).toBe('ready');
        await page.keyboard.press('Enter');
        await expect.poll(() => screen.evaluate(() => window.__viz.cue)).toBeNull();
      }
      await expect.poll(() => screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual([id]);
      await expect.poll(() => pixel(screen, liveCanvas(id))).toEqual([204, 0, 0, 255]);
    } catch (error) {
      const diagnostic = await screen.evaluate(() => ({ programs: window.__viz.programs, timings: window.__viz.cueTimings, audio: window.__viz.patternAudio.store }));
      await testInfo.attach('output-readiness', { body: JSON.stringify(diagnostic, null, 2), contentType: 'application/json' });
      throw error;
    }
    await idleOutput(screen);
  });
}

test.describe('multi-source output at high pixel density', () => {
  test.use({ deviceScaleFactor: 2 });
  test('repeated library clicks render a modulated blend without disk or control gates', async ({ page, context }) => {
    test.setTimeout(60000);
    const screen = await boot(page, context);
    const source = 'time / 60';
    await page.evaluate(async source => (await import('/src/nodes/script-approval.js')).approveExpression(source), source);
    const graph = { version: 1, name: 'Multi-source blend', nodes: [
      { id: 'red', type: 'pattern', patternId: 'solid-color', x: 0, y: 0,
        params: { hue: 0, saturation: 1, brightness: .8, pulse: 0 } },
      { id: 'blue', type: 'pattern', patternId: 'solid-color', x: 0, y: 200,
        params: { hue: 2 / 3, saturation: 1, brightness: .6, pulse: 0 } },
      { id: 'clock', type: 'script', source, x: 0, y: 400 },
      { id: 'blend', type: 'blend', mode: 'Normal', opacity: .5, x: 300, y: 0 },
      { id: 'output', type: 'output', x: 600, y: 0 },
    ], edges: [{ from: 'red', to: 'blend', port: 'base' }, { from: 'blue', to: 'blend', port: 'layer' }, { from: 'blend', to: 'output', port: 'image' }],
      modulations: ['red', 'blue'].map(to => ({ from: 'clock', to, param: 'pulse', min: 0, max: 1 })) };
    const id = await savePattern(page, { graph });
    await waitForRecord(screen, id);
    for (let i = 0; i < 4; i++) {
      await clickPattern(page, screen, id);
      await expect.poll(() => screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual([id]);
      // Half-opacity blending may round an 8-bit colour channel by one byte.
      await expect.poll(async () => {
        const color = await pixel(screen, liveCanvas(id));
        return color ? Math.max(...color.map((value, channel) => Math.abs(value - [102, 0, 77, 255][channel]))) : Infinity;
      }).toBeLessThanOrEqual(1);
      await expect.poll(() => pixel(page, '#preview-stage > canvas')).toEqual(await pixel(screen, liveCanvas(id)));
      await idleOutput(screen);
      await clickPattern(page, screen, 'bars');
      await expect.poll(() => screen.evaluate(() => window.__viz.liveSelection.ids)).toEqual(['bars']);
      await idleOutput(screen);
    }
  });
});
