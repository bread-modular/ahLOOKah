// Purpose-built vector scenes: mechanisms, laser paths, print artifacts and masks.
// Reference-style mappings: sustained bands shape the structure (bass = major
// mass, mids = deformation, highs = fine detail), while gated percussion adds
// distinct transient accents — kick punches the bass-driven mass, snare snaps
// the mid-driven articulation, hats burst the fine high accents.
import { canvasFactory, circle, color, entry, path, TAU } from './runtime.js';

const riso = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, hue }) => {
  ctx.fillStyle = '#eee9d9'; ctx.fillRect(-4, -1, 8, 2);
  // Screen-print separations of a typographic cutout: registration, skew, tears.
  // Kick jumps the registration, snare jolts the shear, hats tear extra strips.
  ctx.globalCompositeOperation = 'multiply';
  for (let plate = 0; plate < 3; plate++) {
    ctx.save(); ctx.translate((plate - 1) * (.025 + b * .65 + kick * .18), Math.sin(t + plate) * .02);
    ctx.transform(1, 0, (plate - 1) * (m * 1.1 + snare * .28), 1, 0, 0);
    const ink = color(hue + plate / 3, 52, 95);
    for (let strip = 0; strip < 12; strip++) {
      ctx.save(); ctx.beginPath(); ctx.rect(-2, -.9 + strip * .15, 4, .145 - h * .105 - hat * .03); ctx.clip();
      ctx.translate(Math.sin(strip * 9 + plate + t * 2) * (h * .48 + hat * .2), 0);
      path(ctx, [[-1.05, .75], [-.58, -.75], [-.18, -.75], [.3, .75], [-.07, .75], [-.2, .3], [-.61, .3], [-.73, .75]], ink);
      path(ctx, [[.35, -.75], [1.05, -.75], [1.05, -.4], [.69, -.4], [.69, .75], [.35, .75]], ink);
      ctx.restore();
    }
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
});

const iris = canvasFactory((ctx, { t, b, m, h, kick, snare, hat, beat, detail }) => {
  ctx.fillStyle = '#000'; ctx.fillRect(-4, -1, 8, 2);
  const blades = Math.round(6 + detail * 2), opening = .35 + b * .48 + kick * .11;
  ctx.save(); ctx.rotate(t * .12 + m * 2.1 + snare * .45);
  ctx.scale((1 + m * .65) * (1 + beat * .04), (1 - m * .5) * (1 + beat * .04));
  const points = Array.from({ length: blades }, (_, i) => {
    const a = i * TAU / blades, r = opening * (i % 2 ? 1 : 1 + h * .8 + hat * .2);
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
  if (h > 0 || hat > 0) circle(ctx, 0, 0, opening * Math.min(.85, h * 1.5 + hat * .35), '#000');
  ctx.restore();
});

export const GRAPHIC_PATTERNS = [
  entry('riso-misprint', 'Riso Misprint', 'Glitch / Effects', 'Three subtractive print plates: bass misregisters, mids shear, highs tear out horizontal strips; kicks jump registration, snares jolt the shear, hats rip extra tears.', riso, null),
  entry('iris-diaphragm', 'Iris Diaphragm', 'Alphas', 'Grayscale mechanical matte: bass opens the iris, mids rotate blades, highs perforate the core; kicks punch the aperture, snares snap the blades, hats flicker the perforation.', iris, 'Blade Count'),
];
