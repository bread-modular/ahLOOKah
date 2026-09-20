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
    audioControlSchema: d.audio?.schema || {},
    createAudioController: ({ rng } = {}) => {
      const state = { rng: rng || Math.random };
      return {
        update(frame) {
          if (!d.audio) return { continuous: {}, arrays: {}, events: [] };
          const value = invoke('audio.update', d.audio.update, frame, state);
          const clean = validateControlsForSlot({ continuous: {}, arrays: {}, events: [], ...value, runtimeId: 'custom', paramsRevision: 0 }, { runtimeId: 'custom', paramsRevision: 0, audioControlSchema: d.audio.schema });
          if (!clean) { report(`${file}: ${d.id}.audio.update: values do not match audio.schema`); return neutralControlsForSchema(d.audio.schema); }
          return clean;
        },
        dispose() { invoke('audio.dispose', d.audio?.dispose, state); },
      };
    },
    factory: (audio, videoDeviceId, params, runtime = {}) => (p) => {
      const cleanups = [];
      let disposed = false;
      const controller = new AbortController();
      const ctx = {
        p, params, audio, videoDeviceId, runtime, state: {}, signal: controller.signal,
        controls: runtime.audioControls,
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
        try { ctx.controls?.read(); invoke('draw', d.draw, ctx); }
        catch (e) { p.noLoop(); throw e; }
      };
      p.windowResized = () => {
        p.resizeCanvas(p.windowWidth, p.windowHeight);
        invoke('resize', d.resize, ctx);
      };
    },
  };
}
