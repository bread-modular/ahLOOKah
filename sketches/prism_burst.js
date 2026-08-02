// Prism Burst — rotating god-ray shards from a blooming core.
// Rays fade out in three alpha steps (gradient feel), a counter-rotating
// inner ray set adds mechanical complexity, dust motes orbit in the beams,
// and the layered core bloom swells with every kick. Mainstage sunburst.
import { makeBands, glowCircle, vignette } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  let rotation = 0;
  let hueOffset = 0;
  const getBands = makeBands();
  let dust = [];

  function buildDust() {
    dust = [];
    for (let i = 0; i < 60; i++) {
      dust.push({
        a: p.random(p.TWO_PI),
        r: p.random(0.2, 1),
        s: p.random(0.0005, 0.003),
        size: p.random(0.5, 2),
      });
    }
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    buildDust();
  };

  p.draw = () => {
    const P = params || {};
    const rayCount = Math.floor(P.rays ?? 48);
    const spin = P.spin ?? 1;
    const lengthMul = P.length ?? 1;
    const corePulse = P.core ?? 1;

    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.02);
    const energy = freqs ? b.energy : 0.2 + idle * 0.2;
    const sub = freqs ? b.sub : 0.2 + idle * 0.2;
    const high = freqs ? b.high : idle * 0.3;

    rotation += (0.002 + energy * 0.02) * spin;
    hueOffset = (hueOffset + 0.3 + energy * 2) % 360;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const maxR = p.min(p.width, p.height) * 0.52 * lengthMul;
    const coreR = (14 + sub * 60) * corePulse;

    // Outer rays — 3 fading segments each (gradient falloff)
    const bin = freqs ? freqs.left : null;
    for (let i = 0; i < rayCount; i++) {
      const a = rotation + (i / rayCount) * p.TWO_PI;
      const bi = Math.floor((i / rayCount) * 200) + 2;
      const v = bin ? bin[bi] / 255 : 0.3 + 0.3 * p.sin(t * 0.03 + i);
      const len = coreR + v * maxR * (0.4 + energy);
      const hue = (hueOffset + (i / rayCount) * 120) % 360;
      const w = (p.TWO_PI / rayCount) * 0.5;
      for (let s = 0; s < 3; s++) {
        const t0 = s / 3, t1 = (s + 1) / 3;
        const r0 = coreR + (len - coreR) * t0;
        const r1 = coreR + (len - coreR) * t1;
        const alpha = (1 - t0) * (1 - t0) * (60 + v * 160);
        const wa = w * (1 - t0 * 0.5);
        p.noStroke();
        p.fill(hue, 80, 95, alpha);
        p.triangle(
          cx + p.cos(a - wa) * r0, cy + p.sin(a - wa) * r0,
          cx + p.cos(a + wa) * r0, cy + p.sin(a + wa) * r0,
          cx + p.cos(a) * r1, cy + p.sin(a) * r1
        );
      }
      // Needle highlight on highs
      if (high > 0.2) {
        p.stroke(hue, 30, 100, high * 140);
        p.strokeWeight(0.8);
        p.line(cx + p.cos(a) * coreR, cy + p.sin(a) * coreR, cx + p.cos(a) * len, cy + p.sin(a) * len);
      }
    }

    // Counter-rotating inner rays
    const inner = Math.floor(rayCount / 3);
    for (let i = 0; i < inner; i++) {
      const a = -rotation * 1.6 + (i / inner) * p.TWO_PI;
      const len = coreR * (1.6 + 0.5 * p.sin(t * 0.05 + i));
      p.stroke((hueOffset + 180) % 360, 70, 100, 90 + sub * 100);
      p.strokeWeight(1.2);
      p.line(cx + p.cos(a) * coreR * 0.5, cy + p.sin(a) * coreR * 0.5, cx + p.cos(a) * len, cy + p.sin(a) * len);
    }

    // Layered core bloom
    glowCircle(p, cx, cy, coreR * 0.5, hueOffset, 80, 100, 0.6 + sub * 0.6);

    // Orbiting dust motes caught in the beams
    p.noStroke();
    for (const d of dust) {
      d.a += d.s * (1 + energy * 3);
      const rr = d.r * maxR * (0.5 + 0.5 * p.sin(t * 0.01 + d.r * 9));
      const tw = 0.4 + 0.6 * p.sin(t * 0.07 + d.r * 40);
      p.fill((hueOffset + 200) % 360, 30, 100, (40 + high * 120) * tw);
      p.circle(cx + p.cos(d.a) * rr, cy + p.sin(d.a) * rr, d.size * (1 + high));
    }

    vignette(p, 0.55);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
