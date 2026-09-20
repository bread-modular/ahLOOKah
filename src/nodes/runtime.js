import VizCore from '../core/index.js';
import { ProgramRuntime } from '../program-runtime.js';
import { PreviewAudio } from '../preview-audio.js';
import { MODES, validateGraph } from './model.js';
import { sourceDiagnostics } from './portability.js';

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
const sizeFor = (width, height) => {
  const ratio = Math.min(1, 1280 / Math.max(1, width), 720 / Math.max(1, height));
  return [Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio))];
};
export class GraphRuntime {
  constructor({ graph, sketches, dependencies = [], width = 480, height = 270, audio = new PreviewAudio(), context = {}, videoDeviceId = null, preview = true }) {
    this.graph = validateGraph(graph);
    this.size = sizeFor(width, height);
    this.disposed = false;
    this.sources = new Map(); this.buffers = new Map(); this.messages = new Map();
    this.diagnostics = sourceDiagnostics(this.graph, sketches, dependencies);
    this.graph.nodes.forEach(n => { const canvas = document.createElement('canvas'); [canvas.width, canvas.height] = this.size; this.buffers.set(n.id, canvas); });
    if (this.diagnostics.length) { this.ready = Promise.resolve(); return; }
    const waits = [];
    for (const node of this.graph.nodes.filter(n => n.type === 'pattern')) {
      const sketch = sketches.find(s => s.id === node.patternId);
      const camera = sketch.camera || sketch.surfaces?.some(s => sketches.find(x => x.id === s.patternId)?.camera);
      if (camera && (preview || !context.cameraSource)) {
        this.messages.set(node.id, 'Camera is available only on the output screen (shared capture).'); continue;
      }
      const params = { ...Object.fromEntries((sketch.params || []).map(d => [d.key, d.default])), ...node.params };
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
  render(targetId = this.graph.nodes.find(n => n.type === 'output').id) {
    const done = new Set();
    const visit = id => {
      if (done.has(id)) return this.buffers.get(id);
      done.add(id);
      const node = this.graph.nodes.find(n => n.id === id), canvas = this.buffers.get(id);
      if (!node) return null;
      const source = port => { const edge = this.graph.edges.find(e => e.to === id && e.port === port); return edge ? visit(edge.from) : null; };
      if (node.type !== 'pattern') composite(canvas.getContext('2d'), source(node.type === 'blend' ? 'base' : 'image'), node.type === 'blend' ? source('layer') : null, node.mode || 'Normal', node.opacity ?? 1);
      const runtime = this.sources.get(id);
      const message = this.diagnostics[0] || this.messages.get(id) || runtime?.error?.message;
      if (message) {
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#291722'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffb7cb'; ctx.font = '14px sans-serif';
        ctx.fillText(message.slice(0, 80), 12, 30);
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
  dispose() { if (this.disposed) return; this.disposed = true; this.sources.forEach(s => s.dispose()); this.sources.clear(); this.buffers.forEach(c => { c.width = c.height = 1; }); this.buffers.clear(); }
}
export function graphFactory(record, sketches) {
  // Closed-over JSON snapshot: saving another revision never mutates this one.
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
