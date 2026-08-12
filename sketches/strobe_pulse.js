// Strobe Pulse — beat-synced strobe with a white-hot core, colored halo,
// radial rays and a ghosting afterimage of the previous flash. RGB split
// layers give the chromatic punch; scanlines and vignette add texture.
// The opted-in path consumes the flash envelope, hues and band scalars from a
// DOM-free capture-side controller; the legacy raw-frame path is preserved.
import { makeBands, vignette } from './viz-utils.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    hueOffset: { min: 0, max: 360, neutral: 0 },
    high: { min: 0, max: 1.6, neutral: 0 },
    flash: { min: 0, max: 1, neutral: 0 },
    ghost: { min: 0, max: 1, neutral: 0 },
    flashHue: { min: 0, max: 360, neutral: 0 },
    ghostHue: { min: 0, max: 360, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: {
      hueOffset: 0,
      high: 0,
      flash: 0,
      ghost: 0,
      flashHue: 0,
      ghostHue: 0,
    },
  },
});

// Legacy rawBands: sub/mid/high/energy from byte bins (this sketch has no
// bass/mid/high responsiveness params, so boosts default to 1).
function rawBands(freqs, params) {
  if (!freqs?.length) return { sub: 0, mid: 0, high: 0, energy: 0 };
  const bb = params?.bass ?? 1;
  const mb = params?.mid ?? 1;
  const hb = params?.high ?? 1;
  let sub = 0, mid = 0, high = 0;
  for (let i = 0; i < 4; i++) sub += freqs[i] || 0;
  for (let i = 40; i < 150; i++) mid += freqs[i] || 0;
  for (let i = 150; i < 500; i++) high += freqs[i] || 0;
  sub = (sub / (4 * 255)) * bb;
  mid = (mid / (110 * 255)) * mb;
  high = (high / (350 * 255)) * hb;
  return { sub, mid, high, energy: (sub + mid + high) / 3 };
}

// The controller owns the smoothed envelope, hue drift, kick detection and
// the flash/ghost decay envelopes. Geometry stays fully visual on the renderer.
export function createAudioController({ rng = Math.random } = {}) {
  const random = typeof rng === 'function' ? rng : Math.random;
  let flash = 0;
  let flashHue = 0;
  let prevSub = 0;
  let hueOffset = 0;
  let ghostHue = 0;
  let ghost = 0;
  let s = 0, m = 0, h = 0, e = 0;

  // viz-utils makeBands() smoothing is per-frame (atk 0.6 / rel 0.14); the
  // time-based equivalent keeps the envelope identical at any controller cadence.
  const follow = (current, target, atk, rel, dt) => {
    const amount = target > current ? 1 - Math.pow(1 - atk, 60 * dt) : 1 - Math.pow(1 - rel, 60 * dt);
    return current + (target - current) * amount;
  };

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const raw = rawBands(freqs.left, params);
      s = follow(s, raw.sub, 0.6, 0.14, dt);
      m = follow(m, raw.mid, 0.6, 0.14, dt);
      h = follow(h, raw.high, 0.6, 0.14, dt);
      e = follow(e, raw.energy, 0.6, 0.14, dt);
      const b = { sub: s, mid: m, high: h, energy: e };

      const threshold = Number(params.threshold ?? 0.32);
      const decay = Number(params.decay ?? 0.82);
      const colorCycle = Number(params.cycle ?? 1);

      hueOffset = (hueOffset + (0.4 * colorCycle + b.energy * 2) * dt * 60) % 360;

      // Rising-edge kick detection fires the strobe; old flash becomes ghost.
      if (b.sub > threshold && b.sub > prevSub + 0.02) {
        ghostHue = flashHue;
        ghost = flash * 0.6;
        flash = 1;
        flashHue = (hueOffset + (random() * 60 - 30) + 360) % 360;
      }
      prevSub = b.sub;
      // Legacy per-frame decays calibrated to elapsed seconds.
      flash *= Math.pow(decay, 60 * dt);
      ghost *= Math.pow(decay * 0.94, 60 * dt);

      return {
        continuous: {
          hueOffset,
          high: clamp(b.high, 0, 1.6),
          flash: clamp(flash, 0, 1),
          ghost: clamp(ghost, 0, 1),
          flashHue,
          ghostHue,
        },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let flash = 0;
  let flashHue = 0;
  let prevSub = 0;
  let hueOffset = 0;
  let ghostHue = 0;
  let ghost = 0;
  const getBands = makeBands();
  const audioControls = runtimeContext?.audioControls || null;

  function drawStrobe(high) {
    const P = params || {};
    const split = P.split ?? 1;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const diag = Math.hypot(p.width, p.height);
    const t = p.frameCount;
    const f = flash;

    // Ghost afterimage of the previous flash (lingering color memory)
    if (ghost > 0.01) {
      p.noStroke();
      p.fill(ghostHue, 70, 60, ghost * 60);
      p.rect(0, 0, p.width, p.height);
    }

    if (f > 0.01) {
      // RGB-split full-screen layers
      const layers = [
        { hue: (flashHue + 120 * split) % 360, dx: -f * split * 14 },
        { hue: flashHue, dx: 0 },
        { hue: (flashHue - 120 * split + 360) % 360, dx: f * split * 14 },
      ];
      for (const L of layers) {
        p.noStroke();
        p.fill(L.hue, 85, 90, f * 90);
        p.rect(L.dx - 20, -20, p.width + 40, p.height + 40);
      }
      // White-hot core
      p.fill(0, 0, 100, f * 140);
      p.ellipse(cx, cy, diag * 0.5 * f, diag * 0.34 * f);
      // Radial rays bursting out of the core
      const rays = 12;
      p.stroke(flashHue, 60, 100, f * 120);
      for (let i = 0; i < rays; i++) {
        const a = (i / rays) * p.TWO_PI + t * 0.01;
        p.strokeWeight(1 + f * 3);
        p.line(
          cx + p.cos(a) * diag * 0.08, cy + p.sin(a) * diag * 0.08,
          cx + p.cos(a) * diag * 0.5 * f, cy + p.sin(a) * diag * 0.5 * f
        );
      }
    }

    // Edge flicker on highs
    if (high > 0.25) {
      p.noStroke();
      p.fill(hueOffset % 360, 80, 100, high * 40);
      p.rect(0, 0, p.width, 3);
      p.rect(0, p.height - 3, p.width, 3);
    }
  }

  function drawMigrated() {
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    hueOffset = C.hueOffset;
    flash = C.flash;
    ghost = C.ghost;
    flashHue = C.flashHue;
    ghostHue = C.ghostHue;

    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    drawStrobe(C.high);

    // Scanline texture
    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 40);
    for (let y = 0; y < p.height; y += 4) p.rect(0, y, p.width, 1);

    vignette(p, 0.5);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    const P = params || {};
    const threshold = P.threshold ?? 0.32;
    const decay = P.decay ?? 0.82;

    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.06);
    const sub = freqs ? b.sub : idle * 0.5;
    const high = freqs ? b.high : idle * 0.3;

    hueOffset = (hueOffset + 0.4 * (P.cycle ?? 1) + b.energy * 2) % 360;

    // Rising-edge kick detection fires the strobe; old flash becomes ghost
    if (sub > threshold && sub > prevSub + 0.02) {
      ghostHue = flashHue;
      ghost = flash * 0.6;
      flash = 1;
      flashHue = (hueOffset + p.random(-30, 30) + 360) % 360;
    }
    prevSub = sub;
    flash *= decay;
    ghost *= decay * 0.94;

    drawStrobe(high);

    // Scanline texture
    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 40);
    for (let y = 0; y < p.height; y += 4) p.rect(0, y, p.width, 1);

    vignette(p, 0.5);
  }

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
