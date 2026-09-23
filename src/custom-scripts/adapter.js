import { createFeatureController, createReactiveController, FEATURE_SCHEMA, SILENT_FEATURES, response, accent } from '../sketches/feature-controls.js';
import { neutralControlsForSchema, validateControlsForSlot } from '../pattern-audio-protocol.js';

// Keep the native factory contract intact: custom patterns participate in all
// existing LIVE/CUE/merge/projection/preview and compact audio-control paths.
export function adaptPattern({ file, definition: d }, report, asset) {
  const invoke = (phase, fn, ...args) => {
    try {
      const result = fn?.(...args);
      if (result?.then) return result.catch((e) => { report(`${file}: ${d.id}.${phase}: ${e.message}`); throw e; });
      return result;
    }
    catch (e) { report(`${file}: ${d.id}.${phase}: ${e.message}`); throw e; }
  };
  return {
    id: d.id, name: d.name, params: d.params || [], camera: !!d.camera,
    ...(d.fx ? { fx: Object.freeze({ input: d.fx.input }) } : {}),
    group: 'Custom Scripts', customScript: file, audioTransport: 'pattern-controls',
    audioControlSchema: d.audio?.schema || FEATURE_SCHEMA,
    createAudioController: ({ rng } = {}) => {
      if (!d.audio) return createReactiveController();
      const state = { rng: rng || Math.random };
      // Never share adaptive baselines between LIVE/CUE/projection slots. The
      // engine retires this controller on reload, stream reset and slot removal.
      let reactiveController;
      let disposed = false;
      return {
        update(frame = {}) {
          if (disposed) return neutralControlsForSchema(d.audio?.schema || FEATURE_SCHEMA);
          const input = frame.frame ?? frame.shared?.frame;
          const hasSpectrum = Boolean(input?.left?.length || input?.right?.length);
          if (!hasSpectrum) {
            reactiveController?.dispose();
            reactiveController = undefined;
          }
          let reactive;
          const readReactive = () => {
            if (disposed) return { ...SILENT_FEATURES };
            if (!reactive) {
              reactive = !hasSpectrum
                ? { ...SILENT_FEATURES }
                : (reactiveController ||= createFeatureController()).update(frame).continuous;
            }
            return reactive;
          };
          if (!d.audio) return { continuous: readReactive(), arrays: {}, events: [] };
          // Lazy: old raw-only scripts pay no feature-analysis cost. Repeated
          // access in a single tick cannot advance the dynamics twice.
          const context = { ...frame, response, accent, get reactive() { return readReactive(); } };
          const value = invoke('audio.update', d.audio.update, context, state);
          const clean = validateControlsForSlot({ continuous: {}, arrays: {}, events: [], ...value, runtimeId: 'custom', paramsRevision: 0 }, { runtimeId: 'custom', paramsRevision: 0, audioControlSchema: d.audio.schema });
          if (!clean) { report(`${file}: ${d.id}.audio.update: values do not match audio.schema`); return neutralControlsForSchema(d.audio.schema); }
          return clean;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          reactiveController?.dispose();
          reactiveController = undefined;
          invoke('audio.dispose', d.audio?.dispose, state);
        },
      };
    },
    factory: (audio, videoDeviceId, params, runtime = {}) => (p) => {
      // Graph instances opt in explicitly; a capable standalone pattern remains a
      // source, and an unsupported FX request must never fall back to its camera.
      const inputMode = runtime.inputMode === undefined ? 'source' : runtime.inputMode;
      if (inputMode !== 'source' && inputMode !== 'fx') throw new Error(`${d.id}: invalid inputMode: ${String(inputMode)}`);
      if (inputMode === 'fx' && d.fx?.input !== 'image') throw new Error(`${d.id}: FX mode requires fx: { input: 'image' }`);
      const cleanups = [];
      let disposed = false;
      let imageInput = null;
      const controller = new AbortController();
      const noFxCapture = () => { throw new Error(`${d.id}: camera capture is unavailable in FX mode`); };
      // Guard the supported raw entry point too: a script using
      // ctx.createCapture(...) || p.createCapture(...) must not open a camera.
      const originalCapture = inputMode === 'fx' ? Object.getOwnPropertyDescriptor(p, 'createCapture') : null;
      if (inputMode === 'fx') p.createCapture = noFxCapture;
      const ctx = {
        p, params, audio, videoDeviceId, runtime, state: {}, signal: controller.signal,
        controls: runtime.audioControls,
        reactive: { ...SILENT_FEATURES }, response, accent,
        onCleanup(fn) {
          if (typeof fn !== 'function') throw new Error('onCleanup requires a function');
          if (disposed) fn(); else cleanups.push(fn);
        },
        async assetURL(name) {
          const blob = await asset(name);
          if (disposed) throw new Error('Pattern disposed while loading asset');
          const url = URL.createObjectURL(blob);
          ctx.onCleanup(() => URL.revokeObjectURL(url));
          return url;
        },
        createCapture(constraints = {}, callback) {
          if (inputMode === 'fx') noFxCapture();
          return runtime.createCapture ? runtime.createCapture(p, constraints, callback) : p.createCapture(constraints, callback);
        },
      };
      Object.defineProperties(ctx, {
        inputMode: { enumerable: true, value: inputMode },
        imageInput: { enumerable: true, get: () => imageInput },
      });
      const remove = p.remove.bind(p);
      p.remove = () => {
        if (disposed) return remove();
        disposed = true;
        controller.abort();
        imageInput = null;
        ctx.reactive = { ...SILENT_FEATURES };
        try {
          try { invoke('dispose', d.dispose, ctx); } catch { /* report, still clean up */ }
          for (const cleanup of cleanups.reverse()) {
            try { cleanup(); } catch (e) { report(`${file}: cleanup: ${e.message}`); }
          }
          return remove();
        } finally {
          if (inputMode === 'fx') {
            if (originalCapture) Object.defineProperty(p, 'createCapture', originalCapture);
            else delete p.createCapture;
          }
        }
      };
      p.preload = () => invoke('preload', d.preload, ctx);
      p.setup = () => {
        p.createCanvas(p.windowWidth, p.windowHeight, d.renderer === 'webgl' ? p.WEBGL : p.P2D);
        return invoke('setup', d.setup, ctx);
      };
      p.draw = () => {
        try {
          const packet = ctx.controls?.read();
          // Custom schemas retain their exact meaning; never reinterpret a
          // user-defined 'bass' key as our feature transport.
          ctx.reactive = !d.audio && !disposed
            ? { ...SILENT_FEATURES, ...packet?.continuous }
            : { ...SILENT_FEATURES };
          // The graph owns this canvas. Only borrow the current view for this
          // synchronous draw; never retain an old frame on the renderer context.
          imageInput = !disposed && inputMode === 'fx' ? runtime.getImageInput?.() ?? null : null;
          invoke('draw', d.draw, ctx);
        }
        catch (e) { p.noLoop(); throw e; }
        finally { imageInput = null; }
      };
      p.windowResized = () => {
        p.resizeCanvas(p.windowWidth, p.windowHeight);
        invoke('resize', d.resize, ctx);
      };
    },
  };
}
