// Plasma Waves — domain-warped liquid plasma rendered as chunky glow cells.
// The plasma feeds back into itself (warp of warp) for that oily, molten
// metal look. Energy drives flow speed, sub swells the scale, mids bend the
// warp, highs drift the hue. Vignette keeps it cinematic.
import { makeBands, vignette } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  let t = 0;
  let hueOffset = 0;
  const getBands = makeBands();

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
  };

  p.draw = () => {
    const P = params || {};
    const cell = Math.max(4, Math.floor(P.cell ?? 10));
    const speed = P.speed ?? 1;
    const scaleBase = P.scale ?? 1;

    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const idle = 0.5 + 0.5 * p.sin(p.frameCount * 0.015);
    const energy = freqs ? b.energy : 0.2 + idle * 0.25;
    const sub = freqs ? b.sub : 0.25 + idle * 0.2;
    const mid = freqs ? b.mid : 0.2;
    const high = freqs ? b.high : idle * 0.25;

    t += (0.008 + energy * 0.06) * speed;
    hueOffset = (hueOffset + 0.2 + high * 2) % 360;

    const scale = 0.005 * scaleBase * (1 + sub * 0.8);
    const warp = 1.5 + mid * 4;
    const cxS = (p.width * scale) / 2;
    const cyS = (p.height * scale) / 2;

    p.noStroke();
    for (let y = 0; y < p.height; y += cell) {
      const sy = y * scale;
      for (let x = 0; x < p.width; x += cell) {
        const sx = x * scale;
        // Domain warp: plasma coordinates bent by plasma
        const wx = p.sin(sy * 1.7 + t * 1.3) * warp;
        const wy = p.sin(sx * 1.3 - t) * warp;
        let v = p.sin((sx + wx) * 2 + t);
        v += p.sin((sy + wy) * 2.4 - t * 1.2);
        v += p.sin(sx + sy + wx - wy + t * 0.7);
        const dx = sx + wx * 0.5 - cxS;
        const dy = sy + wy * 0.5 - cyS;
        v += p.sin(Math.sqrt(dx * dx + dy * dy) * 3 - t * 1.5);
        const n = v / 8 + 0.5; // normalize to ~[0,1]
        const hue = (hueOffset + n * 140) % 360;
        const bri = 12 + n * n * 88 * (0.5 + energy);
        p.fill(hue, 85, bri, 200);
        p.rect(x, y, cell + 0.5, cell + 0.5);
      }
    }

    vignette(p, 0.6);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
