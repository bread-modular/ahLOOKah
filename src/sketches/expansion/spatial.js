// Expansion projected-3D scenes: real 3D vertices, painter-sorted faces for
// solid volumes and depth-sorted segment lists for wireframes, all on Canvas2D
// with bounded geometry budgets. The three techno-* scenes are the requested
// Techno 3D descendants: same DNA (wireframe core + rushing perspective
// streaks + band-split structures), three different constructions.
import { TAU, canvasFactory, circle, color, expansionEntry, expansionParams, hash, path } from './runtime.js';

function project([x, y, z], yaw) {
  const X = x * Math.cos(yaw) - z * Math.sin(yaw), Z = x * Math.sin(yaw) + z * Math.cos(yaw);
  const Y = y * .83 - Z * .56, depth = 5.8 + y * .56 + Z * .83;
  return [X * 3.4 / depth, Y * 3.4 / depth, depth];
}

function renderFaces(ctx, faces, yaw, hue) {
  const projected = faces.map(({ points, shade }) => {
    const ps = points.map((p) => project(p, yaw));
    return { ps, z: ps.reduce((n, p) => n + p[2], 0) / ps.length, shade };
  }).sort((a, b) => b.z - a.z);
  for (const { ps, shade } of projected) path(ctx, ps, color(hue + shade * .1, 25 + shade * 46), '#122030', .007);
}

function renderSegments(ctx, segments, yaw, hue) {
  const projected = segments.map(({ a, b, shade, width }) => {
    const pa = project(a, yaw), pb = project(b, yaw);
    return { pa, pb, z: (pa[2] + pb[2]) / 2, shade, width };
  }).sort((s1, s2) => s2.z - s1.z);
  for (const { pa, pb, z, shade, width } of projected) {
    const fade = Math.max(.15, Math.min(1, 2.6 / z));
    path(ctx, [pa, pb], null, color(hue + shade * .12, 40 + shade * 45, 85, fade), width);
  }
  return projected;
}

// Rushing perspective streak field (the Techno 3D signature), deterministic.
function streaks(ctx, { t, b, h, hue, yaw, count = 34, seed = 0 }) {
  const segs = [];
  for (let i = 0; i < count; i++) {
    const x = (hash(i, seed + 1) - .5) * 3.4, y = (hash(i, seed + 2) - .5) * 3.4;
    const span = 7;
    const z = ((hash(i, seed + 3) * span + t * (1.2 + b * 5.5)) % span) - 4.5;
    const len = .12 + h * 1.1;                       // high: streak length
    segs.push({ a: [x, y, z], b: [x, y, Math.min(2.2, z + len)], shade: .55, width: .006 + h * .012 });
  }
  renderSegments(ctx, segs, yaw, hue);
}

// Voxel heightfield (Voxel Space demoscene terrain). Bass extrudes the column
// field, mids shear the lattice and yaw the bed, highs jitter fine heights and
// flash top-face glints.
const voxelCascade = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const n = Math.max(7, Math.min(14, Math.round(7 + detail * 4)));
  const faces = [], step = 3 / n;
  const yaw = .55 + Math.sin(t * .15) * .06 + m * .45;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const X0 = (x - n / 2) * step + m * .7 * Math.sin(z * .8 + t * .5); // mid: lattice shear
    const Z0 = (z - n / 2) * step + m * .3 * Math.cos(x * .6 - t * .4);
    const wave = .5 + .5 * Math.sin(x * .9 + z * .7 + t * 1.4);
    let height = .12 + b * 1.25 * wave;              // bass: major extrusion
    height += m * .3 * (.5 + .5 * Math.cos(z * 1.9 + x));
    height += h * .14 * (hash(x * 31 + z * 7, 1) - .5); // high: fine height jitter
    const s = step * .68, yTop = .8 - height, yBase = .88;
    const a = [X0, yTop, Z0], bb = [X0 + s, yTop, Z0], c = [X0 + s, yTop, Z0 + s], d = [X0, yTop, Z0 + s];
    const glint = h > .01 && hash(x * 17 + z * 29, Math.floor(t * 5)) > 1 - h * .55;
    faces.push({ points: [a, bb, c, d], shade: glint ? 1.15 : .95 },
      { points: [d, c, [X0 + s, yBase, Z0 + s], [X0, yBase, Z0 + s]], shade: .46 },
      { points: [bb, [X0 + s, yBase, Z0], [X0 + s, yBase, Z0 + s], c], shade: .15 });
  }
  renderFaces(ctx, faces, yaw, hue);
});

// Nested gyroscope rings. Bass expands ring radii and the core, mids precess
// each ring plane (deformation), highs light node markers and fine rim ticks.
const gyroLattice = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const K = Math.max(18, Math.min(48, Math.round(18 + detail * 16)));
  const yaw = t * .18;
  const segs = [];
  for (let ring = 0; ring < 3; ring++) {
    const R = (.4 + ring * .24) * (1 + b * .6);      // bass: major radius swell
    const tilt = ring * 1.05 + m * 1.3 * Math.sin(t * .6 + ring); // mid: precession
    const spin = t * (.3 + ring * .17);
    const pt = (i) => {
      const a = i / K * TAU + spin;
      const u = [Math.cos(a) * R, Math.sin(a) * R, 0];
      return [
        u[0],
        u[1] * Math.cos(tilt) - u[2] * Math.sin(tilt),
        u[1] * Math.sin(tilt) + u[2] * Math.cos(tilt),
      ];
    };
    for (let i = 0; i < K; i++) segs.push({ a: pt(i), b: pt(i + 1), shade: .3 + ring * .2, width: .008 });
    if (h > .01) for (let i = 0; i < K; i += 2) {    // high: rim ticks
      const p0 = pt(i), l = Math.hypot(p0[0], p0[1], p0[2]) || 1;
      segs.push({ a: p0, b: [p0[0] * (1 + h * .12 / l), p0[1] * (1 + h * .12 / l), p0[2] * (1 + h * .12 / l)], shade: .85, width: .004 });
    }
  }
  const nodes = renderSegments(ctx, segs, yaw, hue);
  if (h > .01) for (let i = 0; i < nodes.length; i += 6) { // high: node markers
    const { pa, z } = nodes[i];
    circle(ctx, pa[0], pa[1], Math.max(.004, .02 * (2.6 / z) * (0.4 + h)), color(hue + .5, 85, 95, h * .85));
  }
  const c = .16 * (1 + b * .8);                      // bass: core swell
  const oct = [[c, 0, 0], [-c, 0, 0], [0, c, 0], [0, -c, 0], [0, 0, c], [0, 0, -c]];
  renderSegments(ctx, [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [2, 5], [3, 4], [3, 5]]
    .map(([i, j]) => ({ a: oct[i], b: oct[j], shade: .9, width: .006 })), yaw + t * .4, hue);
});

// Techno Torus — Techno 3D descendant #1: wireframe torus-knot core. Bass
// pumps core scale and streak speed, mids morph the knot winding (deformed
// geometry), highs lengthen streaks and spark knot vertices.
const technoTorus = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const yaw = t * .35;
  streaks(ctx, { t, b, h, hue: hue + .55, yaw, seed: 3 });
  const U = Math.max(60, Math.min(150, Math.round(60 + detail * 50)));
  const V = 6;
  const q = 3 + m * 2.2;                             // mid: winding morph
  const scale = .34 * (1 + b * .85);                 // bass: major core pump
  const knot = (u) => {
    const r = 2 + Math.cos(q * u);
    return [r * Math.cos(2 * u) * scale, r * Math.sin(2 * u) * scale, Math.sin(q * u) * scale * 1.6];
  };
  const rings = [];
  for (let i = 0; i < U; i++) {
    const u = i / U * TAU;
    const p0 = knot(u), p1 = knot(u + .02);
    const tangent = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const l = Math.hypot(...tangent) || 1;
    const n1 = [-tangent[1] / l, tangent[0] / l, 0];
    const n2 = [
      tangent[1] * n1[2] - tangent[2] * n1[1],
      tangent[2] * n1[0] - tangent[0] * n1[2],
      tangent[0] * n1[1] - tangent[1] * n1[0],
    ];
    const tube = .05 * (1 + b * .5);
    rings.push([...Array(V)].map((_, j) => {
      const a = j / V * TAU + t * .8;
      return [
        p0[0] + (n1[0] * Math.cos(a) + n2[0] * Math.sin(a)) * tube,
        p0[1] + (n1[1] * Math.cos(a) + n2[1] * Math.sin(a)) * tube,
        p0[2] + (n1[2] * Math.cos(a) + n2[2] * Math.sin(a)) * tube,
      ];
    }));
  }
  const segs = [];
  for (let i = 0; i < U; i++) {
    const next = rings[(i + 1) % U];
    for (let j = 0; j < V; j++) {
      segs.push({ a: rings[i][j], b: next[j], shade: .55, width: .005 });
      if (i % 4 === 0) segs.push({ a: rings[i][j], b: rings[i][(j + 1) % V], shade: .3, width: .004 });
    }
  }
  const projected = renderSegments(ctx, segs, yaw, hue);
  if (h > .01) for (let i = 0; i < projected.length; i += 9) { // high: vertex sparks
    const { pa, z } = projected[i];
    circle(ctx, pa[0], pa[1], Math.max(.003, .014 * (2.6 / z) * (0.3 + h)), color(hue + .5, 88, 100, h * .8));
  }
});

// Techno Helix — Techno 3D descendant #2: wireframe double-helix column.
// Bass expands helix radius and pushes the camera, mids change the twist
// density and skew the rungs, highs spark rung midpoints and cross-links.
const technoHelix = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const yaw = .3 + t * .2;
  streaks(ctx, { t, b, h, hue: hue + .5, yaw, seed: 9 });
  const N = Math.max(28, Math.min(72, Math.round(28 + detail * 24)));
  const R = .5 * (1 + b * .7);                       // bass: major radius pump
  const turns = 2.2 + m * 3.2;                       // mid: twist deformation
  const segs = [];
  const strand = (s, i) => {
    const f = i / (N - 1);
    const a = f * turns * TAU + t * 1.2 + s * Math.PI;
    const z = 1.8 - f * 5.2 + (t * (0.5 + b * 1.4)) % 1.3;
    return [Math.cos(a) * R, Math.sin(a) * R * (.8 + m * .3), z];
  };
  for (let i = 0; i < N - 1; i++) for (const s of [0, 1]) {
    const a = strand(s, i), bb = strand(s, i + 1);
    if (Math.abs(a[2] - bb[2]) > 1.2) continue;      // helix wrap: never stretch a segment across the scene
    segs.push({ a, b: bb, shade: .5 + s * .25, width: .006 });
  }
  for (let i = 0; i < N; i += 2) {                   // rungs, skewed by mids
    const a = strand(0, i), bb = strand(1, i);
    const skew = m * .3;
    segs.push({ a: [a[0] + skew, a[1], a[2]], b: [bb[0] - skew, bb[1], bb[2]], shade: .25, width: .004 });
    if (h > .01 && i % 4 === 0) {                    // high: cross-link accents
      const mid = [(a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2, (a[2] + bb[2]) / 2];
      segs.push({ a: [mid[0], mid[1], mid[2]], b: [mid[0] * 1.5, mid[1] * 1.5, mid[2]], shade: .85, width: .003 + h * .004 });
    }
  }
  const projected = renderSegments(ctx, segs, yaw, hue);
  if (h > .01) for (let i = 0; i < projected.length; i += 8) { // high: rung sparks
    const { pa, z } = projected[i];
    circle(ctx, pa[0], pa[1], Math.max(.003, .016 * (2.6 / z) * (0.3 + h)), color(hue + .55, 85, 100, h * .75));
  }
});

// Techno Array — Techno 3D descendant #3: receding wireframe cube field.
// Bass pumps cube scale in traveling waves, mids ripple the grid geometry,
// highs glint cube corners and flicker edges, streaks keep the techno rush.
const technoArray = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const yaw = .45 + Math.sin(t * .2) * .05;
  streaks(ctx, { t, b, h, hue: hue + .5, yaw, seed: 17, count: 26 });
  const C = Math.max(4, Math.min(10, Math.round(4 + detail * 3)));
  const rows = 5;
  const segs = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < C; c++) {
    const pulse = .5 + .5 * Math.sin(c * .9 - t * 3 + r);
    const s = .14 * (1 + b * 1.2 * pulse);           // bass: major scale wave
    const x = (c - (C - 1) / 2) * .55;
    const y = (r - (rows - 1) / 2) * .5 + m * .4 * Math.sin(c + r * 2 + t * 2.2); // mid: ripple
    const z = -r * .9 + m * .2 * Math.cos(c * 1.3 - t);
    const corners = [];
    for (const [dx, dy, dz] of [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]])
      corners.push([x + dx * s, y + dy * s, z + dz * s]);
    for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) {
      const flicker = h > .01 && hash(c * 7 + r * 13 + i, Math.floor(t * 20)) < h * .3; // high: edge flicker
      segs.push({ a: corners[i], b: corners[j], shade: flicker ? .95 : .35 + pulse * .3, width: flicker ? .007 : .005 });
    }
  }
  const projected = renderSegments(ctx, segs, yaw, hue);
  if (h > .01) for (let i = 0; i < projected.length; i += 7) { // high: corner glints
    const { pa, z } = projected[i];
    circle(ctx, pa[0], pa[1], Math.max(.003, .013 * (2.6 / z) * (0.3 + h)), color(hue + .5, 88, 100, h * .8));
  }
});

export const SPATIAL_PATTERNS = [
  expansionEntry({ id: 'voxel-cascade', name: 'Voxel Cascade', group: '3D', factory: voxelCascade, params: expansionParams('Grid Density'), description: 'Voxel-Space heightfield: bass extrudes the column field in waves, mids shear the lattice and yaw the bed, highs jitter fine heights and flash top-face glints.' }),
  expansionEntry({ id: 'gyro-lattice', name: 'Gyro Lattice', group: '3D', factory: gyroLattice, params: expansionParams('Ring Segments'), description: 'Nested gyroscope wireframe: bass expands ring radii and the octahedron core, mids precess each ring plane, highs light node markers and rim ticks.' }),
  expansionEntry({ id: 'techno-torus', name: 'Techno Torus', group: '3D', factory: technoTorus, params: expansionParams('Knot Detail'), description: 'Techno 3D descendant — wireframe torus-knot core with rushing streaks: bass pumps core scale and streak speed, mids morph the knot winding, highs lengthen streaks and spark vertices.' }),
  expansionEntry({ id: 'techno-helix', name: 'Techno Helix', group: '3D', factory: technoHelix, params: expansionParams('Strand Detail'), description: 'Techno 3D descendant — wireframe double helix in flight: bass expands radius and camera push, mids change twist density and skew rungs, highs spark rung midpoints and cross-links.' }),
  expansionEntry({ id: 'techno-array', name: 'Techno Array', group: '3D', factory: technoArray, params: expansionParams('Grid Columns'), description: 'Techno 3D descendant — receding wireframe cube field: bass pumps cube scale in traveling waves, mids ripple the grid geometry, highs glint corners and flicker edges.' }),
];
