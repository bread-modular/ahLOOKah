// Vortex Spiral — a hypnotic spiral galaxy with real depth.
// Dots shrink and dim toward the core (depth falloff), faint lines stitch
// each arm together, a bloom core breathes with the sub, and stardust
// sparkles drift between the arms. Elliptical squash adds a 3D tilt.
import { makeBands, glowCircle, vignette } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  let rotation = 0;
  let hueOffset = 0;
  const getBands = makeBands();

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
  };

  p.draw = () => {
    const P = params || {};
    const arms = Math.floor(P.arms ?? 5);
    const density = Math.floor(P.density ?? 90);
    const twist = P.twist ?? 1;
    const sparkle = P.sparkle ?? 1;

    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 30);
    p.rect(0, 0, p.width, p.height);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.02);
    const energy = freqs ? b.energy : 0.18 + idle * 0.2;
    const sub = freqs ? b.sub : 0.2 + idle * 0.2;
    const mid = freqs ? b.mid : 0.2;
    const high = freqs ? b.high : idle * 0.3;

    rotation += 0.004 + energy * 0.05;
    hueOffset = (hueOffset + 0.3 + energy * 2) % 360;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const maxR = p.min(p.width, p.height) * 0.48 * (1 + sub * 0.25);
    const twistAmt = (2 + mid * 6) * twist;

    // Bloom core breathing with the sub
    glowCircle(p, cx, cy, 12 + sub * 40, hueOffset, 80, 100, 0.5 + sub);

    // Spiral arms with depth falloff + stitching lines
    for (let a = 0; a < arms; a++) {
      const armOff = (a / arms) * p.TWO_PI;
      let px = null, py = null;
      for (let i = 0; i < density; i++) {
        const tt = i / density;
        const ang = rotation + armOff + tt * twistAmt;
        const r = tt * maxR;
        const x = cx + p.cos(ang) * r;
        const y = cy + p.sin(ang) * r * 0.82; // elliptical squash = 3D tilt
        const depth = 0.3 + tt * 0.7; // outer dots are "closer"
        const hue = (hueOffset + tt * 120 + a * 20) % 360;
        const size = (1 + tt * 4) * (1 + energy * 0.8);
        p.noStroke();
        p.fill(hue, 80, 95, 50 + depth * 150);
        p.circle(x, y, size * 2.2);
        p.fill(hue, 40, 100, 110 + depth * 130);
        p.circle(x, y, size);
        if (px !== null) {
          p.stroke(hue, 70, 80, 24 + depth * 40);
          p.strokeWeight(0.7);
          p.line(px, py, x, y);
        }
        px = x; py = y;
      }
    }

    // Stardust sparkles drifting between the arms
    const sparkles = Math.floor(40 * sparkle * (0.4 + high));
    p.noStroke();
    for (let i = 0; i < sparkles; i++) {
      const ang = p.random(p.TWO_PI);
      const r = p.random(maxR);
      const tw = 0.5 + 0.5 * p.sin(t * 0.1 + i);
      p.fill((hueOffset + 180) % 360, 30, 100, (80 + high * 140) * tw);
      p.circle(
        cx + p.cos(ang + rotation * 0.5) * r,
        cy + p.sin(ang + rotation * 0.5) * r * 0.82,
        1 + high * 2.5
      );
    }

    vignette(p, 0.5);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
