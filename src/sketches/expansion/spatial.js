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
function streaks(ctx, { t, b, h, hue, yaw, count = 40, seed = 0 }) {
  const segs = [];
  for (let i = 0; i < count; i++) {
    const x = (hash(i, seed + 1) - .5) * 3.4, y = (hash(i, seed + 2) - .5) * 3.4;
    const span = 7;
    const z = ((hash(i, seed + 3) * span + t * (1.2 + b * 5.5)) % span) - 4.5;
    const len = .12 + h * 1.7;                       // high: streak length
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
  const K = Math.max(20, Math.min(52, Math.round(20 + detail * 18)));
  const yaw = t * .18;
  const segs = [];
  for (let ring = 0; ring < 5; ring++) {
    const R = (.34 + ring * .17) * (1 + b * 1.0);    // bass: major radius swell
    const tilt = ring * .75 + m * 1.6 * Math.sin(t * .6 + ring * 1.1); // mid: precession
    const spin = t * (.3 + ring * .13);
    const pt = (i) => {
      const a = i / K * TAU + spin;
      const u = [Math.cos(a) * R, Math.sin(a) * R, 0];
      return [
        u[0],
        u[1] * Math.cos(tilt) - u[2] * Math.sin(tilt),
        u[1] * Math.sin(tilt) + u[2] * Math.cos(tilt),
      ];
    };
    for (let i = 0; i < K; i++) segs.push({ a: pt(i), b: pt(i + 1), shade: .35 + ring * .14, width: .02 });
    for (let i = 0; i < K; i += 6) {                 // radial spokes tie the lattice together
      const p0 = pt(i), p1 = pt(i + 3);
      segs.push({ a: [p0[0] * .32, p0[1] * .32, p0[2] * .32], b: p1, shade: .3, width: .008 });
    }
    if (h > .01) for (let i = 0; i < K; i++) {       // high: rim ticks
      const p0 = pt(i), l = Math.hypot(p0[0], p0[1], p0[2]) || 1;
      segs.push({ a: p0, b: [p0[0] * (1 + h * .42 / l), p0[1] * (1 + h * .42 / l), p0[2] * (1 + h * .42 / l)], shade: .95, width: .009 + h * .013 });
    }
    if (h > .01) for (let bead = 0; bead < 4; bead++) { // high: traveling beads per ring
      const p0 = pt(Math.floor((t * 6 + bead * K / 4 + ring * 7) % K));
      segs.push({ a: [p0[0] * .94, p0[1] * .94, p0[2] * .94], b: [p0[0] * 1.16, p0[1] * 1.16, p0[2] * 1.16], shade: 1, width: .04 + h * .05 });
    }
  }
  const nodes = renderSegments(ctx, segs, yaw, hue);
  if (h > .01) for (let i = 0; i < nodes.length; i += 4) { // high: node markers
    const { pa, z } = nodes[i];
    circle(ctx, pa[0], pa[1], Math.max(.006, .03 * (2.6 / z) * (0.4 + h)), color(hue + .5, 88, 100, h));
  }
  const c = .22 * (1 + b * 1.1);                     // bass: core swell
  const oct = [[c, 0, 0], [-c, 0, 0], [0, c, 0], [0, -c, 0], [0, 0, c], [0, 0, -c]];
  renderSegments(ctx, [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [2, 5], [3, 4], [3, 5]]
    .map(([i, j]) => ({ a: oct[i], b: oct[j], shade: .95, width: .01 })), yaw + t * .4, hue);
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
    const tube = .075 * (1 + b * .7);
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
      segs.push({ a: rings[i][j], b: next[j], shade: .6, width: .011 });
      if (i % 3 === 0) segs.push({ a: rings[i][j], b: rings[i][(j + 1) % V], shade: .35, width: .008 });
    }
  }
  if (h > .01) for (let ring2 = 0; ring2 < 2; ring2++) { // high: orbiting satellite dots
    const R2 = 1.15 + ring2 * .3;
    for (let i = 0; i < 22; i++) {
      const a = i * TAU / 22 + t * (0.6 + ring2 * .4) * (ring2 ? -1 : 1);
      segs.push({ a: [Math.cos(a) * R2, Math.sin(a) * R2 * .5, -1 - ring2], b: [Math.cos(a + .05) * R2, Math.sin(a + .05) * R2 * .5, -1 - ring2], shade: 1, width: .02 + h * .03 });
    }
  }
  const projected = renderSegments(ctx, segs, yaw, hue);
  if (h > .01) for (let i = 0; i < projected.length; i += 4) { // high: vertex sparks
    const { pa, z } = projected[i];
    circle(ctx, pa[0], pa[1], Math.max(.006, .038 * (2.6 / z) * (0.35 + h)), color(hue + .5, 88, 100, h));
  }
});

// Techno Helix — Techno 3D descendant #2: wireframe double-helix column.
// Bass expands helix radius and pushes the camera, mids change the twist
// density and skew the rungs, highs spark rung midpoints and cross-links.
const technoHelix = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const yaw = .3 + t * .2;
  streaks(ctx, { t, b, h, hue: hue + .5, yaw, seed: 9 });
  const N = Math.max(28, Math.min(72, Math.round(28 + detail * 24)));
  const R = .55 * (1 + b * 1.1);                     // bass: major radius pump
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
    segs.push({ a, b: bb, shade: .55 + s * .25, width: .016 });
    if (h > .01) {                                   // high: ghost tracer strand (opposite phase)
      const g0 = [a[0] * 1.35, -a[1] * 1.35, a[2]], g1 = [bb[0] * 1.35, -bb[1] * 1.35, bb[2]];
      segs.push({ a: g0, b: g1, shade: .95, width: .01 + h * .018 });
    }
  }
  for (let i = 0; i < N; i++) {                      // rungs, skewed by mids
    const a = strand(0, i), bb = strand(1, i);
    const skew = m * .35;
    segs.push({ a: [a[0] + skew, a[1], a[2]], b: [bb[0] - skew, bb[1], bb[2]], shade: .3, width: .01 });
    if (h > .01 && i % 2 === 0) {                    // high: cross-link accents
      const mid = [(a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2, (a[2] + bb[2]) / 2];
      segs.push({ a: [mid[0], mid[1], mid[2]], b: [mid[0] * 1.6, mid[1] * 1.6, mid[2]], shade: .9, width: .008 + h * .012 });
    }
  }
  const projected = renderSegments(ctx, segs, yaw, hue);
  if (h > .01) for (let i = 0; i < projected.length; i += 3) { // high: rung sparks
    const { pa, z } = projected[i];
    circle(ctx, pa[0], pa[1], Math.max(.006, .034 * (2.6 / z) * (0.35 + h)), color(hue + .55, 88, 100, h));
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
    const s = .16 * (1 + b * 1.6 * pulse);           // bass: major scale wave
    const x = (c - (C - 1) / 2) * .55;
    const y = (r - (rows - 1) / 2) * .5 + m * .65 * Math.sin(c + r * 2 + t * 2.2); // mid: ripple
    const z = -r * .9 + m * .3 * Math.cos(c * 1.3 - t);
    const corners = [];
    for (const [dx, dy, dz] of [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]])
      corners.push([x + dx * s, y + dy * s, z + dz * s]);
    for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) {
      const flicker = h > .01 && hash(c * 7 + r * 13 + i, Math.floor(t * 20)) < h * .6; // high: edge flicker
      segs.push({ a: corners[i], b: corners[j], shade: flicker ? 1 : .4 + pulse * .3, width: flicker ? .01 + h * .008 : .008 });
    }
  }
  if (h > .01) for (let i = 0; i < C * rows; i++) { // high: data-rain streaks between cubes
    const x = (hash(i, 4) - .5) * C * .55;
    const z = -hash(i, 5) * 4;
    const y0 = (hash(i, Math.floor(t * 8) + 6) - .5) * 2.2;
    segs.push({ a: [x, y0, z], b: [x, y0 - .3 - h * .5, z], shade: 1, width: .009 + h * .016 });
  }
  const projected = renderSegments(ctx, segs, yaw, hue);
  if (h > .01) for (let i = 0; i < projected.length; i += 3) { // high: corner glints
    const { pa, z } = projected[i];
    circle(ctx, pa[0], pa[1], Math.max(.007, .038 * (2.6 / z) * (0.35 + h)), color(hue + .5, 90, 100, h));
  }
});

export const SPATIAL_PATTERNS = [
  expansionEntry({ id: 'voxel-cascade', name: 'Voxel Cascade', group: '3D', factory: voxelCascade, params: expansionParams('Grid Density'), description: 'Voxel-Space heightfield: bass extrudes the column field in waves, mids shear the lattice and yaw the bed, highs jitter fine heights and flash top-face glints.' }),
  expansionEntry({ id: 'gyro-lattice', name: 'Gyro Lattice', group: '3D', factory: gyroLattice, params: expansionParams('Ring Segments'), description: 'Nested gyroscope wireframe: bass expands ring radii and the octahedron core, mids precess each ring plane, highs light node markers and rim ticks.' }),
  expansionEntry({ id: 'techno-torus', name: 'Techno Torus', group: '3D', factory: technoTorus, params: expansionParams('Knot Detail'), description: 'Techno 3D descendant — wireframe torus-knot core with rushing streaks: bass pumps core scale and streak speed, mids morph the knot winding, highs lengthen streaks and spark vertices.' }),
  expansionEntry({ id: 'techno-helix', name: 'Techno Helix', group: '3D', factory: technoHelix, params: expansionParams('Strand Detail'), description: 'Techno 3D descendant — wireframe double helix in flight: bass expands radius and camera push, mids change twist density and skew rungs, highs spark rung midpoints and cross-links.' }),
  expansionEntry({ id: 'techno-array', name: 'Techno Array', group: '3D', factory: technoArray, params: expansionParams('Grid Columns'), description: 'Techno 3D descendant — receding wireframe cube field: bass pumps cube scale in traveling waves, mids ripple the grid geometry, highs glint corners and flicker edges.' }),
];
