// Neon Spectrum — colorful frequency bars with additive glow.
// Each bar gets its own hue from a slowly cycling rainbow; bass/mid/high
// energy push brightness, bar height and hue speed. Ideal for techno sets.
export default (audio, videoDeviceId, params) => (p) => {
  let hueOffset = 0;

  function bands(freqs) {
    if (!freqs) return { low: 0, mid: 0, high: 0, energy: 0 };
    // Boosts are read live from params so sliders apply immediately
    const bb = params?.bass ?? 1;
    const mb = params?.mid ?? 1;
    const hb = params?.high ?? 1;
    let low = 0, mid = 0, high = 0;
    for (let i = 0; i < 40; i++) low += freqs[i];
    for (let i = 40; i < 150; i++) mid += freqs[i];
    for (let i = 150; i < 500; i++) high += freqs[i];
    low = low / (40 * 255) * bb;
    mid = mid / (110 * 255) * mb;
    high = high / (350 * 255) * hb;
    return { low, mid, high, energy: (low + mid + high) / 3 };
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
  };

  p.draw = () => {
    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = bands(freqs ? freqs.left : null);

    hueOffset = (hueOffset + 0.35 + b.energy * 2.5) % 360;

    // Bar count is structural but re-read each frame so it applies on the fly
    const BARS = params?.bars ?? 72;

    const w = p.width / BARS;
    for (let i = 0; i < BARS; i++) {
      let v;
      if (freqs) {
        const idx = Math.floor(p.map(i, 0, BARS, 0, 700));
        v = freqs.left[idx] / 255;
      } else {
        // Idle animation so the stage is never black
        v = 0.06 + 0.1 * p.sin(p.frameCount * 0.05 + i * 0.45);
      }

      const h = p.map(p.pow(v, 1.3), 0, 1, 0, p.height * 0.85);
      const hue = (hueOffset + i * 6.5) % 360;
      const sat = 70 + v * 30;
      const bri = 55 + v * 45;

      p.noStroke();
      p.fill(hue, sat, bri, 210);
      p.rect(i * w, p.height / 2 - h, w - 2, h);
      p.fill(hue, sat, bri * 0.6, 150);
      p.rect(i * w, p.height / 2, w - 2, h);

      // Bright caps for extra punch
      p.fill(hue, sat, 100, 230);
      p.rect(i * w, p.height / 2 - h - 3, w - 2, 4);
      p.rect(i * w, p.height / 2 + h - 3, w - 2, 4);
    }

    // Full-screen strobing tint on loud peaks
    if (b.energy > 0.45) {
      p.noStroke();
      p.fill((hueOffset + 180) % 360, 60, 90, 14);
      p.rect(0, 0, p.width, p.height);
    }
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
