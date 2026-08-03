// Film Grain — a tinted color field with subtle animated grain, like an old
// film print held on a title card. Grain specks live in a small offscreen
// buffer that is refreshed at a filmic cadence (the speed param), and a
// soft flicker + vignette complete the look. Needs no audio to feel alive.
import { vignette } from './viz-utils.js';

export default (audio, videoDeviceId, params) => (p) => {
  let buf = null;
  let lastGrainFrame = -999;
  let level = 0;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 1, 1, 1);
    p.noStroke();
  };

  // Recreate the grain buffer only when grain size or window size changes.
  function ensureBuffer(size) {
    const bw = Math.max(2, Math.ceil(p.width / size));
    const bh = Math.max(2, Math.ceil(p.height / size));
    if (!buf || buf.width !== bw || buf.height !== bh) {
      buf = p.createGraphics(bw, bh);
      buf.pixelDensity(1);
      buf.clear();
    }
  }

  // Smoothed overall loudness (0..1). Always safe when audio is unavailable.
  function audioLevel() {
    if (!audio || !audio.isStarted || typeof audio.getFrequencies !== 'function') return 0;
    const freqs = audio.getFrequencies();
    if (!freqs || !freqs.left) return 0;
    let sum = 0;
    for (let i = 0; i < freqs.left.length; i++) sum += freqs.left[i];
    return sum / (freqs.left.length * 255);
  }

  p.draw = () => {
    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const amount = P.amount ?? 0.5;
    const size = Math.max(1, Math.round(P.size ?? 2));
    const tint = ((P.tint ?? 0.08) % 1 + 1) % 1;
    const bgBri = P.bgBrightness ?? 0.25;
    const speed = P.speed ?? 1;

    level = p.lerp(level, audioLevel(), 0.1);

    // Tinted background with a gentle projector flicker (noise + audio lift)
    const flicker = 1 + (p.noise(p.frameCount * 0.05) - 0.5) * 0.14 + level * 0.08;
    p.background(tint, 0.45, Math.min(1, Math.max(0, bgBri * flicker)));

    // Refresh the grain at a film-like cadence; speed controls the shutter
    ensureBuffer(size);
    const interval = Math.max(1, Math.round(4 / Math.max(0.05, speed)));
    if (p.frameCount - lastGrainFrame >= interval) {
      lastGrainFrame = p.frameCount;
      const eff = Math.min(1, amount + level * 0.3);
      buf.loadPixels();
      const d = buf.pixels;
      for (let i = 0; i < d.length; i += 4) {
        // Bright and dark specks mixed, alpha scaled by grain amount
        const v = Math.random() > 0.5 ? 255 : 0;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = Math.random() * 255 * eff;
      }
      buf.updatePixels();
    }

    // Soft upscale keeps the grain filmic rather than pixelated
    p.drawingContext.imageSmoothingEnabled = true;
    p.image(buf, 0, 0, p.width, p.height);

    vignette(p, 0.4);
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
