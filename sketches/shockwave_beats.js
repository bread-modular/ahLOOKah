// Shockwave Beats — every kick detonates a triple chromatic shockwave.
// Three staggered rings per hit, alpha falling off with radius, screen shake
// on big kicks, and gravity sparks arcing off the blast. Highs dust the air.
import { makeBands, vignette } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  const waves = [];
  const sparks = [];
  let hueOffset = 0;
  let prevSub = 0;
  let shake = 0;
  const getBands = makeBands();

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
  };

  p.draw = () => {
    const P = params || {};
    const threshold = P.threshold ?? 0.3;
    const speed = P.speed ?? 1;
    const chroma = P.chroma ?? 1;
    const maxWaves = Math.floor(P.max ?? 24);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.05);
    const sub = freqs ? b.sub : (idle > 0.85 ? idle * 0.5 : 0.1);
    const high = freqs ? b.high : idle * 0.3;

    hueOffset = (hueOffset + 0.4 + b.energy * 2) % 360;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const maxR = Math.hypot(p.width, p.height) * 0.6;

    // Kick: spawn triple staggered rings + shake + gravity sparks
    if (sub > threshold && sub > prevSub + 0.02 && waves.length < maxWaves) {
      const hue = (hueOffset + p.random(-20, 20) + 360) % 360;
      for (let k = 0; k < 3; k++) {
        waves.push({ r: -k * 14, hue: (hue + k * 24) % 360, power: sub, w: (3 - k) * 3 });
      }
      shake = Math.min(14, sub * 22);
      const n = Math.floor(10 + sub * 30);
      for (let i = 0; i < n; i++) {
        const a = p.random(p.TWO_PI);
        const sp = p.random(2, 9) * (0.5 + sub);
        sparks.push({ x: cx, y: cy, vx: p.cos(a) * sp, vy: p.sin(a) * sp - 1, life: 1, hue });
      }
    }
    prevSub = sub;

    // Screen shake (decays fast)
    p.translate(p.random(-shake, shake), p.random(-shake, shake));
    shake *= 0.85;

    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 26);
    p.rect(-20, -20, p.width + 40, p.height + 40);
    p.blendMode(p.ADD);

    // Shockwave rings with chromatic edges
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      w.r += (3 + w.power * 9) * speed;
      if (w.r < 0) continue;
      const life = 1 - w.r / maxR;
      if (life <= 0) {
        waves.splice(i, 1);
        continue;
      }
      const alpha = life * life * 255;
      for (let cIdx = -1; cIdx <= 1; cIdx++) {
        const rr = w.r + cIdx * chroma * 6 * (1 + w.r * 0.01);
        if (rr <= 0) continue;
        const hue = (w.hue + cIdx * 60 * chroma + 360) % 360;
        p.stroke(hue, 80, 95, alpha * (cIdx === 0 ? 0.9 : 0.4));
        p.strokeWeight(Math.max(0.5, w.w * life * (cIdx === 0 ? 1.6 : 1)));
        p.noFill();
        p.circle(cx, cy, rr * 2);
      }
    }

    // Gravity sparks
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.12;
      s.vx *= 0.99;
      s.life -= 0.02;
      if (s.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      p.noStroke();
      p.fill(s.hue, 60, 100, s.life * 240);
      p.circle(s.x, s.y, 1 + s.life * 3);
    }

    // High-frequency dust in the air
    if (high > 0.3) {
      p.noStroke();
      for (let i = 0; i < high * 12; i++) {
        p.fill((hueOffset + 180) % 360, 40, 100, high * 160);
        p.circle(p.random(p.width), p.random(p.height), p.random(1, 2.5));
      }
    }

    vignette(p, 0.5);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
