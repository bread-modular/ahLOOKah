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
      const cleanups = [];
      let disposed = false;
      const controller = new AbortController();
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
          return runtime.createCapture ? runtime.createCapture(p, constraints, callback) : p.createCapture(constraints, callback);
        },
      };
      const remove = p.remove.bind(p);
      p.remove = () => {
        if (!disposed) {
          disposed = true;
          controller.abort();
          ctx.reactive = { ...SILENT_FEATURES };
          try { invoke('dispose', d.dispose, ctx); } catch { /* report, still clean up */ }
          for (const cleanup of cleanups.reverse()) {
            try { cleanup(); } catch (e) { report(`${file}: cleanup: ${e.message}`); }
          }
        }
        return remove();
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
          invoke('draw', d.draw, ctx);
        }
        catch (e) { p.noLoop(); throw e; }
      };
      p.windowResized = () => {
        p.resizeCanvas(p.windowWidth, p.windowHeight);
        invoke('resize', d.resize, ctx);
      };
    },
  };
}
