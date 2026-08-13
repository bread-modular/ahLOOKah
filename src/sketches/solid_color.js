// Solid Color — a fullscreen flat field of color. The simplest building
// block in the library: pure, clean, and instantly usable as a base layer.
// An optional (off by default) audio pulse gently lifts the brightness.
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

// The controller owns the loudness envelope. The old renderer averaged the
// byte spectrum and smoothed it with a per-frame lerp (0.12); the time-based
// form below reproduces that curve exactly at the nominal 60 FPS cadence.
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
      level += (target - level) * (1 - Math.pow(1 - 0.12, dt * 60));
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
  const audioControls = runtimeContext?.audioControls || null;
  let level = 0;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 1, 1, 1);
    p.noStroke();
  };

  // Opted-in path: brightness comes from the capture-side smoothed level.
  function drawMigrated() {
    const P = params || {};
    const hue = ((P.hue ?? 0.6) % 1 + 1) % 1;
    const sat = P.saturation ?? 0.7;
    const bri = P.brightness ?? 0.9;
    const pulse = P.pulse ?? 0;
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    // Small audio-reactive brightness lift (pulse defaults to 0 = off)
    const b = Math.min(1, Math.max(0, bri + C.level * pulse * 0.3));
    p.background(hue, sat, b);
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

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
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
