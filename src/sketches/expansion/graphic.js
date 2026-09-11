// Expansion vector scenes: oscilloscope, kinetic sculpture, sequencer, stutter
// buffer, laser galvo, neon tubing, broadcast scopes and stage-light mattes.
// Every scene documents its structural band split: bass moves/scales the major
// mass, mids deform geometry, highs restructure the fine accents. Reference-
// style gated percussion adds distinct transient accents on top: kicks punch
// the bass-driven mass, snares snap the mid-driven deformation, hats burst
// the fine treble detail. No fabricated idle beats — silence stays silent.
import { TAU, canvasFactory, circle, color, expansionEntry, expansionParams, gray, hash, path } from './runtime.js';

// Lissajous / vectorscan scope (oscilloscope-music VJing). Bass swells and
// drifts the whole figure, mids morph the X/Y frequency ratio, highs reseed
// the phosphor sparkles and phase-dither the trace. Kick punches the swell,
// snare snaps the ratio, hats burst the sparkles, beat flashes the halo.
const lissajousScope = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, beat, detail, hue, aspect }) => {
  ctx.lineWidth = .004;
  ctx.strokeStyle = color(hue + .5, 45, 30, .5);
  for (let i = -3; i <= 3; i++) {
    path(ctx, [[i * .3, -.95], [i * .3, .95]], null, color(hue + .5, 45, 30, .28), .004);
    path(ctx, [[-aspect * .8, i * .3], [aspect * .8, i * .3]], null, color(hue + .5, 45, 30, .28), .004);
  }
  const amp = .58 + b * .5 + kick * .13;            // bass + kick: major scale swell/punch
  const drift = (b * .5 + kick * .12) * Math.sin(t * .7); // bass: whole-figure movement
  const fy = 2 + m * 2.6 + snare * .7;              // mid + snare: ratio morph snap (geometry)
  const spin = t * .8;
  const n = Math.max(160, Math.min(720, Math.round(300 * detail)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = i / n * TAU;
    const dither = (h + hat * .3) * .06 * Math.sin(a * 23 + t * 7); // high + hat: fine phase dither
    pts.push([
      drift + amp * Math.min(aspect, 1.6) * .62 * Math.sin(3 * a + spin + dither),
      amp * .86 * Math.sin(fy * a + dither),
    ]);
  }
  path(ctx, pts, null, color(hue, 60, 90, .22 + beat * .18), .05);   // phosphor halo (beat flash)
  path(ctx, pts, null, color(hue, 78, 95), .008);       // bright trace
  if (h > .01) {                                         // high: ghost trace echo
    path(ctx, pts.map(([x, y], i) => [x + h * .17 * Math.sin(i * .5), y + h * .17 * Math.cos(i * .5)]), null, color(hue + .5, 78, 100, h), .016);
  }
  const dots = 44;
  for (let i = 0; i < dots; i++) {                       // high + hat: re-seeded sparkles
    const a = (i / dots + hash(i, 7) * .02) * TAU;
    const x = drift + amp * Math.min(aspect, 1.6) * .62 * Math.sin(3 * a + spin);
    const y = amp * .86 * Math.sin(fy * a);
    circle(ctx, x, y, .012 + (h + hat * .6) * .08 * hash(i, 3), color(hue + .12, 88, 100, .3 + Math.min(1, h + hat) * .7));
  }
});

// Pendulum-wave kinetic sculpture (Harvard demo / festival art car). Bass sets
// swing amplitude, mids spread the per-pendulum frequencies (dephase), highs
// light bob glints and swing-arc ticks. Kick punches the swing, snare snaps
// the dephase, hats burst the glints.
const pendulumWave = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, detail, hue }) => {
  const n = Math.max(9, Math.min(19, Math.round(9 + detail * 5)));
  const railY = -.78;
  path(ctx, [[-1.25, railY], [1.25, railY]], null, color(hue, 40, 40), .03);
  if (h > .01) for (let i = 0; i < 12; i++) {       // high: rail glints
    const gx = -1.2 + i * .2;
    path(ctx, [[gx, railY], [gx + .12 + h * .06, railY]], null, color(hue + .5, 85, 95, h * .9), .012);
  }
  const amplitude = .28 + b + kick * .3;            // bass + kick: major swing amplitude/punch
  const spread = .3 + m * 2.6 + snare * .6;         // mid + snare: frequency spread snap (dephase)
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? .5 : i / (n - 1);
    const x = -1.1 + 2.2 * f;
    const len = (.48 + .34 * f) * (1 + b * .25 + kick * .08);  // bass: string stretch
    const omega = 2.1 * (1 + spread * (1 - f) * .5);
    const theta = amplitude * Math.sin(t * omega + f * spread * 2.2);
    const bob = [x + Math.sin(theta) * len, railY + Math.cos(theta) * len];
    path(ctx, [[x, railY], bob], null, color(hue + f * .15, 58, 65, .9), .018);
    if (h > .01 || hat > .01) {                     // high + hat: swing-arc accent ticks
      const sparkle = Math.min(1, h + hat * .6);
      const tickA = Math.sign(Math.cos(t * omega + f * spread * 2.2)) || 1;
      const tip = [x + Math.sin(theta + tickA * (.08 + sparkle * .5)) * len, railY + Math.cos(theta + tickA * (.08 + sparkle * .5)) * len];
      path(ctx, [bob, tip], null, color(hue + .5, 82, 98, sparkle), .014);
      circle(ctx, ...bob, .1 + sparkle * .08 + hat * .04, color(hue + f * .15, 72, 92, sparkle * .75)); // bob halo
      for (let sdot = 1; sdot <= 3; sdot++) {       // high + hat: string sparkle beads
        const sf = sdot / 4;
        circle(ctx, x + (bob[0] - x) * sf, railY + (bob[1] - railY) * sf, .008 + sparkle * .032, color(hue + .55, 88, 100, sparkle));
      }
    }
    circle(ctx, ...bob, .075 + b * .045 + kick * .02, color(hue + f * .15, 64, 88));
    circle(ctx, bob[0] - .016, bob[1] - .02, .013 + (h + hat * .5) * .022, color(0, 100, 0, .3 + Math.min(1, h + hat) * .7)); // glint
    circle(ctx, x, railY, .012, gray(.9));
  }
});

// TR-808-style 16-step grid. Bass pumps kick-row cell mass, mids rotate the
// snare pattern and shear the rows, highs subdivide the hat row into fine
// ticks and light grid-vertex accents. Real kicks flash the kick row, real
// snares rotate/flash the snare row, real hats burst the hat-row ticks, the
// detected beat brightens the playhead.
const stepSequencer = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, beat, detail, hue }) => {
  const steps = Math.max(8, Math.min(32, Math.round(8 + detail * 8)));
  const w = 1.9 / steps, rows = [-.48, 0, .48];
  const playX = -1 + 2 * ((t * .5) % 1);
  const shear = m * .12 + snare * .05;              // mid + snare: row shear (geometry)
  ctx.save(); ctx.transform(1, 0, shear, 1, 0, 0);
  for (let r = 0; r < 3; r++) {
    const y = rows[r];
    const rowH = .3 * (r === 0 ? 1 + b * .9 + kick * .3 : 1);  // bass + kick: kick row mass
    const offset = Math.floor(m * 8 + snare * 2);   // mid + snare: pattern rotation
    if (r === 0 && (b > .01 || kick > .01)) {       // bass + kick: row-wide punch glow
      ctx.fillStyle = color(hue, 45, 80, Math.min(1, b * .3 + kick * .35));
      ctx.fillRect(-1, y - rowH * .8, 2, rowH * 1.6);
    }
    if (r === 1 && snare > .01) {                   // snare: row flash
      ctx.fillStyle = color(hue + .1, 45, 85, snare * .3);
      ctx.fillRect(-1, y - rowH * .8, 2, rowH * 1.6);
    }
    for (let i = 0; i < steps; i++) {
      const x = -1 + i * w;
      const on = r === 0 ? hash(i, 11) < .45 : r === 1 ? hash(i + offset, 23) < .3 + m * .3 : hash(i, 37) < .8;
      const hot = Math.abs(playX - (x + w / 2)) < w * .55;
      if (r === 2) {
        // high + hat: hat row subdivides into fine 32nd ticks
        const sub = 1 + Math.floor(h * 3.2 + hat * 1.4);
        for (let s = 0; s < sub; s++) {
          if (!on) continue;
          const tx = x + s * (w / sub);
          ctx.fillStyle = color(hue + .08, hot ? 85 : 55, 85, on ? Math.min(1, .35 + h * .65 + hat * .4) : .12);
          ctx.fillRect(tx + .006, y - rowH / 2, w / sub - .012, rowH * (.6 + h * .7 + hat * .3));
        }
      } else {
        const grow = r === 0 ? b * .55 + kick * .3 : r === 1 ? snare * .18 : 0; // percussion cell punch
        const cw = w * (.68 + grow), ch = rowH * (.68 + grow * .5);
        ctx.fillStyle = on ? color(hue + r * .1, hot ? 80 : 52, 80) : color(hue, 18, 40, .55);
        ctx.fillRect(x + w / 2 - cw / 2, y - ch / 2, cw, ch);
      }
      if (h > .01 || hat > .01) circle(ctx, x, y + rowH * .72, .008 + (h + hat * .5) * .03, color(hue + .5, 75, 90, Math.min(1, h * .9 + hat * .5))); // vertex accents
    }
  }
  ctx.restore();
  path(ctx, [[playX, -.85], [playX, .85]], null, color(hue + .55, 85, 95, Math.min(1, .35 + b * .5 + beat * .4)), .012);
});

// Beat-repeat / stutter-edit buffer (iZotope Stutter Edit, Ableton Beat
// Repeat). Bass lengthens the looped repeat region and pumps the ring, mids
// scatter slice order and squash the ring, highs click the slice boundaries
// and reseed grain accents around the buffer. Kicks punch the repeat region,
// snares snap the scatter, hats burst the boundary clicks.
const stutterBuffer = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, detail, hue }) => {
  const slices = Math.max(12, Math.min(40, Math.round(10 + detail * 14)));
  const playhead = t * 2.4;
  const r0 = .48 * (1 + b * .45 + kick * .12), r1 = .88 * (1 + b * .25 + kick * .08); // bass + kick: ring pump
  const repeat = 1 + Math.floor(b * (slices / 3) + kick * 2);         // bass + kick: repeat length
  const headSlice = Math.floor(playhead / TAU * slices) % slices;
  ctx.save(); ctx.transform(1 + m * .22, 0, 0, 1 - m * .26, 0, 0); // mid: squash
  for (let i = 0; i < slices; i++) {
    const inRepeat = ((i - headSlice + slices) % slices) < repeat;
    const scatter = (m * .8 + snare * .3) * Math.sin(i * 3.7 + t * 2);    // mid + snare: slice scatter snap
    const a0 = i / slices * TAU + scatter * .12, a1 = (i + 1) / slices * TAU + scatter * .12;
    const amp = .4 + hash(i, 5) * .6;
    const rr = r0 + (r1 - r0) * amp * (inRepeat ? 1 : .5 + m * .35);
    const pts = [[Math.cos(a0) * r0, Math.sin(a0) * r0]];
    for (let k = 1; k <= 3; k++) {
      const a = a0 + (a1 - a0) * k / 3;
      pts.push([Math.cos(a) * (k % 2 ? rr : r0), Math.sin(a) * (k % 2 ? rr : r0)]);
    }
    pts.push([Math.cos(a1) * r0, Math.sin(a1) * r0]);
    path(ctx, pts, inRepeat ? color(hue + .06, 62, 90) : color(hue, 32, 60, .85), color(hue + .5, 60, 80, .5), .005);
    if (inRepeat) for (let e = 1; e <= 2; e++)             // stutter echoes
      path(ctx, pts.map(([x, y]) => {
        const a = Math.atan2(y, x) + e * (a1 - a0) * 1.5, l = Math.hypot(x, y) * (1 + e * .04);
        return [Math.cos(a) * l, Math.sin(a) * l];
      }), null, color(hue + .1, 60, 90, .5 / e), .012);
    if (h > .01 || hat > .01) {                            // high + hat: boundary clicks + grain
      const click = Math.min(1, h * .95 + hat * .55);
      path(ctx, [[Math.cos(a0) * (r0 - .04), Math.sin(a0) * (r0 - .04)], [Math.cos(a0) * (r1 + .03 + click * .2), Math.sin(a0) * (r1 + .03 + click * .2)]], null, color(hue + .5, 82, 98, click), .012);
      for (let g = 0; g < 4; g++) {
        const aa = a0 + hash(i * 4 + g, 9) * (a1 - a0);
        circle(ctx, Math.cos(aa) * (r1 + .05 + click * .22), Math.sin(aa) * (r1 + .05 + click * .22), .008 + click * .045, color(hue + .45, 88, 100, click));
      }
    }
  }
  ctx.restore();
  const na = playhead % TAU;                               // needle
  path(ctx, [[0, 0], [Math.cos(na) * (r1 + .06), Math.sin(na) * (r1 + .06)]], null, color(hue + .55, 85, 95), .01);
  circle(ctx, 0, 0, .05, color(hue, 70, 80));
});

// Galvo-scanned laser fan (ILDA vector scanning, 25-40kpps galvos). Bass opens
// the sweep angle and throws the beams, mids warp the scan pattern (Lissajous
// endpoint offsets), highs flicker beam intensity and spark the endpoints.
// Kicks punch the fan open, snares snap the warp, hats burst the sparks.
const galvoSweep = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, energy, detail, hue }) => {
  const beams = Math.max(4, Math.min(16, Math.round(4 + detail * 6)));
  const origin = [0, .92];
  const fan = .3 + b * .75 + kick * .18;                   // bass + kick: sweep amplitude/punch
  // haze cone behind the beams (energy lifts the room haze)
  path(ctx, [origin, [-1.7 * fan, -.95], [1.7 * fan, -.95]], color(hue, 42, 75, Math.min(1, .07 + b * .1 + energy * .06)), null);
  for (let i = 0; i < beams; i++) {
    const f = beams === 1 ? .5 : i / (beams - 1);
    const angle = -fan + 2 * fan * f + (m * .55 + snare * .2) * Math.sin(t * 2 + i * 1.7); // mid + snare: scan warp snap
    const tip = [
      Math.sin(angle) * 2.1 + m * .5 * Math.sin(t * 1.3 + i * 2.1),
      origin[1] - Math.cos(angle) * 1.9 + m * .3 * Math.cos(t * .9 + i * 1.3),
    ];
    const flicker = .3 + .7 * Math.min(1, h + hat * .5) * hash(i, Math.floor(t * 24));  // high + hat: hard flicker
    path(ctx, [origin, tip], null, color(hue + f * .25, 55, 95, .2 * flicker + .08), .05);
    path(ctx, [origin, tip], null, color(hue + f * .25, 82, 100, .55 * flicker + .3), .009);
    if (h > .01 || hat > .01) {
      const spark = Math.min(1, h + hat * .6);
      circle(ctx, ...tip, .022 + spark * .12 * hash(i, 4), color(hue + .5, 88, 100, spark));
      for (let d = 1; d <= 7; d++) {                     // high + hat: scan dots along beams
        const df = d / 8;
        circle(ctx, origin[0] + (tip[0] - origin[0]) * df, origin[1] + (tip[1] - origin[1]) * df, .012 + spark * .05, color(hue + f * .25 + .1, 90, 100, spark));
      }
    }
  }
  ctx.fillStyle = color(hue, 25, 30);
  ctx.fillRect(origin[0] - .09, origin[1] - .06, .18, .12);
  circle(ctx, origin[0], origin[1] - .02, .02 + b * .012 + kick * .012, color(hue + .5, 85, 95));
});

// Neon sign tubing with a buzzing transformer. Bass swells the glow halo and
// wall wash, mids morph the tube path between two sign outlines, highs buzz
// per-segment brightness and drop occasional segments. Kicks swell the halo,
// snares snap the morph, hats harden the buzz, energy lifts the wall wash.
const neonSign = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, energy, detail, hue }) => {
  const bolt = [[-.28, -.8], [.08, -.8], [-.12, -.18], [.26, -.18], [-.3, .82], [-.04, .12], [-.3, .12], [.18, -.82]];
  const wave = [];
  for (let i = 0; i <= 7; i++) wave.push([-1.05 + i * .3, (i % 2 ? -.45 : .35) * (0.7 + .3 * Math.sin(i))]);
  const k = Math.max(26, Math.min(90, Math.round(26 + detail * 32)));
  const sample = (pts, closed) => {
    const out = [], src = closed ? [...pts, pts[0]] : pts;
    let total = 0; const lens = [];
    for (let i = 0; i < src.length - 1; i++) { const l = Math.hypot(src[i + 1][0] - src[i][0], src[i + 1][1] - src[i][1]); lens.push(l); total += l; }
    for (let s = 0; s < k; s++) {
      let d = total * s / (k - 1);
      let seg = 0; while (seg < lens.length - 1 && d > lens[seg]) { d -= lens[seg]; seg++; }
      const f = lens[seg] ? d / lens[seg] : 0;
      out.push([src[seg][0] + (src[seg + 1][0] - src[seg][0]) * f, src[seg][1] + (src[seg + 1][1] - src[seg][1]) * f]);
    }
    return out;
  };
  const A = sample(bolt, false), B = sample(wave, false);
  const morph = .5 - .5 * Math.cos(Math.min(1.4, m + snare * .3) * Math.PI);   // mid + snare: outline morph snap
  const pts = A.map(([x, y], i) => [x + (B[i][0] - x) * morph, y + (B[i][1] - y) * morph]);
  if (h > .01 || hat > .01) for (let gx = -5; gx <= 5; gx++) for (let gy = -3; gy <= 3; gy++) { // high + hat: wall seam sparks
    if (hash(gx * 7 + gy * 13, Math.floor(t * 18)) > .35 + Math.min(1, h + hat * .5) * .5) continue;
    circle(ctx, gx * .32 + hash(gy, gx) * .1, gy * .3, .014 + Math.min(1, h + hat * .5) * .05, color(hue + .5, 75, 85, Math.min(1, h * .9 + hat * .5)));
  }
  circle(ctx, 0, 0, .95 + b * .55 + kick * .14, color(hue, 38, 80, Math.min(1, .07 + b * .13 + kick * .06 + energy * .04))); // bass + kick + energy: wall wash
  const segments = 18;
  for (let s = 0; s < segments; s++) {
    const seg = pts.slice(Math.floor(s * (k - 1) / segments), Math.floor((s + 1) * (k - 1) / segments) + 1);
    if (seg.length < 2) continue;
    const buzz = 1 - Math.min(1, h + hat * .55) * .85 * hash(s, Math.floor(t * 30));   // high + hat: buzz (tube-wide dim-flicker)
    if ((h > .01 || hat > .01) && hash(s * 1.7, Math.floor(t * 22) + 99) < (h + hat * .5) * .1) continue; // dropout
    path(ctx, seg, null, color(hue, 60, 95, .2 * (1 + b * .9 + kick * .4) * buzz), .12 * (1 + b * .7 + kick * .25));
    path(ctx, seg, null, color(hue, 75, 100, .55 * buzz), .036 * (1 + b * .35 + kick * .15));
    path(ctx, seg, null, color(0, 100, 0, .95 * buzz), .011);
  }
  if (h > .01 || hat > .01) {
    // high + hat: bright scan spark racing along the tube + vertex sparks
    const spark = Math.min(1, h + hat * .6);
    const scan = Math.floor(t * 24) % k;
    for (let i = 0; i < Math.max(2, Math.round(spark * 14)); i++) {
      const j = (scan + i) % k;
      circle(ctx, pts[j][0], pts[j][1], .024 + spark * .07, color(0, 100, 0, spark));
    }
    for (let i = 0; i < k; i += 2) circle(ctx, pts[i][0], pts[i][1], .016 + spark * .06, color(hue + .5, 88, 100, .35 + spark * .65));
  }
});

// Broadcast waveform monitor (Tektronix-style luma scope). Bass sets trace
// gain, mids morph the monitored signal shape, highs jitter the trace, light
// peak dots and brighten graticule accents. Kicks punch the gain, snares snap
// the morph, hats burst the peak dots, beat ticks the graticule.
const waveformMonitor = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, beat, detail, hue }) => {
  const L = -1.25, R = 1.25, T = -.8, B = .8;
  ctx.fillStyle = color(hue, 12 + beat * 4, 30); ctx.fillRect(L, T, R - L, B - T);
  for (let g = 0; g <= 4; g++) {                            // graticule (IRE)
    const y = B - g * .4;
    path(ctx, [[L, y], [R, y]], null, g === 0 ? color(hue, 48, 45, .95) : color(hue, 38, 35, .6 + beat * .3), g === 2 ? .012 : .006);
    for (let tick = 0; tick <= 10; tick++) if (h > .01) circle(ctx, L + (R - L) * tick / 10, y, .006 + h * .02, color(hue + .5, 70, 85, h * .7));
  }
  const signal = (x, f) => {                                // synthesized video line
    const steps = .5 + .5 * Math.sin(x * 4.1 + f);
    const blocks = hash(Math.floor((x + 1.3) * 5.2), 2);
    const ramp = (x + 1.3) / 2.6 * .8 + .1 * Math.sin(x * 9 + f * 2);
    return { a: ramp * .6 + steps * .25, b: blocks };
  };
  const gain = .55 + b * 1.1 + kick * .3;                   // bass + kick: trace gain/punch
  const fields = Math.max(1, Math.min(4, Math.round(detail * 2)));
  for (let field = 0; field < fields; field++) {
    const pts = [];
    const n = 220;
    for (let i = 0; i <= n; i++) {
      const x = L + (R - L) * i / n;
      const s = signal(x + field * .04, t * .6 + field);
      let v = s.a + (s.b - s.a) * Math.min(1, m + snare * .3); // mid + snare: signal morph snap
      v += (h + hat * .5) * .13 * (hash(i, Math.floor(t * 20) + field) - .5); // high + hat: trace jitter
      pts.push([x, B - v * gain * 1.9]);
    }
    path(ctx, pts, null, color(hue + field * .06, 65, 90, .28), .055);
    path(ctx, pts, null, color(hue + field * .06, 78, 98, .6 + .4 / fields), .013);
    if (h > .01 || hat > .01) for (let i = 6; i < n; i += 8) { // high + hat: peak dots
      const [, y] = pts[i];
      if (y < T + .35) circle(ctx, pts[i][0], y, .016 + Math.min(1, h + hat * .6) * .05, color(0, 100, 0, Math.min(1, h + hat * .6)));
    }
  }
  if (h > .01) for (let g = 0; g <= 4; g++) for (let led = 0; led < 4; led++) { // high: IRE marker LEDs
    circle(ctx, L + .04 + led * .07, B - g * .4, .01 + h * .04, color(hue + .5, 80, 95, h * .9));
  }
});

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

// Rotating gobo wheel in a profile spot (stage-lighting breakup gobos).
// Bass zooms the projected pattern and swells the beam, mids rotate and morph
// spokes into ring dots, highs shimmer the pattern rim and drift dust motes.
// Kicks punch the zoom, snares snap the rotation, hats burst the rim shimmer,
// the detected beat swells the beam. Grayscale-on-black for the Alpha Blend.
const goboWheel = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, beat, detail }) => {
  const spokes = Math.max(5, Math.min(16, Math.round(5 + detail * 6)));
  const scale = .8 + b * .55 + kick * .13;                  // bass + kick: gobo zoom/punch
  const rot = t * .5 + m * 2.4 + snare * .45;               // mid + snare: rotation snap
  ctx.save(); ctx.rotate(rot); ctx.scale(scale, scale);
  const grad = ctx.createRadialGradient(0, 0, .1, 0, 0, 1.05);
  const boost = .55 + b * .4 + beat * .12;                  // bass + beat: beam swell
  grad.addColorStop(0, gray(1));                            // white-hot core (full alpha for the matte)
  grad.addColorStop(.42, gray(Math.min(1, .9 * boost + .1)));
  grad.addColorStop(.75, gray(Math.min(1, .5 * boost))); grad.addColorStop(1, gray(0));
  ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, 1.05, 0, TAU); ctx.fill();
  circle(ctx, 0, 0, .34, gray(1));                           // solid white hub
  ctx.fillStyle = gray(0, .92);
  for (let i = 0; i < spokes; i++) {                        // spoke mask (mids thin it)
    ctx.save(); ctx.rotate(i * TAU / spokes);
    ctx.fillRect(-.028 * Math.max(.1, 1 - m * .7), .22, .056 * Math.max(.1, 1 - m * .7), .83); // hub stays white
    ctx.restore();
  }
  for (const ring of [.38, .68]) for (let i = 0; i < spokes * 2; i++) { // dot mask grows with mids
    const a = i * TAU / (spokes * 2) + ring;
    circle(ctx, Math.cos(a) * ring, Math.sin(a) * ring, .02 + m * .075, gray(0, .9));
  }
  ctx.restore();
  if (h > .01 || hat > .01) {
    const shimmer = Math.min(1, h + hat * .55);
    // high + hat: fine rotating shimmer web across the whole spot
    const web = 34;
    for (let i = 0; i < web; i++) {
      const a = i * TAU / web - rot * 1.4;
      const rr = (.3 + .55 * hash(i, 6)) * scale;
      path(ctx, [[Math.cos(a) * rr * .4, Math.sin(a) * rr * .4], [Math.cos(a + .02) * (rr + shimmer * .32 * scale), Math.sin(a + .02) * (rr + shimmer * .32 * scale)]], null, gray(1, shimmer), .019);
    }
    const rim = 72;                                          // high + hat: rim shimmer + shadow notches
    const r = (.74 + shimmer * .22) * scale;
    for (let i = 0; i < rim; i++) {
      const a = i * TAU / rim;
      if (hash(i, Math.floor(t * 14)) > .3 + shimmer * .55) continue;
      const bright = hash(i, 8) > .4;
      path(ctx, [[Math.cos(a + rot) * r, Math.sin(a + rot) * r], [Math.cos(a + rot + .05) * (r + .09 + shimmer * .2), Math.sin(a + rot + .05) * (r + .09 + shimmer * .2)]], null, bright ? gray(.98, shimmer) : gray(0, shimmer * .95), bright ? .014 : .024);
    }
    for (let i = 0; i < 22; i++) {                           // high + hat: dust motes
      const a = hash(i, 1) * TAU + t * (.2 + hash(i, 2) * .3);
      circle(ctx, Math.cos(a) * hash(i, 3) * .95, Math.sin(a) * hash(i, 4) * .95, .014 + shimmer * .055, gray(.97, shimmer * .95));
    }
  }
}, { background: '#000' });

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
  expansionEntry({ id: 'lissajous-scope', name: 'Lissajous Scope', group: 'Simple', factory: lissajousScope, params: expansionParams('Trace Loops'), description: 'Oscilloscope-music vectorscan: bass swells and drifts the figure, mids morph the X:Y frequency ratio, highs dither the trace and reseed phosphor sparkles; kicks punch the swell, snares snap the ratio, hats burst the sparkles.' }),
  expansionEntry({ id: 'pendulum-wave', name: 'Pendulum Wave', group: 'Simple', factory: pendulumWave, params: expansionParams('Pendulum Count'), description: 'Kinetic pendulum-wave sculpture: bass sets swing amplitude, mids spread the per-pendulum frequencies into dephase patterns, highs light glints and swing-arc ticks; kicks punch the swing, snares snap the dephase, hats burst the glints.' }),
  expansionEntry({ id: 'step-sequencer', name: 'Step Sequencer', group: 'Rhythmic', factory: stepSequencer, params: expansionParams('Step Count', { accents: true }), description: 'TR-808-style step grid: bass pumps kick-row cell mass, mids rotate the snare pattern and shear the rows, highs subdivide hat steps into fine ticks; real kicks/snares/hats flash their own rows, the beat brightens the playhead.' }),
  expansionEntry({ id: 'stutter-buffer', name: 'Stutter Buffer', group: 'Rhythmic', factory: stutterBuffer, params: expansionParams('Slice Count', { accents: true }), description: 'Beat-repeat/stutter-edit ring buffer: bass lengthens the looped repeat region and pumps the ring, mids scatter slice order and squash the ring, highs click slice boundaries and reseed grain; kicks punch the repeat region, snares snap the scatter, hats burst the clicks.' }),
  expansionEntry({ id: 'galvo-sweep', name: 'Galvo Sweep', group: 'Neon / Lasers', factory: galvoSweep, params: expansionParams('Beam Count', { accents: true }), description: 'ILDA galvo-scanned laser fan: bass opens the sweep amplitude, mids warp the scan-pattern geometry, highs flicker beam intensity and spark the endpoints; kicks punch the fan open, snares snap the warp, hats burst the endpoint sparks.' }),
  expansionEntry({ id: 'neon-sign', name: 'Neon Sign', group: 'Neon / Lasers', factory: neonSign, params: expansionParams('Tube Detail'), description: 'Buzzing neon tubing: bass swells the glow halo and wall wash, mids morph the tube path between two sign outlines, highs buzz per-segment brightness with dropouts; kicks swell the halo, snares snap the morph, hats harden the buzz.' }),
  expansionEntry({ id: 'waveform-monitor', name: 'Waveform Monitor', group: 'Basics', factory: waveformMonitor, params: expansionParams('Overlay Fields'), description: 'Broadcast luma scope: bass sets trace gain, mids morph the monitored signal shape, highs jitter the trace, light peak dots and brighten graticule accents; kicks punch the gain, snares snap the morph, hats burst the peak dots.' }),
  expansionEntry({ id: 'test-card', name: 'Test Card', group: 'Basics', factory: testCard, params: expansionParams('Grid Density'), description: 'PM5544-style calibration card: bass breathes the center circle and grid scale, mids split convergence crosses into misregistered beams, highs subdivide and shimmer the resolution wedges; kicks punch the breathing, snares snap the misconvergence, hats burst the shimmer.' }),
  expansionEntry({ id: 'gobo-wheel', name: 'Gobo Wheel', group: 'Alphas', factory: goboWheel, params: expansionParams('Spoke Count', { hue: false }), description: 'Rotating stage gobo in a profile spot: bass zooms the projected pattern and swells the beam, mids rotate and morph spokes into ring dots, highs shimmer the rim with drifting dust; kicks punch the zoom, snares snap the rotation, hats burst the rim shimmer.' }),
  expansionEntry({ id: 'blinder-matrix', name: 'Blinder Matrix', group: 'Alphas', factory: blinderMatrix, params: expansionParams('Matrix Columns', { hue: false, accents: true }), description: 'Audience blinder/ACL lamp matrix: bass swells lamp radius and glow, mids re-route the chase pattern across cells, highs twinkle individual filaments; kicks flash the lamps, snares snap the chase, hats burst the twinkle.' }),
];
