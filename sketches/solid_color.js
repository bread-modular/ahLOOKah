// Solid Color — a fullscreen flat field of color. The simplest building
// block in the library: pure, clean, and instantly usable as a base layer.
// An optional (off by default) audio pulse gently lifts the brightness.
export default (audio, videoDeviceId, params) => (p) => {
  let level = 0;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 1, 1, 1);
    p.noStroke();
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

  p.draw = () => {
    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const hue = ((P.hue ?? 0.6) % 1 + 1) % 1;
    const sat = P.saturation ?? 0.7;
    const bri = P.brightness ?? 0.9;
    const pulse = P.pulse ?? 0;

    level = p.lerp(level, audioLevel(), 0.12);

    // Small audio-reactive brightness lift (pulse defaults to 0 = off)
    const b = Math.min(1, Math.max(0, bri + level * pulse * 0.3));
    p.background(hue, sat, b);
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
