// Expansion projected-3D scenes: real 3D vertices, painter-sorted faces for
// solid volumes and depth-sorted segment lists for wireframes, all on Canvas2D
// with bounded geometry budgets. Reference-style gated percussion: kicks punch
// the bass-driven mass, snares snap the mid deformation, hats burst the fine
// sparks, the detected beat boosts key swells.
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
  for (const { ps, shade } of projected) path(ctx, ps, color(hue + shade * .1, 25 + Math.min(1, shade) * 46), '#122030', .007);
}

function renderSegments(ctx, segments, yaw, hue) {
  const projected = segments.map(({ a, b, shade, width }) => {
    const pa = project(a, yaw), pb = project(b, yaw);
    return { pa, pb, z: (pa[2] + pb[2]) / 2, shade, width };
  }).sort((s1, s2) => s2.z - s1.z);
  for (const { pa, pb, z, shade, width } of projected) {
    const fade = Math.max(.15, Math.min(1, 2.6 / z));
    path(ctx, [pa, pb], null, color(hue + shade * .12, 40 + Math.min(1, shade) * 45, 85, fade), width);
  }
  return projected;
}

// Voxel heightfield (Voxel Space demoscene terrain). Bass extrudes the column
// field, mids shear the lattice and yaw the bed, highs jitter fine heights and
// flash top-face glints. Kicks spike the extrusion, snares jolt the shear,
// hats burst the glints.
const voxelCascade = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, detail, hue }) => {
  const n = Math.max(7, Math.min(14, Math.round(7 + detail * 4)));
  const faces = [], step = 3 / n;
  const yaw = .55 + Math.sin(t * .15) * .06 + m * .45;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const X0 = (x - n / 2) * step + (m * .7 + snare * .22) * Math.sin(z * .8 + t * .5); // mid + snare: lattice shear jolt
    const Z0 = (z - n / 2) * step + m * .3 * Math.cos(x * .6 - t * .4);
    const wave = .5 + .5 * Math.sin(x * .9 + z * .7 + t * 1.4);
    let height = .12 + (b * 1.25 + kick * .45) * wave; // bass + kick: major extrusion/spike
    height += m * .3 * (.5 + .5 * Math.cos(z * 1.9 + x));
    height += (h + hat * .5) * .14 * (hash(x * 31 + z * 7, 1) - .5); // high + hat: fine height jitter
    const s = step * .68, yTop = .8 - height, yBase = .88;
    const a = [X0, yTop, Z0], bb = [X0 + s, yTop, Z0], c = [X0 + s, yTop, Z0 + s], d = [X0, yTop, Z0 + s];
    const glint = (h > .01 || hat > .01) && hash(x * 17 + z * 29, Math.floor(t * 5)) > 1 - Math.min(1, h + hat * .6) * .55;
    faces.push({ points: [a, bb, c, d], shade: glint ? 1.15 + hat * .25 : .95 },
      { points: [d, c, [X0 + s, yBase, Z0 + s], [X0, yBase, Z0 + s]], shade: .46 },
      { points: [bb, [X0 + s, yBase, Z0], [X0 + s, yBase, Z0 + s], c], shade: .15 });
  }
  renderFaces(ctx, faces, yaw, hue);
});

// Nested gyroscope rings. Bass expands ring radii and the core, mids precess
// each ring plane (deformation), highs light node markers and fine rim ticks.
// Kicks pulse the radii, snares snap the precession, hats burst the beads.
const gyroLattice = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, beat, detail, hue }) => {
  const K = Math.max(20, Math.min(52, Math.round(20 + detail * 18)));
  const yaw = t * .18;
  const segs = [];
  for (let ring = 0; ring < 5; ring++) {
    const R = (.34 + ring * .17) * (1 + b * 1.0 + kick * .3); // bass + kick: major radius swell/pulse
    const tilt = ring * .75 + (m * 1.6 + snare * .5) * Math.sin(t * .6 + ring * 1.1); // mid + snare: precession snap
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
    if (h > .01 || hat > .01) for (let i = 0; i < K; i++) { // high + hat: rim ticks
      const p0 = pt(i), l = Math.hypot(p0[0], p0[1], p0[2]) || 1;
      const grow = Math.min(1.4, h + hat * .6);
      segs.push({ a: p0, b: [p0[0] * (1 + grow * .42 / l), p0[1] * (1 + grow * .42 / l), p0[2] * (1 + grow * .42 / l)], shade: .95, width: .009 + grow * .013 });
    }
    if (h > .01 || hat > .01) for (let bead = 0; bead < 4; bead++) { // high + hat: traveling beads per ring
      const p0 = pt(Math.floor((t * 6 + bead * K / 4 + ring * 7) % K));
      segs.push({ a: [p0[0] * .94, p0[1] * .94, p0[2] * .94], b: [p0[0] * 1.16, p0[1] * 1.16, p0[2] * 1.16], shade: 1, width: .04 + Math.min(1, h + hat * .6) * .05 });
    }
  }
  const nodes = renderSegments(ctx, segs, yaw, hue);
  if (h > .01 || hat > .01) for (let i = 0; i < nodes.length; i += 4) { // high + hat: node markers
    const { pa, z } = nodes[i];
    circle(ctx, pa[0], pa[1], Math.max(.006, .03 * (2.6 / z) * (0.4 + Math.min(1, h + hat * .6))), color(hue + .5, 88, 100, Math.min(1, h + hat * .6)));
  }
  const c = .22 * (1 + b * 1.1 + kick * .25 + beat * .12);   // bass + kick + beat: core swell/flash
  const oct = [[c, 0, 0], [-c, 0, 0], [0, c, 0], [0, -c, 0], [0, 0, c], [0, 0, -c]];
  renderSegments(ctx, [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [2, 5], [3, 4], [3, 5]]
    .map(([i, j]) => ({ a: oct[i], b: oct[j], shade: .95, width: .01 })), yaw + t * .4, hue);
});


export const SPATIAL_PATTERNS = [
  expansionEntry({ id: 'voxel-cascade', name: 'Voxel Cascade', group: '3D', factory: voxelCascade, params: expansionParams('Grid Density'), description: 'Voxel-Space heightfield: bass extrudes the column field in waves, mids shear the lattice and yaw the bed, highs jitter fine heights and flash top-face glints; kicks spike the extrusion, snares jolt the shear, hats burst the glints.' }),
  expansionEntry({ id: 'gyro-lattice', name: 'Gyro Lattice', group: '3D', factory: gyroLattice, params: expansionParams('Ring Segments'), description: 'Nested gyroscope wireframe: bass expands ring radii and the octahedron core, mids precess each ring plane, highs light node markers and rim ticks; kicks pulse the radii, snares snap the precession, hats burst the beads.' }),
];
