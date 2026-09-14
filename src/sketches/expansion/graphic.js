// Expansion vector scenes: broadcast test card and stage-light matte.
// Every scene documents its structural band split: bass moves/scales the major
// mass, mids deform geometry, highs restructure the fine accents. Reference-
// style gated percussion adds distinct transient accents on top: kicks punch
// the bass-driven mass, snares snap the mid-driven deformation, hats burst
// the fine treble detail. No fabricated idle beats — silence stays silent.
import { canvasFactory, circle, color, expansionEntry, expansionParams, gray, hash, path } from './runtime.js';

// PM5544-style test card. Bass breathes the center circle and grid scale,
// mids split the convergence crosses into misregistered beams, highs subdivide
// and shimmer the resolution wedges. Kicks punch the breathing, snares snap
// the misconvergence, hats burst the shimmer.
const testCard = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, detail, hue }) => {
  const cols = Math.max(10, Math.min(26, Math.round(8 + detail * 9)));
  const s = 1 + b * .14 + kick * .05;                       // bass + kick: scale pump
  ctx.save(); ctx.scale(s, s);
  ctx.fillStyle = gray(.14); ctx.fillRect(-2.2, -1, 4.4, 2);
  ctx.lineWidth = .006; ctx.strokeStyle = gray(.4, .8);
  for (let i = -cols; i <= cols; i++) {
    const skew = (i % 2 ? 1 : -1) * (m * .08 + snare * .03); // mid + snare: grid misregistration snap
    path(ctx, [[i / cols * 1.6 + skew, -1], [i / cols * 1.6 - skew, 1]], null, gray(.38, .75), .006);
  }
  for (let i = -6; i <= 6; i++) path(ctx, [[-1.6, i / 6 + (i % 2 ? m * .04 : -m * .04)], [1.6, i / 6 - (i % 2 ? m * .04 : -m * .04)]], null, gray(.38, .75), .006);
  const R = .62 * (1 + b * .3 + kick * .1);                 // bass + kick: circle breathing/punch
  circle(ctx, 0, 0, R, gray(.85), gray(.15), .012);
  circle(ctx, 0, 0, R * .55, gray(.2));
  path(ctx, [[-R, 0], [R, 0]], null, gray(.1), .01); path(ctx, [[0, -R], [0, R]], null, gray(.1), .01);
  for (const [cx, cy] of [[-1.25, -.7], [1.25, -.7], [-1.25, .7], [1.25, .7], [0, 0]]) {
    for (let beam = -1; beam <= 1; beam++) {                // mid + snare: misconvergence snap
      const ox = beam * (m * .17 + snare * .06), oy = -beam * (m * .12 + snare * .04);
      path(ctx, [[cx - .13 + ox, cy + oy], [cx + .13 + ox, cy + oy]], null, color(hue + beam * .12, 62, 88, beam ? .9 : 1), .01);
      path(ctx, [[cx + ox, cy - .13 + oy], [cx + ox, cy + .13 + oy]], null, color(hue + beam * .12, 62, 88, beam ? .9 : 1), .01);
    }
  }
  for (const side of [-1, 1]) {                             // resolution wedges
    const n = 6 + Math.floor(h * 22 + hat * 6);             // high + hat: wedge subdivision
    for (let i = 0; i < n; i++) {
      const y0 = side * .78, y1 = side * .98;
      const x = -.6 + i * (.5 / Math.max(1, n - 1));
      const shimmer = .25 + .75 * (i % 2 ? 1 : Math.min(1, h + hat * .5) * hash(i, Math.floor(t * 16))); // high + hat: shimmer
      path(ctx, [[x, y0], [x - side * .08, y1]], null, gray(shimmer), .012);
      path(ctx, [[-x, y0], [-x + side * .08, y1]], null, gray(shimmer), .012);
      if (h > .01 || hat > .01) circle(ctx, x, y1 - side * .04, .01 + Math.min(1, h + hat * .5) * .035, gray(.98, Math.min(1, h + hat * .5))); // needle markers
    }
  }
  for (const side of [-1, 1]) for (let i = 0; i < 5; i++) { // side castellations, swapped by highs
    ctx.fillStyle = gray(.2 + .6 * ((i + Math.floor(h * 3)) % 2));
    ctx.fillRect(side * 1.75 - .06, -.6 + i * .24, .12, .12);
  }
  if (h > .01 || hat > .01) for (let i = -4; i <= 4; i++) { // high + hat: axis tick marks
    const tick = Math.min(1, h + hat * .5);
    path(ctx, [[i * .12, -.035 - tick * .03], [i * .12, .035 + tick * .03]], null, gray(.95, tick * .9), .008);
    path(ctx, [[-.035 - tick * .03, i * .12], [.035 + tick * .03, i * .12]], null, gray(.95, tick * .9), .008);
  }
  ctx.restore();
});

// Audience blinder / ACL-bar lamp matrix. Bass swells lamp radius and glow,
// mids re-route the chase pattern across the cells, highs twinkle individual
// filaments. Kicks flash the lamps, snares snap the chase routing, hats burst
// the twinkle, the detected beat swells the whole matrix. Grayscale-on-black.
const blinderMatrix = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, beat, detail }) => {
  const cols = Math.max(4, Math.min(12, Math.round(4 + detail * 4)));
  const rowsN = Math.max(3, Math.min(8, Math.round(3 + detail * 2.5)));
  const cw = 3 / cols, ch = 1.9 / rowsN;
  for (let y = 0; y < rowsN; y++) for (let x = 0; x < cols; x++) {
    const cx = -1.5 + (x + .5) * cw, cy = -.95 + (y + .5) * ch;
    const lane = x * .31 + y * (0.17 + m * .8 + snare * .22); // mid + snare: chase geometry snap
    const on = ((t * .8 + lane) % 1 + 1) % 1 < .3 + m * .25;
    const r = Math.min(cw, ch) * .3 * (1 + b * .5 + kick * .28 + beat * .08); // bass + kick + beat: lamp swell/flash
    circle(ctx, cx, cy, r * 1.5, gray(.16 + kick * .1));
    circle(ctx, cx, cy, r, on ? gray(Math.min(1, .55 + b * .3 + kick * .2)) : gray(.22));
    if (on) circle(ctx, cx, cy, r * .65, gray(1));
    if (h > .01 || hat > .01) {
      const tw = hash(x * 13 + y * 7, Math.floor(t * 12));   // high + hat: twinkle
      const sparkle = Math.min(1, h + hat * .6);
      if (tw > .35) circle(ctx, cx, cy, r * (.4 + sparkle * .9), gray(1, (tw - .35) * 1.6 * sparkle));
      circle(ctx, cx - r * .3, cy - r * .3, .016 + sparkle * .05, gray(1, sparkle)); // filament glint
      const oa = t * 2 + x + y * 2;                          // orbiting chase sparkle
      circle(ctx, cx + Math.cos(oa) * r * 1.35, cy + Math.sin(oa) * r * 1.35, .012 + sparkle * .045, gray(1, sparkle * .95));
    }
  }
}, { background: '#000' });

export const GRAPHIC_PATTERNS = [
  expansionEntry({ id: 'test-card', name: 'Test Card', group: 'Basics', factory: testCard, params: expansionParams('Grid Density'), description: 'PM5544-style calibration card: bass breathes the center circle and grid scale, mids split convergence crosses into misregistered beams, highs subdivide and shimmer the resolution wedges; kicks punch the breathing, snares snap the misconvergence, hats burst the shimmer.' }),
  expansionEntry({ id: 'blinder-matrix', name: 'Blinder Matrix', group: 'Alphas', factory: blinderMatrix, params: expansionParams('Matrix Columns', { hue: false, accents: true }), description: 'Audience blinder/ACL lamp matrix: bass swells lamp radius and glow, mids re-route the chase pattern across cells, highs twinkle individual filaments; kicks flash the lamps, snares snap the chase, hats burst the twinkle.' }),
];
