// Shared helpers for the audio-reactive sketches: band extraction with
// envelope smoothing, layered glow drawing, vignettes and hue math.
// These are the building blocks that give the effects their "produced" look.

// Extract sub/mid/high/energy from a frequency array with band boosts.
export function rawBands(freqs, params) {
  if (!freqs) return { sub: 0, mid: 0, high: 0, energy: 0 };
  const bb = params?.bass ?? 1;
  const mb = params?.mid ?? 1;
  const hb = params?.high ?? 1;
  let sub = 0, mid = 0, high = 0;
  for (let i = 0; i < 4; i++) sub += freqs[i];
  for (let i = 40; i < 150; i++) mid += freqs[i];
  for (let i = 150; i < 500; i++) high += freqs[i];
  sub = (sub / (4 * 255)) * bb;
  mid = (mid / (110 * 255)) * mb;
  high = (high / (350 * 255)) * hb;
  return { sub, mid, high, energy: (sub + mid + high) / 3 };
}

// Envelope-smoothed bands: punchy attack, silky release. This is what makes
// motion feel "tight" to the music instead of jittery. Create once per sketch.
export function makeBands() {
  let s = 0, m = 0, h = 0, e = 0;
  const follow = (cur, target, atk = 0.6, rel = 0.14) =>
    cur + (target - cur) * (target > cur ? atk : rel);
  return (freqs, params) => {
    const raw = rawBands(freqs, params);
    s = follow(s, raw.sub);
    m = follow(m, raw.mid);
    h = follow(h, raw.high);
    e = follow(e, raw.energy);
    return { sub: s, mid: m, high: h, energy: e };
  };
}

// Layered glow dot: wide soft halo + hot core. Additive-friendly.
// Use sparingly (cores, heads) — for hundreds of particles use 2-layer glows.
export function glowCircle(p, x, y, r, hue, sat, bri, alpha = 1) {
  if (r <= 0.5) return;
  p.noStroke();
  p.fill(hue, sat, bri, 16 * alpha);
  p.circle(x, y, r * 6);
  p.fill(hue, sat, bri, 32 * alpha);
  p.circle(x, y, r * 3.2);
  p.fill(hue, sat * 0.5, 100, 90 * alpha);
  p.circle(x, y, r * 1.6);
  p.fill(hue, sat * 0.2, 100, 200 * alpha);
  p.circle(x, y, r * 0.8);
}

// Dark vignette around the edges — instant depth, focuses the eye center-stage.
export function vignette(p, strength = 0.5) {
  const ctx = p.drawingContext;
  const cx = p.width / 2, cy = p.height / 2;
  const g = ctx.createRadialGradient(
    cx, cy, Math.min(cx, cy) * 0.5,
    cx, cy, Math.max(cx, cy) * 1.35
  );
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  p.blendMode(p.BLEND);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, p.width, p.height);
}

// Shortest-path hue lerp (for smooth gradient trails).
export function lerpHue(a, b, t) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}
