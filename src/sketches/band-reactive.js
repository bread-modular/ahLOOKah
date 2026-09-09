// Compact, shared band transport for inexpensive patterns. Feature extraction
// stays on the capture owner (one scan per tick), never in each output shader.
import { makeAudioFeatures } from './audio-features.js';

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

export function createBandController() {
  return {
    update({ shared, params = {} }) {
      return { continuous: scaleBands(shared?.getFeatures?.(), params), arrays: {}, events: [] };
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
  return (dt) => scaleBands(analyze(
    audio?.isStarted ? audio.getAnalysisFrame?.() : null, {}, dt,
  ), params);
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
