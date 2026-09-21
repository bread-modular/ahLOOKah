import { response } from '../sketches/feature-controls.js';
import { isSignalSource, parameters } from './definitions.js';
export const BANDS = ['bass', 'mid', 'high'];
export const SIGNAL_DRAG = 'application/x-viz-audio-signal';
export const OPACITY = { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: .01, default: 1 };
export const numeric = d => !!d && !d.options && (!d.type || ['number', 'range', 'numeric'].includes(d.type)) && [d.min, d.max, d.step, d.default].every(Number.isFinite) && d.max > d.min && d.step > 0;
export const definitions = (node, sketches) => node?.type === 'blend' ? [OPACITY] : node?.type === 'pattern' ? sketches.find(s => s.id === node.patternId)?.params || [] : parameters(node);
export const clampStep = (v, d) => Math.min(d.max, Math.max(d.min, Number((d.min + Math.round((Math.min(d.max, Math.max(d.min, v)) - d.min) / d.step) * d.step).toPrecision(12))));
export const signalValue = (continuous, band) => BANDS.includes(band) ? response(continuous?.[band]) : 0;
// Terminal normalization only: scalar intermediates stay signed floats, and the
// input range defaults to 0…1 so legacy mappings behave exactly as before.
export function mappedValue(mapping, signal, def) {
  const min = clampStep(mapping.min, def), max = clampStep(mapping.max, def);
  const low = Number.isFinite(mapping.inputMin) ? mapping.inputMin : 0, high = Number.isFinite(mapping.inputMax) ? mapping.inputMax : 1;
  const span = high - low;
  const value = Number.isFinite(signal) ? signal : 0;
  const t = span > 0 ? Math.min(1, Math.max(0, (value - low) / span)) : 0;
  return clampStep(min + (max - min) * t, def);
}
export function mappingDiagnostics(graph, sketches) {
  return (graph.modulations || []).filter(m => m.param && !numeric(definitions(graph.nodes.find(n => n.id === m.to), sketches).find(d => d.key === m.param)))
    .map(m => `Unsupported modulation parameter: ${m.to}.${m.param}; only numeric sliders can map (not enum, bool or text).`);
}
// Read-only, live values passed to renderers. Stored base parameters never change.
// Audio sources read the shared continuous frame; Math/Script sources read the
// runtime's once-per-frame signal value through `readSignal`.
export function parameterView(graph, node, sketches, readContinuous, readSignal = null) {
  const defs = definitions(node, sketches);
  const base = node.type === 'blend' ? { opacity: node.opacity } : { ...Object.fromEntries(defs.map(d => [d.key, d.default])), ...node.params };
  const result = { ...base };
  for (const m of graph.modulations || []) {
    if (m.to !== node.id || !m.param) continue;
    const def = defs.find(d => d.key === m.param), source = graph.nodes.find(n => n.id === m.from);
    if (!numeric(def) || !isSignalSource(source)) continue;
    const read = source.type === 'audio' ? () => signalValue(readContinuous(), source.band)
      : readSignal ? () => readSignal(source.id) : null;
    if (!read) continue;
    Object.defineProperty(result, m.param, { enumerable: true, configurable: true, get: () => mappedValue(m, read(), def) });
  }
  return result;
}
