// Purpose-built vector scenes: mechanisms, laser paths, print artifacts and masks.
import { canvasFactory, circle, color, entry, path, TAU } from './runtime.js';

const counterweight = canvasFactory((ctx, { t, b, m, h, hue }) => {
  // Five double pendulums, not an amplitude bar chart. Bass changes lever arms,
  // mid articulates the lower joints; treble opens the counterweight jaws.
  for (let i = 0; i < 5; i++) {
    const x = (i - 2) * .55, a = Math.sin(t + i * .72) * .12 + (i % 2 ? -1 : 1) * b * 1.65;
    const len = .47 + b * .3, joint = [x + Math.sin(a) * len, -.65 + Math.cos(a) * len];
    const a2 = -a + m * 2.5 * Math.sin(i * 1.2 + .5 + t * .7);
    const end = [joint[0] + Math.sin(a2) * .45, joint[1] + Math.cos(a2) * .45];
    path(ctx, [[x, -.8], [x, -.65], joint, end], null, color(hue, 70, 20), .035);
    circle(ctx, ...joint, .065 + b * .03, color(hue + .08));
    circle(ctx, x, -.8, .035, '#fff');
    for (const side of [-1, 1]) {
      ctx.save(); ctx.translate(...end); ctx.rotate(side * (.12 + h * 2.2));
      path(ctx, [[0, -.08], [side * .13, -.08], [side * (.17 + h * .1), .19 + h * .24], [0, .19 + h * .24]], color(hue + i * .06), '#0a1020');
      ctx.restore();
    }
  }
});

const ratchet = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const teeth = Math.round(12 * detail), radius = .40 + b * .4;
  ctx.save(); ctx.rotate(t * .45 + m * 2.8);
  const points = [];
  for (let i = 0; i < teeth * 4; i++) {
    const a = i / (teeth * 4) * TAU, r = radius + (i % 4 < 2 ? .12 + h * .3 : 0);
    points.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  path(ctx, points, color(hue + .06, 48), color(hue, 80), .025);
  circle(ctx, 0, 0, radius * .7, '#050811', color(hue, 40));
  for (let i = 0; i < 6; i++) {
    const a = i * TAU / 6;
    path(ctx, [[Math.cos(a) * .13, Math.sin(a) * .13], [Math.cos(a) * radius * .64, Math.sin(a) * radius * .64]], null, color(hue, 78), .07);
  }
  circle(ctx, 0, 0, .14, color(hue + .5)); ctx.restore();
  // A visible escapement pawl and reciprocal striker make a coherent machine.
  for (const side of [-1, 1]) {
    const x = side * (1.3 - b * .36);
    path(ctx, [[x, -.6], [x - side * (.28 + m * .4), -.13], [x, .08]], color(hue + .5, 70), '#fff');
    path(ctx, [[x, .25], [x, .75]], null, color(hue, 45), .04);
    ctx.fillStyle = color(hue + .5); ctx.fillRect(x - .12, .24 + h * .38, .24, .2);
  }
});

const vectorKnot = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  const pts = [];
  for (let i = 0; i <= 420; i++) {
    const a = i / 420 * TAU, r = .58 + (.1 + b * .5) * Math.cos(3 * a + t);
    const x = r * Math.cos(2 * a), y = r * Math.sin(2 * a), z = (.14 + m * .72) * Math.sin(3 * a + t);
    const tilt = .6 + m * 1.65, py = y * Math.cos(tilt) - z * Math.sin(tilt);
    const depth = 2.8 + y * Math.sin(tilt) + z * Math.cos(tilt);
    pts.push([x * 3 / depth * 1.45, py * 3 / depth * 1.45]);
  }
  // Three parallel laser tracks, with treble changing their physical separation.
  for (const offset of [-1, 0, 1]) {
    const track = pts.map(([x, y], i) => {
      const next = pts[(i + 1) % pts.length], prev = pts[(i + pts.length - 1) % pts.length];
      const dx = next[0] - prev[0], dy = next[1] - prev[1], len = Math.max(.0001, Math.hypot(dx, dy));
      const spread = offset * (.008 + h * (.18 + .06 * Math.sin(i * .12 - t * 3)));
      return [x - dy / len * spread, y + dx / len * spread];
    });
    path(ctx, track, null, color(hue + offset * .18, 25), .055 * detail);
    path(ctx, track, null, color(hue + offset * .18, 76), .013 * detail);
  }
});

const prismScanner = canvasFactory((ctx, { t, b, m, h, hue }) => {
  const triangle = [[-.6, .62], [.0, -.65], [.65, .62], [-.6, .62]];
  path(ctx, triangle, color(hue, 9, 35), color(hue, 70), .025);
  const launch = [-1.65, -.5 + Math.sin(t) * .08 + b * 1.05];
  const strike = [-.4 + m * .9, -.15 + b * .45];
  path(ctx, [launch, strike], null, '#eaffff', .025);
  for (let i = 0; i < 9; i++) {
    const angle = -.9 - h * .8 + i * (.1 + h * .27) + m * .7;
    const end = [1.65, strike[1] + Math.sin(angle) * 1.4];
    path(ctx, [strike, [.52, .4 - b * .45], end], null, color(hue + i * .055, 24), .065);
    path(ctx, [strike, [.52, .4 - b * .45], end], null, color(hue + i * .055, 72), .014);
  }
  circle(ctx, ...strike, .055, '#fff');
});

const riso = canvasFactory((ctx, { t, b, m, h, hue }) => {
  ctx.fillStyle = '#eee9d9'; ctx.fillRect(-4, -1, 8, 2);
  // Screen-print separations of a typographic cutout: registration, skew, tears.
  ctx.globalCompositeOperation = 'multiply';
  for (let plate = 0; plate < 3; plate++) {
    ctx.save(); ctx.translate((plate - 1) * (.025 + b * .65), Math.sin(t + plate) * .02);
    ctx.transform(1, 0, (plate - 1) * m * 1.1, 1, 0, 0);
    const ink = color(hue + plate / 3, 52, 95);
    for (let strip = 0; strip < 12; strip++) {
      ctx.save(); ctx.beginPath(); ctx.rect(-2, -.9 + strip * .15, 4, .145 - h * .105); ctx.clip();
      ctx.translate(Math.sin(strip * 9 + plate + t * 2) * h * .48, 0);
      path(ctx, [[-1.05, .75], [-.58, -.75], [-.18, -.75], [.3, .75], [-.07, .75], [-.2, .3], [-.61, .3], [-.73, .75]], ink);
      path(ctx, [[.35, -.75], [1.05, -.75], [1.05, -.4], [.69, -.4], [.69, .75], [.35, .75]], ink);
      ctx.restore();
    }
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
});

const barnDoors = canvasFactory((ctx, { t, b, m, h, detail, hue }) => {
  ctx.fillStyle = '#000'; ctx.fillRect(-4, -1, 8, 2);
  ctx.save(); ctx.rotate(m * 1.8 + Math.sin(t * .4) * .025);
  ctx.translate(m * .4, 0);
  const x = .22 + b * .95, y = .68;
  ctx.fillStyle = color(hue, 78, 35);
  // Highs articulate FIVE separate shutters, not another global scale axis.
  for (let i = 0; i < 5; i++) {
    const row = 2 * y / 5, shift = (i % 2 ? -1 : 1) * h * .32;
    ctx.fillRect(-x * detail + shift, -y + i * row + h * .075, 2 * x * detail, row - h * .15);
  }
  // Hard-edged framing tool: bass width, mid hinge, high louver separation.
  ctx.restore();
});

const iris = canvasFactory((ctx, { t, b, m, h, detail }) => {
  ctx.fillStyle = '#000'; ctx.fillRect(-4, -1, 8, 2);
  const blades = Math.round(6 + detail * 2), opening = .35 + b * .48;
  ctx.save(); ctx.rotate(t * .12 + m * 2.1);
  ctx.scale(1 + m * .65, 1 - m * .5);
  const points = Array.from({ length: blades }, (_, i) => {
    const a = i * TAU / blades, r = opening * (i % 2 ? 1 : 1 + h * .8);
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  path(ctx, points, '#fff');
  // Blade seams are finite soft-gray wedges, not transparency painted into RGBA.
  for (let i = 0; i < blades; i++) {
    const a = i * TAU / blades;
    const p = points[i], q = [Math.cos(a + .3) * (opening + .18), Math.sin(a + .3) * (opening + .18)];
    path(ctx, [p, q, points[(i + 1) % blades]], '#777');
  }
  // Treble perforates the center as well as unfolding tips: not a second zoom.
  if (h > 0) circle(ctx, 0, 0, opening * Math.min(.85, h * 1.5), '#000');
  ctx.restore();
});

export const GRAPHIC_PATTERNS = [
  entry('counterweight', 'Counterweight', 'Simple', 'Coupled hanging levers: bass swings the arms, mids articulate joints, highs open the jaws.', counterweight, null),
  entry('ratchet-wheel', 'Ratchet Wheel', 'Rhythmic', 'Mechanical escapement: bass expands the gear, mids advance the ratchet, highs extend teeth and strikers.', ratchet, 'Tooth Count'),
  entry('vector-knot', 'Vector Knot', 'Neon / Lasers', 'Laser torus knot: bass changes knot lobes, mids tilt depth, highs separate the three beam tracks.', vectorKnot, 'Beam Width'),
  entry('prism-scanner', 'Prism Scanner', 'Neon / Lasers', 'Prismatic scanner: bass moves the incident beam, mids move its strike point, highs fan the refracted paths.', prismScanner, null),
  entry('riso-misprint', 'Riso Misprint', 'Glitch / Effects', 'Three subtractive print plates: bass misregisters, mids shear, highs tear out horizontal strips.', riso, null),
  entry('barn-doors', 'Barn Doors', 'Basics', 'Stage shutter aperture: bass opens width, mids rotate the doors, highs separate five sliding louvers.', barnDoors, 'Aperture Aspect'),
  entry('iris-diaphragm', 'Iris Diaphragm', 'Alphas', 'Grayscale mechanical matte: bass opens the iris, mids rotate blades, highs perforate the core and unfold pointed blades.', iris, 'Blade Count'),
];
