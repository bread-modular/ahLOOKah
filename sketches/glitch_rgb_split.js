// RGB Split — chromatic aberration bursts. A retro broadcast test pattern is
// rendered to an offscreen buffer, then stamped three times through red,
// green and blue tint passes with ADD blending. Where the passes align the
// image reconstructs clean; highs (or random glitches) fire offset bursts
// that tear the channels apart into fringes.
import { makeBands } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  let buf = null;
  let bw = 0;
  let bh = 0;
  let burst = 0;
  let t = 0;
  const getBands = makeBands();

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.noStroke();
  };

  // Half-res buffer: cheap to redraw, and the crunchy upscale suits the look.
  function ensureBuffer() {
    const w = Math.max(64, Math.min(960, Math.floor(p.width / 2)));
    const h = Math.max(64, Math.floor((w * p.height) / Math.max(1, p.width)));
    if (!buf || bw !== w || bh !== h) {
      bw = w;
      bh = h;
      if (buf) buf.remove();
      buf = p.createGraphics(w, h);
      buf.pixelDensity(1);
      buf.noStroke();
      buf.colorMode(p.HSB, 360, 100, 100, 255);
    }
  }

  function drawSignal() {
    buf.background(0, 0, 5);
    // color bars
    const bars = 8;
    const barH = bh * 0.55;
    for (let i = 0; i < bars; i++) {
      buf.fill(((i / bars) * 360 + t * 30) % 360, 82, 92);
      buf.rect((i * bw) / bars + 1, 0, bw / bars - 2, barH);
    }
    // pulsing target circles
    const r = bh * (0.16 + 0.05 * Math.sin(t * 2.3));
    buf.fill(0, 0, 100);
    buf.circle(bw / 2, bh * 0.66, r * 2.4);
    buf.fill((t * 55) % 360, 90, 100);
    buf.circle(bw / 2, bh * 0.66, r * 1.5);
    buf.fill(0, 0, 8);
    buf.circle(bw / 2, bh * 0.66, r * 0.6);
    // scrolling sync ticks
    for (let i = 0; i < 10; i++) {
      const x = ((i * 131 + t * 90) % (bw + 60)) - 60;
      buf.fill(0, 0, i % 2 ? 75 : 35);
      buf.rect(x, bh * 0.88, 46, bh * 0.05);
    }
  }

  p.draw = () => {
    const P = params || {};
    const intensity = P.intensity ?? 0.4;
    const burstAmt = P.burst ?? 1;
    const speed = P.speed ?? 1;
    const pulse = P.pulse ?? 1;

    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    t += dt * (0.4 + speed);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const high = freqs ? b.high : 0;

    // Burst triggers: sharp highs, plus rare random glitches when idle
    if ((high * pulse > 0.32 && Math.random() < 0.4) || Math.random() < 0.018) {
      burst = 1;
    }
    burst *= 0.86;

    ensureBuffer();
    drawSignal();

    p.background(0);
    const wob = Math.sin(t * 1.8) * 0.6 + Math.sin(t * 0.7 + 1.3) * 0.4;
    const offX = intensity * 12 * wob + burst * burstAmt * 70;
    const offY = intensity * 5 * Math.cos(t * 1.2) + burst * burstAmt * 26;

    // Hard-pixel upscale keeps the fringes crisp
    const ctx = p.drawingContext;
    ctx.imageSmoothingEnabled = false;
    p.blendMode(p.ADD);
    p.tint(255, 0, 0);
    p.image(buf, offX, offY, p.width, p.height);
    p.tint(0, 255, 0);
    p.image(buf, 0, 0, p.width, p.height);
    p.tint(0, 0, 255);
    p.image(buf, -offX, -offY, p.width, p.height);
    p.noTint();
    p.blendMode(p.BLEND);
    ctx.imageSmoothingEnabled = true;

    // White-out flash on the hardest bursts
    if (burst > 0.85) {
      p.fill(255, 255, 255, 24);
      p.rect(0, 0, p.width, p.height);
    }
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
