// Glitch Matrix — digital rain with a warehouse twist.
// Glowing white-hot lead glyphs, fading trails, mid-driven speed bursts per
// column, and high-frequency glitch slices that tear the screen with
// RGB-split displacement. Matrix meets mainstage.
import { makeBands, vignette } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  const CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ01<>/\\|+=*#';
  let columns = [];
  let hueOffset = 0;
  const getBands = makeBands();

  function ensureColumns(n) {
    while (columns.length < n) {
      columns.push({
        y: p.random(-p.height, 0),
        speed: p.random(2, 7),
        burst: 0,
        len: Math.floor(p.random(10, 26)),
      });
    }
    columns.length = Math.min(columns.length, n);
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    p.textFont('monospace');
  };

  p.draw = () => {
    const P = params || {};
    const colCount = Math.floor(P.columns ?? 40);
    const speedMul = P.speed ?? 1;
    const glitchAmt = P.glitch ?? 1;
    const trail = P.trail ?? 1;

    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 16 + trail * 14);
    p.rect(0, 0, p.width, p.height);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const idle = 0.5 + 0.5 * p.sin(p.frameCount * 0.02);
    const energy = freqs ? b.energy : 0.2 + idle * 0.2;
    const sub = freqs ? b.sub : 0.2;
    const mid = freqs ? b.mid : 0.2;
    const high = freqs ? b.high : idle * 0.3;

    hueOffset = (hueOffset + 0.2 + energy) % 360;
    ensureColumns(colCount);

    const colW = p.width / colCount;
    const size = Math.max(12, colW * 0.9);
    p.textSize(size);
    p.textAlign(p.CENTER, p.TOP);

    for (let i = 0; i < colCount; i++) {
      const col = columns[i];
      // Mid energy randomly triggers per-column speed bursts
      if (p.random() < mid * 0.02) col.burst = 1;
      col.burst *= 0.96;
      col.y += (col.speed + col.burst * 14) * speedMul * (0.5 + energy);
      if (col.y - col.len * size > p.height) {
        col.y = p.random(-p.height * 0.4, -size);
        col.speed = p.random(2, 7);
        col.len = Math.floor(p.random(10, 26));
      }
      const x = i * colW + colW / 2;
      const hue = (hueOffset + i * 2) % 360;
      for (let j = 0; j < col.len; j++) {
        const y = col.y - j * size;
        if (y < -size || y > p.height + size) continue;
        const tt = 1 - j / col.len;
        const ch = CHARS[Math.floor(p.random(CHARS.length))];
        if (j === 0) {
          // Glowing head: bright core + colored halo pass
          p.fill(hue, 40, 100, 255);
          p.text(ch, x, y);
          p.fill(hue, 90, 100, 90 + sub * 120);
          p.text(ch, x, y);
        } else {
          p.fill(hue, 85, 60 + tt * 35, tt * 220);
          p.text(ch, x, y);
        }
      }
    }

    // RGB-split glitch slice tears on highs
    if (high > 0.3 && p.random() < high * 0.3 * glitchAmt) {
      const sy = p.random(p.height * 0.7);
      const sh = p.random(8, 40);
      const dx = p.random(-40, 40) * glitchAmt * high;
      const img = p.get(0, sy, p.width, sh);
      p.blendMode(p.BLEND);
      p.tint(0, 100, 100, 120);
      p.image(img, dx, sy);
      p.tint(180, 100, 100, 120);
      p.image(img, -dx, sy);
      p.noTint();
    }

    vignette(p, 0.5);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
