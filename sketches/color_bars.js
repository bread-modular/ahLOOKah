// Color Bars — classic TV test-signal vertical bars with a VJ twist.
// Evenly spaced saturated bars span the full color wheel; the wobble param
// lets the music shove them around. With no audio (or wobble at 0) it holds
// a perfectly clean broadcast-style pattern.
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
    const count = Math.max(2, Math.round(P.bars ?? 8));
    const sat = P.saturation ?? 0.85;
    const bri = P.brightness ?? 0.95;
    const wobble = P.wobble ?? 1;

    level = p.lerp(level, audioLevel(), 0.14);

    p.background(0, 0, 0);

    const bw = p.width / count;
    const t = p.frameCount * 0.012;
    // Audio drives the shove; a whisper of idle noise keeps it alive silently
    const amp = wobble * (level * bw * 1.1 + bw * 0.08);

    for (let i = 0; i < count; i++) {
      const hue = ((i / count) % 1 + 1) % 1;
      const dx = (p.noise(i * 7.31, t) - 0.5) * 2 * amp;
      const dy = (p.noise(i * 13.77 + 50, t) - 0.5) * 1.2 * amp;

      p.fill(hue, sat, bri);
      // Slight overlap (+1) avoids hairline seams between bars; vertical pad
      // keeps edges covered while bars slide around.
      p.rect(i * bw + dx, -amp + dy, bw + 1, p.height + amp * 2);
    }
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
