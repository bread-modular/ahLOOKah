// Compact, shared band transport for inexpensive patterns. Feature extraction
// stays on the capture owner (one scan per tick), never in each output shader.
import { makeAudioFeatures } from './audio-features.js';
import { makeAudioShader } from './shader-utils.js';

export const BAND_PARAMS = [
  { key: 'bass', label: 'Bass Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'mid', label: 'Mid Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'high', label: 'High Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
];

export const SILENT_BANDS = Object.freeze({ bass: 0, mid: 0, high: 0 });
export const BAND_SCHEMA = Object.freeze({
  continuous: {
    bass: { min: 0, max: 3.2, neutral: 0 },
    mid: { min: 0, max: 3.2, neutral: 0 },
    high: { min: 0, max: 3.2, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: { continuous: SILENT_BANDS },
});

export const bounded = (value, fallback, min, max) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));

export function scaleBands(features = {}, params = {}) {
  return {
    bass: bounded(features.sub, 0, 0, 1.6) * bounded(params.bass, 1, 0, 2),
    mid: bounded(features.mid, 0, 0, 1.6) * bounded(params.mid, 1, 0, 2),
    high: bounded(features.high, 0, 0, 1.6) * bounded(params.high, 1, 0, 2),
  };
}

// Only the September 9–10 collections opt into this response. Keep scaleBands,
// BAND_PARAMS and BAND_SCHEMA unchanged: older Bars also uses the linear mapper,
// and the legacy registry shares the parameter definitions.
// A finite-slope soft knee lifts modest levels (0.2 -> ~0.71), without a noise
// pedestal, hard saturation during ordinary music, or mixing the bands. Apply
// the slider AFTER shaping: half really is half, and zero is exactly silent.
export function responsiveBands(features = {}, params = {}) {
  const lift = (value) => {
    const ceiling = 1.6, knee = 0.35;
    const x = bounded(value, 0, 0, ceiling);
    return Math.min(ceiling, x * ((ceiling + knee) / (x + knee)));
  };
  return scaleBands({ sub: lift(features?.sub), mid: lift(features?.mid), high: lift(features?.high) }, params);
}

export function createBandController() {
  return {
    update({ shared, params = {} }) {
      return { continuous: responsiveBands(shared?.getFeatures?.(), params), arrays: {}, events: [] };
    },
    dispose() {},
  };
}

// Standalone sketches still work without ProgramRuntime. The normal app path
// only reads its binding, including neutral decay when audio becomes stale.
export function makeBandReader(audio, params, runtimeContext = {}) {
  const binding = runtimeContext.audioControls;
  if (binding) return () => binding.read()?.continuous || SILENT_BANDS;
  const analyze = makeAudioFeatures();
  return (dt) => responsiveBands(analyze(
    audio?.isStarted ? audio.getAnalysisFrame?.() : null, {}, dt,
  ), params);
}

// Use the same reader for standalone shaders as Canvas/camera sketches. A local
// binding prevents makeAudioShader's LEGACY idle beats and parameter pre-scaling
// from bypassing our response curve. Real runtime bindings pass through untouched
// (one read, no second FFT, no double gain, existing stale decay preserved).
export function makeBandShader(audio, params, fragment, mapUniforms, runtimeContext = {}) {
  return (p) => {
    const readBands = makeBandReader(audio, params, runtimeContext);
    const audioControls = runtimeContext.audioControls || {
      read: () => ({ continuous: readBands(bounded(p.deltaTime / 1000, 1 / 60, 0, 0.1)) }),
    };
    makeAudioShader(audio, params, fragment, (P, _bands, instance, controls) =>
      mapUniforms(P, controls?.continuous || SILENT_BANDS, instance),
    { audioControls, renderScale: 1 })(p);
  };
}

export function reactiveEntry({ id, name, group, factory, params, description, camera = false }) {
  return {
    id, name, group, factory, params, description,
    ...(camera ? { camera: true } : {}),
    audioReactive: true,
    audioTransport: 'pattern-controls',
    audioControlSchema: BAND_SCHEMA,
    createAudioController: createBandController,
  };
}
