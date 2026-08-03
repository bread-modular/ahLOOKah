// Checkerboard — the classic two-color checker pattern. It drifts slowly on
// a diagonal (phase shift) and the whole board breathes in scale with the
// music. One color doubles as the background so only half the cells are
// drawn — cheap even at small cell sizes.
export default (audio, videoDeviceId, params) => (p) => {
  let phase = 0;
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
    const cellBase = Math.max(8, P.cell ?? 48);
    const hueA = ((P.hueA ?? 0.58) % 1 + 1) % 1;
    const hueB = ((P.hueB ?? 0.08) % 1 + 1) % 1;
    const speed = P.speed ?? 0.5;
    const pulse = P.pulse ?? 1;

    level = p.lerp(level, audioLevel(), 0.12);

    // Slow diagonal phase drift; beats push the pattern along a little faster
    phase += speed + level * pulse * 2;

    // Audio-reactive scale pulse: cells swell gently with the music
    const cell = cellBase * (1 + level * pulse * 0.35);

    // Pattern period is two cells, so wrapping at 2*cell is seamless
    const ox = -(phase % (cell * 2));
    const oy = -((phase * 0.5) % (cell * 2));

    p.background(hueA, 0.85, 0.95); // color A doubles as the background
    p.fill(hueB, 0.85, 0.95);

    const cols = Math.ceil(p.width / cell) + 4;
    const rows = Math.ceil(p.height / cell) + 4;
    for (let iy = 0; iy < rows; iy++) {
      for (let ix = 0; ix < cols; ix++) {
        if ((ix + iy) % 2 === 0) continue;
        // +0.5 overlap avoids hairline seams between cells
        p.rect(ox + ix * cell, oy + iy * cell, cell + 0.5, cell + 0.5);
      }
    }
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
