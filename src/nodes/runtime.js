import { parameterView, signalValue } from './modulation.js';
import { createSignalConsumers } from './audio-provider.js';
import VizCore from '../core/index.js';
import { ProgramRuntime } from '../program-runtime.js';
import { PreviewAudio } from '../preview-audio.js';
import { MODES, validateGraph } from './model.js';
import { sourceDiagnostics } from './portability.js';
import { isVisualType } from './definitions.js';
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
export class GraphRuntime {
  constructor({ graph, sketches, dependencies = [], width = 480, height = 270, audio = new PreviewAudio(), context = {}, videoDeviceId = null, preview = true }) {
    this.graph = validateGraph(graph);
    this.signal = this.graph.nodes.some(n => n.type === 'audio')
      ? createSignalConsumers(context.audioControlStore, context.audioRole, this.graph.nodes.filter(n => n.type === 'audio'))
      : null;
    if (this.signal) context.registerChildRuntime?.(this.signal);
    // Route-aware continuous reads: nodeId selects the node's own requested
    // device/channel binding. Legacy callbacks that ignore the argument keep
    // working (they return one shared frame for every node).
    this.readContinuous = (nodeId) => context.readAudioSignals
      ? context.readAudioSignals(nodeId)
      : (this.signal?.read(nodeId) || {});
    this.frame = 0;
    this.frameSignals = new Map();
    // Compilation happens once per node here, never inside a frame: this cache
    // retains one compiled program per language + exact source for the runtime's
    // whole life and cannot evict a live program.
    this.scriptCache = new Map();
    this.scriptPrograms = new Map();
    this.startedAt = performance.now();
    this.params = new Map(this.graph.nodes.filter(n => ['pattern', 'blend', 'color'].includes(n.type))
      .map(n => [n.id, parameterView(this.graph, n, sketches, this.readContinuous, id => this.signalValue(id))]));
    this.size = sizeFor(width, height);
    this.disposed = false;
    this.sources = new Map(); this.buffers = new Map(); this.messages = new Map();
    this.diagnostics = sourceDiagnostics(this.graph, sketches, dependencies);
    this.graph.nodes.filter(n => isVisualType(n)).forEach(n => { const canvas = document.createElement('canvas'); [canvas.width, canvas.height] = this.size; this.buffers.set(n.id, canvas); });
    // A disk-loaded Script source never carries trust with it: evaluation only
    // happens after this browser approved that exact text in that language.
    for (const node of this.graph.nodes.filter(n => n.type === 'script')) {
      this.scriptPrograms.set(node.id, scriptProgram(node, this.scriptCache));
      if (!isScriptApproved(scriptLanguageOf(node), scriptSource(node))) this.messages.set(node.id, SCRIPT_APPROVAL_MESSAGE);
    }
    if (this.diagnostics.length) { this.ready = Promise.resolve(); return; }
    const waits = [];
    for (const node of this.graph.nodes.filter(n => n.type === 'pattern')) {
      const sketch = sketches.find(s => s.id === node.patternId);
      const camera = sketch.camera || sketch.surfaces?.some(s => sketches.find(x => x.id === s.patternId)?.camera);
      if (camera && (preview || !context.cameraSource)) {
        this.messages.set(node.id, 'Camera is available only on the output screen (shared capture).'); continue;
      }
      const params = this.params.get(node.id);
      const layer = document.createElement('div');
      const capture = canvas => {
        if (this.disposed) return;
        const target = this.buffers.get(node.id), ctx = target.getContext('2d');
        ctx.clearRect(0, 0, target.width, target.height);
        // Copy inside the source's completed draw, before WebGL discards pixels.
        ctx.drawImage(canvas, 0, 0, target.width, target.height);
      };
      const runtime = new ProgramRuntime({ coreConstructor: VizCore, selection: { ids: [sketch.id], merge: false },
        sketches, audio, videoDeviceId, getParams: () => params, layer,
        cameraSource: context.cameraSource || null, getSize: () => this.size,
        preview, audioControlStore: context.audioControlStore || null,
        consumerSessionId: `graph-${crypto.randomUUID()}`, audioRole: context.audioRole || 'preview',
        onAudioSlotsChanged: context.onAudioSlotsChanged, onDraw: capture });
      this.sources.set(node.id, runtime);
      context.registerChildRuntime?.(runtime);
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
        waits.push(ready.catch(error => { if (!this.disposed) this.messages.set(node.id, error.message); }));
      } catch (error) { this.messages.set(node.id, error.message); }
    }
    this.ready = Promise.all(waits);
  }
  elapsed() { return (performance.now() - this.startedAt) / 1000; }
  // One shared memo per frame: fanout reads the same value however many
  // parameters/nodes consume it, and cycles fall back to 0 instead of hanging.
  signalValue(id) { return this.computeSignal(id, new Set()); }
  // Inspector diagnostics: this node's route binding status (source health,
  // calibration, freshness) — the same data renderers consume.
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
        // Defensive refresh only if the id was not present at construction; the
        // per-frame path never compiles.
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
  render(targetId = this.graph.nodes.find(n => n.type === 'output').id) {
    const done = new Set();
    // Scalar values are computed once per rendered frame and shared by every
    // consumer (sidebar readout, preview, LIVE and CUE runtimes).
    this.frame++; this.frameSignals.clear();
    const visit = id => {
      if (done.has(id)) return this.buffers.get(id);
      done.add(id);
      const node = this.graph.nodes.find(n => n.id === id), canvas = this.buffers.get(id);
      if (!node || !canvas) return null;
      const source = port => { const edge = this.graph.edges.find(e => e.to === id && e.port === port); return edge ? visit(edge.from) : null; };
      if (node.type === 'color') applyColor(canvas.getContext('2d'), source('image'), this.params.get(id) || {});
      else if (node.type !== 'pattern') composite(canvas.getContext('2d'), source(node.type === 'blend' ? 'base' : 'image'), node.type === 'blend' ? source('layer') : null, node.mode || 'Normal', this.params.get(id)?.opacity ?? 1);
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
  getDiagnostics() { return [...this.diagnostics, ...this.messages.values(), ...[...this.sources.values()].filter(r => r.error).map(r => r.error.message)]; }
  resize(w, h) {
    const next = sizeFor(w, h); if (next.join() === this.size.join()) return;
    this.size = next;
    for (const canvas of this.buffers.values()) [canvas.width, canvas.height] = next;
    for (const source of this.sources.values()) source.resize(...next);
  }
  pause() { this.sources.forEach(s => s.pause()); }
  resume() { this.sources.forEach(s => s.resume()); }
  dispose() { if (this.disposed) return; this.disposed = true; this.signal?.dispose(); this.sources.forEach(s => s.dispose()); this.sources.clear(); this.buffers.forEach(c => { c.width = c.height = 1; }); this.buffers.clear(); this.frameSignals.clear(); this.scriptPrograms.clear(); }
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
      const image = graph.render();
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
