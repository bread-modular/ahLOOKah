import { parameterView, signalValue } from './modulation.js';
import { createSignalConsumers } from './audio-provider.js';
import VizCore from '../core/index.js';
import { ProgramRuntime } from '../program-runtime.js';
import { PreviewAudio } from '../preview-audio.js';
import { MODES, validateGraph } from './model.js';
import { graphDiagnostics } from './portability.js';
import { isVisualType, inputModeOf } from './definitions.js';
import { CAMERA_NODE_PATTERN } from './camera-source.js';
import { mathValue, mathIssue, scriptValue, scriptProgram, scriptLanguageOf, scriptSource } from './scalar.js';
import { isScriptApproved, SCRIPT_APPROVAL_MESSAGE } from './script-approval.js';

export function composite(ctx, base, layer, mode, opacity) {
  const { width, height } = ctx.canvas;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);
  if (base) ctx.drawImage(base, 0, 0, width, height);
  ctx.globalAlpha = opacity; ctx.globalCompositeOperation = MODES[mode];
  if (layer) ctx.drawImage(layer, 0, 0, width, height);
  ctx.restore();
}
const colorParam = (params, key, fallback) => Number.isFinite(params?.[key]) ? params[key] : fallback;
// Filter order is fixed (saturate → brightness → contrast → hue) and identity
// defaults return 'none', so an untouched Color node is a pixel-exact copy.
export function colorFilter(params = {}) {
  const saturation = Math.max(0, colorParam(params, 'saturation', 1));
  const brightness = Math.max(0, colorParam(params, 'brightness', 1));
  const contrast = Math.max(0, colorParam(params, 'contrast', 1));
  const hue = colorParam(params, 'hue', 0);
  if (saturation === 1 && brightness === 1 && contrast === 1 && hue === 0) return 'none';
  return `saturate(${saturation}) brightness(${brightness}) contrast(${contrast}) hue-rotate(${hue}deg)`;
}
export function applyColor(ctx, source, params = {}) {
  const { width, height } = ctx.canvas;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none'; ctx.clearRect(0, 0, width, height);
  if (source) {
    const filter = colorFilter(params);
    if (filter !== 'none') ctx.filter = filter;
    // drawImage preserves the source alpha channel; the filter only maps color.
    ctx.drawImage(source, 0, 0, width, height);
  }
  ctx.restore();
}
const sizeFor = (width, height) => {
  const ratio = Math.min(1, 1280 / Math.max(1, width), 720 / Math.max(1, height));
  return [Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio))];
};
const clear = canvas => canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
let graphGeneration = 0;
const canvasFor = size => {
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = size;
  return canvas;
};

export class GraphRuntime {
  constructor({ graph, sketches, dependencies = [], width = 480, height = 270, audio = new PreviewAudio(), context = {}, videoDeviceId = null, preview = true }) {
    this.graph = validateGraph(graph);
    this.hasFx = this.graph.nodes.some(n => n.type === 'pattern' && inputModeOf(n) === 'fx');
    this.signal = this.graph.nodes.some(n => n.type === 'audio')
      ? createSignalConsumers(context.audioControlStore, context.audioRole, this.graph.nodes.filter(n => n.type === 'audio'))
      : null;
    if (this.signal) context.registerChildRuntime?.(this.signal);
    // Route-aware continuous reads: nodeId selects the node's own requested
    // device/channel binding. Legacy callbacks that ignore the argument work.
    this.readContinuous = (nodeId) => context.readAudioSignals
      ? context.readAudioSignals(nodeId)
      : (this.signal?.read(nodeId) || {});
    this.frame = 0;
    this.generation = ++graphGeneration;
    this.frameSignals = new Map();
    this.scriptCache = new Map();
    this.scriptPrograms = new Map();
    this.startedAt = performance.now();
    this.params = new Map(this.graph.nodes.filter(n => ['pattern', 'blend', 'color'].includes(n.type))
      .map(n => [n.id, parameterView(this.graph, n, sketches, this.readContinuous, id => this.signalValue(id))]));
    this.size = sizeFor(width, height);
    this.pendingSize = null;
    this.disposed = false;
    this.sources = new Map(); this.buffers = new Map(); this.messages = new Map();
    this.work = new Map(); this.staging = new Map(); this.sourceRevision = new Map();
    this.inFlight = null;
    const diagnostic = graphDiagnostics(this.graph, sketches, dependencies);
    this.diagnostics = diagnostic.messages;
    this.nodeDiagnostics = diagnostic.byNode;
    this.graph.nodes.filter(n => isVisualType(n)).forEach(n => {
      this.buffers.set(n.id, canvasFor(this.size));
      if (this.hasFx) this.work.set(n.id, canvasFor(this.size));
      if (this.hasFx && (n.type === 'camera' || (n.type === 'pattern' && inputModeOf(n) === 'source')))
        this.staging.set(n.id, canvasFor(this.size));
    });
    // A disk-loaded Script source never carries trust with it.
    for (const node of this.graph.nodes.filter(n => n.type === 'script')) {
      this.scriptPrograms.set(node.id, scriptProgram(node, this.scriptCache));
      if (!isScriptApproved(scriptLanguageOf(node), scriptSource(node))) this.messages.set(node.id, SCRIPT_APPROVAL_MESSAGE);
    }
    // Retain legacy invalid-source behavior for graphs without FX; an FX graph
    // instead isolates each broken branch and keeps its saved wires repairable.
    if (this.diagnostics.length && !this.hasFx) { this.ready = Promise.resolve(); return; }
    const reachable = new Set();
    const reach = id => {
      if (reachable.has(id)) return;
      reachable.add(id);
      this.graph.edges.filter(e => e.to === id).forEach(e => reach(e.from));
    };
    reach(this.graph.nodes.find(n => n.type === 'output').id);
    const waits = [];
    // SharedCameraSource ties a pending source to its acquisition epoch. Starting
    // two distinct physical devices concurrently would retire the first epoch;
    // bring camera *nodes* online in sequence without blocking noncamera FX.
    let cameraReady = Promise.resolve();
    for (const node of this.graph.nodes.filter(n => n.type === 'pattern' || n.type === 'camera')) {
      // A dangling Camera card is editable without acquiring unused hardware.
      if (node.type === 'camera' && !reachable.has(node.id)) continue;
      if (this.nodeDiagnostics.has(node.id)) continue;
      const sketch = node.type === 'camera' ? CAMERA_NODE_PATTERN : sketches.find(s => s.id === node.patternId);
      if (!sketch) continue;
      const fx = node.type === 'pattern' && inputModeOf(node) === 'fx';
      const camera = node.type === 'camera' || (!fx && (sketch.camera || sketch.surfaces?.some(s => sketches.find(x => x.id === s.patternId)?.camera)));
      if (camera && (preview || !context.cameraSource)) {
        this.messages.set(node.id, 'Camera is available only on the output screen (shared capture).'); continue;
      }
      const params = this.params.get(node.id);
      const layer = document.createElement('div');
      const capture = canvas => {
        if (this.disposed) return;
        const target = fx ? this.work.get(node.id) : (this.staging.get(node.id) || this.buffers.get(node.id));
        if (!target) return;
        const ctx = target.getContext('2d');
        ctx.clearRect(0, 0, target.width, target.height);
        // Copy inside the completed user draw, BEFORE WebGL discards pixels.
        ctx.drawImage(canvas, 0, 0, target.width, target.height);
        this.sourceRevision.set(node.id, (this.sourceRevision.get(node.id) || 0) + 1);
      };
      const runtime = new ProgramRuntime({ coreConstructor: VizCore, selection: { ids: [sketch.id], merge: false },
        sketches: node.type === 'camera' ? [...sketches, CAMERA_NODE_PATTERN] : sketches,
        audio, videoDeviceId: node.type === 'camera' ? (node.deviceId ?? videoDeviceId) : videoDeviceId,
        getParams: () => params || {}, layer, inputMode: fx ? 'fx' : 'source',
        includeAudioSlots: node.type !== 'camera',
        cameraSource: fx ? null : context.cameraSource || null, getSize: () => this.size,
        preview, audioControlStore: context.audioControlStore || null,
        consumerSessionId: `graph-${crypto.randomUUID()}`, audioRole: context.audioRole || 'preview',
        onAudioSlotsChanged: context.onAudioSlotsChanged, onDraw: capture });
      this.sources.set(node.id, runtime);
      context.registerChildRuntime?.(runtime);
      const prepare = () => {
        if (this.disposed) return Promise.resolve();
        try {
          const ready = runtime.prepare();
          // Projection pixels must also be copied in the compositor callback,
          // not one requestAnimationFrame later when WebGL may be blank.
          for (const projection of runtime.projectionLayers) {
            const presented = projection.onPresented;
            projection.onPresented = () => {
              if (!projection.renderer) this.messages.set(node.id, 'Projection compositor unavailable');
              else capture(projection.canvas);
              presented?.();
            };
          }
          return ready.catch(error => { if (!this.disposed) this.messages.set(node.id, error.message); });
        } catch (error) { this.messages.set(node.id, error.message); return Promise.resolve(); }
      };
      if (node.type === 'camera') {
        // A deferred runtime can be disposed before prepare(); consume its
        // rejected readiness promise so teardown never leaks a rejection.
        runtime.readyPromise.catch(() => {});
        cameraReady = cameraReady.then(prepare);
        waits.push(cameraReady);
      } else waits.push(prepare());
    }
    this.ready = Promise.all(waits);
  }
  elapsed() { return (performance.now() - this.startedAt) / 1000; }
  signalValue(id) { return this.computeSignal(id, new Set()); }
  // Inspector diagnostics: Audio source health, calibration and freshness.
  getNodeStatus(id) { return this.signal?.getNodeStatus?.(id) || null; }
  computeSignal(id, visiting) {
    if (this.frameSignals.has(id)) return this.frameSignals.get(id);
    const node = this.graph.nodes.find(n => n.id === id);
    if (node?.type === 'audio') { const value = signalValue(this.readContinuous(id), node.band); this.frameSignals.set(id, value); return value; }
    if (!node || (node.type !== 'math' && node.type !== 'script')) return 0;
    if (visiting.has(id)) { this.messages.set(id, 'Signal loop detected → 0.'); return 0; }
    visiting.add(id);
    const readInput = port => {
      const edge = (this.graph.signalEdges || []).find(e => e.to === id && e.port === port);
      return edge ? this.computeSignal(edge.from, visiting) : null;
    };
    let value = 0;
    try {
      if (node.type === 'math') {
        const issue = mathIssue(node, readInput);
        value = mathValue(node, readInput);
        if (issue) this.messages.set(id, issue); else this.messages.delete(id);
      } else if (!isScriptApproved(scriptLanguageOf(node), scriptSource(node))) {
        this.messages.set(id, SCRIPT_APPROVAL_MESSAGE);
        value = 0;
      } else {
        let program = this.scriptPrograms.get(id);
        if (!program) { program = scriptProgram(node, this.scriptCache); this.scriptPrograms.set(id, program); }
        const result = scriptValue(node, { time: this.elapsed(), readInput, program }, this.scriptCache);
        value = result.value;
        if (result.error) this.messages.set(id, result.error); else this.messages.delete(id);
      }
    } catch (error) {
      this.messages.set(id, `Signal node failed: ${error.message} → 0.`);
      value = 0;
    } finally { visiting.delete(id); }
    if (!Number.isFinite(value)) {
      this.messages.set(id, 'Signal node produced a non-finite number → 0.');
      value = 0;
    }
    this.frameSignals.set(id, value);
    return value;
  }
  // Synchronous legacy renderer. For FX graphs this is the *last wholly
  // committed* presentation view; it requests one coalesced renderFrame() in
  // the background. NodesEditor may keep its existing rAF/ctx.drawImage loop.
  render(targetId = this.graph.nodes.find(n => n.type === 'output').id) {
    if (this.hasFx) {
      if (!this.disposed) this.renderFrame(targetId).catch(error => {
        if (!this.disposed) this.messages.set(targetId, `Graph render failed: ${error.message}`);
      });
      return this.buffers.get(targetId) || null;
    }
    const done = new Set();
    this.frame++; this.frameSignals.clear();
    const visit = id => {
      if (done.has(id)) return this.buffers.get(id);
      done.add(id);
      const node = this.graph.nodes.find(n => n.id === id), canvas = this.buffers.get(id);
      if (!node || !canvas) return null;
      const source = port => { const edge = this.graph.edges.find(e => e.to === id && e.port === port); return edge ? visit(edge.from) : null; };
      if (node.type === 'color') applyColor(canvas.getContext('2d'), source('image'), this.params.get(id) || {});
      else if (node.type !== 'pattern' && node.type !== 'camera') composite(canvas.getContext('2d'), source(node.type === 'blend' ? 'base' : 'image'), node.type === 'blend' ? source('layer') : null, node.mode || 'Normal', this.params.get(id)?.opacity ?? 1);
      const runtime = this.sources.get(id);
      const message = this.diagnostics[0] || this.messages.get(id) || runtime?.error?.message;
      if (message) {
        const ctx = canvas.getContext('2d'); ctx.save(); ctx.filter = 'none'; ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#291722'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffb7cb'; ctx.font = '14px sans-serif';
        ctx.fillText(message.slice(0, 80), 12, 30);
        ctx.restore();
      }
      return canvas;
    };
    return visit(targetId);
  }
  // At most one async tick. Each source is snapshotted ONCE into its work canvas
  // before the first await; independent onDraw writes only staging. Every FX
  // reads stable upstream work, fan-out reuses that canvas, and the front/work
  // maps swap only after the whole reachable DAG has completed.
  renderFrame(targetId = this.graph.nodes.find(n => n.type === 'output').id) {
    if (!this.hasFx) return Promise.resolve(this.render(targetId));
    if (this.disposed) return Promise.resolve(null);
    if (this.inFlight) return this.inFlight.then(() => this.buffers.get(targetId) || null);
    const evaluation = this._evaluate(targetId);
    this.inFlight = evaluation.finally(() => { if (this.inFlight === settled) this.inFlight = null; });
    const settled = this.inFlight;
    return settled;
  }
  async _evaluate(targetId) {
    await this.ready;
    if (this.disposed) return null;
    if (this.pendingSize) this._applySize(this.pendingSize);
    const generation = this.generation;
    const frameId = ++this.frame;
    const timestampMs = performance.now();
    this.frameSignals.clear();
    // Pin reachable autonomous sources synchronously at the graph boundary.
    // Their callbacks may keep updating staging during awaits, but no consumer
    // sees a later revision halfway through this tick (including fan-out).
    const used = new Set();
    const reach = id => {
      if (used.has(id)) return;
      used.add(id);
      this.graph.edges.filter(e => e.to === id).forEach(e => reach(e.from));
    };
    reach(targetId);
    const available = new Set();
    for (const [id, staging] of this.staging) {
      if (!used.has(id)) continue;
      const canvas = this.work.get(id);
      if (!this.sourceRevision.get(id) || this.sources.get(id)?.error) { clear(canvas); continue; }
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
      available.add(id);
    }
    const done = new Map();
    const visit = async id => {
      if (done.has(id)) return done.get(id);
      // Store the promise immediately to bound fan-out and prevent duplicate
      // effects even if a future caller asks for the same dependency.
      const pending = (async () => {
        const node = this.graph.nodes.find(n => n.id === id), canvas = this.work.get(id);
        if (!node || !canvas || this.disposed || generation !== this.generation) return null;
        const source = async port => {
          const edge = this.graph.edges.find(e => e.to === id && e.port === port);
          return edge ? visit(edge.from) : null;
        };
        try {
          if (this.nodeDiagnostics.has(id)) { clear(canvas); return null; }
          if (node.type === 'pattern' && inputModeOf(node) === 'fx') {
            const upstream = await source('image');
            if (this.disposed || generation !== this.generation) return null;
            const runtime = this.sources.get(id);
            if (!upstream || !runtime) {
              clear(canvas);
              if (runtime) this.messages.set(id, `Image input pending for FX pattern ${id}`);
              return null;
            }
            // Borrowed canvas; immutable view metadata, NOT immutable pixels.
            const image = Object.freeze({ source: upstream, width: upstream.width, height: upstream.height,
              frameId, timestampMs, generation });
            await runtime.requestGraphFrame(image);
            if (this.disposed || generation !== this.generation) return null;
            this.messages.delete(id);
            return canvas;
          }
          if (node.type === 'pattern' || node.type === 'camera') return available.has(id) ? canvas : null;
          if (node.type === 'color') {
            const upstream = await source('image');
            applyColor(canvas.getContext('2d'), upstream, this.params.get(id) || {});
            return upstream ? canvas : null;
          }
          if (node.type === 'blend') {
            const base = await source('base'), layer = await source('layer');
            composite(canvas.getContext('2d'), base, layer, node.mode || 'Normal', this.params.get(id)?.opacity ?? 1);
            return base || layer ? canvas : null;
          }
          const upstream = await source('image');
          composite(canvas.getContext('2d'), upstream, null, 'Normal', 1);
          return upstream ? canvas : null;
        } catch (error) {
          if (!this.disposed) this.messages.set(id, `Image render failed: ${error.message}`);
          clear(canvas);
          return null;
        }
      })();
      done.set(id, pending);
      return pending;
    };
    await visit(targetId);
    if (this.disposed || generation !== this.generation) return null;
    // A single synchronous commit; no consumer can observe a partially rendered
    // output. Unvisited previews retain their previous committed view.
    for (const id of done.keys()) {
      const front = this.buffers.get(id);
      this.buffers.set(id, this.work.get(id));
      this.work.set(id, front);
    }
    return this.buffers.get(targetId) || null;
  }
  getDiagnostics() { return [...new Set([...this.diagnostics, ...this.messages.values(), ...[...this.sources.values()].filter(r => r.error).map(r => r.error.message)])]; }
  _applySize(next) {
    this.pendingSize = null;
    this.size = next;
    this.generation = ++graphGeneration;
    for (const canvas of [...this.buffers.values(), ...this.work.values(), ...this.staging.values()]) [canvas.width, canvas.height] = next;
    this.sourceRevision.clear();
    for (const source of this.sources.values()) source.resize(...next);
  }
  resize(w, h) {
    const next = sizeFor(w, h);
    if (next.join() === (this.pendingSize || this.size).join()) return;
    if (this.inFlight) this.pendingSize = next;
    else this._applySize(next);
  }
  pause() { this.sources.forEach(s => s.pause()); }
  resume() { this.sources.forEach(s => s.resume()); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.generation = ++graphGeneration;
    this.signal?.dispose(); this.sources.forEach(s => s.dispose()); this.sources.clear();
    for (const canvas of [...this.buffers.values(), ...this.work.values(), ...this.staging.values()]) canvas.width = canvas.height = 1;
    this.buffers.clear(); this.work.clear(); this.staging.clear(); this.sourceRevision.clear();
    this.frameSignals.clear(); this.scriptPrograms.clear();
  }
}
export function graphFactory(record, sketches) {
  // Closed-over disk snapshot; registry changes replace the factory and runtime.
  return (audio, videoDeviceId, params, context = {}) => p => {
    let graph;
    p.setup = () => {
      p.createCanvas(p.windowWidth, p.windowHeight);
      graph = new GraphRuntime({ graph: record.graph, dependencies: record.dependencies, sketches,
        width: p.width, height: p.height, audio, videoDeviceId, context, preview: context.preview !== false });
      context.addPlaybackLifecycle?.({ pause: () => graph.pause(), resume: () => graph.resume() });
    };
    p.draw = async () => {
      if (!graph || graph.disposed) return;
      await graph.ready;
      if (graph.disposed) return;
      graph.resize(p.width, p.height);
      // Await the whole dependency chain, not graph.render()'s synchronous
      // last-committed editor view. The outer core awaits this draw and its
      // finishDraw before publishing a program frame to LIVE/CUE.
      const image = await graph.renderFrame();
      if (!image || graph.disposed) return;
      const ctx = p.drawingContext;
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
      ctx.drawImage(image, 0, 0, p.canvas.width, p.canvas.height); ctx.restore();
    };
    p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
    const remove = p.remove.bind(p);
    p.remove = () => { graph?.dispose(); return remove(); };
    context.addCleanup?.(() => graph?.dispose());
  };
}
