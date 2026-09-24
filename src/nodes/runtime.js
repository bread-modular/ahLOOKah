import { parameterView, signalValue } from './modulation.js';
import { createSignalConsumers } from './audio-provider.js';
import VizCore from '../core/index.js';
import { ProgramRuntime } from '../program-runtime.js';
import { PreviewAudio } from '../preview-audio.js';
import { validateGraph } from './model.js';
import { canvasOperation, isExtendedMode } from './blend-modes.js';
import { glBlend, glTransform } from './gl-compositor.js';
import { isIdentityTransform } from './transform.js';
import { graphDiagnostics } from './portability.js';
import { isVisualType, imageInputConnected, patternInputMode, canAcceptImageFx } from './definitions.js';
import { CAMERA_NODE_PATTERN } from './camera-source.js';
import { createPreviewClip } from './preview-clip.js';
import { mathValue, mathIssue, scriptValue, scriptProgram, scriptLanguageOf, scriptSource } from './scalar.js';
import { lfoValue, lfoRateOf, LFO_MAX_TRAVEL_STEP, LFO_RATE_SLEW } from './lfo.js';
import { midiParameters, midiNodeParams, midiGlide } from './midi.js';
import { MIDI } from '../midi/midi-service.js';
import { createScriptStateStore } from './script-state.js';
import { isScriptApproved, SCRIPT_APPROVAL_MESSAGE } from './script-approval.js';

// Composites base + layer into ctx. Native modes keep the original Canvas2D path
// (identical pixels, alpha handling and cost); the shader-only modes run in the
// shared WebGL2 compositor and fall back to Normal with a returned warning when no
// GPU can render them, so the caller can surface that instead of shipping
// different pixels silently.
export function composite(ctx, base, layer, mode, opacity = 1) {
  const { width, height } = ctx.canvas;
  const shader = isExtendedMode(mode);
  const image = shader ? glBlend(base, layer, mode, opacity, width, height) : null;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);
  if (image) {
    // The compositor canvas is shared and only valid until the next call.
    ctx.drawImage(image, 0, 0, width, height, 0, 0, width, height);
  } else {
    if (base) ctx.drawImage(base, 0, 0, width, height);
    ctx.globalAlpha = opacity; ctx.globalCompositeOperation = canvasOperation(mode);
    if (layer) ctx.drawImage(layer, 0, 0, width, height);
  }
  ctx.restore();
  return shader && !image ? `Blend mode ${mode} needs WebGL2; rendering Normal instead.` : null;
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
// The Transform (image) node. Identity is a pixel-exact copy that needs no GPU at
// all; any real move/scale/rotation runs in the shared WebGL2 compositor (the only
// path that has true perspective). Without a GPU the picture still passes through
// unchanged and the node reports why, so a transform can never go black silently.
export function applyTransform(ctx, source, params = {}) {
  const { width, height } = ctx.canvas;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none'; ctx.clearRect(0, 0, width, height);
  let warning = null;
  if (source) {
    const identity = isIdentityTransform(params);
    // The compositor canvas is shared and only valid until the next call.
    const image = identity ? null : glTransform(source, params, width, height);
    if (!identity && image) ctx.drawImage(image, 0, 0, width, height, 0, 0, width, height);
    else ctx.drawImage(source, 0, 0, width, height);
    if (!identity && !image) warning = 'Transform needs WebGL2; the image passes through unchanged.';
  }
  ctx.restore();
  return warning;
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

// Only these fields can change without changing a source's identity, execution
// plan, input mode or scalar wiring. Mapping endpoints change the conversion,
// not the dependency; adding/removing or retargeting a mapping changes the plan.
const mutableFields = {
  pattern: ['params'], blend: ['opacity', 'mode'], color: ['params'], transform: ['params'],
  audio: ['band'], math: ['a', 'b', 'c'], script: ['inputX', 'inputY'],
  // An LFO is a slider bank: every control (and the drawn table) changes its
  // output, never the plan. Rebuilding the runtime for a held Cycle time drag would
  // restart every source's clock and tear down the audio children each frame.
  lfo: ['params', 'pattern', 'range', 'seed', 'points'],
  // A MIDI node is the same shape: its switches and sliders change what it reads,
  // never the plan, so a live edit must not restart the window's MIDI session.
  midi: ['mode', 'gateMode', 'channel', 'deviceId', 'params'],
};
export function graphLifecycleKey(graph, sketches, dependencies = []) {
  const nodes = graph.nodes.map(node => Object.fromEntries(Object.entries(node)
    .filter(([key]) => key !== 'x' && key !== 'y' && !mutableFields[node.type]?.includes(key))));
  const modulations = (graph.modulations || []).map(({ from, to, param }) => ({ from, to, param: param ?? null }));
  // A formerly invalid source was never prepared. Crossing its diagnostic
  // boundary must activate/retire it rather than treating it as a slider edit.
  const invalid = [...graphDiagnostics(graph, sketches, dependencies).byNode.keys()].sort();
  return JSON.stringify({ version: graph.version, nodes, edges: graph.edges,
    signalEdges: graph.signalEdges || [], modulations, invalid });
}

export class GraphRuntime {
  constructor({ graph, sketches, dependencies = [], width = 480, height = 270, audio = new PreviewAudio(), context = {}, videoDeviceId = null, preview = true }) {
    this.graph = validateGraph(graph);
    // The edge, not a saved mode flag, switches to FX. An editor preview also
    // uses the graph-clocked path for its synthetic Camera/implicit video input.
    this.previewFx = new Set(preview ? this.graph.nodes.filter(n => n.type === 'pattern'
      && !imageInputConnected(this.graph, n.id) && sketches.find(s => s.id === n.patternId)?.camera
      && canAcceptImageFx(sketches.find(s => s.id === n.patternId))).map(n => n.id) : []);
    this.nodeById = new Map(this.graph.nodes.map(n => [n.id, n]));
    this.outputId = this.graph.nodes.find(n => n.type === 'output').id;
    this.incoming = new Map();
    const addDependency = (to, from) => {
      if (!this.incoming.has(to)) this.incoming.set(to, []);
      this.incoming.get(to).push(from);
    };
    this.graph.edges.forEach(e => addDependency(e.to, e.from));
    (this.graph.signalEdges || []).forEach(e => addDependency(e.to, e.from));
    (this.graph.modulations || []).filter(m => m.param).forEach(m => addDependency(m.to, m.from));
    this.planned = new Set();
    this.sourceReady = new Map();
    this.targetReady = new Map();
    this.cameraReady = Promise.resolve();
    this.preview = preview; this.sketches = sketches; this.context = context;
    this.dependencies = dependencies;
    this.lifecycleKey = graphLifecycleKey(this.graph, sketches, dependencies);
    this.audio = audio; this.videoDeviceId = videoDeviceId;
    // An unused FX branch must not switch LIVE to the async renderer. Editor
    // previews can select that branch later, so keep their FX clock available.
    const outputPlan = this.dependenciesFor(this.outputId);
    this.hasFx = this.graph.nodes.some(n => (preview || outputPlan.has(n.id))
      && patternInputMode(n, this.graph) === 'fx')
      || (preview && (this.graph.nodes.some(n => n.type === 'camera') || this.previewFx.size > 0))
      || (!preview && [...outputPlan].some(id => this.nodeById.get(id)?.type === 'camera'));
    this.signal = null;
    // Route-aware continuous reads: nodeId selects the node's own requested
    // device/channel binding. Legacy callbacks that ignore the argument work.
    this.readContinuous = (nodeId) => context.readAudioSignals
      ? context.readAudioSignals(nodeId)
      : (this.signal?.read(nodeId) || {});
    this.frame = 0;
    this.generation = ++graphGeneration;
    this.frameSignals = new Map();
    // Cycles each LFO has travelled, the rate each one is currently running at, and
    // the clock the last integration step used. Both accumulators outlive parameter
    // edits (updateGraph keeps them) so a cycle time change is a change of speed,
    // never a jump in position.
    this.lfoTravel = new Map();
    this.lfoRate = new Map();
    this.lastSignalTick = null;
    // The step the last integration used. MIDI control values are glided with the
    // same step, so a mapped source eases them exactly like the LFO's rate.
    this.frameDt = 0;
    // One live LFO evaluation at a time per node. A mapped control re-enters
    // computeSignal through its parameter view's getter, so a modulation loop
    // would recurse (model.js refuses to *save* one; this keeps a hand-edited
    // file from exhausting the stack before it is repaired).
    this.pendingSignals = new Set();
    // The live value of every automated MIDI control, glided frame by frame exactly
    // like the LFO's rate (same response time). It survives parameter edits, so
    // typing an Attack keeps the glide instead of restarting it.
    this.midiGlide = new Map();
    this.scriptCache = new Map();
    this.scriptPrograms = new Map();
    // Persistent `state.<name>` storage for this runtime's Script nodes. It lives
    // exactly as long as the graph does — see script-state.js.
    this.scriptState = createScriptStateStore();
    this.startedAt = performance.now();
    this.params = new Map();
    // Parameter views are created with their target's activation, before a
    // Pattern's ProgramRuntime captures its view in _prepareSource().
    this.size = sizeFor(width, height);
    // No media request, video element or MediaStream exists in the editor.
    // Even the synthetic clip waits until a Camera/implicit FX preview is used.
    this.sample = null;
    this.pendingSize = null;
    this.disposed = false;
    this.sources = new Map(); this.buffers = new Map(); this.messages = new Map();
    // Warnings report degraded but still-rendering nodes. Fatal node errors
    // instead suppress only that branch's image in both render paths.
    this.warnings = new Map();
    this.work = new Map(); this.staging = new Map(); this.sourceRevision = new Map();
    this.inFlight = null;
    this.activeTarget = this.outputId;
    this.paused = false;
    const diagnostic = graphDiagnostics(this.graph, sketches, dependencies);
    this.diagnostics = diagnostic.messages;
    this.nodeDiagnostics = diagnostic.byNode;
    // Preserve graph-wide repair/approval notices without compiling or running
    // an unrelated Script. A disk-loaded source never carries trust with it.
    for (const node of this.graph.nodes.filter(n => n.type === 'script'))
      if (!isScriptApproved(scriptLanguageOf(node), scriptSource(node))) this.messages.set(node.id, SCRIPT_APPROVAL_MESSAGE);
    // Output is the only eager target. A disconnected editor selection expands
    // this plan on first request; LIVE never expands past Output.
    this.ready = this._activate(this.outputId);
  }
  // An editor parameter commit keeps the graph, sources and their clocks alive.
  // In particular ProgramRuntime's factory receives the *object* returned by
  // getParams during _prepareSource, not a fresh lookup each draw. Redefine that
  // same object's properties so both captured factories and future audio slot
  // snapshots see new bases and mapping getters. Structural edits return false:
  // the owner must dispose this graph and construct one with a new plan.
  updateGraph(graph) {
    if (this.disposed) return false;
    const next = validateGraph(graph);
    if (graphLifecycleKey(next, this.sketches, this.dependencies) !== this.lifecycleKey) return false;
    if (JSON.stringify(next) === JSON.stringify(this.graph)) return true;
    // An async FX tick already underway must not commit a mix of old and new
    // parameters. Its child is retained, but its graph commit is retired.
    if (this.inFlight) this.generation = ++graphGeneration;
    this.graph = next;
    this.nodeById = new Map(next.nodes.map(node => [node.id, node]));
    this.frameSignals.clear();
    for (const [id, view] of this.params) {
      const fresh = parameterView(next, this.nodeById.get(id), this.sketches,
        this.readContinuous, sourceId => this.signalValue(sourceId));
      for (const key of Object.keys(view)) delete view[key];
      Object.defineProperties(view, Object.getOwnPropertyDescriptors(fresh));
    }
    const diagnostic = graphDiagnostics(next, this.sketches, this.dependencies);
    this.diagnostics = diagnostic.messages;
    this.nodeDiagnostics = diagnostic.byNode;
    // Publishing the plan refreshes ProgramRuntime's parameter fingerprint and
    // paramsRevision without retiring the child's audio slot or controller.
    this.context.onAudioSlotsChanged?.();
    return true;
  }
  dependenciesFor(targetId) {
    const used = new Set();
    const visit = id => {
      if (used.has(id) || !this.nodeById.has(id)) return;
      used.add(id);
      (this.incoming.get(id) || []).forEach(visit);
    };
    visit(targetId);
    return used;
  }
  _activate(targetId) {
    if (this.disposed || (!this.preview && targetId !== this.outputId)) return Promise.resolve();
    if (this.targetReady.has(targetId)) return this.targetReady.get(targetId);
    const needed = this.dependenciesFor(targetId);
    const addedAudio = [];
    for (const node of this.graph.nodes) {
      if (!needed.has(node.id) || this.planned.has(node.id)) continue;
      this.planned.add(node.id);
      if (['pattern', 'blend', 'color', 'transform', 'lfo', 'midi'].includes(node.type))
        this.params.set(node.id, parameterView(this.graph, node, this.sketches, this.readContinuous, id => this.signalValue(id)));
      if (node.type === 'audio') addedAudio.push(node);
      // A planned MIDI node means this graph reads a controller: ask for this
      // window's session once (idempotent, single-flight, never per edit). The
      // session is a window-level singleton shared by the editor preview and the
      // LIVE output screen, so nothing is disposed with this runtime.
      if (node.type === 'midi') MIDI.ensure();
      if (isVisualType(node)) {
        this.buffers.set(node.id, canvasFor(this.size));
        if (this.hasFx) this.work.set(node.id, canvasFor(this.size));
        if (this.hasFx && ((node.type === 'camera' && !this.preview)
          || (node.type === 'pattern' && patternInputMode(node, this.graph) === 'source' && !this.previewFx.has(node.id))))
          this.staging.set(node.id, canvasFor(this.size));
        if (this.preview && !this.sample && (node.type === 'camera' || this.previewFx.has(node.id)))
          this.sample = createPreviewClip(...this.size);
      }
      if (node.type === 'script') this.scriptPrograms.set(node.id, scriptProgram(node, this.scriptCache));
    }
    if (addedAudio.length) {
      if (this.signal) this.signal.addNodes(addedAudio);
      else {
        this.signal = createSignalConsumers(this.context.audioControlStore, this.context.audioRole, addedAudio);
        this.context.registerChildRuntime?.(this.signal);
      }
      // On a late preview expansion the owner's plan must include new routes.
      // The initial registration is already published by the parent/editor.
      if (this.ready) this.context.onAudioSlotsChanged?.();
    }
    for (const node of this.graph.nodes) {
      if (!needed.has(node.id) || this.sourceReady.has(node.id) || (node.type !== 'pattern' && node.type !== 'camera')) continue;
      this.sourceReady.set(node.id, this._prepareSource(node));
    }
    const ready = Promise.all([...needed].map(id => this.sourceReady.get(id)).filter(Boolean));
    this.targetReady.set(targetId, ready);
    return ready;
  }
  _prepareSource(node) {
    // Camera previews use sample pixels, not a capture child. Broken nodes
    // remain in the graph and in diagnostics, but cannot start a renderer.
    if ((node.type === 'camera' && this.preview) || this.nodeDiagnostics.has(node.id)) return Promise.resolve();
    const { sketches, context, preview, audio, videoDeviceId } = this;
    const sketch = node.type === 'camera' ? CAMERA_NODE_PATTERN : sketches.find(s => s.id === node.patternId);
    if (!sketch) return Promise.resolve();
    const fx = node.type === 'pattern' && (patternInputMode(node, this.graph) === 'fx' || this.previewFx.has(node.id));
    const camera = node.type === 'camera' || (!fx && (sketch.camera || sketch.surfaces?.some(s => sketches.find(x => x.id === s.patternId)?.camera)));
    if (camera && (preview || !context.cameraSource)) {
      this.messages.set(node.id, 'Camera is available only on the output screen (shared capture).'); return Promise.resolve();
    }
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
      getParams: () => this.params.get(node.id) || {}, layer, inputMode: fx ? 'fx' : 'source',
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
      // SharedCameraSource ties a pending source to its acquisition epoch.
      // Serialise physical Camera nodes, including ones selected later.
      runtime.readyPromise.catch(() => {});
      this.cameraReady = this.cameraReady.then(prepare);
      return this.cameraReady;
    }
    return prepare();
  }
  _activeAudioNodes() {
    // Output's routes stay warm while the inspector previews another branch;
    // previously inspected disconnected routes do not stay in the capture plan.
    return this.paused ? [] : new Set([...this.dependenciesFor(this.outputId), ...this.dependenciesFor(this.activeTarget)]);
  }
  _selectTarget(targetId) {
    if (!this.preview || this.activeTarget === targetId) return;
    this.activeTarget = targetId;
    const needed = this.dependenciesFor(targetId);
    if (this.signal?.setActiveNodes(this._activeAudioNodes())) this.context.onAudioSlotsChanged?.();
    // Keep shared instances warm; park previously selected disconnected
    // branches so their autonomous draw loops stop consuming preview resources.
    for (const [id, source] of this.sources) {
      if (needed.has(id) && !this.paused) source.resume();
      else source.pause();
    }
  }
  elapsed() { return (performance.now() - this.startedAt) / 1000; }
  signalValue(id) {
    // Inspector readouts and disconnected parameter views can request a scalar
    // before their image target is rendered. Register its route synchronously;
    // source preparation remains shared with the next preview frame.
    if (this.preview && !this.planned.has(id)) void this._activate(id);
    return this.computeSignal(id, new Set());
  }
  // One integration step per frame, for every LFO in the graph. Cycle time is a
  // rate, so a node's position is the travel accumulated here rather than
  // `elapsed × rate`: editing the cycle time — or driving it with a mapped signal
  // — changes how fast the shape moves and never snaps it back to the start of its
  // cycle, which is what makes automation read as acceleration instead of a
  // restart. The step is clamped so a backgrounded tab cannot teleport the shape,
  // and Start Position stays an absolute anchor the operator can scrub.
  advanceSignals() {
    const now = this.elapsed();
    const dt = this.lastSignalTick === null ? 0 : Math.min(LFO_MAX_TRAVEL_STEP, Math.max(0, now - this.lastSignalTick));
    this.lastSignalTick = now;
    this.frameDt = dt;
    if (!(dt > 0)) return;
    const advanced = new Set();
    const glide = Math.min(1, dt / LFO_RATE_SLEW);
    // Sources travel FIRST, whatever their type: a node reading a Math/Script value
    // that depends on another LFO must see that LFO advanced in this frame, so the
    // same graph produces the same frame whatever order its nodes are stored in and
    // a mapped rate is never one frame behind its own source. The set marks a node
    // before recursing, so a hand-edited loop cannot spin here either.
    const advance = id => {
      if (advanced.has(id)) return;
      advanced.add(id);
      (this.incoming.get(id) || []).forEach(advance);
      const node = this.nodeById.get(id);
      if (node?.type !== 'lfo') return;
      // A rate step glides instead of arriving as a kick — the shape still never
      // restarts, and only how fast the travel accumulates changes.
      const target = lfoRateOf(node, this.params.get(id));
      const previous = this.lfoRate.get(id);
      const rate = previous === undefined ? target : previous + (target - previous) * glide;
      this.lfoRate.set(id, rate);
      this.lfoTravel.set(id, (this.lfoTravel.get(id) ?? 0) + dt * rate);
    };
    for (const node of this.graph.nodes) advance(node.id);
  }
  // The LFO reads its own controls through the same live parameter view every
  // other controllable node uses, so a signal mapped onto Cycle time or Start
  // Position arrives converted, in the control's domain, exactly like a mapped
  // Color or Transform slider. The view is created on demand for a node no plan has
  // activated yet (an unwired draft still has to answer a readout), and reads the
  // modulating source through the shared visiting set so a loop is reported
  // instead of recursing.
  lfoSignal(id, node, visiting) {
    if (this.pendingSignals.has(id)) { this.messages.set(id, 'Signal loop detected → 0.'); return 0; }
    this.pendingSignals.add(id);
    try {
      let view = this.params.get(id);
      if (!view) {
        view = parameterView(this.graph, node, this.sketches, this.readContinuous, sourceId => this.computeSignal(sourceId, visiting));
        this.params.set(id, view);
      }
      const value = lfoValue(node, { travel: this.lfoTravel.get(id) ?? 0, params: view });
      return Number.isFinite(value) ? value : 0;
    } finally { this.pendingSignals.delete(id); }
  }
  // A MIDI node reads its own switches and sliders and asks the window's MIDI
  // session for the value of the channel/device they describe. The numeric sliders
  // come through the same live parameter view every other controllable node uses, so
  // a mapped Attack/Decay/Apply Velocity arrives already converted into the control's
  // domain; the view is created on demand for a node no plan has activated yet (an
  // unwired draft still has to answer a readout) and reads its modulating source
  // through the shared visiting set, so a loop is reported instead of recursing.
  // Only a *mapped* control is glided, with the frame step the LFO uses for its rate:
  // a steppy source eases the envelope instead of kicking it, while a manual slider
  // edit is used exactly as stored. Dropping a mapping forgets its glide, so
  // re-mapping starts from the value the operator left on the slider.
  midiSignal(id, node, visiting) {
    if (this.pendingSignals.has(id)) { this.messages.set(id, 'Signal loop detected → 0.'); return 0; }
    this.pendingSignals.add(id);
    try {
      let view = this.params.get(id);
      if (!view) {
        view = parameterView(this.graph, node, this.sketches, this.readContinuous, sourceId => this.computeSignal(sourceId, visiting));
        this.params.set(id, view);
      }
      const mapped = new Set((this.graph.modulations || []).filter(m => m.to === id && m.param).map(m => m.param));
      let glide = this.midiGlide.get(id);
      if (!glide) { glide = new Map(); this.midiGlide.set(id, glide); }
      for (const key of [...glide.keys()]) if (!mapped.has(key)) glide.delete(key);
      const step = Number.isFinite(this.frameDt) ? this.frameDt : 0;
      const params = midiNodeParams(node, view, (key, target, base) => {
        if (!mapped.has(key)) return target;
        const next = midiGlide(glide.get(key), target, step, base);
        glide.set(key, next);
        return next;
      });
      MIDI.ensure();
      const value = MIDI.level(params);
      return Number.isFinite(value) ? value : 0;
    } finally { this.pendingSignals.delete(id); }
  }
  // Inspector diagnostics: Audio source health, calibration and freshness.
  getNodeStatus(id) {
    if (this.preview && !this.planned.has(id)) void this._activate(id);
    return this.signal?.getNodeStatus?.(id) || null;
  }
  // A Script node's persistent state, for the inspector readout: one entry per
  // slot/buffer with its current contents, or null when the node stores nothing.
  // Reading it never advances the state.
  getScriptState(id) { return this.scriptState.readout(id); }
  // The explicit user action behind the inspector's "Reset state" button:
  // restore the script's declared initial values and forget the timing.
  resetScriptState(id) { return this.scriptState.reset(id); }
  computeSignal(id, visiting) {
    if (this.frameSignals.has(id)) return this.frameSignals.get(id);
    const node = this.graph.nodes.find(n => n.id === id);
    if (node?.type === 'audio') { const value = signalValue(this.readContinuous(id), node.band); this.frameSignals.set(id, value); return value; }
    if (node?.type === 'lfo') {
      const value = this.lfoSignal(id, node, visiting);
      this.frameSignals.set(id, value);
      return value;
    }
    if (node?.type === 'midi') {
      const value = this.midiSignal(id, node, visiting);
      this.frameSignals.set(id, value);
      return value;
    }
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
        // One evaluation per node per frame. The store keys on the frame counter,
        // hands the body its own state array plus the elapsed dt, and commits only
        // a clean run — so a readout, a mapping or any other reader between frames
        // can never advance an accumulator a second time.
        const time = this.elapsed();
        const result = this.scriptState.run(id, { tick: this.frame, time, entry: program }, (dt, state) =>
          scriptValue(node, { time, dt, readInput, program, state }, this.scriptCache));
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
    if (this.disposed || (!this.preview && targetId !== this.outputId)) return null;
    if (!this.planned.has(targetId)) void this._activate(targetId);
    this._selectTarget(targetId);
    const done = new Map();
    this.frame++; this.frameSignals.clear();
    this.advanceSignals();
    const visit = id => {
      if (done.has(id)) return done.get(id);
      const node = this.nodeById.get(id), canvas = this.buffers.get(id);
      if (!node || !canvas) return null;
      // The node that owns the failure produces no image in either renderer.
      // An invalid branch is transparent to a healthy Blend sibling; its
      // diagnostic remains visible through getDiagnostics().
      const runtime = this.sources.get(id);
      if (this.nodeDiagnostics.has(id) || this.messages.has(id) || runtime?.error) {
        clear(canvas); done.set(id, null); return null;
      }
      const source = port => { const edge = this.graph.edges.find(e => e.to === id && e.port === port); return edge ? visit(edge.from) : null; };
      const params = this.params.get(id) || {};
      let result = canvas;
      if (node.type === 'color' || node.type === 'transform') {
        const upstream = source('image');
        if (node.type === 'color') applyColor(canvas.getContext('2d'), upstream, params);
        else {
          const warning = applyTransform(canvas.getContext('2d'), upstream, params);
          if (warning) this.warnings.set(id, warning); else this.warnings.delete(id);
        }
        if (!upstream) result = null;
      } else if (node.type === 'blend') {
        const base = source('base'), layer = source('layer');
        const warning = composite(canvas.getContext('2d'), base, layer, node.mode || 'Normal', params.opacity ?? 1);
        if (warning) this.warnings.set(id, warning); else this.warnings.delete(id);
        if (!base && !layer) result = null;
      } else if (node.type === 'output') {
        composite(canvas.getContext('2d'), source('image'), null, 'Normal', 1);
      } else if (!this.sourceRevision.has(id) && !runtime) {
        clear(canvas); result = null;
      }
      done.set(id, result);
      return result;
    };
    return visit(targetId);
  }
  // At most one async tick. Each source is snapshotted ONCE into its work canvas
  // before the first await; independent onDraw writes only staging. Every FX
  // reads stable upstream work, fan-out reuses that canvas, and the front/work
  // maps swap only after the whole reachable DAG has completed.
  renderFrame(targetId = this.outputId) {
    if (this.disposed || (!this.preview && targetId !== this.outputId)) return Promise.resolve(null);
    if (!this.hasFx) return this.ready.then(() => this._activate(targetId)).then(() => this.disposed ? null : this.render(targetId));
    if (this.inFlight) return this.inFlightTarget === targetId
      ? this.inFlight.then(() => this.buffers.get(targetId) || null)
      : this.inFlight.then(() => this.renderFrame(targetId));
    this.inFlightTarget = targetId;
    const evaluation = this._evaluate(targetId);
    this.inFlight = evaluation.finally(() => { if (this.inFlight === settled) { this.inFlight = null; this.inFlightTarget = null; } });
    const settled = this.inFlight;
    return settled;
  }
  async _evaluate(targetId) {
    await this.ready;
    await this._activate(targetId);
    if (this.disposed) return null;
    this._selectTarget(targetId);
    if (this.pendingSize) this._applySize(this.pendingSize);
    const generation = this.generation;
    const frameId = ++this.frame;
    const timestampMs = performance.now();
    this.frameSignals.clear();
    this.advanceSignals();
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
    // Draw once at the frame boundary before any FX await. This single bounded
    // canvas is shared by preview Camera nodes and implicit camera-FX inputs;
    // no next tick can redraw it until this in-flight evaluation has committed.
    const sample = this.sample && [...used].some(id => this.nodeById.get(id)?.type === 'camera' || this.previewFx.has(id))
      ? this.sample.draw(this.elapsed()) : null;
    if (sample) for (const node of this.graph.nodes) {
      if (node.type !== 'camera' || !used.has(node.id)) continue;
      const canvas = this.work.get(node.id);
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(sample, 0, 0, canvas.width, canvas.height);
      this.sourceRevision.set(node.id, this.sample.revision);
      available.add(node.id);
    }
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
      // Inspector previews can target an Audio/Script node, which has no image
      // buffer. Never commit it as a visited visual node (or swap in undefined).
      const node = this.graph.nodes.find(n => n.id === id), canvas = this.work.get(id);
      if (!node || !canvas || this.disposed || generation !== this.generation) return null;
      // Store the promise immediately to bound fan-out and prevent duplicate
      // effects even if a future caller asks for the same dependency.
      const pending = (async () => {
        const source = async port => {
          const edge = this.graph.edges.find(e => e.to === id && e.port === port);
          return edge ? visit(edge.from) : null;
        };
        try {
          if (this.nodeDiagnostics.has(id)) { clear(canvas); return null; }
          if (node.type === 'pattern' && (patternInputMode(node, this.graph) === 'fx' || this.previewFx.has(id))) {
            const upstream = this.previewFx.has(id) ? sample : await source('image');
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
          if (node.type === 'transform') {
            const upstream = await source('image');
            const warning = applyTransform(canvas.getContext('2d'), upstream, this.params.get(id) || {});
            if (warning) this.warnings.set(id, warning); else this.warnings.delete(id);
            return upstream ? canvas : null;
          }
          if (node.type === 'blend') {
            const base = await source('base'), layer = await source('layer');
            const warning = composite(canvas.getContext('2d'), base, layer, node.mode || 'Normal', this.params.get(id)?.opacity ?? 1);
            if (warning) this.warnings.set(id, warning); else this.warnings.delete(id);
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
  // Warnings are reported like diagnostics (they are visible text in the editor)
  // but never painted onto a node canvas: a degraded mode still shows its picture.
  getDiagnostics() { return [...new Set([...this.diagnostics, ...this.warnings.values(), ...this.messages.values(), ...[...this.sources.values()].filter(r => r.error).map(r => r.error.message)])]; }
  _applySize(next) {
    this.pendingSize = null;
    this.size = next;
    this.generation = ++graphGeneration;
    for (const canvas of [...this.buffers.values(), ...this.work.values(), ...this.staging.values()]) [canvas.width, canvas.height] = next;
    this.sample?.resize(...next);
    this.sourceRevision.clear();
    for (const source of this.sources.values()) source.resize(...next);
  }
  resize(w, h) {
    const next = sizeFor(w, h);
    if (next.join() === (this.pendingSize || this.size).join()) return;
    if (this.inFlight) this.pendingSize = next;
    else this._applySize(next);
  }
  pause() {
    this.paused = true; this.sources.forEach(s => s.pause());
    if (this.preview && this.signal?.setActiveNodes([])) this.context.onAudioSlotsChanged?.();
  }
  resume() {
    this.paused = false;
    const active = this.dependenciesFor(this.activeTarget);
    if (this.preview && this.signal?.setActiveNodes(this._activeAudioNodes())) this.context.onAudioSlotsChanged?.();
    this.sources.forEach((source, id) => { if (!this.preview || active.has(id)) source.resume(); });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.generation = ++graphGeneration;
    this.signal?.dispose(); this.sources.forEach(s => s.dispose()); this.sources.clear();
    this.sample?.dispose(); this.sample = null;
    for (const canvas of [...this.buffers.values(), ...this.work.values(), ...this.staging.values()]) canvas.width = canvas.height = 1;
    this.buffers.clear(); this.work.clear(); this.staging.clear(); this.sourceRevision.clear();
    this.frameSignals.clear(); this.scriptPrograms.clear(); this.pendingSignals.clear();
    this.lfoTravel.clear(); this.lfoRate.clear(); this.lastSignalTick = null; this.frameDt = 0; this.midiGlide.clear();
    this.scriptState.clear();
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
