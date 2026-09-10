// Expansion vector scenes: oscilloscope, kinetic sculpture, sequencer, stutter
// buffer, laser galvo, neon tubing, broadcast scopes and stage-light mattes.
// Every scene documents its structural band split: bass moves/scales the major
// mass, mids deform geometry, highs restructure the fine accents.
import { TAU, canvasFactory, circle, color, expansionEntry, expansionParams, gray, hash, path } from './runtime.js';

// Lissajous / vectorscan scope (oscilloscope-music VJing). Bass swells and
// drifts the whole figure, mids morph the X/Y frequency ratio, highs reseed
// the phosphor sparkles and phase-dither the trace.
const lissajousScope = canvasFactory((ctx, { t, b, m, h, detail, hue, aspect }) => {
  ctx.lineWidth = .004;
  ctx.strokeStyle = color(hue + .5, 45, 30, .5);
  for (let i = -3; i <= 3; i++) {
    path(ctx, [[i * .3, -.95], [i * .3, .95]], null, color(hue + .5, 45, 30, .28), .004);
    path(ctx, [[-aspect * .8, i * .3], [aspect * .8, i * .3]], null, color(hue + .5, 45, 30, .28), .004);
  }
  const amp = .58 + b * .5;                       // bass: major scale swell
  const drift = b * .5 * Math.sin(t * .7);        // bass: whole-figure movement
  const fy = 2 + m * 2.6;                         // mid: ratio morph (geometry)
  const spin = t * .8;
  const n = Math.max(160, Math.min(720, Math.round(300 * detail)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = i / n * TAU;
    const dither = h * .06 * Math.sin(a * 23 + t * 7); // high: fine phase dither
    pts.push([
      drift + amp * Math.min(aspect, 1.6) * .62 * Math.sin(3 * a + spin + dither),
      amp * .86 * Math.sin(fy * a + dither),
    ]);
  }
  path(ctx, pts, null, color(hue, 60, 90, .22), .05);   // phosphor halo
  path(ctx, pts, null, color(hue, 78, 95), .008);       // bright trace
  if (h > .01) {                                         // high: ghost trace echo
    path(ctx, pts.map(([x, y], i) => [x + h * .13 * Math.sin(i * .5), y + h * .13 * Math.cos(i * .5)]), null, color(hue + .5, 75, 100, h), .012);
  }
  const dots = 44;
  for (let i = 0; i < dots; i++) {                       // high: re-seeded sparkles
    const a = (i / dots + hash(i, 7) * .02) * TAU;
    const x = drift + amp * Math.min(aspect, 1.6) * .62 * Math.sin(3 * a + spin);
    const y = amp * .86 * Math.sin(fy * a);
    circle(ctx, x, y, .01 + h * .07 * hash(i, 3), color(hue + .12, 88, 100, .3 + h * .7));
  }
});

// Pendulum-wave kinetic sculpture (Harvard demo / festival art car). Bass sets
// swing amplitude, mids spread the per-pendulum frequencies (dephase), highs
// light bob glints and swing-arc ticks.
const pendulumWave = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const n = Math.max(9, Math.min(19, Math.round(9 + detail * 5)));
  const railY = -.78;
  path(ctx, [[-1.25, railY], [1.25, railY]], null, color(hue, 40, 40), .03);
  const amplitude = .24 + b * .9;                 // bass: major swing amplitude
  const spread = .3 + m * 2.6;                    // mid: frequency spread (dephase)
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? .5 : i / (n - 1);
    const x = -1.1 + 2.2 * f;
    const len = (.48 + .34 * f) * (1 + b * .25);  // bass: string stretch
    const omega = 2.1 * (1 + spread * (1 - f) * .5);
    const theta = amplitude * Math.sin(t * omega + f * spread * 2.2);
    const bob = [x + Math.sin(theta) * len, railY + Math.cos(theta) * len];
    path(ctx, [[x, railY], bob], null, color(hue + f * .15, 58, 65, .9), .016);
    if (h > .01) {                                // high: swing-arc accent ticks
      const tickA = Math.sign(Math.cos(t * omega + f * spread * 2.2)) || 1;
      const tip = [x + Math.sin(theta + tickA * (.08 + h * .5)) * len, railY + Math.cos(theta + tickA * (.08 + h * .5)) * len];
      path(ctx, [bob, tip], null, color(hue + .5, 82, 98, h), .014);
      circle(ctx, ...bob, .09 + h * .07, color(hue + f * .15, 70, 90, h * .6)); // bob halo
      for (let sdot = 1; sdot <= 3; sdot++) {     // high: string sparkle beads
        const sf = sdot / 4;
        circle(ctx, x + (bob[0] - x) * sf, railY + (bob[1] - railY) * sf, .006 + h * .024, color(hue + .55, 85, 100, h * .9));
      }
    }
    circle(ctx, ...bob, .06 + b * .03, color(hue + f * .15, 64, 88));
    circle(ctx, bob[0] - .016, bob[1] - .02, .013 + h * .022, color(0, 100, 0, .3 + h * .7)); // glint
    circle(ctx, x, railY, .012, gray(.9));
  }
});

// TR-808-style 16-step grid. Bass pumps kick-row cell mass, mids rotate the
// snare pattern and shear the rows, highs subdivide the hat row into fine
// ticks and light grid-vertex accents.
const stepSequencer = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const steps = Math.max(8, Math.min(32, Math.round(8 + detail * 8)));
  const w = 1.9 / steps, rows = [-.48, 0, .48];
  const playX = -1 + 2 * ((t * .5) % 1);
  const shear = m * .12;                          // mid: row shear (geometry)
  ctx.save(); ctx.transform(1, 0, shear, 1, 0, 0);
  for (let r = 0; r < 3; r++) {
    const y = rows[r];
    const rowH = .3 * (r === 0 ? 1 + b * .9 : 1);  // bass: kick row mass
    const offset = Math.floor(m * 8);              // mid: pattern rotation
    if (r === 0 && b > .01) {                      // bass: row-wide punch glow
      ctx.fillStyle = color(hue, 45, 80, b * .3);
      ctx.fillRect(-1, y - rowH * .8, 2, rowH * 1.6);
    }
    for (let i = 0; i < steps; i++) {
      const x = -1 + i * w;
      const on = r === 0 ? hash(i, 11) < .45 : r === 1 ? hash(i + offset, 23) < .3 + m * .3 : hash(i, 37) < .8;
      const hot = Math.abs(playX - (x + w / 2)) < w * .55;
      if (r === 2) {
        // high: hat row subdivides into fine 32nd ticks
        const sub = 1 + Math.floor(h * 3.2);
        for (let s = 0; s < sub; s++) {
          if (!on) continue;
          const tx = x + s * (w / sub);
          ctx.fillStyle = color(hue + .08, hot ? 85 : 55, 85, on ? .35 + h * .65 : .12);
          ctx.fillRect(tx + .006, y - rowH / 2, w / sub - .012, rowH * (.6 + h * .7));
        }
      } else {
        const grow = r === 0 ? b * .55 : 0;        // bass: kick cell punch
        const cw = w * (.68 + grow), ch = rowH * (.68 + grow * .5);
        ctx.fillStyle = on ? color(hue + r * .1, hot ? 80 : 52, 80) : color(hue, 18, 40, .55);
        ctx.fillRect(x + w / 2 - cw / 2, y - ch / 2, cw, ch);
      }
      if (h > .01) circle(ctx, x, y + rowH * .72, .008 + h * .03, color(hue + .5, 75, 90, h * .9)); // vertex accents
    }
  }
  ctx.restore();
  path(ctx, [[playX, -.85], [playX, .85]], null, color(hue + .55, 85, 95, .35 + b * .5), .012);
});

// Beat-repeat / stutter-edit buffer (iZotope Stutter Edit, Ableton Beat
// Repeat). Bass lengthens the looped repeat region and pumps the ring, mids
// scatter slice order and squash the ring, highs click the slice boundaries
// and reseed grain accents around the buffer.
const stutterBuffer = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const slices = Math.max(12, Math.min(40, Math.round(10 + detail * 14)));
  const playhead = t * 2.4;
  const r0 = .48 * (1 + b * .45), r1 = .88 * (1 + b * .25); // bass: ring pump
  const repeat = 1 + Math.floor(b * (slices / 3));         // bass: repeat length
  const headSlice = Math.floor(playhead / TAU * slices) % slices;
  ctx.save(); ctx.transform(1 + m * .22, 0, 0, 1 - m * .26, 0, 0); // mid: squash
  for (let i = 0; i < slices; i++) {
    const inRepeat = ((i - headSlice + slices) % slices) < repeat;
    const scatter = m * .8 * Math.sin(i * 3.7 + t * 2);    // mid: slice scatter
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
    if (h > .01) {                                         // high: boundary clicks + grain
      path(ctx, [[Math.cos(a0) * (r0 - .04), Math.sin(a0) * (r0 - .04)], [Math.cos(a0) * (r1 + .03 + h * .2), Math.sin(a0) * (r1 + .03 + h * .2)]], null, color(hue + .5, 82, 98, h * .95), .012);
      for (let g = 0; g < 4; g++) {
        const aa = a0 + hash(i * 4 + g, 9) * (a1 - a0);
        circle(ctx, Math.cos(aa) * (r1 + .05 + h * .22), Math.sin(aa) * (r1 + .05 + h * .22), .008 + h * .045, color(hue + .45, 88, 100, h));
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
const galvoSweep = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const beams = Math.max(4, Math.min(16, Math.round(4 + detail * 6)));
  const origin = [0, .92];
  const fan = .3 + b * .75;                                // bass: sweep amplitude
  // haze cone behind the beams
  path(ctx, [origin, [-1.7 * fan, -.95], [1.7 * fan, -.95]], color(hue, 42, 75, .07 + b * .1), null);
  for (let i = 0; i < beams; i++) {
    const f = beams === 1 ? .5 : i / (beams - 1);
    const angle = -fan + 2 * fan * f + m * .55 * Math.sin(t * 2 + i * 1.7); // mid: scan warp
    const tip = [
      Math.sin(angle) * 2.1 + m * .5 * Math.sin(t * 1.3 + i * 2.1),
      origin[1] - Math.cos(angle) * 1.9 + m * .3 * Math.cos(t * .9 + i * 1.3),
    ];
    const flicker = .3 + .7 * h * hash(i, Math.floor(t * 24));              // high: hard flicker
    path(ctx, [origin, tip], null, color(hue + f * .25, 55, 95, .2 * flicker + .08), .05);
    path(ctx, [origin, tip], null, color(hue + f * .25, 82, 100, .55 * flicker + .3), .009);
    if (h > .01) {
      circle(ctx, ...tip, .012 + h * .08 * hash(i, 4), color(hue + .5, 88, 100, h * .95));
      for (let d = 1; d <= 5; d++) {                                        // high: scan dots along beams
        const df = d / 6;
        circle(ctx, origin[0] + (tip[0] - origin[0]) * df, origin[1] + (tip[1] - origin[1]) * df, .006 + h * .028, color(hue + f * .25 + .1, 88, 100, h * .8));
      }
    }
  }
  ctx.fillStyle = color(hue, 25, 30);
  ctx.fillRect(origin[0] - .09, origin[1] - .06, .18, .12);
  circle(ctx, origin[0], origin[1] - .02, .02 + b * .012, color(hue + .5, 85, 95));
});

// Neon sign tubing with a buzzing transformer. Bass swells the glow halo and
// wall wash, mids morph the tube path between two sign outlines, highs buzz
// per-segment brightness and drop occasional segments.
const neonSign = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
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
  const morph = .5 - .5 * Math.cos(m * Math.PI);           // mid: outline morph
  const pts = A.map(([x, y], i) => [x + (B[i][0] - x) * morph, y + (B[i][1] - y) * morph]);
  circle(ctx, 0, 0, .85 + b * .5, color(hue, 35, 80, .05 + b * .1)); // bass: wall wash
  const segments = 18;
  for (let s = 0; s < segments; s++) {
    const seg = pts.slice(Math.floor(s * (k - 1) / segments), Math.floor((s + 1) * (k - 1) / segments) + 1);
    if (seg.length < 2) continue;
    const buzz = .55 + .45 * h * hash(s, Math.floor(t * 30));        // high: buzz
    if (h > .01 && hash(s * 1.7, Math.floor(t * 22) + 99) < h * .1) continue; // dropout
    path(ctx, seg, null, color(hue, 60, 95, .2 * (1 + b * .9) * buzz), .12 * (1 + b * .7));
    path(ctx, seg, null, color(hue, 75, 100, .55 * buzz), .036 * (1 + b * .35));
    path(ctx, seg, null, color(0, 100, 0, .95 * buzz), .011);
  }
  if (h > .01) {
    // high: bright scan spark racing along the tube + vertex sparks
    const scan = Math.floor(t * 24) % k;
    for (let i = 0; i < Math.max(2, Math.round(h * 8)); i++) {
      const j = (scan + i) % k;
      circle(ctx, pts[j][0], pts[j][1], .012 + h * .04, color(0, 100, 0, h * .9));
    }
    for (let i = 0; i < k; i += 2) circle(ctx, pts[i][0], pts[i][1], .007 + h * .035, color(hue + .5, 88, 100, .25 + h * .7));
  }
});

// Broadcast waveform monitor (Tektronix-style luma scope). Bass sets trace
// gain, mids morph the monitored signal shape, highs jitter the trace, light
// peak dots and brighten graticule accents.
const waveformMonitor = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const L = -1.25, R = 1.25, T = -.8, B = .8;
  ctx.fillStyle = color(hue, 8, 25); ctx.fillRect(L, T, R - L, B - T);
  for (let g = 0; g <= 4; g++) {                            // graticule (IRE)
    const y = B - g * .4;
    path(ctx, [[L, y], [R, y]], null, g === 0 ? color(hue, 45, 40, .9) : color(hue, 35, 30, .5), g === 2 ? .01 : .005);
    for (let tick = 0; tick <= 10; tick++) if (h > .01) circle(ctx, L + (R - L) * tick / 10, y, .004 + h * .012, color(hue + .5, 65, 80, h * .5));
  }
  const signal = (x, f) => {                                // synthesized video line
    const steps = .5 + .5 * Math.sin(x * 4.1 + f);
    const blocks = hash(Math.floor((x + 1.3) * 5.2), 2);
    const ramp = (x + 1.3) / 2.6 * .8 + .1 * Math.sin(x * 9 + f * 2);
    return { a: ramp * .6 + steps * .25, b: blocks };
  };
  const gain = .42 + b * .85;                               // bass: trace gain
  const fields = Math.max(1, Math.min(4, Math.round(detail * 2)));
  for (let field = 0; field < fields; field++) {
    const pts = [];
    const n = 220;
    for (let i = 0; i <= n; i++) {
      const x = L + (R - L) * i / n;
      const s = signal(x + field * .04, t * .6 + field);
      let v = s.a + (s.b - s.a) * m;                        // mid: signal morph
      v += h * .05 * (hash(i, Math.floor(t * 20) + field) - .5); // high: trace jitter
      pts.push([x, B - v * gain * 1.5]);
    }
    path(ctx, pts, null, color(hue + field * .06, 65, 90, .16), .03);
    path(ctx, pts, null, color(hue + field * .06, 75, 95, .5 + .5 / fields), .006);
    if (h > .01) for (let i = 6; i < n; i += 11) {          // high: peak dots
      const [, y] = pts[i];
      if (y < T + .3) circle(ctx, pts[i][0], y, .006 + h * .02, color(hue + .5, 85, 100, h * .8));
    }
  }
});

// PM5544-style test card. Bass breathes the center circle and grid scale,
// mids split the convergence crosses into misregistered beams, highs subdivide
// and shimmer the resolution wedges.
const testCard = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const cols = Math.max(10, Math.min(26, Math.round(8 + detail * 9)));
  const s = 1 + b * .14;                                    // bass: scale pump
  ctx.save(); ctx.scale(s, s);
  ctx.fillStyle = gray(.14); ctx.fillRect(-2.2, -1, 4.4, 2);
  ctx.lineWidth = .006; ctx.strokeStyle = gray(.4, .8);
  for (let i = -cols; i <= cols; i++) path(ctx, [[i / cols * 1.6, -1], [i / cols * 1.6, 1]], null, gray(.38, .7), .005);
  for (let i = -6; i <= 6; i++) path(ctx, [[-1.6, i / 6], [1.6, i / 6]], null, gray(.38, .7), .005);
  const R = .62 * (1 + b * .3);                             // bass: circle breathing
  circle(ctx, 0, 0, R, gray(.85), gray(.15), .012);
  circle(ctx, 0, 0, R * .55, gray(.2));
  path(ctx, [[-R, 0], [R, 0]], null, gray(.1), .01); path(ctx, [[0, -R], [0, R]], null, gray(.1), .01);
  for (const [cx, cy] of [[-1.25, -.7], [1.25, -.7], [-1.25, .7], [1.25, .7], [0, 0]]) {
    for (let beam = -1; beam <= 1; beam++) {                // mid: misconvergence
      const ox = beam * m * .09, oy = -beam * m * .06;
      path(ctx, [[cx - .11 + ox, cy + oy], [cx + .11 + ox, cy + oy]], null, color(hue + beam * .12, 60, 85, beam ? .8 : 1), .008);
      path(ctx, [[cx + ox, cy - .11 + oy], [cx + ox, cy + .11 + oy]], null, color(hue + beam * .12, 60, 85, beam ? .8 : 1), .008);
    }
  }
  for (const side of [-1, 1]) {                             // resolution wedges
    const n = 4 + Math.floor(h * 9);                        // high: wedge subdivision
    for (let i = 0; i < n; i++) {
      const y0 = side * .86, y1 = side * .98;
      const x = -.5 + i * (.32 / Math.max(1, n - 1));
      const shimmer = .35 + .65 * (i % 2 ? 1 : h * hash(i, Math.floor(t * 16))); // high: shimmer
      path(ctx, [[x, y0], [x - side * .06, y1]], null, gray(shimmer), .005);
      path(ctx, [[-x, y0], [-x + side * .06, y1]], null, gray(shimmer), .005);
    }
  }
  for (const side of [-1, 1]) for (let i = 0; i < 5; i++) { // side castellations
    ctx.fillStyle = gray(.2 + .55 * (i % 2));
    ctx.fillRect(side * 1.75 - .06, -.6 + i * .24, .12, .12);
  }
  ctx.restore();
});

// Rotating gobo wheel in a profile spot (stage-lighting breakup gobos).
// Bass zooms the projected pattern and swells the beam, mids rotate and morph
// spokes into ring dots, highs shimmer the pattern rim and drift dust motes.
// Grayscale-on-black for the Alpha Blend mapper.
const goboWheel = canvasFactory((ctx, { t, b, m, h, detail }) => {
  const spokes = Math.max(5, Math.min(16, Math.round(5 + detail * 6)));
  const scale = .8 + b * .55;                               // bass: gobo zoom
  const rot = t * .5 + m * 2.4;                             // mid: rotation
  ctx.save(); ctx.rotate(rot); ctx.scale(scale, scale);
  const grad = ctx.createRadialGradient(0, 0, .1, 0, 0, 1.05);
  const boost = .55 + b * .4;                               // bass: beam swell
  grad.addColorStop(0, gray(.95 * boost)); grad.addColorStop(.75, gray(.5 * boost)); grad.addColorStop(1, gray(0));
  ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, 1.05, 0, TAU); ctx.fill();
  ctx.fillStyle = gray(0, .92);
  for (let i = 0; i < spokes; i++) {                        // spoke mask (mids thin it)
    ctx.save(); ctx.rotate(i * TAU / spokes);
    ctx.fillRect(-.028 * (1 - m * .7), 0, .056 * (1 - m * .7), 1.05);
    ctx.restore();
  }
  for (const ring of [.38, .68]) for (let i = 0; i < spokes * 2; i++) { // dot mask grows with mids
    const a = i * TAU / (spokes * 2) + ring;
    circle(ctx, Math.cos(a) * ring, Math.sin(a) * ring, .02 + m * .075, gray(0, .9));
  }
  ctx.restore();
  if (h > .01) {
    const rim = 40;                                          // high: rim shimmer
    for (let i = 0; i < rim; i++) {
      const a = i * TAU / rim;
      if (hash(i, Math.floor(t * 14)) > .45 + h * .4) continue;
      const r = (.78 + h * .2) * scale;
      path(ctx, [[Math.cos(a + rot) * r, Math.sin(a + rot) * r], [Math.cos(a + rot) * (r + .05 + h * .1), Math.sin(a + rot) * (r + .05 + h * .1)]], null, gray(.9, h * .7), .006);
    }
    for (let i = 0; i < 10; i++) {                           // high: dust motes
      const a = hash(i, 1) * TAU + t * (.2 + hash(i, 2) * .3);
      circle(ctx, Math.cos(a) * hash(i, 3) * .9, Math.sin(a) * hash(i, 4) * .9, .005 + h * .02, gray(.95, h * .75));
    }
  }
}, { background: '#000' });

// Audience blinder / ACL-bar lamp matrix. Bass swells lamp radius and glow,
// mids re-route the chase pattern across the cells, highs twinkle individual
// filaments. Grayscale-on-black for the Alpha Blend mapper.
const blinderMatrix = canvasFactory((ctx, { t, b, m, h, detail }) => {
  const cols = Math.max(4, Math.min(12, Math.round(4 + detail * 4)));
  const rowsN = Math.max(3, Math.min(8, Math.round(3 + detail * 2.5)));
  const cw = 3 / cols, ch = 1.9 / rowsN;
  for (let y = 0; y < rowsN; y++) for (let x = 0; x < cols; x++) {
    const cx = -1.5 + (x + .5) * cw, cy = -.95 + (y + .5) * ch;
    const lane = x * .31 + y * (0.17 + m * .8);              // mid: chase geometry
    const on = ((t * .8 + lane) % 1 + 1) % 1 < .3 + m * .25;
    const r = Math.min(cw, ch) * .3 * (1 + b * .5);          // bass: lamp swell
    circle(ctx, cx, cy, r * 1.5, gray(.16));
    circle(ctx, cx, cy, r, on ? gray(.55 + b * .3) : gray(.22));
    if (on) circle(ctx, cx, cy, r * .55, gray(.95));
    if (h > .01) {
      const tw = hash(x * 13 + y * 7, Math.floor(t * 12));   // high: twinkle
      if (tw > .55) circle(ctx, cx, cy, r * (.2 + h * .5), gray(1, (tw - .55) * 2 * h));
      circle(ctx, cx - r * .3, cy - r * .3, .008 + h * .025, gray(1, h * .5)); // filament glint
    }
  }
}, { background: '#000' });

export const GRAPHIC_PATTERNS = [
  expansionEntry({ id: 'lissajous-scope', name: 'Lissajous Scope', group: 'Simple', factory: lissajousScope, params: expansionParams('Trace Loops'), description: 'Oscilloscope-music vectorscan: bass swells and drifts the figure, mids morph the X:Y frequency ratio, highs dither the trace and reseed phosphor sparkles.' }),
  expansionEntry({ id: 'pendulum-wave', name: 'Pendulum Wave', group: 'Simple', factory: pendulumWave, params: expansionParams('Pendulum Count'), description: 'Kinetic pendulum-wave sculpture: bass sets swing amplitude, mids spread the per-pendulum frequencies into dephase patterns, highs light glints and swing-arc ticks.' }),
  expansionEntry({ id: 'step-sequencer', name: 'Step Sequencer', group: 'Rhythmic', factory: stepSequencer, params: expansionParams('Step Count'), description: 'TR-808-style step grid: bass pumps kick-row cell mass, mids rotate the snare pattern and shear the rows, highs subdivide hat steps into fine ticks with grid-vertex accents.' }),
  expansionEntry({ id: 'stutter-buffer', name: 'Stutter Buffer', group: 'Rhythmic', factory: stutterBuffer, params: expansionParams('Slice Count'), description: 'Beat-repeat/stutter-edit ring buffer: bass lengthens the looped repeat region and pumps the ring, mids scatter slice order and squash the ring, highs click slice boundaries and reseed grain.' }),
  expansionEntry({ id: 'galvo-sweep', name: 'Galvo Sweep', group: 'Neon / Lasers', factory: galvoSweep, params: expansionParams('Beam Count'), description: 'ILDA galvo-scanned laser fan: bass opens the sweep amplitude, mids warp the scan-pattern geometry, highs flicker beam intensity and spark the endpoints.' }),
  expansionEntry({ id: 'neon-sign', name: 'Neon Sign', group: 'Neon / Lasers', factory: neonSign, params: expansionParams('Tube Detail'), description: 'Buzzing neon tubing: bass swells the glow halo and wall wash, mids morph the tube path between two sign outlines, highs buzz per-segment brightness with occasional dropouts.' }),
  expansionEntry({ id: 'waveform-monitor', name: 'Waveform Monitor', group: 'Basics', factory: waveformMonitor, params: expansionParams('Overlay Fields'), description: 'Broadcast luma scope: bass sets trace gain, mids morph the monitored signal shape, highs jitter the trace, light peak dots and brighten graticule accents.' }),
  expansionEntry({ id: 'test-card', name: 'Test Card', group: 'Basics', factory: testCard, params: expansionParams('Grid Density'), description: 'PM5544-style calibration card: bass breathes the center circle and grid scale, mids split convergence crosses into misregistered beams, highs subdivide and shimmer the resolution wedges.' }),
  expansionEntry({ id: 'gobo-wheel', name: 'Gobo Wheel', group: 'Alphas', factory: goboWheel, params: expansionParams('Spoke Count', { hue: false }), description: 'Rotating stage gobo in a profile spot: bass zooms the projected pattern and swells the beam, mids rotate and morph spokes into ring dots, highs shimmer the rim with drifting dust.' }),
  expansionEntry({ id: 'blinder-matrix', name: 'Blinder Matrix', group: 'Alphas', factory: blinderMatrix, params: expansionParams('Matrix Columns', { hue: false }), description: 'Audience blinder/ACL lamp matrix: bass swells lamp radius and glow, mids re-route the chase pattern across cells, highs twinkle individual filaments.' }),
];
