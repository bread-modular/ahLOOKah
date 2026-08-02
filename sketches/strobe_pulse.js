// Strobe Pulse — beat-synced strobe with a white-hot core, colored halo,
// radial rays and a ghosting afterimage of the previous flash. RGB split
// layers give the chromatic punch; scanlines and vignette add texture.
import { makeBands, vignette } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  let flash = 0;
  let flashHue = 0;
  let prevSub = 0;
  let hueOffset = 0;
  let ghostHue = 0;
  let ghost = 0;
  const getBands = makeBands();

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
  };

  p.draw = () => {
    const P = params || {};
    const threshold = P.threshold ?? 0.32;
    const decay = P.decay ?? 0.82;
    const split = P.split ?? 1;
    const colorCycle = P.cycle ?? 1;

    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.06);
    const sub = freqs ? b.sub : idle * 0.5;
    const high = freqs ? b.high : idle * 0.3;

    hueOffset = (hueOffset + 0.4 * colorCycle + b.energy * 2) % 360;

    // Rising-edge kick detection fires the strobe; old flash becomes ghost
    if (sub > threshold && sub > prevSub + 0.02) {
      ghostHue = flashHue;
      ghost = flash * 0.6;
      flash = 1;
      flashHue = (hueOffset + p.random(-30, 30) + 360) % 360;
    }
    prevSub = sub;
    flash *= decay;
    ghost *= decay * 0.94;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const diag = Math.hypot(p.width, p.height);

    // Ghost afterimage of the previous flash (lingering color memory)
    if (ghost > 0.01) {
      p.noStroke();
      p.fill(ghostHue, 70, 60, ghost * 60);
      p.rect(0, 0, p.width, p.height);
    }

    const f = flash;
    if (f > 0.01) {
      // RGB-split full-screen layers
      const layers = [
        { hue: (flashHue + 120 * split) % 360, dx: -f * split * 14 },
        { hue: flashHue, dx: 0 },
        { hue: (flashHue - 120 * split + 360) % 360, dx: f * split * 14 },
      ];
      for (const L of layers) {
        p.noStroke();
        p.fill(L.hue, 85, 90, f * 90);
        p.rect(L.dx - 20, -20, p.width + 40, p.height + 40);
      }
      // White-hot core
      p.fill(0, 0, 100, f * 140);
      p.ellipse(cx, cy, diag * 0.5 * f, diag * 0.34 * f);
      // Radial rays bursting out of the core
      const rays = 12;
      p.stroke(flashHue, 60, 100, f * 120);
      for (let i = 0; i < rays; i++) {
        const a = (i / rays) * p.TWO_PI + t * 0.01;
        p.strokeWeight(1 + f * 3);
        p.line(
          cx + p.cos(a) * diag * 0.08, cy + p.sin(a) * diag * 0.08,
          cx + p.cos(a) * diag * 0.5 * f, cy + p.sin(a) * diag * 0.5 * f
        );
      }
    }

    // Edge flicker on highs
    if (high > 0.25) {
      p.noStroke();
      p.fill(hueOffset % 360, 80, 100, high * 40);
      p.rect(0, 0, p.width, 3);
      p.rect(0, p.height - 3, p.width, 3);
    }

    // Scanline texture
    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 40);
    for (let y = 0; y < p.height; y += 4) p.rect(0, y, p.width, 1);

    vignette(p, 0.5);
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
