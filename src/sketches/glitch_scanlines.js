// Scanline Roll — broken broadcast monitor. A dim surveillance-style signal
// is overlaid with rolling scan bands (bright leading edge + dark smear),
// per-row horizontal jitter and occasional full-frame hold jumps. Mids/highs
// push the instability hotter; everything still drifts when audio is absent.
// Opted-in renderers consume drive/hot controls and hold-jump events from the
// capture owner; the legacy raw audio path is kept for all other callers.
import { makeBands } from './viz-utils.js';

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    drive: { min: 0, max: 1.6, neutral: 0 },
    hot: { min: 0, max: 1.6, neutral: 0.55 },
  },
  arrays: {},
  events: {
    'hold-jump': { fields: {} },
  },
  neutral: {
    continuous: { drive: 0, hot: 0.55 },
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

// The controller owns the mid/high drive envelope, the hot instability scalar,
// and the time-based hold-jump trigger (legacy per-frame chance 0.004 + hot*0.010
// + drive*pulse*0.02, converted to a per-second rate).
export function createAudioController({ rng = Math.random } = {}) {
  const random = typeof rng === 'function' ? rng : Math.random;
  let s = 0; let m = 0; let h = 0; let e = 0;
  let t = 0;
  let eventCounter = 0;
  const event = (type, values = {}) => ({ id: `${type}-${++eventCounter}`, type, ...values });
  const chanceForRate = (ratePerSecond, dt) => random() < 1 - Math.exp(-Math.max(0, ratePerSecond) * dt);

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const speed = Number.isFinite(params.speed) ? params.speed : 1;
      const intensity = Number.isFinite(params.intensity) ? params.intensity : 1;
      const pulse = Number.isFinite(params.pulse) ? params.pulse : 1;
      t += dt * (0.5 + speed);

      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const hasAudio = Boolean(freqs?.left?.length);
      const raw = rawBands(freqs.left, params);
      s = bandFollow(s, raw.sub, 0.6, 0.14, dt);
      m = bandFollow(m, raw.mid, 0.6, 0.14, dt);
      h = bandFollow(h, raw.high, 0.6, 0.14, dt);
      e = bandFollow(e, raw.energy, 0.6, 0.14, dt);

      const drive = hasAudio
        ? m * 0.5 + h * 0.5
        : 0.12 + 0.1 * Math.sin(t * 0.9);
      const hot = clamp(intensity * (0.55 + drive * pulse * 1.7), 0, 1.6);

      const events = [];
      if (chanceForRate((0.004 + hot * 0.010 + drive * pulse * 0.02) * 60, dt)) {
        events.push(event('hold-jump'));
      }

      return {
        continuous: {
          drive: clamp(drive, 0, 1.6),
          hot,
        },
        arrays: {},
        events,
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let scanBuf = null;
  let jump = 0;
  let t = 0;
  const audioControls = runtimeContext?.audioControls || null;
  const getBands = makeBands();

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.noStroke();
    p.textFont('monospace');
  };

  // Static scanline overlay, rebuilt only on resize (one image blit per frame).
  function ensureScanBuf() {
    if (scanBuf && scanBuf.width === p.width && scanBuf.height === p.height) return;
    if (scanBuf) scanBuf.remove();
    scanBuf = p.createGraphics(p.width, p.height);
    scanBuf.pixelDensity(1);
    scanBuf.clear();
    scanBuf.stroke(0, 0, 0, 84);
    scanBuf.strokeWeight(1);
    for (let y = 0; y < p.height; y += 3) {
      scanBuf.line(0, y + 0.5, p.width, y + 0.5);
    }
  }

  function drawSignal({ drive, hot }) {
    const P = params || {};
    const speed = P.speed ?? 1;
    const intensity = P.intensity ?? 1;
    const nBands = Math.max(1, Math.round(P.bands ?? 3));
    const pulse = P.pulse ?? 1;

    // --- base signal ------------------------------------------------------
    const ctx = p.drawingContext;
    const g = ctx.createLinearGradient(0, 0, 0, p.height);
    g.addColorStop(0, '#0b1020');
    g.addColorStop(1, '#020308');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, p.width, p.height);

    // drifting luminance blocks ("content")
    for (let i = 0; i < 7; i++) {
      const y = ((i * 173 + t * 46) % (p.height + 140)) - 70;
      const wdt = p.width * (0.18 + 0.5 * p.noise(i * 3.7, t * 0.16));
      const x = p.width * 0.5 - wdt / 2 + Math.sin(t * 0.8 + i * 2.2) * 70;
      p.fill(120 + 70 * Math.sin(i * 1.7 + t * 0.6), 150, 210, 26);
      p.rect(x, y, wdt, 12 + 26 * p.noise(i * 2.3, t * 0.25));
    }

    // drifting sync line
    const sy = ((t * 150) % (p.height + 60)) - 30;
    p.fill(190, 215, 255, 46);
    p.rect(0, sy, p.width, 3);

    // OSD corner label
    p.fill(210, 220, 235, 130);
    p.textSize(Math.max(12, p.height * 0.022));
    p.textAlign(p.LEFT, p.TOP);
    p.text(`CH-0${1 + (Math.floor(t * 0.2) % 8)}  NO SIGNAL`, 18, 14);

    // --- rolling scan bands -----------------------------------------------
    for (let i = 0; i < nBands; i++) {
      const bh2 = p.height * (0.05 + 0.05 * p.noise(i * 9.1, t * 0.1));
      const span = p.height + bh2 * 4;
      const by = ((t * p.height * (0.10 + i * 0.045) * (0.6 + drive * pulse)
        + i * (p.height / nBands)) % span) - bh2 * 2;
      // bright leading edge + dark smear behind it
      p.fill(255, 255, 255, 20 + 30 * drive * pulse);
      p.rect(0, by, p.width, bh2 * 0.32);
      p.fill(0, 0, 0, 64);
      p.rect(0, by + bh2 * 0.32, p.width, bh2);
    }

    // --- row jitter ---------------------------------------------------------
    const jitters = Math.floor(2 + hot * 9);
    for (let i = 0; i < jitters; i++) {
      if (Math.random() > 0.35 + hot * 0.28) continue;
      const y = Math.floor(Math.random() * p.height);
      const h = Math.max(2, Math.floor(2 + Math.random() * (5 + hot * 24)));
      const dx = Math.floor((Math.random() * 2 - 1) * (6 + hot * 44));
      if (dx !== 0 && y + h <= p.height) {
        p.copy(0, y, p.width, h, dx, y, p.width, h);
      }
    }

    // --- occasional full-frame hold jump -------------------------------------
    if (jump > 0.06) {
      const jx = Math.round((Math.random() * 2 - 1) * 34 * jump * Math.max(0.4, intensity));
      const jy = Math.round((Math.random() * 2 - 1) * 26 * jump * Math.max(0.4, intensity));
      p.copy(0, 0, p.width, p.height, jx, jy, p.width, p.height);
      if (jump > 0.7 && Math.random() < 0.45) {
        p.fill(255, 255, 255, 16);
        p.rect(0, 0, p.width, p.height);
      }
      jump *= 0.72;
    }

    // --- static scanline overlay ---------------------------------------------
    ensureScanBuf();
    p.image(scanBuf, 0, 0);
  }

  function drawMigrated() {
    const P = params || {};
    const speed = P.speed ?? 1;

    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    t += dt * (0.5 + speed);

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const events = audioControls.consumeEvents();
    for (const item of events) {
      if (item.type === 'hold-jump') jump = 1;
    }

    drawSignal({ drive: C.drive, hot: C.hot });
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    const P = params || {};
    const speed = P.speed ?? 1;
    const intensity = P.intensity ?? 1;
    const nBands = Math.max(1, Math.round(P.bands ?? 3));
    const pulse = P.pulse ?? 1;

    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    t += dt * (0.5 + speed);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const drive = freqs
      ? b.mid * 0.5 + b.high * 0.5
      : 0.12 + 0.1 * Math.sin(t * 0.9);
    const hot = Math.min(1.6, intensity * (0.55 + drive * pulse * 1.7));

    // --- occasional full-frame hold jump -------------------------------------
    if (Math.random() < 0.004 + hot * 0.010 + drive * pulse * 0.02) jump = 1;

    drawSignal({ drive, hot });
  }

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
    if (scanBuf) {
      scanBuf.remove();
      scanBuf = null;
    }
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
