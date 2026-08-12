// Slice Glitch — horizontal tape-tear. A neon test pattern is rendered to an
// offscreen buffer, then random horizontal bands are displaced with wraparound,
// the whole frame occasionally slips vertically (bad hold), and chunky
// block-repeat / solid-chip artifacts land on top. Audio energy scales how
// hard the tear hits; it keeps tearing gently without audio too.
// Opted-in renderers consume the hot scalar and hold-roll events from the
// capture owner; the legacy raw audio path is kept for all other callers.
import { makeBands } from './viz-utils.js';

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    hot: { min: 0, max: 1.7, neutral: 0.46 },
  },
  arrays: {},
  events: {
    'hold-roll': { fields: {} },
  },
  neutral: {
    continuous: { hot: 0.46 },
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

// The controller owns the energy envelope, the hot tear scalar, and the
// time-based vertical-hold roll trigger (legacy per-frame chance
// 0.006 + energy*pulse*0.02, converted to a per-second rate).
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
      const pulse = Number.isFinite(params.pulse) ? params.pulse : 1;
      t += dt * (0.4 + speed);

      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const hasAudio = Boolean(freqs?.left?.length);
      const raw = rawBands(freqs.left, params);
      s = bandFollow(s, raw.sub, 0.6, 0.14, dt);
      m = bandFollow(m, raw.mid, 0.6, 0.14, dt);
      h = bandFollow(h, raw.high, 0.6, 0.14, dt);
      e = bandFollow(e, raw.energy, 0.6, 0.14, dt);

      const energy = hasAudio ? e : 0.24 + 0.1 * Math.sin(t * 1.1);
      const hot = clamp((0.4 + energy * pulse) * 1.15, 0, 1.7);

      const events = [];
      if (chanceForRate((0.006 + energy * pulse * 0.02) * 60, dt)) {
        events.push(event('hold-roll'));
      }

      return {
        continuous: { hot },
        arrays: {},
        events,
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let buf = null;
  let bw = 0;
  let bh = 0;
  let t = 0;
  let rollY = 0;
  const audioControls = runtimeContext?.audioControls || null;
  const getBands = makeBands();

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    p.noStroke();
  };

  // Half-res buffer: cheap to redraw, crunchy upscale suits the look.
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

  function drawPattern() {
    buf.background(252, 55, 9);
    // sliding diagonal neon stripes
    const stripeW = bw / 12;
    const slide = (t * 40) % (stripeW * 2);
    for (let i = -2; i < 15; i++) {
      buf.push();
      buf.translate(i * stripeW + slide, bh * 0.5);
      buf.rotate(-0.32);
      buf.fill(((i * 28 + t * 46) % 360 + 360) % 360, 85, 95, 150);
      buf.rect(-stripeW * 0.34, -bh, stripeW * 0.68, bh * 2);
      buf.pop();
    }
    // orbiting orbs with hot cores
    for (let i = 0; i < 5; i++) {
      const ox = bw * (0.5 + 0.38 * Math.sin(t * 0.9 + i * 2.2));
      const oy = bh * (0.5 + 0.34 * Math.cos(t * 0.72 + i * 1.63));
      const r = bh * (0.05 + 0.035 * (1 + Math.sin(t * 2.1 + i)));
      buf.fill(((t * 64 + i * 58) % 360 + 360) % 360, 90, 100, 225);
      buf.circle(ox, oy, r * 2);
      buf.fill(0, 0, 100, 90);
      buf.circle(ox, oy, r * 0.9);
    }
  }

  function drawTears(hot) {
    const P = params || {};
    const sliceCount = P.slices ?? 10;
    const shift = P.shift ?? 0.5;
    const blockCount = P.blocks ?? 8;

    ensureBuffer();
    drawPattern();

    p.background(0, 0, 0);
    const ctx = p.drawingContext;
    ctx.imageSmoothingEnabled = false;
    const kx = p.width / bw;
    const ky = p.height / bh;

    // vertical hold slip: the whole frame rolls a little, then settles
    rollY *= 0.88;
    if (Math.abs(rollY) > 0.5) {
      p.image(buf, 0, rollY, p.width, p.height);
      p.image(buf, 0, rollY > 0 ? rollY - p.height : rollY + p.height, p.width, p.height);
    } else {
      p.image(buf, 0, 0, p.width, p.height);
    }

    // horizontal slice tears with wraparound
    const n = Math.floor(sliceCount * hot * p.random(0.45, 1));
    for (let i = 0; i < n; i++) {
      const sy = Math.floor(Math.random() * (bh - 2));
      const sh = Math.max(2, Math.floor(2 + Math.random() * bh * 0.09));
      const dx = Math.round((Math.random() * 2 - 1) * shift * bw * 0.55 * hot);
      if (dx === 0) continue;
      const dy = sy * ky;
      const dh = sh * ky;
      p.image(buf, dx * kx, dy, p.width, dh, 0, sy, bw, sh);
      // wrap so the tear never leaves a black gap
      p.image(buf, dx > 0 ? dx * kx - p.width : dx * kx + p.width, dy, p.width, dh, 0, sy, bw, sh);
    }

    // block artifacts: repeated regions + solid neon chips
    const nb = Math.floor(blockCount * hot * p.random(0.35, 1));
    for (let i = 0; i < nb; i++) {
      if (Math.random() < 0.55) {
        const sw2 = Math.max(4, Math.floor(bw * p.random(0.06, 0.3)));
        const sh2 = Math.max(4, Math.floor(bh * p.random(0.06, 0.26)));
        const sx = Math.floor(Math.random() * (bw - sw2));
        const sy = Math.floor(Math.random() * (bh - sh2));
        const dx = Math.floor(Math.random() * (bw - sw2));
        const dy = Math.floor(Math.random() * (bh - sh2));
        p.image(buf, dx * kx, dy * ky, sw2 * kx, sh2 * ky, sx, sy, sw2, sh2);
      } else {
        p.fill(Math.floor(Math.random() * 360), 90, 100, 210);
        p.rect(Math.random() * p.width, Math.random() * p.height,
          p.random(12, 90), p.random(4, 26));
      }
    }

    ctx.imageSmoothingEnabled = true;
  }

  function drawMigrated() {
    const P = params || {};
    const speed = P.speed ?? 1;

    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    t += dt * (0.4 + speed);

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const events = audioControls.consumeEvents();
    for (const item of events) {
      if (item.type === 'hold-roll') {
        rollY = p.random(-0.12, 0.12) * p.height;
      }
    }

    drawTears(C.hot);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    const P = params || {};
    const speed = P.speed ?? 1;
    const pulse = P.pulse ?? 1;

    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    t += dt * (0.4 + speed);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const energy = freqs ? b.energy : 0.24 + 0.1 * Math.sin(t * 1.1);
    const hot = Math.min(1.7, (0.4 + energy * pulse) * 1.15);

    // vertical hold slip: the whole frame rolls a little, then settles
    if (Math.random() < 0.006 + energy * pulse * 0.02) {
      rollY = p.random(-0.12, 0.12) * p.height;
    }

    drawTears(hot);
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
