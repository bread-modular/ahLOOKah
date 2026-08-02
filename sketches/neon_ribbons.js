// Neon Ribbons — flowing silk ribbons of light with real depth.
// Multi-octave sine flow gives organic movement, each trail carries a hue
// gradient (shifted tail → hot head), width pulses with energy, and glowing
// bloom heads shimmer with the highs. Long-exposure light-painting look.
import { makeBands, glowCircle, lerpHue, vignette } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  let ribbons = [];
  let hueOffset = 0;
  const getBands = makeBands();

  function ensureRibbons(n) {
    while (ribbons.length < n) {
      ribbons.push({
        phase: p.random(1000),
        speed: p.random(0.5, 1.5),
        hue: p.random(360),
        trail: [],
      });
    }
    ribbons.length = Math.min(ribbons.length, n);
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
  };

  p.draw = () => {
    const P = params || {};
    const count = Math.floor(P.ribbons ?? 6);
    const flow = P.flow ?? 1;
    const width = P.width ?? 1;
    const trailLen = Math.floor(P.trail ?? 60);

    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 20);
    p.rect(0, 0, p.width, p.height);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const waves = audio && audio.isStarted ? audio.getWaveforms() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.02);
    const energy = freqs ? b.energy : 0.18 + idle * 0.2;
    const mid = freqs ? b.mid : 0.2;
    const high = freqs ? b.high : idle * 0.3;

    hueOffset = (hueOffset + 0.3 + energy * 2) % 360;
    ensureRibbons(count);

    const wave = waves ? waves.left : null;

    for (let r = 0; r < ribbons.length; r++) {
      const rb = ribbons[r];
      rb.phase += 0.004 * rb.speed * (1 + energy * 2) * flow;
      const wv = wave ? wave[Math.floor((r / ribbons.length) * wave.length)] / 255 : 0;
      // Multi-octave sine flow field — organic, never repeating
      const fx = rb.phase * 0.7;
      const hx = p.width * (0.5
        + 0.32 * p.sin(fx + rb.phase)
        + 0.12 * p.sin(fx * 2.3 + 1.7)
        + 0.06 * p.sin(fx * 4.1 + 4.2));
      const hy = p.height * (0.5
        + 0.3 * p.sin(fx * 1.3 + rb.phase * 2)
        + 0.14 * p.sin(fx * 2.9 + 0.6)
        + wv * 0.2 * (1 + mid * 2));
      rb.trail.push({ x: hx, y: hy });
      if (rb.trail.length > trailLen) rb.trail.shift();

      const hue = (hueOffset + rb.hue) % 360;
      // Trail: hue gradient + width taper, two-pass glow
      for (let i = 1; i < rb.trail.length; i++) {
        const tt = i / rb.trail.length;
        const segHue = lerpHue(hue + 60, hue, tt);
        const a = tt * tt * 200;
        p.stroke(segHue, 85, 95, a * 0.35);
        p.strokeWeight((1 + tt * 5) * width * (1 + energy) * 2.2);
        p.line(rb.trail[i - 1].x, rb.trail[i - 1].y, rb.trail[i].x, rb.trail[i].y);
        p.stroke(segHue, 60, 100, a);
        p.strokeWeight((1 + tt * 5) * width * (1 + energy) * 0.8);
        p.line(rb.trail[i - 1].x, rb.trail[i - 1].y, rb.trail[i].x, rb.trail[i].y);
      }

      // Glowing bloom head
      glowCircle(p, hx, hy, (3 + high * 8) * width, hue, 60, 100, 0.5 + high * 0.5);
    }

    vignette(p, 0.45);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
