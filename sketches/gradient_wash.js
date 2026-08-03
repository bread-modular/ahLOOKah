// Color Wash — a smooth two-color gradient that slowly drifts and rotates.
// The gradient is painted into a tiny offscreen strip (2x256) once per frame
// and stretched across the screen diagonal, so it is perfectly smooth and
// costs almost nothing to draw. Audio adds a gentle breathing scale.
export default (audio, videoDeviceId, params) => (p) => {
  let strip = null; // low-res gradient strip, stretched to fill the screen
  let angle = 0;
  let level = 0;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 1, 1, 1);
    p.noStroke();
    strip = p.createGraphics(2, 256);
    strip.pixelDensity(1);
    strip.colorMode(p.HSB, 1, 1, 1);
    strip.noStroke();
  };

  // Smoothed overall loudness (0..1). Always safe when audio is unavailable.
  function audioLevel() {
    if (!audio || !audio.isStarted || typeof audio.getFrequencies !== 'function') return 0;
    const freqs = audio.getFrequencies();
    if (!freqs || !freqs.left) return 0;
    let sum = 0;
    for (let i = 0; i < freqs.left.length; i++) sum += freqs.left[i];
    return sum / (freqs.left.length * 255);
  }

  // Shortest-path hue interpolation on a 0..1 wheel.
  function lerpHue(a, b, t) {
    const d = ((b - a + 1.5) % 1) - 0.5;
    return ((a + d * t) % 1 + 1) % 1;
  }

  p.draw = () => {
    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const hueA = ((P.hueA ?? 0.55) % 1 + 1) % 1;
    const hueB = ((P.hueB ?? 0.92) % 1 + 1) % 1;
    const speed = P.speed ?? 0.6;
    const pulse = P.pulse ?? 0.8;

    level = p.lerp(level, audioLevel(), 0.1);

    // Very slow organic hue drift so the wash keeps evolving
    const t = p.millis() * 0.00002 * speed;
    const hA = (hueA + t) % 1;
    const hB = (hueB - t * 0.6 + 1) % 1;

    // Repaint the strip with the current colors (256 thin rows — trivial cost)
    const rows = strip.height;
    for (let y = 0; y < rows; y++) {
      const f = y / (rows - 1);
      const hue = lerpHue(hA, hB, f);
      const sat = 0.75 + 0.1 * f;
      const bri = Math.min(1, (0.95 - 0.45 * f) * (1 + level * pulse * 0.15));
      strip.fill(hue, sat, bri);
      strip.rect(0, y, strip.width, 1);
    }

    // Slow rotation drift (steady spin + noise wander), audio breathing scale
    angle += 0.0012 * speed + (p.noise(p.frameCount * 0.002) - 0.5) * 0.0018 * (0.5 + speed);
    const scale = 1 + level * pulse * 0.22;
    const diag = Math.hypot(p.width, p.height) * 1.02;

    p.drawingContext.imageSmoothingEnabled = true;
    p.push();
    p.translate(p.width / 2, p.height / 2);
    p.rotate(angle);
    p.scale(scale);
    p.image(strip, -diag / 2, -diag / 2, diag, diag);
    p.pop();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
