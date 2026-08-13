// Orbital Rings — a 3D gyroscope of glowing light rings.
// Each ring is drawn in three passes (wide halo, mid glow, hot core line)
// with real 3D rotation and perspective. Bass tilts the rig, mids drive the
// spin, highs light up glowing satellites. A bloom core anchors the center.
// The legacy raw-frame path stays intact; opted-in renderers consume final
// controls produced by a DOM-free capture-side controller.
import { makeBands, glowCircle, vignette } from './viz-utils.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    hueOffset: { min: 0, max: 360, neutral: 0 },
    globalSpin: { min: -1_000_000, max: 1_000_000, neutral: 0 },
    sub: { min: 0, max: 2.5, neutral: 0 },
    mid: { min: 0, max: 2.5, neutral: 0 },
    high: { min: 0, max: 2.5, neutral: 0 },
    energy: { min: 0, max: 2.5, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { hueOffset: 0, globalSpin: 0, sub: 0, mid: 0, high: 0, energy: 0 },
  },
});

// Envelope-smoothed bands matching viz-utils.makeBands, calibrated to
// deltaSeconds via exponential per-second factors (identical at 60 fps).
function rawBands(freqs, params) {
  if (!freqs?.length) return { sub: 0, mid: 0, high: 0, energy: 0 };
  const bb = params?.bass ?? 1;
  const mb = params?.mid ?? 1;
  const hb = params?.high ?? 1;
  let sub = 0, mid = 0, high = 0;
  for (let i = 0; i < 4; i++) sub += freqs[i];
  for (let i = 40; i < 150; i++) mid += freqs[i];
  for (let i = 150; i < 500; i++) high += freqs[i];
  sub = (sub / (4 * 255)) * bb;
  mid = (mid / (110 * 255)) * mb;
  high = (high / (350 * 255)) * hb;
  return { sub, mid, high, energy: (sub + mid + high) / 3 };
}

function makeBandsController() {
  let s = 0, m = 0, h = 0, e = 0;
  return (freqs, params, dt) => {
    const raw = rawBands(freqs, params);
    const follow = (cur, target, atk, rel) => {
      const factor = target > cur ? atk : rel;
      const alpha = 1 - Math.pow(1 - factor, dt * 60);
      return cur + (target - cur) * alpha;
    };
    s = follow(s, raw.sub, 0.6, 0.14);
    m = follow(m, raw.mid, 0.6, 0.14);
    h = follow(h, raw.high, 0.6, 0.14);
    e = follow(e, raw.energy, 0.6, 0.14);
    return { sub: s, mid: m, high: h, energy: e };
  };
}

// The controller owns band extraction (same envelope smoothing as the old
// renderer), the time-based hue and spin state. No renderer-side audio math.
export function createAudioController({ rng = Math.random } = {}) {
  let hueOffset = 0;
  let globalSpin = 0;
  const getBands = makeBandsController();

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const b = getBands(freqs.left && freqs.left.length ? freqs.left : null, params, dt);
      const spinSpeed = Math.max(0, Number(params.spin ?? 1));

      hueOffset = (hueOffset + (0.3 + b.energy * 2) * dt * 60) % 360;
      globalSpin += (0.003 + b.mid * 0.03 * spinSpeed) * dt * 60;
      if (Math.abs(globalSpin) > 900_000) globalSpin %= 100_000;

      return {
        continuous: {
          hueOffset,
          globalSpin,
          sub: b.sub,
          mid: b.mid,
          high: b.high,
          energy: b.energy,
        },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let hueOffset = 0;
  let globalSpin = 0;
  const getBands = makeBands();
  const audioControls = runtimeContext?.audioControls || null;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
  };

  // Opted-in renderer: consumes final controls only; no local audio analysis.
  function drawMigrated() {
    const P = params || {};
    const ringCount = Math.floor(P.rings ?? 5);
    const tiltAmt = P.tilt ?? 1;
    const sats = P.satellites ?? 1;

    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const energy = C.energy;
    const sub = C.sub;
    const mid = C.mid;
    const high = C.high;
    const t = p.frameCount;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const baseR = p.min(p.width, p.height) * 0.32 * (1 + sub * 0.2);
    const tiltX = (0.5 + sub * 0.6) * tiltAmt;
    const tiltZ = p.sin(t * 0.004) * 0.4 * tiltAmt;

    // Central energy core
    glowCircle(p, cx, cy, 10 + sub * 36, C.hueOffset, 85, 100, 0.5 + sub * 0.8);

    const segs = 72;
    for (let r = 0; r < ringCount; r++) {
      const ringR = baseR * (0.5 + (r / ringCount) * 0.9);
      const ringPhase = C.globalSpin * (1 + r * 0.35) + r;
      const hue = (C.hueOffset + r * 36) % 360;
      const wobble = p.sin(t * 0.01 + r) * 0.15 * (1 + mid);
      const rz = tiltZ + r * 0.4;

      // 3-pass glow ring: halo → glow → hot core line
      for (let pass = 0; pass < 3; pass++) {
        const lw = [7, 3.5, 1.4][pass] * (1 + energy * 0.6);
        const am = [26, 60, 150][pass];
        p.stroke(hue, pass === 2 ? 40 : 85, 100, am);
        p.strokeWeight(lw);
        p.noFill();
        p.beginShape();
        for (let s = 0; s <= segs; s++) {
          const a = (s / segs) * p.TWO_PI + ringPhase;
          const x = Math.cos(a) * ringR;
          const y = Math.sin(a) * ringR * (0.3 + wobble * 0.2);
          const z = Math.sin(a) * ringR * 0.5;
          const y1 = y * Math.cos(tiltX) - z * Math.sin(tiltX);
          const z1 = y * Math.sin(tiltX) + z * Math.cos(tiltX);
          const x2 = x * Math.cos(rz) - y1 * Math.sin(rz);
          const y2 = x * Math.sin(rz) + y1 * Math.cos(rz);
          const persp = 1 / (1 + z1 * 0.0016);
          p.vertex(cx + x2 * persp, cy + y2 * persp);
        }
        p.endShape();
      }

      // Glowing satellites orbiting each ring
      const satCount = Math.floor(2 * sats + high * 3);
      for (let sIdx = 0; sIdx < satCount; sIdx++) {
        const sa = ringPhase * 1.7 + (sIdx / Math.max(1, satCount)) * p.TWO_PI;
        const x = Math.cos(sa) * ringR;
        const y = Math.sin(sa) * ringR * 0.3;
        const z = Math.sin(sa) * ringR * 0.5;
        const y1 = y * Math.cos(tiltX) - z * Math.sin(tiltX);
        const z1 = y * Math.sin(tiltX) + z * Math.cos(tiltX);
        const x2 = x * Math.cos(rz) - y1 * Math.sin(rz);
        const y2 = x * Math.sin(rz) + y1 * Math.cos(rz);
        const persp = 1 / (1 + z1 * 0.0016);
        glowCircle(p, cx + x2 * persp, cy + y2 * persp, 2.5 + high * 4, hue, 60, 100, 0.4 + high * 0.6);
      }
    }

    vignette(p, 0.55);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    const P = params || {};
    const ringCount = Math.floor(P.rings ?? 5);
    const spinSpeed = P.spin ?? 1;
    const tiltAmt = P.tilt ?? 1;
    const sats = P.satellites ?? 1;

    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.018);
    const energy = freqs ? b.energy : 0.18 + idle * 0.2;
    const sub = freqs ? b.sub : 0.2 + idle * 0.2;
    const mid = freqs ? b.mid : 0.2;
    const high = freqs ? b.high : idle * 0.3;

    hueOffset = (hueOffset + 0.3 + energy * 2) % 360;
    globalSpin += 0.003 + mid * 0.03 * spinSpeed;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const baseR = p.min(p.width, p.height) * 0.32 * (1 + sub * 0.2);
    const tiltX = (0.5 + sub * 0.6) * tiltAmt;
    const tiltZ = p.sin(t * 0.004) * 0.4 * tiltAmt;

    // Central energy core
    glowCircle(p, cx, cy, 10 + sub * 36, hueOffset, 85, 100, 0.5 + sub * 0.8);

    const segs = 72;
    for (let r = 0; r < ringCount; r++) {
      const ringR = baseR * (0.5 + (r / ringCount) * 0.9);
      const ringPhase = globalSpin * (1 + r * 0.35) + r;
      const hue = (hueOffset + r * 36) % 360;
      const wobble = p.sin(t * 0.01 + r) * 0.15 * (1 + mid);
      const rz = tiltZ + r * 0.4;

      // 3-pass glow ring: halo → glow → hot core line
      for (let pass = 0; pass < 3; pass++) {
        const lw = [7, 3.5, 1.4][pass] * (1 + energy * 0.6);
        const am = [26, 60, 150][pass];
        p.stroke(hue, pass === 2 ? 40 : 85, 100, am);
        p.strokeWeight(lw);
        p.noFill();
        p.beginShape();
        for (let s = 0; s <= segs; s++) {
          const a = (s / segs) * p.TWO_PI + ringPhase;
          const x = Math.cos(a) * ringR;
          const y = Math.sin(a) * ringR * (0.3 + wobble * 0.2);
          const z = Math.sin(a) * ringR * 0.5;
          const y1 = y * Math.cos(tiltX) - z * Math.sin(tiltX);
          const z1 = y * Math.sin(tiltX) + z * Math.cos(tiltX);
          const x2 = x * Math.cos(rz) - y1 * Math.sin(rz);
          const y2 = x * Math.sin(rz) + y1 * Math.cos(rz);
          const persp = 1 / (1 + z1 * 0.0016);
          p.vertex(cx + x2 * persp, cy + y2 * persp);
        }
        p.endShape();
      }

      // Glowing satellites orbiting each ring
      const satCount = Math.floor(2 * sats + high * 3);
      for (let sIdx = 0; sIdx < satCount; sIdx++) {
        const sa = ringPhase * 1.7 + (sIdx / Math.max(1, satCount)) * p.TWO_PI;
        const x = Math.cos(sa) * ringR;
        const y = Math.sin(sa) * ringR * 0.3;
        const z = Math.sin(sa) * ringR * 0.5;
        const y1 = y * Math.cos(tiltX) - z * Math.sin(tiltX);
        const z1 = y * Math.sin(tiltX) + z * Math.cos(tiltX);
        const x2 = x * Math.cos(rz) - y1 * Math.sin(rz);
        const y2 = x * Math.sin(rz) + y1 * Math.cos(rz);
        const persp = 1 / (1 + z1 * 0.0016);
        glowCircle(p, cx + x2 * persp, cy + y2 * persp, 2.5 + high * 4, hue, 60, 100, 0.4 + high * 0.6);
      }
    }

    vignette(p, 0.55);
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
