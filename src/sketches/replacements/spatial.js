// Real projected 3D vertices and painter-sorted faces; bounded geometry budgets.
import { canvasFactory, color, entry, path } from './runtime.js';

function project([x, y, z], yaw) {
  const X = x * Math.cos(yaw) - z * Math.sin(yaw), Z = x * Math.sin(yaw) + z * Math.cos(yaw);
  const Y = y * .83 - Z * .56, depth = 5.8 + y * .56 + Z * .83;
  return [X * 3.4 / depth, Y * 3.4 / depth, depth];
}
function renderFaces(ctx, faces, yaw, hue) {
  const projected = faces.map(({ points, shade }) => {
    const ps = points.map(p => project(p, yaw));
    return { ps, z: ps.reduce((n, p) => n + p[2], 0) / ps.length, shade };
  }).sort((a, b) => b.z - a.z);
  for (const { ps, shade } of projected) path(ctx, ps, color(hue + shade * .1, 25 + shade * 46), '#122030', .007);
}
const pinRelief = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const n = Math.round(7 + detail * 2), faces = [], step = 2.8 / n;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const X = (x - n / 2) * step, Z = (z - n / 2) * step;
    const wave = .5 + .5 * Math.sin(X * 2.2 + Z * 1.4 + t);
    const height = .09 + b * 1.2 * wave + m * .55 * (.5 + .5 * Math.cos(Z * 4 + X));
    const size = step * (.62 + h * .34), y = .7 - height;
    const a = [X, y, Z], c = [X + size, y, Z + size], d = [X, y, Z + size], e = [X + size, y, Z];
    faces.push({ points: [a, e, c, d], shade: .95 },
      { points: [d, c, [X + size, .85, Z + size], [X, .85, Z + size]], shade: .46 },
      { points: [e, [X + size, .85, Z], [X + size, .85, Z + size], c], shade: .15 });
  }
  renderFaces(ctx, faces, .55 + Math.sin(t * .18) * .08 + m * .35, hue);
});
const foldedSpire = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const faces = [], n = Math.round(7 + detail * 3), sides = 8;
  const vertex = (i, j) => {
    const a = j * Math.PI / 4 + i * (.08 + m * .34) + t * .15;
    const r = .35 + b * .5 + (i % 2 ? .06 : .22 + h * .38);
    return [Math.cos(a) * r, (i / n - .5) * 2.8, Math.sin(a) * r];
  };
  for (let i = 0; i < n; i++) for (let j = 0; j < sides; j++) {
    const a = vertex(i, j), bb = vertex(i, j + 1), c = vertex(i + 1, j), d = vertex(i + 1, j + 1);
    faces.push({ points: [a, bb, c], shade: .22 + (j % 3) * .32 }, { points: [bb, d, c], shade: .87 - (j % 3) * .2 });
  }
  renderFaces(ctx, faces, .2, hue);
});
export const SPATIAL_PATTERNS = [
  entry('pin-relief', 'Pin Relief', '3D', 'Instanced sculptural pin bed: bass extrudes waves, mids sculpt ridges and turn the bed, highs expand pin cross-sections.', pinRelief, 'Pin Density'),
  entry('folded-spire', 'Folded Spire', '3D', 'Faceted origami tower: bass expands its body, mids twist successive floors, highs unfold alternating pleats.', foldedSpire, 'Fold Count'),
];
