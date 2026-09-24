import { response } from '../sketches/feature-controls.js';
import { isSignalSource, parameters } from './definitions.js';
import { LFO_RANGE_VALUES, lfoRangeOf } from './lfo.js';
export const BANDS = ['bass', 'mid', 'high'];
export const SIGNAL_DRAG = 'application/x-viz-audio-signal';
export const OPACITY = { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: .01, default: 1 };
import { scaleOf, quantize } from '../param-scale.js';

export const numeric = d => !!d && !d.options && (!d.type || ['number', 'range', 'numeric'].includes(d.type)) && [d.min, d.max, d.step, d.default].every(Number.isFinite) && d.max > d.min && d.step > 0;
export const definitions = (node, sketches) => node?.type === 'blend' ? [OPACITY] : node?.type === 'pattern' ? sketches.find(s => s.id === node.patternId)?.params || [] : parameters(node);
// A logarithmic parameter snaps in decades (and keeps short significant digits);
// a linear one keeps the historical min-relative step exactly as before.
export const clampStep = (v, d) => scaleOf(d) === 'log'
  ? Math.min(d.max, Math.max(d.min, quantize(Math.min(d.max, Math.max(d.min, v)), d)))
  : Math.min(d.max, Math.max(d.min, Number((d.min + Math.round((Math.min(d.max, Math.max(d.min, v)) - d.min) / d.step) * d.step).toPrecision(12))));
// Mapping endpoints are NOT clamped into the target parameter's domain. A
// mapping min/max is a description of the signal sweep (signal 0 → min, signal
// 1 → max), and a sweep may legitimately start below the parameter's own floor
// (e.g. −0.5 for a 0…1 slider): the endpoint is stored exactly as typed so it
// survives save/load instead of being silently reset to the domain floor.
// Only the graph's general finite/±1e6 numeric bound applies (same bound as
// model.js `number()`), and reversed ranges stay valid.
export const ENDPOINT_BOUND = 1000000;
export const mappingEndpoint = (value, fallback = 0) => Number.isFinite(value)
  ? Number(Math.min(ENDPOINT_BOUND, Math.max(-ENDPOINT_BOUND, value)).toPrecision(12))
  : fallback;
export const signalValue = (continuous, band) => BANDS.includes(band) ? response(continuous?.[band]) : 0;
// The signal input range a *new* mapping starts with: the source's own domain, so
// a bipolar LFO (−1…1) sweeps a slider end to end without a manual conversion
// step. Every other source keeps the historical 0…1 mapping.
export function defaultInputRange(source) {
  const [low, high] = source?.type === 'lfo' ? LFO_RANGE_VALUES[lfoRangeOf(source.range)] : [0, 1];
  return { inputMin: low, inputMax: high };
}
// Terminal normalization only: scalar intermediates stay signed floats, and the
// input range defaults to 0…1 so legacy mappings behave exactly as before.
// Stored endpoints are read raw; only the value handed to the target is clamped
// into the target parameter's real domain, at this terminal edge. So a negative
// endpoint shifts the sweep (and persists) instead of being discarded, while a
// renderer never receives an out-of-domain parameter.
export function mappedValue(mapping, signal, def) {
  const min = mappingEndpoint(mapping.min, def.min), max = mappingEndpoint(mapping.max, def.max);
  const low = Number.isFinite(mapping.inputMin) ? mapping.inputMin : 0, high = Number.isFinite(mapping.inputMax) ? mapping.inputMax : 1;
  const span = high - low;
  const value = Number.isFinite(signal) ? signal : 0;
  const t = span > 0 ? Math.min(1, Math.max(0, (value - low) / span)) : 0;
  // A logarithmic parameter sweeps logarithmically between its endpoints: a
  // 0.2 s → 8 s mapping passes 0.4, 0.8, 1.6 … in even steps instead of crawling
  // near the slow end and racing through the fast one. An endpoint at or below
  // zero has no logarithm, so it is read at the parameter's positive floor for
  // this interpolation only (the endpoint itself is still stored as typed).
  if (scaleOf(def) === 'log') {
    const a = Math.max(def.min, min), b = Math.max(def.min, max);
    return clampStep(10 ** (Math.log10(a) + (Math.log10(b) - Math.log10(a)) * t), def);
  }
  return clampStep(min + (max - min) * t, def);
}
export function mappingDiagnostics(graph, sketches) {
  return (graph.modulations || []).filter(m => m.param && !numeric(definitions(graph.nodes.find(n => n.id === m.to), sketches).find(d => d.key === m.param)))
    .map(m => `Unsupported modulation parameter: ${m.to}.${m.param}; only numeric sliders can map (not enum, bool or text).`);
}
// Read-only, live values passed to renderers. Stored base parameters never change.
// Every scalar source prefers the runtime's once-per-frame `readSignal` (so an
// Audio node's routed value matches its Math/Script consumers and readouts); the
// standalone fallback reads the route-aware continuous frame for Audio and skips
// intermediates, exactly as before.
export function parameterView(graph, node, sketches, readContinuous, readSignal = null) {
  const defs = definitions(node, sketches);
  const base = node.type === 'blend' ? { opacity: node.opacity } : { ...Object.fromEntries(defs.map(d => [d.key, d.default])), ...node.params };
  const result = { ...base };
  for (const m of graph.modulations || []) {
    if (m.to !== node.id || !m.param) continue;
    const def = defs.find(d => d.key === m.param), source = graph.nodes.find(n => n.id === m.from);
    if (!numeric(def) || !isSignalSource(source)) continue;
    const read = readSignal ? () => readSignal(source.id)
      : source.type === 'audio' ? () => signalValue(readContinuous(source.id), source.band) : null;
    if (!read) continue;
    Object.defineProperty(result, m.param, { enumerable: true, configurable: true, get: () => mappedValue(m, read(), def) });
  }
  return result;
}
