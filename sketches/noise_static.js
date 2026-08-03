// Noise Static — analog TV snow. The static is generated as raw pixels in a
// tiny offscreen buffer (one pixel per "block") and blitted upscaled, so it
// stays cheap even on huge screens. A slow drifting "hold" band sells the
// broken-tuner vibe. Audio pushes the static hotter.
export default (audio, videoDeviceId, params) => (p) => {
  let buf = null;
  let level = 0;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.noStroke();
  };

  // Recreate the offscreen buffer only when the block size or window changes.
  function ensureBuffer(block) {
    const bw = Math.max(2, Math.ceil(p.width / block));
    const bh = Math.max(2, Math.ceil(p.height / block));
    if (!buf || buf.width !== bw || buf.height !== bh) {
      buf = p.createGraphics(bw, bh);
      buf.pixelDensity(1);
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
    const intensity = P.intensity ?? 0.7;
    const block = Math.max(1, Math.round(P.density ?? 3));
    const color = (P.color ?? 0) >= 0.5; // 0 = mono snow, 1 = chroma snow
    const pulse = P.pulse ?? 1;

    level = p.lerp(level, audioLevel(), 0.16);

    // Audio-reactive intensity: the signal gets noisier as it gets louder
    const hot = Math.min(1, Math.max(0, intensity + level * pulse * 0.4));

    ensureBuffer(block);
    buf.loadPixels();
    const d = buf.pixels;
    if (color) {
      // Independent random channels produce crunchy chroma static
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 128 + (Math.random() * 2 - 1) * 127 * hot;
        d[i + 1] = 128 + (Math.random() * 2 - 1) * 127 * hot;
        d[i + 2] = 128 + (Math.random() * 2 - 1) * 127 * hot;
        d[i + 3] = 255;
      }
    } else {
      for (let i = 0; i < d.length; i += 4) {
        const v = 128 + (Math.random() * 2 - 1) * 127 * hot;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
    buf.updatePixels();

    // Hard-pixel upscale keeps the blocks crisp (chunky analog snow)
    const ctx = p.drawingContext;
    ctx.imageSmoothingEnabled = false;
    p.image(buf, 0, 0, p.width, p.height);
    ctx.imageSmoothingEnabled = true;

    // Drifting vertical-hold band: a dark smear with a bright leading edge
    const bandY = p.noise(p.frameCount * 0.004) * (p.height + 160) - 80;
    const bandH = 20 + level * 40;
    p.fill(0, 0, 0, 46);
    p.rect(0, bandY, p.width, bandH);
    p.fill(255, 255, 255, 20 + level * 30);
    p.rect(0, bandY + bandH, p.width, 3);
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
