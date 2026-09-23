import { test, expect } from '@playwright/test';
import { activeInputs, imageInputConnected, inputs, patternInputMode } from '../src/nodes/definitions.js';
import { connect, connectionRef, deleteNode, removeConnection, validateGraph } from '../src/nodes/model.js';
import { graphDiagnostics, manifestFor, parseGraph, serializeGraph } from '../src/nodes/portability.js';

const image = (from, to) => ({ from, to, port: 'image' });
const effect = { id: 'video-fx', name: 'Video FX', camera: true, fx: { input: 'image' }, params: [] };
const plain = { id: 'plain', name: 'Plain', params: [] };
const pattern = (id, patternId, inputMode) => ({ id, type: 'pattern', patternId, x: 0, y: 0, params: {}, ...(inputMode ? { inputMode } : {}) });
const output = { id: 'output', type: 'output', x: 200, y: 0 };
const graph = (version = 1, mode) => ({ version, name: 'Video FX', nodes: [pattern('source', 'plain'), pattern('effect', 'video-fx', mode), output], edges: [image('effect', 'output')] });

test('optional image socket upgrades v1 atomically and saved explicit FX/source wires remain repairable', () => {
  const old = graph();
  expect(validateGraph(old)).toEqual(old);
  expect(inputs(old.nodes[1])).toEqual(['image']);
  expect(activeInputs(old.nodes[1], effect)).toEqual(['image']);
  expect(activeInputs(old.nodes[1], plain)).toEqual([]);
  const wired = connect(old, 'source', 'effect', 'image', { sketches: [plain, effect] });
  expect(wired.version).toBe(2);
  expect(wired.nodes[1].inputMode).toBeUndefined();
  expect(imageInputConnected(wired, 'effect')).toBe(true);
  expect(patternInputMode(wired.nodes[1], wired)).toBe('fx');
  expect(parseGraph(serializeGraph(wired, manifestFor(wired, [plain, effect]))).graph).toEqual(wired);
  expect(() => validateGraph({ ...wired, version: 1 })).toThrow(/version 2/);
  expect(() => connect(old, 'source', 'effect', 'image')).toThrow(/FX-capable/);
  expect(() => connect(old, 'source', 'effect', 'image', { sketches: [plain, { ...effect, fx: undefined }] })).toThrow(/FX-capable/);
  expect(() => connect(old, 'source', 'effect', 'image', { sketches: [plain, { ...effect, projection: true }] })).toThrow(/FX-capable/);
  expect(() => connect(wired, 'effect', 'source', 'image', { sketches: [plain, effect] })).toThrow(/FX-capable/);
  expect(() => connect(wired, 'effect', 'effect', 'image', { sketches: [plain, effect] })).toThrow(/cycle/);
  const explicitSource = { ...wired, nodes: wired.nodes.map(n => n.id === 'effect' ? { ...n, inputMode: 'source' } : n) };
  expect(patternInputMode(explicitSource.nodes[1], explicitSource)).toBe('fx');
  expect(graphDiagnostics(explicitSource, [plain, effect]).messages).toEqual([]);
  const disconnected = removeConnection(wired, connectionRef('image', image('source', 'effect')));
  expect(patternInputMode(disconnected.nodes[1], disconnected)).toBe('source');
  expect(disconnected.edges).toEqual([image('effect', 'output')]);
  expect(graphDiagnostics(disconnected, [plain, effect]).messages).toEqual([]);

  const savedFx = { ...wired, nodes: wired.nodes.map(n => n.id === 'effect' ? { ...n, inputMode: 'fx' } : n) };
  expect(validateGraph(savedFx).edges).toHaveLength(2);
  const removed = removeConnection(savedFx, connectionRef('image', image('source', 'effect')));
  expect(removed.nodes[1].inputMode).toBeUndefined();
  const deleted = deleteNode(savedFx, 'source');
  expect(deleted.nodes.find(n => n.id === 'effect').inputMode).toBeUndefined();
  expect(deleted.edges).toEqual([image('effect', 'output')]);
  // Imported legacy FX intent with no edge still runs as a source and can save.
  const stranded = { ...savedFx, edges: [image('effect', 'output')] };
  expect(patternInputMode(stranded.nodes[1], stranded)).toBe('source');
  expect(graphDiagnostics(stranded, [plain, effect]).messages).toEqual([]);
  expect(validateGraph(stranded, { complete: true })).toEqual(stranded);
  const unsupported = { ...effect, fx: undefined };
  expect(graphDiagnostics(stranded, [plain, unsupported]).byNode.get('effect').join()).toContain('does not support image FX');
  expect(graphDiagnostics(savedFx, [plain, unsupported]).byNode.get('effect').join()).toContain('saved input and wire retained');
  expect(graphDiagnostics(savedFx, [plain]).byNode.get('effect').join()).toContain('Missing pattern');
  expect(activeInputs(savedFx.nodes[1], unsupported, savedFx)).toEqual(['image']);
  const implicitMissing = { ...savedFx, nodes: wired.nodes };
  expect(activeInputs(implicitMissing.nodes[1], undefined, implicitMissing)).toEqual(['image']);
});

test('FX editor targeting a scalar node never swaps an undefined image buffer into disposal', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const graph = { version: 2, name: 'scalar preview', nodes: [
      { id: 'camera', type: 'camera', deviceId: null, x: 0, y: 0 },
      { id: 'audio', type: 'audio', band: 'bass', x: 0, y: 0 },
      { id: 'output', type: 'output', x: 0, y: 0 },
    ], edges: [{ from: 'camera', to: 'output', port: 'image' }] };
    const runtime = new GraphRuntime({ graph, sketches: [], preview: true });
    try {
      await runtime.ready;
      const scalar = await runtime.renderFrame('audio');
      const output = await runtime.renderFrame();
      return { scalar, hasScalarBuffer: runtime.buffers.has('audio'), hasScalarWork: runtime.work.has('audio'),
        pixel: [...output.getContext('2d').getImageData(3, 3, 1, 1).data] };
    } finally { runtime.dispose(); }
  });
  expect(result.scalar).toBeNull();
  expect(result.hasScalarBuffer).toBe(false);
  expect(result.hasScalarWork).toBe(false);
  expect(result.pixel[3]).toBe(255);
});

test('synthetic clip is bounded, colorful, asymmetric, time-varying and disposable', async ({ page }) => {
  await page.goto('/?role=nodes');
  const clip = await page.evaluate(async () => {
    const { createPreviewClip } = await import('/src/nodes/preview-clip.js');
    const source = createPreviewClip(8000, 4500);
    const size = [source.canvas.width, source.canvas.height];
    const digest = () => {
      const pixels = source.canvas.getContext('2d').getImageData(0, 0, size[0], size[1]).data;
      let hash = 2166136261;
      for (let i = 0; i < pixels.length; i += 31) hash = Math.imul(hash ^ pixels[i], 16777619);
      return hash >>> 0;
    };
    source.draw(0); const first = digest();
    const left = [...source.canvas.getContext('2d').getImageData(3, 3, 1, 1).data];
    const right = [...source.canvas.getContext('2d').getImageData(size[0] - 4, 3, 1, 1).data];
    source.draw(0); const repeated = digest();
    source.draw(4); const moved = digest();
    source.resize(320, 180);
    const resized = [source.canvas.width, source.canvas.height];
    const revision = source.revision;
    const canvas = source.canvas;
    source.dispose();
    return { size, left, right, first, repeated, moved, resized, revision, after: source.draw(5), canvasSize: [canvas.width, canvas.height] };
  });
  expect(clip.size).toEqual([640, 360]);
  expect(clip.left[3]).toBe(255);
  expect(clip.right[3]).toBe(255);
  expect(clip.left).not.toEqual(clip.right);
  expect(clip.first).toBe(clip.repeated);
  expect(clip.moved).not.toBe(clip.first);
  expect(clip.revision).toBe(3);
  expect(clip.resized).toEqual([320, 180]);
  expect(clip.after).toBeNull();
  expect(clip.canvasSize).toEqual([1, 1]);
});

test('editor Camera → implicit FX → implicit FX → Output publishes this tick’s animated sample without capture', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const image = (from, to) => ({ from, to, port: 'image' });
    const nodes = [
      { id: 'cam', type: 'camera', deviceId: null, x: 0, y: 0 },
      { id: 'fx1', type: 'pattern', patternId: 'video-fx', params: {}, x: 0, y: 0 },
      { id: 'fx2', type: 'pattern', patternId: 'video-fx', params: {}, x: 0, y: 0 },
      { id: 'out', type: 'output', x: 0, y: 0 },
    ];
    const graph = { version: 2, name: 'preview chain', nodes, edges: [image('cam', 'fx1'), image('fx1', 'fx2'), image('fx2', 'out')] };
    const modes = [], stamps = [], inputs = [], revisions = [];
    const fx = { id: 'video-fx', camera: true, fx: { input: 'image' }, params: [], factory: (_a, _v, _p, ctx) => p => {
      modes.push(ctx.inputMode);
      p.setup = () => { p.createCanvas(48, 32); if (ctx.inputMode !== 'fx') ctx.createCapture(p, { video: true }); };
      p.draw = () => { const f = ctx.getImageInput(); stamps.push(f.frameId); inputs.push(f.source); p.image(f.source, 0, 0, p.width, p.height); };
    } };
    let acquired = 0, mediaRequests = 0;
    const devices = navigator.mediaDevices;
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = (...args) => { mediaRequests++; return original(...args); };
    const r = new GraphRuntime({ graph, sketches: [fx], preview: true, context: { cameraSource: { acquire() { acquired++; throw Error('Real capture forbidden'); } } } });
    const pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
    try {
      await r.ready;
      r.elapsed = () => 0;
      const first = pixel(await r.renderFrame(), 200, 100);
      const upstream = pixel(r.buffers.get('cam'), 200, 100);
      revisions.push(r.sourceRevision.get('cam'));
      r.elapsed = () => 2;
      const next = pixel(await r.renderFrame(), 200, 100);
      const nextUpstream = pixel(r.buffers.get('cam'), 200, 100);
      revisions.push(r.sourceRevision.get('cam'));
      const diagnostics = r.getDiagnostics();
      const hasFx = r.hasFx, cameraChild = r.sources.has('cam');
      return { first, upstream, next, nextUpstream, revisions, diagnostics, hasFx, cameraChild,
        modes, stamps, inputWasSample: inputs[0] === r.sample.canvas,
        acquired, mediaRequests };
    } finally { r.dispose(); devices.getUserMedia = original; }
  });
  expect(result.hasFx).toBe(true);
  expect(result.cameraChild).toBe(false);
  expect(result.modes).toEqual(['fx', 'fx']);
  expect(result.stamps).toEqual([1, 1, 2, 2]);
  expect(result.inputWasSample).toBe(false); // FX1 gets the Camera work snapshot, not mutable sample pixels
  expect(result.first).toEqual(result.upstream);
  expect(result.next).toEqual(result.nextUpstream);
  expect(result.first).not.toEqual(result.next);
  expect(result.revisions[1]).toBeGreaterThan(result.revisions[0]);
  expect(result.diagnostics).toEqual([]);
  expect(result.acquired).toBe(0);
  expect(result.mediaRequests).toBe(0);
});

test('unconnected legacy FX camera falls back to the real output source; preview uses FX sample only', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const image = (from, to) => ({ from, to, port: 'image' });
    const graph = { version: 2, name: 'fallback', nodes: [
      { id: 'fx', type: 'pattern', patternId: 'video-fx', inputMode: 'fx', params: {}, x: 0, y: 0 },
      { id: 'out', type: 'output', x: 0, y: 0 },
    ], edges: [image('fx', 'out')] };
    const modes = [], captures = [];
    const fx = { id: 'video-fx', camera: true, fx: { input: 'image' }, params: [], factory: (_a, _v, _p, ctx) => p => {
      modes.push(ctx.inputMode);
      let lease;
      p.setup = () => { p.createCanvas(64, 36); if (ctx.inputMode === 'source') lease = ctx.createCapture(p, { video: true }); };
      p.draw = () => {
        if (ctx.inputMode === 'fx') p.image(ctx.getImageInput().source, 0, 0, p.width, p.height);
        else if (lease?.elt) p.image(lease.elt, 0, 0, p.width, p.height);
      };
    } };
    let released = 0;
    const cameraSource = { acquire({ onReady }) {
      captures.push('acquired');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
      canvas.getContext('2d').fillStyle = '#43b51a'; canvas.getContext('2d').fillRect(0, 0, 2, 2);
      queueMicrotask(onReady);
      return { capture: { elt: canvas, hide() {} }, release() { released++; } };
    } };
    const pixel = c => [...c.getContext('2d').getImageData(1, 1, 1, 1).data];
    const output = new GraphRuntime({ graph, sketches: [fx], preview: false, context: { cameraSource } });
    await output.ready;
    const real = pixel(await output.renderFrame()), outputFx = output.hasFx, outDiagnostic = output.getDiagnostics();
    output.dispose();
    const freshGraph = { ...graph, nodes: graph.nodes.map(n => n.id === 'fx' ? { ...n, inputMode: undefined } : n) };
    const freshOutput = new GraphRuntime({ graph: freshGraph, sketches: [fx], preview: false, context: { cameraSource } });
    await freshOutput.ready;
    const freshReal = pixel(await freshOutput.renderFrame()); freshOutput.dispose();
    const preview = new GraphRuntime({ graph, sketches: [fx], preview: true, context: { cameraSource } });
    await preview.ready;
    preview.elapsed = () => 2;
    const sample = pixel(await preview.renderFrame()), previewFx = preview.hasFx, previewDiagnostic = preview.getDiagnostics();
    preview.dispose();
    const freshPreview = new GraphRuntime({ graph: freshGraph, sketches: [fx], preview: true, context: { cameraSource } });
    await freshPreview.ready; freshPreview.elapsed = () => 2;
    const freshSample = pixel(await freshPreview.renderFrame()); freshPreview.dispose();
    return { real, freshReal, sample, freshSample, modes, captures, released, outputFx, previewFx, outDiagnostic, previewDiagnostic };
  });
  expect(result.outputFx).toBe(false);
  expect(result.previewFx).toBe(true);
  expect(result.modes).toEqual(['source', 'source', 'fx', 'fx']);
  expect(result.real).toEqual([67, 181, 26, 255]);
  expect(result.freshReal).toEqual(result.real);
  expect(result.sample[3]).toBe(255);
  expect(result.freshSample).toEqual(result.sample);
  expect(result.sample).not.toEqual(result.real);
  expect(result.captures).toEqual(['acquired', 'acquired']);
  expect(result.released).toBe(2);
  expect(result.outDiagnostic).toEqual([]);
  expect(result.previewDiagnostic).toEqual([]);
});
