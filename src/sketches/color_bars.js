// Color Bars — classic TV test-signal vertical bars with a VJ twist.
// Evenly spaced saturated bars span the full color wheel; the wobble param
// lets the music shove them around. With no audio (or wobble at 0) it holds
// a perfectly clean broadcast-style pattern.
// Opted-in renderers consume a smoothed loudness level from the capture
// owner; the legacy raw audio path is kept for all other callers.

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    level: { min: 0, max: 1, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { level: 0 },
  },
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// The controller owns the loudness envelope (legacy per-frame lerp 0.14),
// converted to a frame-rate-independent time constant.
export function createAudioController({ rng = Math.random } = {}) {
  let level = 0;
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const left = freqs.left;
      let target = 0;
      if (left?.length) {
        let sum = 0;
        for (let i = 0; i < left.length; i++) sum += left[i] || 0;
        target = clamp(sum / (left.length * 255), 0, 1);
      }
      level += (target - level) * (1 - Math.pow(1 - 0.14, dt * 60));
      if (level < 1e-6) level = 0;
      return {
        continuous: { level },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let level = 0;
  const audioControls = runtimeContext?.audioControls || null;

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

  function drawBars(level) {
    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const count = Math.max(2, Math.round(P.bars ?? 8));
    const sat = P.saturation ?? 0.85;
    const bri = P.brightness ?? 0.95;
    const wobble = P.wobble ?? 1;

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
  }

  function drawMigrated() {
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    drawBars(C.level);
  }

  function drawLegacy() {
    level = p.lerp(level, audioLevel(), 0.14);
    drawBars(level);
  }

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
