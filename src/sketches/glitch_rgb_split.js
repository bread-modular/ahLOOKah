// RGB Split — chromatic aberration bursts. A retro broadcast test pattern is
// rendered to an offscreen buffer, then stamped three times through red,
// green and blue tint passes with ADD blending. Where the passes align the
// image reconstructs clean; highs (or random glitches) fire offset bursts
// that tear the channels apart into fringes.
// Opted-in renderers consume the burst envelope from the capture owner; the
// legacy raw audio path is kept for all other callers.
import { makeBands } from './viz-utils.js';

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    burst: { min: 0, max: 1, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { burst: 0 },
  },
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Legacy byte-band extraction + per-frame envelope (mirrors viz-utils makeBands).
function rawBands(freqs, params) {
  if (!freqs?.length) return { sub: 0, mid: 0, high: 0, energy: 0 };
  const bb = params?.bass ?? 1;
  const mb = params?.mid ?? 1;
  const hb = params?.high ?? 1;
  let sub = 0; let mid = 0; let high = 0;
  for (let i = 0; i < 4; i++) sub += freqs[i] || 0;
  for (let i = 40; i < 150; i++) mid += freqs[i] || 0;
  for (let i = 150; i < 500; i++) high += freqs[i] || 0;
  sub = (sub / (4 * 255)) * bb;
  mid = (mid / (110 * 255)) * mb;
  high = (high / (350 * 255)) * hb;
  return { sub, mid, high, energy: (sub + mid + high) / 3 };
}

const bandFollow = (cur, target, atk, rel, dt) => {
  const alpha = target > cur ? 1 - Math.pow(1 - atk, dt * 60) : 1 - Math.pow(1 - rel, dt * 60);
  return cur + (target - cur) * alpha;
};

// The controller owns the high-band envelope and the burst trigger/decay. The
// old renderer fired a burst per frame with P = (hotHigh ? 0.4 : 0) + 0.018 and
// decayed it by 0.86/frame; both are converted to per-second rates so cadence
// does not change the look.
export function createAudioController({ rng = Math.random } = {}) {
  const random = typeof rng === 'function' ? rng : Math.random;
  let s = 0; let m = 0; let h = 0; let e = 0;
  let burst = 0;
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const raw = rawBands(freqs.left, params);
      s = bandFollow(s, raw.sub, 0.6, 0.14, dt);
      m = bandFollow(m, raw.mid, 0.6, 0.14, dt);
      h = bandFollow(h, raw.high, 0.6, 0.14, dt);
      e = bandFollow(e, raw.energy, 0.6, 0.14, dt);

      const pulse = Number.isFinite(params.pulse) ? params.pulse : 1;
      // Burst triggers: sharp highs, plus rare random glitches when idle.
      const hot = h * pulse > 0.32;
      const ratePerSecond = (hot ? 0.4 : 0) * 60 + 0.018 * 60;
      if (random() < 1 - Math.exp(-ratePerSecond * dt)) burst = 1;
      burst *= Math.pow(0.86, 60 * dt);
      if (burst < 1e-4) burst = 0;

      return {
        continuous: { burst: clamp(burst, 0, 1) },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let buf = null;
  let bw = 0;
  let bh = 0;
  let burst = 0;
  let t = 0;
  const audioControls = runtimeContext?.audioControls || null;
  const getBands = makeBands();

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.noStroke();
  };

  // Half-res buffer: cheap to redraw, and the crunchy upscale suits the look.
  function ensureBuffer() {
    const w = Math.max(64, Math.min(960, Math.floor(p.width / 2)));
    const h = Math.max(64, Math.floor((w * p.height) / Math.max(1, p.width)));
    if (!buf || bw !== w || bh !== h) {
      bw = w;
      bh = h;
      if (buf) buf.remove();
      buf = p.createGraphics(w, h);
      buf.pixelDensity(1);
      buf.noStroke();
      buf.colorMode(p.HSB, 360, 100, 100, 255);
    }
  }

  function drawSignal() {
    buf.background(0, 0, 5);
    // color bars
    const bars = 8;
    const barH = bh * 0.55;
    for (let i = 0; i < bars; i++) {
      buf.fill(((i / bars) * 360 + t * 30) % 360, 82, 92);
      buf.rect((i * bw) / bars + 1, 0, bw / bars - 2, barH);
    }
    // pulsing target circles
    const r = bh * (0.16 + 0.05 * Math.sin(t * 2.3));
    buf.fill(0, 0, 100);
    buf.circle(bw / 2, bh * 0.66, r * 2.4);
    buf.fill((t * 55) % 360, 90, 100);
    buf.circle(bw / 2, bh * 0.66, r * 1.5);
    buf.fill(0, 0, 8);
    buf.circle(bw / 2, bh * 0.66, r * 0.6);
    // scrolling sync ticks
    for (let i = 0; i < 10; i++) {
      const x = ((i * 131 + t * 90) % (bw + 60)) - 60;
      buf.fill(0, 0, i % 2 ? 75 : 35);
      buf.rect(x, bh * 0.88, 46, bh * 0.05);
    }
  }

  function drawStamp(burst) {
    const P = params || {};
    const intensity = P.intensity ?? 0.4;
    const burstAmt = P.burst ?? 1;

    ensureBuffer();
    drawSignal();

    p.background(0);
    const wob = Math.sin(t * 1.8) * 0.6 + Math.sin(t * 0.7 + 1.3) * 0.4;
    const offX = intensity * 12 * wob + burst * burstAmt * 70;
    const offY = intensity * 5 * Math.cos(t * 1.2) + burst * burstAmt * 26;

    // Hard-pixel upscale keeps the fringes crisp
    const ctx = p.drawingContext;
    ctx.imageSmoothingEnabled = false;
    p.blendMode(p.ADD);
    p.tint(255, 0, 0);
    p.image(buf, offX, offY, p.width, p.height);
    p.tint(0, 255, 0);
    p.image(buf, 0, 0, p.width, p.height);
    p.tint(0, 0, 255);
    p.image(buf, -offX, -offY, p.width, p.height);
    p.noTint();
    p.blendMode(p.BLEND);
    ctx.imageSmoothingEnabled = true;

    // White-out flash on the hardest bursts
    if (burst > 0.85) {
      p.fill(255, 255, 255, 24);
      p.rect(0, 0, p.width, p.height);
    }
  }

  function drawMigrated() {
    const P = params || {};
    const speed = P.speed ?? 1;

    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    t += dt * (0.4 + speed);

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    drawStamp(C.burst);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    const P = params || {};
    const intensity = P.intensity ?? 0.4;
    const burstAmt = P.burst ?? 1;
    const speed = P.speed ?? 1;
    const pulse = P.pulse ?? 1;

    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    t += dt * (0.4 + speed);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const high = freqs ? b.high : 0;

    // Burst triggers: sharp highs, plus rare random glitches when idle
    if ((high * pulse > 0.32 && Math.random() < 0.4) || Math.random() < 0.018) {
      burst = 1;
    }
    burst *= 0.86;

    drawStamp(burst);
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
