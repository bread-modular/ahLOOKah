import { test, expect } from '@playwright/test';
import { inputs, activeInputs, defaultNode } from '../src/nodes/definitions.js';
import { newGraph, connect, validateGraph } from '../src/nodes/model.js';
import { manifestFor, graphDiagnostics, serializeGraph, parseGraph } from '../src/nodes/portability.js';

const pattern = (id, patternId, mode) => ({ id, type: 'pattern', patternId, x: 0, y: 0, params: {}, ...(mode ? { inputMode: mode } : {}) });
const out = { id: 'out', type: 'output', x: 200, y: 0 };
const fxGraph = () => ({ version: 2, name: 'FX chain', nodes: [pattern('src', 'plain'), pattern('fx1', 'effect', 'fx'), pattern('fx2', 'effect', 'fx'), out], edges: [
  { from: 'src', to: 'fx1', port: 'image' }, { from: 'fx1', to: 'fx2', port: 'image' }, { from: 'fx2', to: 'out', port: 'image' },
] });
const fxSketch = { id: 'effect', name: 'Effect', fx: { input: 'image' }, params: [] };

test('v1 stays source; v2 FX/camera persist, validate ports/cycles/camera selection and file versions', () => {
  expect(newGraph().version).toBe(1);
  expect(inputs(pattern('old', 'effect'))).toEqual(['image']); // potential optional port
  expect(activeInputs(pattern('old', 'effect'))).toEqual([]);
  expect(activeInputs(pattern('old', 'effect'), fxSketch)).toEqual(['image']);
  expect(activeInputs(pattern('a', 'effect', 'fx'))).toEqual(['image']);
  const old = { version: 1, name: 'old', nodes: [pattern('old', 'effect'), out], edges: [{ from: 'old', to: 'out', port: 'image' }] };
  expect(validateGraph(old)).toEqual(old);
  expect(parseGraph(serializeGraph(old, [{ id: 'effect', signature: null }])).graph).toEqual(old);
  const graph = fxGraph();
  const camera = defaultNode('camera', 0, 0, 'webcam');
  expect(camera).toMatchObject({ type: 'camera', deviceId: null });
  graph.nodes.push({ ...camera, deviceId: 'opaque:Cam/01' });
  graph.edges[0].from = 'webcam';
  const sketches = [fxSketch, { id: 'plain', name: 'Plain', params: [] }];
  expect(manifestFor(graph, sketches).map(d => d.id)).toEqual(['plain', 'effect']); // no camera entry
  const json = serializeGraph(graph, manifestFor(graph, sketches));
  const saved = JSON.parse(json);
  expect(saved.version).toBe(2);
  expect(parseGraph(json).graph).toEqual(validateGraph(graph));
  expect(() => parseGraph(JSON.stringify({ ...saved, version: 3 }))).toThrow(/Unsupported/);
  expect(() => parseGraph(JSON.stringify({ ...saved, version: 1 }))).toThrow(/versions do not match/);
  expect(() => validateGraph({ ...graph, version: 1 })).toThrow(/version 2/);
  expect(() => validateGraph({ ...graph, version: 3 })).toThrow(/version/);
  for (const deviceId of ['', 'x'.repeat(513), 'cam\n0', 123, false])
    expect(() => validateGraph({ ...graph, nodes: graph.nodes.map(n => n.id === 'webcam' ? { ...n, deviceId } : n) })).toThrow(/camera input device/);
  expect(validateGraph({ ...graph, nodes: graph.nodes.map(n => n.id === 'webcam' ? { ...n, deviceId: 'x'.repeat(512) } : n) }).nodes.at(-1).deviceId).toHaveLength(512);
  expect(() => validateGraph({ ...graph, nodes: graph.nodes.map(n => n.id === 'fx1' ? { ...n, inputMode: 'wrong' } : n) })).toThrow(/input mode/);
  expect(() => validateGraph({ ...graph, edges: [...graph.edges, { from: 'fx2', to: 'fx1', port: 'image' }] })).toThrow(/duplicate/);
  expect(() => connect(graph, 'fx2', 'fx1', 'image', { sketches })).toThrow(/cycle/);
  expect(() => connect(graph, 'fx1', 'src', 'image', { sketches })).toThrow(/FX-capable/);
  expect(() => connect(graph, 'webcam', 'fx1', 'image')).toThrow(/FX-capable/);
  expect(connect(graph, 'webcam', 'fx1', 'image', { sketches }).edges).toContainEqual({ from: 'webcam', to: 'fx1', port: 'image' });
  expect(() => validateGraph({ ...graph, edges: [...graph.edges, { from: 'fx1', to: 'webcam', port: 'image' }] })).toThrow(/port/);
});

test('unavailable FX capability or disconnected image is diagnosed, never deletes saved input or manifest', () => {
  const graph = fxGraph();
  const withoutCapability = graphDiagnostics(graph, [{ id: 'plain', name: 'Plain', params: [] }, { id: 'effect', name: 'Effect', params: [] }]);
  expect(withoutCapability.byNode.get('fx1').join()).toContain('does not support image FX');
  expect(validateGraph(graph).edges).toHaveLength(3);
  const missing = graphDiagnostics(graph, [{ id: 'plain', name: 'Plain', params: [] }]);
  expect(missing.byNode.get('fx2').join()).toContain('Missing pattern');
  const disconnected = { ...graph, edges: graph.edges.filter(e => e.to !== 'fx1') };
  expect(validateGraph(disconnected).edges).toHaveLength(2);
  expect(graphDiagnostics(disconnected, [fxSketch, { id: 'plain', params: [] }]).byNode.has('fx1')).toBe(false);
  expect(validateGraph(disconnected, { complete: true }).nodes.find(n => n.id === 'fx1').inputMode).toBe('fx');
});

test('controlled FX chain reuses completed frames, pins fan-out, coalesces ticks and clears failures', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async graph => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const events = [], contexts = [];
    let value = 30, releaseDraw = null, stall = false;
    const sketch = {
      id: 'plain', name: 'Plain', params: [],
      factory: (_a, _v, _p, ctx) => p => {
        contexts.push(ctx);
        p.setup = () => p.createCanvas(48, 32);
        p.draw = () => { p.background(value, 0, 0); };
      },
    };
    const effect = { id: 'effect', name: 'Effect', fx: { input: 'image' }, camera: true, params: [], factory: (_a, _v, _params, ctx) => p => {
      contexts.push(ctx);
      p.setup = () => { p.createCanvas(48, 32); events.push(['setup', ctx.inputMode, ctx.getImageInput()]); };
      p.draw = async () => {
        const frame = ctx.getImageInput();
        const red = frame.source.getContext('2d').getImageData(0, 0, 1, 1).data[0];
        events.push(['draw', frame.frameId, red, frame.width, frame.height, frame.generation]);
        if (stall && !releaseDraw) await new Promise(resolve => { releaseDraw = resolve; });
        const after = frame.source.getContext('2d').getImageData(0, 0, 1, 1).data[0];
        events.push(['after', frame.frameId, after]);
        p.background(after + 10, 0, 0);
      };
    } };
    graph.nodes.push({ id: 'blend', type: 'blend', x: 0, y: 0, mode: 'Normal', opacity: 0 });
    graph.edges = graph.edges.filter(e => e.to !== 'out').concat([
      { from: 'fx2', to: 'blend', port: 'base' }, { from: 'fx1', to: 'blend', port: 'layer' }, { from: 'blend', to: 'out', port: 'image' },
    ]);
    const r = new GraphRuntime({ graph, sketches: [sketch, effect], preview: true });
    await r.ready;
    const source = r.sources.get('src'); source.pause();
    const pixel = canvas => [...canvas.getContext('2d').getImageData(1, 1, 1, 1).data];
    const first = pixel(await r.renderFrame());
    const firstEvents = events.filter(e => e[0] === 'draw').map(e => e.slice(1, 3));
    value = 90;
    await source.primary.redraw();
    stall = true;
    const one = r.renderFrame();
    const two = r.renderFrame();
    // The FX callback itself is the synchronisation point; no clock sleep.
    while (!releaseDraw) await Promise.resolve();
    const committedDuringDraw = pixel(r.render());
    value = 140;
    await source.primary.redraw(); // independent source writes staging, not pinned work
    releaseDraw();
    const second = pixel(await one), coalesced = pixel(await two);
    const secondEvents = events.filter(e => e[0] === 'draw').slice(2).map(e => e.slice(1, 3));
    const third = pixel(await r.renderFrame());
    const setup = events.filter(e => e[0] === 'setup');
    const paused = r.sources.get('fx1').primary.isLooping() === false;
    const diagnostics = r.getDiagnostics();
    r.dispose();
    return { first, firstEvents, committedDuringDraw, second, coalesced, secondEvents, third, setup, paused, diagnostics,
      modes: contexts.map(c => c.inputMode) };
  }, fxGraph());
  expect(result.first).toEqual([50, 0, 0, 255]);
  expect(result.firstEvents[0][1]).toBe(30);
  expect(result.firstEvents[1][1]).toBe(40);
  expect(result.firstEvents[0][0]).toBe(result.firstEvents[1][0]);
  expect(result.committedDuringDraw).toEqual(result.first);
  expect(result.second).toEqual([110, 0, 0, 255]);
  expect(result.coalesced).toEqual(result.second);
  expect(result.secondEvents[0][1]).toBe(90);
  expect(result.secondEvents[1][1]).toBe(100);
  expect(result.third).toEqual([160, 0, 0, 255]);
  expect(result.setup).toEqual([['setup', 'fx', null], ['setup', 'fx', null]]);
  expect(result.paused).toBe(true);
  expect(result.diagnostics).toEqual([]);
  expect(result.modes).toEqual(['source', 'fx', 'fx']);
});

test('FX capture entry points reject before raw fallback, unconnected camera FX uses the editor sample', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async graph => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const pixel = c => [...c.getContext('2d').getImageData(0, 0, 1, 1).data];
    let sourceCalls = 0, rawCalls = 0, fxCalls = 0;
    const adapted = { id: 'effect', name: 'Adapted camera', camera: true, fx: { input: 'image' }, params: [], factory: (_a, _v, _p, ctx) => p => {
      p.setup = () => {
        p.createCanvas(48, 32);
        if (ctx.inputMode === 'source') { sourceCalls++; ctx.createCapture(p, { video: true }); }
      };
      p.draw = () => {
        if (ctx.inputMode === 'fx') { fxCalls++; const f = ctx.getImageInput(); p.image(f.source, 0, 0, p.width, p.height); }
      };
    } };
    const solid = { id: 'plain', params: [], factory: () => p => { p.setup = () => p.createCanvas(48, 32); p.draw = () => p.background(33, 0, 0); } };
    const safe = new GraphRuntime({ graph, sketches: [solid, adapted] }); await safe.ready;
    const valid = pixel(await safe.renderFrame()); safe.dispose();
    const disconnected = { ...graph, edges: graph.edges.filter(e => e.to !== 'fx1') };
    const empty = new GraphRuntime({ graph: disconnected, sketches: [solid, adapted] }); await empty.ready;
    const blank = pixel(await empty.renderFrame()); const message = empty.getDiagnostics().join(); empty.dispose();
    const bad = { ...adapted, factory: (_a, _v, _p, ctx) => p => {
      p.setup = () => { p.createCanvas(48, 32); ctx.createCapture(p, { video: true }) || p.createCapture({ video: true }); };
    } };
    const guard = new GraphRuntime({ graph, sketches: [solid, bad] }); await guard.ready;
    const noFallback = pixel(await guard.renderFrame()); const guarded = guard.getDiagnostics().join(); guard.dispose();
    const raw = { ...adapted, factory: () => p => { p.setup = () => { p.createCanvas(48, 32); rawCalls++; p.createCapture({ video: true }); }; } };
    const direct = new GraphRuntime({ graph, sketches: [solid, raw] }); await direct.ready;
    const rawGuarded = direct.getDiagnostics().join(); direct.dispose();
    return { valid, blank, message, noFallback, guarded, rawGuarded, sourceCalls, rawCalls, fxCalls };
  }, { ...fxGraph(), nodes: [pattern('src', 'plain'), pattern('fx1', 'effect', 'fx'), out], edges: [
    { from: 'src', to: 'fx1', port: 'image' }, { from: 'fx1', to: 'out', port: 'image' },
  ] });
  expect(result.valid).toEqual([33, 0, 0, 255]);
  expect(result.blank[3]).toBe(255);
  expect(result.blank.slice(0, 3).some(channel => channel > 0)).toBe(true);
  expect(result.message).not.toContain('Camera is available only');
  expect(result.message).not.toContain('Image input required');
  expect(result.noFallback).toEqual([0, 0, 0, 0]);
  expect(result.guarded).toContain('FX patterns cannot acquire a camera');
  expect(result.rawGuarded).toContain('FX patterns cannot acquire a camera');
  expect(result.sourceCalls).toBe(0);
  expect(result.rawCalls).toBe(1); // attempted but rejected before getUserMedia
  expect(result.fxCalls).toBeGreaterThan(0);
});

test('camera source selects Global or pinned device, owns only output lease, and samples in preview', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { manifestFor } = await import('/src/nodes/portability.js');
    const graph = deviceId => ({ version: 2, name: 'camera source', nodes: [
      { id: 'cam', type: 'camera', deviceId, x: 0, y: 0 }, { id: 'out', type: 'output', x: 100, y: 0 },
    ], edges: [{ from: 'cam', to: 'out', port: 'image' }] });
    const requested = [], leases = [], audioSlots = [];
    const store = { upsertSlot: slot => audioSlots.push(slot.patternId), retireSlots() {} };
    const manager = { acquire: ({ deviceId, onReady }) => {
      requested.push(deviceId);
      const video = document.createElement('canvas'); video.width = video.height = 2;
      Object.defineProperties(video, { videoWidth: { value: 2 }, videoHeight: { value: 2 }, readyState: { value: 2 } });
      video.getContext('2d').fillRect(0, 0, 2, 2);
      queueMicrotask(onReady);
      const lease = { capture: { elt: video, hide() {} }, release: () => { lease.released++; }, released: 0 };
      leases.push(lease); return lease;
    } };
    const preview = new GraphRuntime({ graph: graph(null), sketches: [], preview: true, context: { cameraSource: manager } });
    await preview.ready;
    const previewPixel = [...(await preview.renderFrame()).getContext('2d').getImageData(5, 5, 1, 1).data];
    const blocked = preview.getDiagnostics().join(); preview.dispose();
    const unavailable = new GraphRuntime({ graph: graph(null), sketches: [], preview: false });
    await unavailable.ready; const missing = unavailable.getDiagnostics().join(); unavailable.dispose();
    const dangling = new GraphRuntime({ graph: { ...graph(null), edges: [] }, sketches: [], preview: false, context: { cameraSource: manager } });
    await dangling.ready; dangling.dispose();
    const global = new GraphRuntime({ graph: graph(null), sketches: [], preview: false, videoDeviceId: 'settings-device', context: { cameraSource: manager, audioControlStore: store } });
    await global.ready; const globalPixel = [...(await global.renderFrame()).getContext('2d').getImageData(0, 0, 1, 1).data]; global.dispose(); global.dispose();
    const pinned = new GraphRuntime({ graph: graph('specific/device'), sketches: [], preview: false, videoDeviceId: 'settings-device', context: { cameraSource: manager } });
    await pinned.ready; await pinned.renderFrame(); pinned.dispose();
    const dual = graph(null);
    dual.nodes.splice(1, 0, { id: 'cam2', type: 'camera', deviceId: 'second/device', x: 0, y: 100 },
      { id: 'mix', type: 'blend', mode: 'Normal', opacity: 0.5, x: 50, y: 0 });
    dual.edges = [{ from: 'cam', to: 'mix', port: 'base' }, { from: 'cam2', to: 'mix', port: 'layer' }, { from: 'mix', to: 'out', port: 'image' }];
    const together = new GraphRuntime({ graph: dual, sketches: [], preview: false, videoDeviceId: 'settings-device', context: { cameraSource: manager } });
    await together.ready; together.dispose();
    return { blocked, previewPixel, missing, requested, leases: leases.map(l => l.released), audioSlots, globalPixel, manifest: manifestFor(graph(null), []) };
  });
  expect(result.blocked).toBe('');
  expect(result.previewPixel[3]).toBe(255);
  expect(result.previewPixel.slice(0, 3).some(channel => channel > 0)).toBe(true);
  expect(result.missing).toContain('Camera is available only');
  expect(result.requested).toEqual(['settings-device', 'specific/device', 'settings-device', 'second/device']);
  expect(result.leases).toEqual([1, 1, 1, 1]);
  expect(result.audioSlots).toEqual([]);
  expect(result.globalPixel).toEqual([0, 0, 0, 255]);
  expect(result.manifest).toEqual([]);
});

test('camera → FX acquires only upstream; disposal during an async FX draw cannot commit', async ({ page }) => {
  await page.goto('/?role=screen');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const graph = { version: 2, name: 'camera into FX', nodes: [
      { id: 'cam', type: 'camera', deviceId: 'pinned', x: 0, y: 0 },
      { id: 'fx', type: 'pattern', patternId: 'camera-effect', inputMode: 'fx', params: {}, x: 30, y: 0 },
      { id: 'out', type: 'output', x: 100, y: 0 },
    ], edges: [{ from: 'cam', to: 'fx', port: 'image' }, { from: 'fx', to: 'out', port: 'image' }] };
    let acquire = 0, released = 0, fxDraws = 0, unlock;
    const cameraSource = { acquire: ({ deviceId, onReady }) => {
      if (deviceId !== 'pinned') throw new Error('Wrong device');
      acquire++;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
      canvas.getContext('2d').fillStyle = 'red'; canvas.getContext('2d').fillRect(0, 0, 2, 2);
      Object.defineProperties(canvas, { videoWidth: { value: 2 }, videoHeight: { value: 2 }, readyState: { value: 2 } });
      queueMicrotask(onReady);
      return { capture: { elt: canvas, hide() {} }, release: () => { released++; } };
    } };
    const sketch = { id: 'camera-effect', camera: true, fx: { input: 'image' }, params: [], factory: (_a, _v, _p, ctx) => p => {
      p.setup = () => p.createCanvas(48, 32);
      p.draw = async () => {
        fxDraws++;
        if (fxDraws === 2) await new Promise(resolve => { unlock = resolve; });
        p.image(ctx.getImageInput().source, 0, 0, p.width, p.height);
      };
    } };
    const r = new GraphRuntime({ graph, sketches: [sketch], preview: false, context: { cameraSource } });
    await r.ready;
    const pixel = c => [...c.getContext('2d').getImageData(0, 0, 1, 1).data];
    const first = pixel(await r.renderFrame());
    const pending = r.renderFrame();
    while (!unlock) await Promise.resolve();
    const before = pixel(r.buffers.get('out'));
    r.dispose(); unlock();
    const after = await pending;
    return { first, before, after, acquire, released, fxDraws, disposed: r.disposed, buffers: r.buffers.size };
  });
  expect(result.first).toEqual([255, 0, 0, 255]);
  expect(result.before).toEqual(result.first);
  expect(result.after).toBeNull();
  expect(result.acquire).toBe(1);
  expect(result.released).toBe(1);
  expect(result.fxDraws).toBe(2);
  expect(result.disposed).toBe(true);
  expect(result.buffers).toBe(0);
});

test('WebGL FX uploads a reused canvas every tick and publishes the completed draw', async ({ page }) => {
  await page.goto('/?role=nodes');
  const pixels = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    let red = 30;
    const source = { id: 'plain', params: [], factory: () => p => {
      p.setup = () => { p.pixelDensity(1); p.createCanvas(32, 32); };
      p.draw = () => p.background(red, 0, 0);
    } };
    const fx = { id: 'shader-fx', params: [], fx: { input: 'image' }, factory: (_a, _v, _p, ctx) => p => {
      let shader;
      p.setup = () => {
        p.pixelDensity(1); p.createCanvas(32, 32, p.WEBGL);
        shader = p.createShader(`precision highp float; attribute vec3 aPosition; attribute vec2 aTexCoord; varying vec2 uv;
          void main(){ uv=aTexCoord; vec4 pos=vec4(aPosition,1.0); pos.xy=pos.xy*2.0-1.0; gl_Position=pos; }`,
        `precision highp float; varying vec2 uv; uniform sampler2D uTex;
          void main(){ gl_FragColor=texture2D(uTex,uv); }`);
      };
      p.draw = () => { p.clear(); p.shader(shader); shader.setUniform('uTex', ctx.getImageInput().source); p.rect(0, 0, p.width, p.height); };
    } };
    const graph = { version: 2, name: 'GL FX', nodes: [
      { id: 'a', type: 'pattern', patternId: 'plain', params: {}, x: 0, y: 0 },
      { id: 'b', type: 'pattern', patternId: 'shader-fx', inputMode: 'fx', params: {}, x: 0, y: 0 },
      { id: 'out', type: 'output', x: 0, y: 0 },
    ], edges: [{ from: 'a', to: 'b', port: 'image' }, { from: 'b', to: 'out', port: 'image' }] };
    const r = new GraphRuntime({ graph, sketches: [source, fx], width: 32, height: 32 });
    await r.ready; r.sources.get('a').pause();
    const pixel = c => [...c.getContext('2d').getImageData(16, 16, 1, 1).data];
    const first = pixel(await r.renderFrame());
    red = 90; await r.sources.get('a').primary.redraw();
    const second = pixel(await r.renderFrame());
    const diagnostics = r.getDiagnostics(); r.dispose();
    return { first, second, diagnostics };
  });
  expect(pixels.first).toEqual([30, 0, 0, 255]);
  expect(pixels.second).toEqual([90, 0, 0, 255]);
  expect(pixels.diagnostics).toEqual([]);
});

test('a failed FX draw clears its previous committed pixels with a diagnostic', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    let fail = false;
    const source = { id: 'plain', params: [], factory: () => p => {
      p.setup = () => p.createCanvas(16, 16); p.draw = () => p.background(111, 0, 0);
    } };
    const effect = { id: 'effect', fx: { input: 'image' }, params: [], factory: (_a, _v, _p, context) => p => {
      p.setup = () => p.createCanvas(16, 16);
      p.draw = () => { if (fail) throw new Error('Test FX failure'); p.image(context.getImageInput().source, 0, 0, p.width, p.height); };
    } };
    const graph = { version: 2, name: 'failure', nodes: [
      { id: 'a', type: 'pattern', patternId: 'plain', x: 0, y: 0, params: {} },
      { id: 'b', type: 'pattern', patternId: 'effect', inputMode: 'fx', x: 0, y: 0, params: {} },
      { id: 'out', type: 'output', x: 0, y: 0 },
    ], edges: [{ from: 'a', to: 'b', port: 'image' }, { from: 'b', to: 'out', port: 'image' }] };
    const r = new GraphRuntime({ graph, sketches: [source, effect], width: 16, height: 16 }); await r.ready;
    const pixel = c => [...c.getContext('2d').getImageData(0, 0, 1, 1).data];
    const good = pixel(await r.renderFrame()); fail = true;
    const blank = pixel(await r.renderFrame()); const diagnostics = r.getDiagnostics().join(); r.dispose();
    return { good, blank, diagnostics };
  });
  expect(result.good).toEqual([111, 0, 0, 255]);
  expect(result.blank).toEqual([0, 0, 0, 0]);
  expect(result.diagnostics).toContain('Test FX failure');
});
