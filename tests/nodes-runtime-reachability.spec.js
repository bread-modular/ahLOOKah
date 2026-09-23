import { test, expect } from '@playwright/test';

test('LIVE plans only Output image and scalar dependencies; unused FX, capture, audio and canvases stay dormant', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { approveExpression } = await import('/src/nodes/script-approval.js');
    approveExpression('x + 0.2');
    const pattern = (id, patternId) => ({ id, type: 'pattern', patternId, params: {}, x: 0, y: 0 });
    const edge = (from, to, port = 'image') => ({ from, to, port });
    const output = { id: 'out', type: 'output', x: 0, y: 0 };
    const color = id => ({ id, type: 'color', params: { brightness: 1 }, x: 0, y: 0 });
    const audio = (id, deviceId = null) => ({ id, type: 'audio', band: 'bass', deviceId, channel: 'mono', x: 0, y: 0 });
    const pixel = canvas => [...canvas.getContext('2d').getImageData(2, 2, 1, 1).data];
    const counts = { good: [0, 0], unused: [0, 0], camera: [0, 0], fx: [0, 0] };
    const sketch = (id, extras = {}) => ({ id, params: [{ key: 'brightness', min: 0, max: 1, step: .01, default: .5 }], ...extras,
      factory: () => p => {
        p.setup = () => { counts[id][0]++; p.createCanvas(16, 16); };
        p.draw = () => { counts[id][1]++; p.background(180, 30, 5); };
      } });
    const nodes = [pattern('used', 'good'), color('tint'),
      { id: 'mix', type: 'blend', mode: 'Normal', opacity: .5, x: 0, y: 0 }, output,
      audio('needed'), { id: 'script', type: 'script', source: 'x + 0.2', inputX: 0, inputY: 0, x: 0, y: 0 },
      { id: 'scalar', type: 'math', op: 'add', a: 0, b: .2, x: 0, y: 0 },
      audio('orphan-audio', 'unused-device'),
      { id: 'orphan-script', type: 'script', source: 'x', inputX: 0, inputY: 0, x: 0, y: 0 },
      pattern('camera-pattern', 'camera'),
      { id: 'camera-node', type: 'camera', deviceId: 'unused-camera', x: 0, y: 0 },
      pattern('unused-fx', 'fx'), pattern('broken', 'deleted-pattern'),
      ...Array.from({ length: 10 }, (_, i) => pattern(`unused-${i}`, 'unused'))];
    const graph = { version: 2, name: 'active only', nodes,
      edges: [edge('used', 'tint'), edge('tint', 'mix', 'base'), edge('used', 'mix', 'layer'), edge('mix', 'out')],
      signalEdges: [edge('needed', 'script', 'x'), edge('script', 'scalar', 'a')],
      modulations: [{ from: 'scalar', to: 'tint', param: 'brightness', min: .1, max: 1 }] };
    const slots = [], signalSlotIds = [], retired = [], children = [], acquisitions = [];
    const store = { upsertSlot: slot => { if (slot.audioInput) { slots.push(slot.audioInput.deviceId); signalSlotIds.push(slot.runtimeId); } }, retireSlots: ids => retired.push(...ids),
      createBinding: () => ({ read: () => ({ continuous: { bass: 1.6 } }), noteDraw() {}, setEventDeliveryEnabled() {} }) };
    const runtime = new GraphRuntime({ graph, sketches: [sketch('good'), sketch('unused'), sketch('camera', { camera: true }), sketch('fx', { fx: { input: 'image' } })],
      preview: false, context: { audioControlStore: store, cameraSource: { acquire: arg => acquisitions.push(arg) }, registerChildRuntime: r => children.push(r) } });
    await runtime.ready;
    const image = pixel(await runtime.renderFrame());
    const beforeDispose = { image, hasFx: runtime.hasFx, sources: [...runtime.sources.keys()], buffers: [...runtime.buffers.keys()],
      work: runtime.work.size, staging: runtime.staging.size, slots, counts, acquisitions: acquisitions.length,
      signal: runtime.signalValue('scalar'), mapped: runtime.params.get('tint').brightness,
      scripts: [...runtime.scriptPrograms.keys()], params: [...runtime.params.keys()],
      diagnostics: runtime.getDiagnostics(), children: children.length };
    runtime.dispose();
    return { ...beforeDispose, retired: retired.filter(id => signalSlotIds.includes(id)).length };
  });
  expect(result.image[3]).toBe(255);
  expect(result.image[0]).toBeGreaterThan(0);
  expect(result.hasFx).toBe(false);
  expect(result.sources).toEqual(['used']);
  expect(result.buffers.sort()).toEqual(['mix', 'out', 'tint', 'used']);
  expect(result.work).toBe(0);
  expect(result.staging).toBe(0);
  expect(result.slots).toEqual([null]);
  expect(result.scripts).toEqual(['script']);
  expect(result.params.sort()).toEqual(['mix', 'tint', 'used']);
  expect(result.children).toBe(2); // one audio consumer and one source runtime
  expect(result.counts.good[0]).toBe(1);
  expect(result.counts.good[1]).toBeGreaterThan(0);
  expect(result.counts.unused).toEqual([0, 0]);
  expect(result.counts.camera).toEqual([0, 0]);
  expect(result.counts.fx).toEqual([0, 0]);
  expect(result.acquisitions).toBe(0);
  expect(result.signal).toBeGreaterThan(.2);
  expect(result.mapped).toBeGreaterThan(.1);
  expect(result.diagnostics).toContain('Missing pattern: deleted-pattern');
  expect(result.diagnostics.join(' ')).toContain('Script not approved');
  expect(result.retired).toBe(1);
});

test('editor selection prepares disconnected targets once and expands audio routes without duplicate shared dependencies', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const pixel = canvas => [...canvas.getContext('2d').getImageData(2, 2, 1, 1).data];
    const counts = { shared: 0, side: 0 }, draws = { shared: 0, side: 0 }, slots = new Map(), retired = [];
    const sketches = ['shared', 'side'].map(id => ({ id, params: [{ key: 'brightness', min: 0, max: 1, step: .01, default: .5 }],
      factory: () => p => { p.setup = () => { counts[id]++; p.createCanvas(16, 16); };
        p.draw = () => { draws[id]++; p.background(id === 'shared' ? 210 : 40, 0, 0); }; } }));
    const graph = { version: 2, name: 'lazy previews', nodes: [
      { id: 'shared', type: 'pattern', patternId: 'shared', params: {}, x: 0, y: 0 },
      { id: 'side', type: 'pattern', patternId: 'side', params: {}, x: 0, y: 0 },
      { id: 'mix', type: 'blend', mode: 'Normal', opacity: 1, x: 0, y: 0 },
      { id: 'tint', type: 'color', params: { brightness: 1, saturation: 1 }, x: 0, y: 0 },
      { id: 'cam', type: 'camera', deviceId: null, x: 0, y: 0 },
      { id: 'a', type: 'audio', band: 'bass', deviceId: null, channel: 'mono', x: 0, y: 0 },
      { id: 'b', type: 'audio', band: 'bass', deviceId: null, channel: 'mono', x: 0, y: 0 },
      { id: 'c', type: 'audio', band: 'bass', deviceId: 'new-route', channel: 'mono', x: 0, y: 0 },
      { id: 'out', type: 'output', x: 0, y: 0 }],
      edges: [{ from: 'shared', to: 'out', port: 'image' }, { from: 'shared', to: 'mix', port: 'base' },
        { from: 'side', to: 'mix', port: 'layer' }, { from: 'side', to: 'tint', port: 'image' }],
      modulations: [
        { from: 'a', to: 'shared', param: 'brightness', min: 0, max: 1 },
        { from: 'b', to: 'tint', param: 'brightness', min: 0, max: 1 },
        { from: 'c', to: 'tint', param: 'saturation', min: 0, max: 1 },
      ] };
    let notified = 0, captured = 0;
    const store = { upsertSlot: d => { if (d.audioInput) slots.set(d.runtimeId, d); }, retireSlots: ids => { retired.push(...ids); ids.forEach(id => slots.delete(id)); },
      createBinding: () => ({ read: () => ({ continuous: { bass: 1 } }), getState: () => ({ isReady: true }),
        noteDraw() {}, setEventDeliveryEnabled() {} }) };
    const runtime = new GraphRuntime({ graph, sketches, preview: true, width: 16, height: 16,
      context: { audioControlStore: store, cameraSource: { acquire() { captured++; } }, onAudioSlotsChanged: () => notified++ } });
    try {
      await runtime.ready;
      const initially = { sources: [...runtime.sources.keys()], buffers: [...runtime.buffers.keys()], slots: slots.size,
        sample: runtime.sample, ...counts, draws: { ...draws } };
      const outputPixel = pixel(await runtime.renderFrame());
      const mixed = pixel(await runtime.renderFrame('mix'));
      await runtime.renderFrame('mix');
      const afterMix = { sources: [...runtime.sources.keys()], buffers: [...runtime.buffers.keys()], counts: { ...counts },
        opacity: runtime.params.get('mix')?.opacity };
      const tinted = pixel(await runtime.renderFrame('tint'));
      const afterTint = { slots: slots.size, routes: [...slots.values()].map(d => d.audioInput.deviceId),
        status: !!runtime.getNodeStatus('b'), notified, counts: { ...counts },
        brightness: runtime.params.get('tint')?.brightness, saturation: runtime.params.get('tint')?.saturation };
      const sampled = pixel(await runtime.renderFrame('cam'));
      const parked = runtime.sources.get('side').paused;
      await runtime.renderFrame('mix');
      const resumed = !runtime.sources.get('side').paused;
      return { initially, outputPixel, mixed, afterMix, tinted, afterTint, sampled, parked, resumed, captured,
        sampleCreated: !!runtime.sample, finalCounts: { ...counts } };
    } finally { runtime.dispose(); }
  });
  expect(result.initially).toMatchObject({ sources: ['shared'], buffers: ['shared', 'out'], slots: 1, sample: null, shared: 1, side: 0 });
  expect(result.initially.draws.side).toBe(0);
  expect(result.outputPixel[0]).toBe(210);
  expect(result.mixed[0]).toBe(40);
  expect(result.afterMix).toMatchObject({ sources: ['shared', 'side'], counts: { shared: 1, side: 1 }, opacity: 1 });
  expect(result.afterMix.buffers.sort()).toEqual(['mix', 'out', 'shared', 'side']);
  expect(result.tinted[3]).toBe(255);
  expect(result.afterTint).toMatchObject({ slots: 2, status: true, counts: { shared: 1, side: 1 } });
  expect(result.afterTint.brightness).toBeGreaterThan(0);
  expect(result.afterTint.saturation).toBeGreaterThan(0);
  expect(result.afterTint.routes).toEqual([null, 'new-route']);
  expect(result.afterTint.notified).toBeGreaterThan(0);
  expect(result.sampled[3]).toBe(255);
  expect(result.sampleCreated).toBe(true);
  expect(result.captured).toBe(0);
  expect(result.parked).toBe(true);
  expect(result.resumed).toBe(true);
  expect(result.finalCounts).toEqual({ shared: 1, side: 1 });
});

test('selecting a disconnected Pattern lazily installs saved and modulated parameter views before source prepare', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const setups = { main: 0, side: 0 }, slots = [];
    const sketches = [
      { id: 'main', params: [], factory: () => p => {
        p.setup = () => { setups.main++; p.createCanvas(16, 16); };
        p.draw = () => p.background(32, 0, 0);
      } },
      { id: 'side', params: [
        { key: 'level', min: 0, max: 1, step: .01, default: .2 },
        { key: 'glow', min: 0, max: 1, step: .01, default: .1 },
      ], factory: (_audio, _video, params) => p => {
        p.setup = () => { setups.side++; p.createCanvas(16, 16); };
        p.draw = () => p.background(Math.round(params.level * 200), Math.round(params.glow * 200), 0);
      } },
    ];
    const graph = { version: 2, name: 'lazy parameter views', nodes: [
      { id: 'main', type: 'pattern', patternId: 'main', params: {}, x: 0, y: 0 },
      { id: 'side', type: 'pattern', patternId: 'side', params: { level: .75, glow: .1 }, x: 0, y: 0 },
      { id: 'audio', type: 'audio', band: 'bass', deviceId: null, channel: 'mono', x: 0, y: 0 },
      { id: 'gain', type: 'math', op: 'add', a: 0, b: .25, x: 0, y: 0 },
      { id: 'out', type: 'output', x: 0, y: 0 },
    ], edges: [{ from: 'main', to: 'out', port: 'image' }],
    signalEdges: [{ from: 'audio', to: 'gain', port: 'a' }],
    modulations: [{ from: 'gain', to: 'side', param: 'glow', min: .1, max: .9 }] };
    const store = { upsertSlot: slot => { if (slot.audioInput) slots.push(slot.runtimeId); }, retireSlots() {},
      createBinding: () => ({ read: () => ({ continuous: { bass: 1.2 } }), noteDraw() {}, setEventDeliveryEnabled() {} }) };
    const runtime = new GraphRuntime({ graph, sketches, preview: true, width: 16, height: 16,
      context: { audioControlStore: store } });
    try {
      await runtime.ready;
      const before = { params: [...runtime.params.keys()], sources: [...runtime.sources.keys()], slots: slots.length, setups: { ...setups } };
      const side = await runtime.renderFrame('side');
      const pixel = [...side.getContext('2d').getImageData(2, 2, 1, 1).data];
      const view = runtime.params.get('side');
      const after = { params: [...runtime.params.keys()], sources: [...runtime.sources.keys()], slots: slots.length,
        saved: view?.level, mapped: view?.glow, base: runtime.graph.nodes.find(n => n.id === 'side').params.glow,
        setups: { ...setups }, pixel };
      await runtime.renderFrame('side');
      return { before, after, repeated: { setups: { ...setups }, slots: slots.length } };
    } finally { runtime.dispose(); }
  });
  expect(result.before).toEqual({ params: ['main'], sources: ['main'], slots: 0, setups: { main: 1, side: 0 } });
  expect(result.after.params.sort()).toEqual(['main', 'side']);
  expect(result.after.sources).toEqual(['main', 'side']);
  expect(result.after.saved).toBe(.75);
  expect(result.after.mapped).toBe(.6);
  expect(result.after.base).toBe(.1);
  expect(result.after.pixel).toEqual([150, 120, 0, 255]);
  expect(result.after.slots).toBe(1);
  expect(result.after.setups).toEqual({ main: 1, side: 1 });
  expect(result.repeated).toEqual({ setups: { main: 1, side: 1 }, slots: 1 });
});

test('unrelated missing/invalid/changed Patterns do not poison healthy output in either renderer; reachable failures remain diagnosed', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { dependencySignature } = await import('/src/nodes/portability.js');
    const pixel = canvas => [...canvas.getContext('2d').getImageData(2, 2, 1, 1).data];
    let idleSetups = 0, idleDraws = 0;
    const sketches = [
      { id: 'good', name: 'Good', params: [], factory: () => p => { p.setup = () => p.createCanvas(16, 16); p.draw = () => p.background(205, 0, 0); } },
      { id: 'idle', name: 'Idle', params: [], factory: () => p => {
        p.setup = () => { idleSetups++; p.createCanvas(16, 16); };
        p.draw = () => { idleDraws++; p.background(80, 0, 0); };
      } },
      { id: 'bounded', name: 'Bounded', params: [{ key: 'brightness', min: 0, max: 1, default: .5 }],
        factory: () => p => { p.setup = () => p.createCanvas(16, 16); p.draw = () => p.background(80, 0, 0); } },
      { id: 'changed', name: 'Changed', params: [], factory: () => p => { p.setup = () => p.createCanvas(16, 16); p.draw = () => p.background(90, 0, 0); } },
      { id: 'fx', name: 'FX', params: [], fx: { input: 'image' }, factory: (_a, _v, _p, ctx) => p => {
        p.setup = () => p.createCanvas(16, 16);
        p.draw = () => p.image(ctx.getImageInput().source, 0, 0, p.width, p.height);
      } },
    ];
    const pattern = (id, patternId, params = {}) => ({ id, type: 'pattern', patternId, params, x: 0, y: 0 });
    const image = (from, to, port = 'image') => ({ from, to, port });
    const base = fx => ({ version: 2, name: 'scoped', nodes: [pattern('healthy', 'good'),
      ...(fx ? [pattern('effect', 'fx')] : []), pattern('idle', 'idle'), pattern('missing', 'deleted'), pattern('invalid', 'bounded', { brightness: 2 }),
      pattern('changed', 'changed'), { id: 'out', type: 'output', x: 0, y: 0 }],
      edges: fx ? [image('healthy', 'effect'), image('effect', 'out')] : [image('healthy', 'out')] });
    const manifest = [{ id: 'changed', signature: 'old-signature', name: 'Changed' },
      { id: 'good', signature: dependencySignature(sketches[0]) }];
    const run = async (fx, failing) => {
      const graph = base(fx);
      if (failing) {
        graph.nodes.push({ id: 'mix', type: 'blend', mode: 'Normal', opacity: 1, x: 0, y: 0 });
        graph.edges = graph.edges.filter(e => e.to !== 'out');
        graph.edges.push(image(fx ? 'effect' : 'healthy', 'mix', 'base'), image(failing, 'mix', 'layer'), image('mix', 'out'));
      }
      const runtime = new GraphRuntime({ graph, sketches, dependencies: manifest, preview: false, width: 16, height: 16 });
      await runtime.ready;
      // Warnings describe degraded rendering, not fatal branch errors.
      runtime.warnings.set('degraded', 'degraded shader warning');
      const output = pixel(await runtime.renderFrame());
      const state = { output, sources: [...runtime.sources.keys()], work: [...runtime.work.keys()],
        diagnostics: runtime.getDiagnostics(), hasFx: runtime.hasFx };
      runtime.dispose();
      return state;
    };
    const broken = async (fx, id) => {
      const graph = base(fx);
      graph.edges = fx ? [image(id, 'effect'), image('effect', 'out')] : [image(id, 'out')];
      const runtime = new GraphRuntime({ graph, sketches, dependencies: manifest, preview: false, width: 16, height: 16 });
      await runtime.ready;
      const state = { pixel: pixel(await runtime.renderFrame()), diagnostics: runtime.getDiagnostics(), sources: [...runtime.sources.keys()] };
      runtime.dispose(); return state;
    };
    return { sync: await run(false), async: await run(true), syncMix: await run(false, 'missing'),
      asyncMix: await run(true, 'invalid'), changed: await run(false, 'changed'),
      broken: await Promise.all(['missing', 'invalid', 'changed'].flatMap(id => [broken(false, id), broken(true, id)])),
      idleSetups, idleDraws };
  });
  for (const item of [result.sync, result.async, result.syncMix, result.asyncMix, result.changed]) {
    expect(item.output).toEqual([205, 0, 0, 255]);
    expect(item.diagnostics.join(' ')).toContain('Missing pattern: deleted');
    expect(item.diagnostics.join(' ')).toContain('Invalid Bounded parameter: brightness');
    expect(item.diagnostics.join(' ')).toContain('Changed dependency: Changed');
    expect(item.diagnostics).toContain('degraded shader warning');
  }
  expect(result.sync.sources).toEqual(['healthy']);
  expect(result.async.sources).toEqual(['healthy', 'effect']);
  expect(result.sync.hasFx).toBe(false);
  expect(result.sync.work).toEqual([]);
  expect(result.async.hasFx).toBe(true);
  expect(result.async.work.sort()).toEqual(['effect', 'healthy', 'out']);
  expect([result.idleSetups, result.idleDraws]).toEqual([0, 0]);
  for (const [index, item] of result.broken.entries()) {
    expect(item.pixel).toEqual([0, 0, 0, 0]);
    expect(item.diagnostics.join(' ')).toContain(index < 2 ? 'Missing pattern: deleted'
      : index < 4 ? 'Invalid Bounded parameter: brightness' : 'Changed dependency: Changed');
    expect(item.sources).not.toContain(index < 2 ? 'missing' : index < 4 ? 'invalid' : 'changed');
  }
});

test('a reachable async FX failure clears only its branch while a healthy sibling and warning persist', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const pixel = canvas => [...canvas.getContext('2d').getImageData(2, 2, 1, 1).data];
    let fail = false;
    const sketches = [
      { id: 'red', params: [], factory: () => p => { p.setup = () => p.createCanvas(16, 16); p.draw = () => p.background(185, 0, 0); } },
      { id: 'effect', params: [], fx: { input: 'image' }, factory: (_a, _v, _p, ctx) => p => {
        p.setup = () => p.createCanvas(16, 16);
        p.draw = () => { if (fail) throw Error('deliberate FX error'); p.image(ctx.getImageInput().source, 0, 0, p.width, p.height); };
      } },
    ];
    const graph = { version: 2, name: 'FX branch', nodes: [
      { id: 'healthy', type: 'pattern', patternId: 'red', params: {}, x: 0, y: 0 },
      { id: 'fx', type: 'pattern', patternId: 'effect', params: {}, x: 0, y: 0 },
      { id: 'mix', type: 'blend', mode: 'Normal', opacity: 1, x: 0, y: 0 },
      { id: 'out', type: 'output', x: 0, y: 0 }], edges: [
      { from: 'healthy', to: 'fx', port: 'image' }, { from: 'healthy', to: 'mix', port: 'base' },
      { from: 'fx', to: 'mix', port: 'layer' }, { from: 'mix', to: 'out', port: 'image' }] };
    const runtime = new GraphRuntime({ graph, sketches, preview: false, width: 16, height: 16 });
    try {
      await runtime.ready;
      const good = pixel(await runtime.renderFrame());
      runtime.warnings.set('fallback', 'nonfatal fallback warning');
      fail = true;
      const healthy = pixel(await runtime.renderFrame());
      return { good, healthy, diagnostics: runtime.getDiagnostics() };
    } finally { runtime.dispose(); }
  });
  expect(result.good).toEqual([185, 0, 0, 255]);
  expect(result.healthy).toEqual(result.good);
  expect(result.diagnostics.join(' ')).toContain('deliberate FX error');
  expect(result.diagnostics).toContain('nonfatal fallback warning');
});

test('source draw failures stay on their own branch in synchronous and FX graphs', async ({ page }) => {
  await page.goto('/?role=nodes');
  const results = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const sketches = [
      { id: 'healthy', params: [], factory: () => p => {
        p.setup = () => p.createCanvas(16, 16);
        p.draw = () => p.background(160, 0, 0);
      } },
      { id: 'broken', params: [], factory: () => p => {
        p.setup = () => p.createCanvas(16, 16);
        p.draw = () => { throw Error('source draw failed'); };
      } },
      { id: 'effect', params: [], fx: { input: 'image' }, factory: (_a, _v, _p, ctx) => p => {
        p.setup = () => p.createCanvas(16, 16);
        p.draw = () => p.image(ctx.getImageInput().source, 0, 0, p.width, p.height);
      } },
    ];
    const pattern = (id, patternId) => ({ id, type: 'pattern', patternId, params: {}, x: 0, y: 0 });
    const edge = (from, to, port = 'image') => ({ from, to, port });
    const run = async fx => {
      const graph = { version: 2, name: 'source failures', nodes: [pattern('healthy', 'healthy'),
        pattern('broken', 'broken'), ...(fx ? [pattern('effect', 'effect')] : []),
        { id: 'mix', type: 'blend', mode: 'Normal', opacity: 1, x: 0, y: 0 },
        { id: 'out', type: 'output', x: 0, y: 0 }],
        edges: [edge('healthy', fx ? 'effect' : 'mix', fx ? 'image' : 'base'),
          ...(fx ? [edge('effect', 'mix', 'base')] : []), edge('broken', 'mix', 'layer'), edge('mix', 'out')] };
      const runtime = new GraphRuntime({ graph, sketches, preview: false, width: 16, height: 16 });
      try {
        await runtime.ready;
        const image = await runtime.renderFrame();
        return { pixel: [...image.getContext('2d').getImageData(2, 2, 1, 1).data],
          diagnostics: runtime.getDiagnostics(), hasFx: runtime.hasFx };
      } finally { runtime.dispose(); }
    };
    return [await run(false), await run(true)];
  });
  expect(results.map(r => r.hasFx)).toEqual([false, true]);
  for (const result of results) {
    expect(result.pixel).toEqual([160, 0, 0, 255]);
    expect(result.diagnostics.join(' ')).toContain('source draw failed');
  }
});
