import { W, H, renderTimeline, difference, png } from './replacement-renderer.js';
import { throughPipeline } from './replacement-pipeline.js';
const bands = ['bass', 'mid', 'high'];
const avg = values => values.reduce((a, b) => a + b, 0) / values.length;

// Exposure-normalized oriented edges in a 6x4 spatial grid: an interpretable
// geometry descriptor (where contours are, and which way they point), rather
// than a pixel-count or color metric. Also report foreground moments/occupancy.
export function structure(rgba) {
  const luma = new Float32Array(W * H), edges = new Uint8Array(W * H), signature = new Float32Array(6 * 4 * 4);
  let max = 1, min = 255;
  for (let i = 0; i < luma.length; i++) {
    luma[i] = .2126 * rgba[4 * i] + .7152 * rgba[4 * i + 1] + .0722 * rgba[4 * i + 2];
    max = Math.max(max, luma[i]); min = Math.min(min, luma[i]);
  }
  let mass = 0, sx = 0, sy = 0, sxx = 0, syy = 0, edgeCount = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, dx = (luma[i + 1] - luma[i - 1]) / (max - min + 1), dy = (luma[i + W] - luma[i - W]) / (max - min + 1);
    if (Math.hypot(dx, dy) > .13) {
      edges[i] = 1; edgeCount++;
      const tile = (Math.floor(y * 4 / H) * 6 + Math.floor(x * 6 / W)) * 4;
      const angle = (Math.atan2(dy, dx) + Math.PI * 2) % Math.PI;
      signature[tile + Math.min(3, Math.floor(angle / Math.PI * 4))]++;
    }
    if ((luma[i] - min) / (max - min + 1) > .35) {
      mass++; sx += x / W; sy += y / H; sxx += (x / W) ** 2; syy += (y / H) ** 2;
    }
  }
  for (let i = 0; i < signature.length; i++) signature[i] /= Math.max(1, edgeCount);
  const centroid = [sx / Math.max(1, mass), sy / Math.max(1, mass)];
  return { edges, signature, occupancy: mass / (W * H), centroid,
    spread: [sxx / Math.max(1, mass) - centroid[0] ** 2, syy / Math.max(1, mass) - centroid[1] ** 2], edgeDensity: edgeCount / (W * H) };
}
export const signatureDistance = (a, b) => a.signature.reduce((v, x, i) => v + Math.abs(x - b.signature[i]), 0);
function metrics(neutral, active) {
  const base = neutral.map(structure), moving = active.map(structure);
  const diffs = active.map((frame, i) => difference(neutral[i], frame));
  let residual = 0;
  for (let f = 1; f < active.length; f++) for (let i = 0; i < W * H; i++) {
    // Subtract autonomous motion AND moving source-camera edges at equal time.
    residual += Math.abs((moving[f].edges[i] - moving[f - 1].edges[i]) - (base[f].edges[i] - base[f - 1].edges[i]));
  }
  return { edge: avg(diffs.map(d => d.edge)), relocation: avg(diffs.map(d => d.edgeRelocation)),
    geometry: avg(moving.map((s, i) => signatureDistance(s, base[i]))),
    temporal: residual / ((active.length - 1) * W * H),
    occupancyChange: avg(moving.map((s, i) => Math.abs(s.occupancy - base[i].occupancy))),
    maxDelta: Math.max(...diffs.map(d => d.maxDelta)) };
}
export async function auditStrength(id, recordings, baselineRoot = '/test-results/replacement-strength/before') {
  const options = { dt: 1 / 30 };
  const neutral = await renderTimeline(id, undefined, {}, null, false, options);
  const zero = await renderTimeline(id, () => ({ sub: .9, mid: .9, high: .9 }), { bass: 0, mid: 0, high: 0 }, null, false, options);
  const baselineModules = await Promise.all(['graphic', 'fields', 'spatial', 'video'].map(name => import(`${baselineRoot}/${name}.js`)));
  const beforeSketch = baselineModules.flatMap(m => Object.values(m).flat()).find(s => s.id === id);
  const beforeOptions = { ...options, sketch: beforeSketch };
  const beforeNeutral = await renderTimeline(id, undefined, {}, null, false, beforeOptions);
  const rendered = {}, before = {}, weak = {}, result = { zero: metrics(neutral, zero), bands: {}, pairwise: {} };
  for (const [i, band] of bands.entries()) {
    const patch = { bass: 0, mid: 0, high: 0, [band]: 1 };
    const pipeline = throughPipeline(id, recordings[band].frames, patch);
    if (pipeline.interpolationDelayMs !== 33) throw new Error('Audit must use the production default interpolation');
    const oldPipeline = throughPipeline(id, recordings[band].frames, patch, { sketch: beforeSketch });
    const controls = pipeline.timeline.slice(-24), oldControls = oldPipeline.timeline.slice(-24);
    rendered[band] = await renderTimeline(id, undefined, patch, controls, false, options);
    before[band] = await renderTimeline(id, undefined, patch, oldControls, false, beforeOptions);
    weak[band] = await renderTimeline(id, f => ({ [['sub', 'mid', 'high'][i]]: f % 12 < 4 ? .015 : .001 }), patch, null, false, options);
    result.bands[band] = { actual: metrics(neutral, rendered[band]), before: metrics(beforeNeutral, before[band]), weak: metrics(neutral, weak[band]),
      amplitude: controls.map(c => c.continuous[band] / 3.2), canonical: pipeline.features.slice(-24).map(f => f[['sub', 'mid', 'high'][i]]) };
  }
  for (const [a, b] of [['bass', 'mid'], ['bass', 'high'], ['mid', 'high']]) {
    result.pairwise[`${a}/${b}`] = avg(weak[a].map((f, i) => signatureDistance(structure(f), structure(weak[b][i]))));
  }
  const peak = 15;
  result.stills = { neutral: png(neutral[peak]), ...Object.fromEntries(bands.map(b => [b, png(rendered[b][peak])])) };
  result.animation = neutral.map((f, i) => ({ neutral: png(f), ...Object.fromEntries(bands.map(b => [b, png(rendered[b][i])])) }));
  result.beforeAnimation = beforeNeutral.map((f, i) => ({ neutral: png(f), ...Object.fromEntries(bands.map(b => [b, png(before[b][i])])) }));
  return result;
}
