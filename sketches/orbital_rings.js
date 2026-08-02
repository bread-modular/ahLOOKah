// Orbital Rings — a 3D gyroscope of glowing light rings.
// Each ring is drawn in three passes (wide halo, mid glow, hot core line)
// with real 3D rotation and perspective. Bass tilts the rig, mids drive the
// spin, highs light up glowing satellites. A bloom core anchors the center.
import { makeBands, glowCircle, vignette } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  let hueOffset = 0;
  let globalSpin = 0;
  const getBands = makeBands();

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
  };

  p.draw = () => {
    const P = params || {};
    const ringCount = Math.floor(P.rings ?? 5);
    const spinSpeed = P.spin ?? 1;
    const tiltAmt = P.tilt ?? 1;
    const sats = P.satellites ?? 1;

    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.018);
    const energy = freqs ? b.energy : 0.18 + idle * 0.2;
    const sub = freqs ? b.sub : 0.2 + idle * 0.2;
    const mid = freqs ? b.mid : 0.2;
    const high = freqs ? b.high : idle * 0.3;

    hueOffset = (hueOffset + 0.3 + energy * 2) % 360;
    globalSpin += 0.003 + mid * 0.03 * spinSpeed;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const baseR = p.min(p.width, p.height) * 0.32 * (1 + sub * 0.2);
    const tiltX = (0.5 + sub * 0.6) * tiltAmt;
    const tiltZ = p.sin(t * 0.004) * 0.4 * tiltAmt;

    // Central energy core
    glowCircle(p, cx, cy, 10 + sub * 36, hueOffset, 85, 100, 0.5 + sub * 0.8);

    const segs = 72;
    for (let r = 0; r < ringCount; r++) {
      const ringR = baseR * (0.5 + (r / ringCount) * 0.9);
      const ringPhase = globalSpin * (1 + r * 0.35) + r;
      const hue = (hueOffset + r * 36) % 360;
      const wobble = p.sin(t * 0.01 + r) * 0.15 * (1 + mid);
      const rz = tiltZ + r * 0.4;

      // 3-pass glow ring: halo → glow → hot core line
      for (let pass = 0; pass < 3; pass++) {
        const lw = [7, 3.5, 1.4][pass] * (1 + energy * 0.6);
        const am = [26, 60, 150][pass];
        p.stroke(hue, pass === 2 ? 40 : 85, 100, am);
        p.strokeWeight(lw);
        p.noFill();
        p.beginShape();
        for (let s = 0; s <= segs; s++) {
          const a = (s / segs) * p.TWO_PI + ringPhase;
          const x = Math.cos(a) * ringR;
          const y = Math.sin(a) * ringR * (0.3 + wobble * 0.2);
          const z = Math.sin(a) * ringR * 0.5;
          const y1 = y * Math.cos(tiltX) - z * Math.sin(tiltX);
          const z1 = y * Math.sin(tiltX) + z * Math.cos(tiltX);
          const x2 = x * Math.cos(rz) - y1 * Math.sin(rz);
          const y2 = x * Math.sin(rz) + y1 * Math.cos(rz);
          const persp = 1 / (1 + z1 * 0.0016);
          p.vertex(cx + x2 * persp, cy + y2 * persp);
        }
        p.endShape();
      }

      // Glowing satellites orbiting each ring
      const satCount = Math.floor(2 * sats + high * 3);
      for (let sIdx = 0; sIdx < satCount; sIdx++) {
        const sa = ringPhase * 1.7 + (sIdx / Math.max(1, satCount)) * p.TWO_PI;
        const x = Math.cos(sa) * ringR;
        const y = Math.sin(sa) * ringR * 0.3;
        const z = Math.sin(sa) * ringR * 0.5;
        const y1 = y * Math.cos(tiltX) - z * Math.sin(tiltX);
        const z1 = y * Math.sin(tiltX) + z * Math.cos(tiltX);
        const x2 = x * Math.cos(rz) - y1 * Math.sin(rz);
        const y2 = x * Math.sin(rz) + y1 * Math.cos(rz);
        const persp = 1 / (1 + z1 * 0.0016);
        glowCircle(p, cx + x2 * persp, cy + y2 * persp, 2.5 + high * 4, hue, 60, 100, 0.4 + high * 0.6);
      }
    }

    vignette(p, 0.55);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
