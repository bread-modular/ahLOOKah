import { test, expect } from '@playwright/test';

test('F06: repeated numeric and mapping edits retain captured parameter views, sources, audio slots and script time', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { approveExpression } = await import('/src/nodes/script-approval.js');
    approveExpression('time');
    const setups = { a: 0, b: 0, idle: 0 }, draws = { a: 0, b: 0, idle: 0 },
      playheads = { a: 0, b: 0, idle: 0 }, disposed = [];
    const sketches = ['a', 'b', 'idle'].map(id => ({ id,
      params: [{ key: 'brightness', label: 'Brightness', min: 0, max: 1, step: .01, default: 1 }],
      // Deliberately capture the factory's params object, as real sketches do.
      factory: (_audio, _video, params) => p => {
        let playbackPosition = 0; // instance-local, like a media playhead
        p.setup = () => { setups[id]++; p.createCanvas(16, 16); };
        p.draw = () => {
          draws[id]++; playheads[id] = ++playbackPosition;
          p.background(Math.round(params.brightness * 200), 0, 0);
        };
      } }));
    const store = { upsertSlot() {}, retireSlots(ids) { disposed.push(...ids); },
      createBinding: () => ({ read: () => ({ continuous: { bass: 1.6 } }), noteDraw() {}, setEventDeliveryEnabled() {} }) };
    let graph = { version: 2, name: 'parameter edits', nodes: [
      { id: 'a', type: 'pattern', patternId: 'a', params: { brightness: .8 }, x: 0, y: 0 },
      { id: 'b', type: 'pattern', patternId: 'b', params: { brightness: .7 }, x: 0, y: 0 },
      { id: 'idle', type: 'pattern', patternId: 'idle', params: {}, x: 0, y: 0 },
      { id: 'tint', type: 'color', params: { brightness: 1 }, x: 0, y: 0 },
      { id: 'move', type: 'transform', params: {}, x: 0, y: 0 },
      { id: 'mix', type: 'blend', mode: 'Normal', opacity: .5, x: 0, y: 0 },
      { id: 'audio', type: 'audio', band: 'bass', deviceId: null, channel: 'mono', x: 0, y: 0 },
      { id: 'clock', type: 'script', source: 'time', inputX: 0, inputY: 0, x: 0, y: 0 },
      { id: 'out', type: 'output', x: 0, y: 0 }],
      edges: [{ from: 'a', to: 'tint', port: 'image' }, { from: 'tint', to: 'move', port: 'image' },
        { from: 'move', to: 'mix', port: 'base' }, { from: 'b', to: 'mix', port: 'layer' }, { from: 'mix', to: 'out', port: 'image' }],
      modulations: [{ from: 'audio', to: 'a', param: 'brightness', min: .3, max: .9 }] };
    let notifications = 0;
    const runtime = new GraphRuntime({ graph, sketches, width: 16, height: 16,
      context: { audioControlStore: store, onAudioSlotsChanged: () => notifications++ } });
    const change = mutate => {
      graph = structuredClone(graph); mutate(graph);
      return runtime.updateGraph(graph);
    };
    try {
      await runtime.ready;
      await runtime.renderFrame();
      const a = runtime.sources.get('a'), b = runtime.sources.get('b');
      const aView = runtime.params.get('a'), bView = runtime.params.get('b');
      const slot = a.getAudioSlotDescriptors()[0];
      const first = { pixel: [...runtime.buffers.get('a').getContext('2d').getImageData(2, 2, 1, 1).data],
        setups: { ...setups }, draws: { ...draws }, playheads: { ...playheads },
        mapped: aView.brightness, slots: slot.runtimeId, revision: slot.paramsRevision,
        time: runtime.signalValue('clock') };
      const edits = [];
      for (const brightness of [.6, .4, .2]) {
        edits.push(change(g => { g.nodes.find(n => n.id === 'b').params.brightness = brightness; }));
        await new Promise(resolve => setTimeout(resolve, 40));
        await runtime.renderFrame();
      }
      edits.push(change(g => {
        g.modulations[0] = { ...g.modulations[0], min: .5, max: .8, inputMin: .5, inputMax: .9 };
        g.nodes.find(n => n.id === 'tint').params.brightness = .7;
        g.nodes.find(n => n.id === 'move').params.scaleX = 1.1;
        g.nodes.find(n => n.id === 'mix').opacity = .25;
      }));
      await new Promise(resolve => setTimeout(resolve, 45));
      await runtime.renderFrame();
      const after = { setups: { ...setups }, draws: { ...draws }, playheads: { ...playheads },
        sources: [...runtime.sources.keys()],
        sameSources: a === runtime.sources.get('a') && b === runtime.sources.get('b'),
        sameViews: aView === runtime.params.get('a') && bView === runtime.params.get('b'),
        a: aView.brightness, b: bView.brightness, tint: runtime.params.get('tint').brightness,
        scale: runtime.params.get('move').scaleX, opacity: runtime.params.get('mix').opacity,
        pixelB: [...runtime.buffers.get('b').getContext('2d').getImageData(2, 2, 1, 1).data],
        time: runtime.signalValue('clock'), slot: a.getAudioSlotDescriptors()[0],
        notifications, retired: disposed.length };
      // A disconnected selection was not constructed by any of those edits.
      // Its latest base must still be installed before its first lazy prepare.
      const lazyUpdate = change(g => { g.nodes.find(n => n.id === 'idle').params.brightness = .45; });
      const lazyPixel = [...(await runtime.renderFrame('idle')).getContext('2d').getImageData(2, 2, 1, 1).data];
      return { edits, first, after, lazyUpdate, lazyPixel, lazySetups: { ...setups } };
    } finally { runtime.dispose(); }
  });
  expect(result.edits).toEqual([true, true, true, true]);
  expect(result.first.setups).toEqual({ a: 1, b: 1, idle: 0 });
  expect(result.first.mapped).toBe(.6);
  expect(result.after.setups).toEqual(result.first.setups);
  expect(result.after.draws.a).toBeGreaterThan(result.first.draws.a);
  expect(result.after.draws.b).toBeGreaterThan(result.first.draws.b);
  expect(result.after.playheads.a).toBeGreaterThan(result.first.playheads.a);
  expect(result.after.playheads.b).toBeGreaterThan(result.first.playheads.b);
  expect(result.after).toMatchObject({ sources: ['a', 'b'], sameSources: true, sameViews: true,
    a: .5, b: .2, tint: .7, scale: 1.1, opacity: .25, pixelB: [40, 0, 0, 255], retired: 0 });
  expect(result.after.slot.runtimeId).toBe(result.first.slots);
  expect(result.after.slot.paramsRevision).toBeGreaterThan(result.first.revision);
  expect(result.after.slot.params.brightness).toBe(.5);
  expect(result.after.time).toBeGreaterThan(result.first.time + .1);
  expect(result.after.notifications).toBeGreaterThan(0);
  expect(result.lazyUpdate).toBe(true);
  expect(result.lazySetups).toEqual({ a: 1, b: 1, idle: 1 });
  expect(result.lazyPixel).toEqual([90, 0, 0, 255]);
});

test('F06: structural/source/FX/route revisions refuse in-place updates; an async FX tick cannot commit old parameters', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const setups = { src: 0, fx: 0 }, histories = [];
    const sketches = [
      { id: 'src', params: [], factory: () => p => {
        p.setup = () => { setups.src++; p.createCanvas(16, 16); };
        p.draw = () => p.background(80, 0, 0);
      } },
      { id: 'fx', fx: { input: 'image' }, params: [{ key: 'level', min: 0, max: 1, step: .01, default: 1 }],
        factory: (_audio, _video, params, context) => p => {
          let history = 0;
          p.setup = () => { setups.fx++; p.createCanvas(16, 16); };
          p.draw = async () => {
            if (!context.getImageInput()) return false;
            history++;
            histories.push(history);
            await new Promise(resolve => setTimeout(resolve, 30));
            p.background(Math.round(history * params.level * 20), 0, 0);
          };
        } },
    ];
    let graph = { version: 2, name: 'FX history', nodes: [
      { id: 'src', type: 'pattern', patternId: 'src', params: {}, x: 0, y: 0 },
      { id: 'effect', type: 'pattern', patternId: 'fx', params: { level: 1 }, x: 0, y: 0 },
      { id: 'audio', type: 'audio', band: 'bass', deviceId: null, channel: 'mono', x: 0, y: 0 },
      { id: 'out', type: 'output', x: 0, y: 0 }],
      edges: [{ from: 'src', to: 'effect', port: 'image' }, { from: 'effect', to: 'out', port: 'image' }] };
    const runtime = new GraphRuntime({ graph, sketches, preview: false, width: 16, height: 16 });
    try {
      await runtime.ready;
      const first = (await runtime.renderFrame()).getContext('2d').getImageData(2, 2, 1, 1).data[0];
      const effect = runtime.sources.get('effect');
      const pending = runtime.renderFrame();
      await new Promise(resolve => setTimeout(resolve, 8)); // FX draw is in flight
      const changed = structuredClone(graph);
      changed.nodes.find(n => n.id === 'effect').params.level = .5;
      const updated = runtime.updateGraph(changed);
      const stale = await pending;
      const committedBeforeNext = runtime.buffers.get('out').getContext('2d').getImageData(2, 2, 1, 1).data[0];
      const next = (await runtime.renderFrame()).getContext('2d').getImageData(2, 2, 1, 1).data[0];
      const variations = {
        wire: { ...changed, edges: [{ from: 'src', to: 'out', port: 'image' }] },
        source: { ...changed, nodes: changed.nodes.map(n => n.id === 'src' ? { ...n, patternId: 'fx' } : n) },
        route: { ...changed, nodes: changed.nodes.map(n => n.id === 'audio' ? { ...n, deviceId: 'another-device' } : n) },
        fxMode: { ...changed, edges: [{ from: 'effect', to: 'out', port: 'image' }] },
        invalid: { ...changed, nodes: changed.nodes.map(n => n.id === 'effect'
          ? { ...n, params: { level: 5 } } : n) },
      };
      const refused = Object.fromEntries(Object.entries(variations).map(([kind, value]) => [kind, runtime.updateGraph(value)]));
      const sameEffect = runtime.sources.get('effect') === effect;
      runtime.dispose();
      const replacement = new GraphRuntime({ graph: variations.wire, sketches, preview: false, width: 16, height: 16 });
      await replacement.ready;
      const replacementSources = [...replacement.sources.keys()];
      replacement.dispose();
      return { updated, stale: stale === null, first, committedBeforeNext, next, histories, setups,
        sameEffect, refused, replacementSources, retired: runtime.disposed };
    } finally { runtime.dispose(); }
  });
  expect(result).toMatchObject({ updated: true, stale: true, first: 20, committedBeforeNext: 20,
    next: 30, histories: [1, 2, 3], sameEffect: true,
    refused: { wire: false, source: false, route: false, fxMode: false, invalid: false },
    replacementSources: ['src'], retired: true });
  expect(result.setups).toEqual({ src: 2, fx: 1 });
});

// Exercise the real React Preview lifecycle, not only GraphRuntime's update API.
test('F06: editor slider and both mapping endpoint pairs do not dispose either Pattern; rewiring still rebuilds', async ({ page, context }) => {
  await context.addInitScript(() => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
  });
  await page.goto('/?role=nodes');
  await page.evaluate(async () => {
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const graph = { version: 1, name: 'F06 editor', nodes: [
      { id: 'a', type: 'pattern', patternId: 'solid-color', x: 40, y: 60,
        params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 } },
      { id: 'b', type: 'pattern', patternId: 'solid-color', x: 40, y: 270,
        params: { hue: .6, saturation: 1, brightness: .8, pulse: 0 } },
      { id: 'mix', type: 'blend', mode: 'Normal', opacity: .4, x: 330, y: 130 },
      { id: 'audio', type: 'audio', band: 'bass', deviceId: null, channel: 'mono', x: 300, y: 350 },
      { id: 'output', type: 'output', x: 650, y: 130 }],
      edges: [{ from: 'a', to: 'mix', port: 'base' }, { from: 'b', to: 'mix', port: 'layer' }, { from: 'mix', to: 'output', port: 'image' }],
      modulations: [{ from: 'audio', to: 'a', param: 'brightness', min: .8, max: 1 }] };
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('f06-editor', { create: true });
    const file = await dir.getFileHandle('f06.nodes.json', { create: true });
    const writer = await file.createWritable();
    await writer.write(serializeGraph(graph, manifestFor(graph, SKETCHES))); await writer.close();
    window.showDirectoryPicker = async () => dir;
    await nodePatterns.link();
    window.__f06GraphId = (await nodePatterns.open('f06.nodes.json')).id;
  });
  const id = await page.evaluate(() => window.__f06GraphId);
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue('F06 editor');
  await expect.poll(() => page.getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(240, 135, 1, 1).data[3])).toBe(255);
  await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { ProgramRuntime } = await import('/src/program-runtime.js');
    const stats = window.__f06 = { graphsDisposed: 0, childrenDisposed: 0, prepared: [], updates: 0 };
    const oldDispose = GraphRuntime.prototype.dispose, oldPrepare = GraphRuntime.prototype._prepareSource,
      oldUpdate = GraphRuntime.prototype.updateGraph, oldChildDispose = ProgramRuntime.prototype.dispose;
    GraphRuntime.prototype.dispose = function (...args) { stats.graphsDisposed++; return oldDispose.apply(this, args); };
    GraphRuntime.prototype._prepareSource = function (node) { stats.prepared.push(node.id); return oldPrepare.call(this, node); };
    GraphRuntime.prototype.updateGraph = function (...args) { stats.updates++; return oldUpdate.apply(this, args); };
    ProgramRuntime.prototype.dispose = function (...args) { stats.childrenDisposed++; return oldChildDispose.apply(this, args); };
  });
  const select = id => page.locator(`[data-node-id="${id}"] .nodes-node-title`).click();
  const stats = () => page.evaluate(() => ({ ...window.__f06 }));
  await select('b');
  for (const value of ['0.7', '0.5', '0.3']) {
    await page.locator('#param-nodes-b-brightness').evaluate((slider, value) => {
      slider.value = value; slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await expect(page.locator('[data-param-target="brightness"] .param-value')).toHaveText(Number(value).toFixed(2));
  }
  await select('a');
  await page.getByRole('button', { name: 'Brightness mapping settings' }).press('Enter');
  await page.getByLabel('Brightness Mapping min').fill('0.25');
  await page.getByLabel('Brightness Mapping max').fill('0.75');
  await page.getByLabel('Brightness Signal in min').fill('0.1');
  await page.getByLabel('Brightness Signal in max').fill('0.9');
  await expect(page.getByLabel('Brightness Mapping min')).toHaveValue('0.25');
  await expect(page.getByLabel('Brightness LIVE mapped value')).toHaveText('LIVE 0.25');
  await expect.poll(() => page.getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(240, 135, 1, 1).data[0])).toBe(64);
  await expect.poll(() => stats()).toMatchObject({ graphsDisposed: 0, childrenDisposed: 0, prepared: [] });
  expect((await stats()).updates).toBeGreaterThanOrEqual(7);
  // Disconnecting the image input changes reachability and must retire both
  // old child runtimes, even when the selection now previews a different target.
  await page.locator('[data-connection="image:output:image"]').dispatchEvent('click');
  await page.getByRole('button', { name: 'Delete connection' }).click();
  await expect.poll(() => stats()).toMatchObject({ graphsDisposed: 1, childrenDisposed: 2 });
});
