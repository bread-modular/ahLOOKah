import { response } from '../sketches/feature-controls.js';
export const BANDS = ['bass', 'mid', 'high'];
export const SIGNAL_DRAG = 'application/x-viz-audio-signal';
export const OPACITY = { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: .01, default: 1 };
export const numeric = d => !!d && !d.options && (!d.type || ['number', 'range', 'numeric'].includes(d.type)) && [d.min, d.max, d.step, d.default].every(Number.isFinite) && d.max > d.min && d.step > 0;
export const definitions = (node, sketches) => node?.type === 'blend' ? [OPACITY] : node?.type === 'pattern' ? sketches.find(s => s.id === node.patternId)?.params || [] : [];
export const clampStep = (v, d) => Math.min(d.max, Math.max(d.min, Number((d.min + Math.round((Math.min(d.max, Math.max(d.min, v)) - d.min) / d.step) * d.step).toPrecision(12))));
export const signalValue = (continuous, band) => BANDS.includes(band) ? response(continuous?.[band]) : 0;
export function mappedValue(mapping, signal, def) {
  const min = clampStep(mapping.min, def), max = clampStep(mapping.max, def);
  return clampStep(min + (max - min) * Math.min(1, Math.max(0, Number.isFinite(signal) ? signal : 0)), def);
}
export function mappingDiagnostics(graph, sketches) {
  return (graph.modulations || []).filter(m => m.param && !numeric(definitions(graph.nodes.find(n => n.id === m.to), sketches).find(d => d.key === m.param)))
    .map(m => `Unsupported modulation parameter: ${m.to}.${m.param}; only numeric sliders can map (not enum, bool or text).`);
}
// Read-only, live values passed to renderers. Stored base parameters never change.
export function parameterView(graph, node, sketches, readContinuous) {
  const defs = definitions(node, sketches);
  const base = node.type === 'blend' ? { opacity: node.opacity } : { ...Object.fromEntries(defs.map(d => [d.key, d.default])), ...node.params };
  const result = { ...base };
  for (const m of graph.modulations || []) {
    if (m.to !== node.id || !m.param) continue;
    const def = defs.find(d => d.key === m.param), source = graph.nodes.find(n => n.id === m.from);
    if (!numeric(def) || source?.type !== 'audio') continue;
    Object.defineProperty(result, m.param, { enumerable: true, configurable: true, get: () => mappedValue(m, signalValue(readContinuous(), source.band), def) });
  }
  return result;
}
