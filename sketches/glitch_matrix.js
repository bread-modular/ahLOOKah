// Glitch Matrix — digital rain with a warehouse twist.
// Glowing white-hot lead glyphs, fading trails, mid-driven speed bursts per
// column, and high-frequency glitch slices that tear the screen with
// RGB-split displacement. Matrix meets mainstage.
// Opted-in renderers consume energy/sub/high/hueOffset controls plus
// column-burst and glitch-slice events from the capture owner; the legacy
// raw audio path is kept for all other callers.
import { makeBands, vignette } from './viz-utils.js';

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    energy: { min: 0, max: 1.6, neutral: 0.2 },
    sub: { min: 0, max: 1.6, neutral: 0.2 },
    high: { min: 0, max: 1.6, neutral: 0 },
    hueOffset: { min: 0, max: 360, neutral: 0 },
  },
  arrays: {},
  events: {
    'column-burst': { fields: { count: { min: 1, max: 80, integer: true, required: true } } },
    'glitch-slice': { fields: {} },
  },
  neutral: {
    continuous: { energy: 0.2, sub: 0.2, high: 0, hueOffset: 0 },
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

// The controller owns the band envelope, the hue drift, and the time-based
// random triggers: per-column speed bursts (legacy per-frame chance mid*0.02
// per column, emitted as a bounded credit) and high-frequency glitch slices
// (legacy per-frame chance high*0.3*glitch).
export function createAudioController({ rng = Math.random } = {}) {
  const random = typeof rng === 'function' ? rng : Math.random;
  let s = 0; let m = 0; let h = 0; let e = 0;
  let hueOffset = 0;
  let t = 0;
  let burstCredit = 0;
  let eventCounter = 0;
  const event = (type, values = {}) => ({ id: `${type}-${++eventCounter}`, type, ...values });
  const chanceForRate = (ratePerSecond, dt) => random() < 1 - Math.exp(-Math.max(0, ratePerSecond) * dt);

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      t += dt;

      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const hasAudio = Boolean(freqs?.left?.length);
      const raw = rawBands(freqs.left, params);
      s = bandFollow(s, raw.sub, 0.6, 0.14, dt);
      m = bandFollow(m, raw.mid, 0.6, 0.14, dt);
      h = bandFollow(h, raw.high, 0.6, 0.14, dt);
      e = bandFollow(e, raw.energy, 0.6, 0.14, dt);

      const idle = 0.5 + 0.5 * Math.sin(t * 1.2);
      const energy = hasAudio ? e : 0.2 + idle * 0.2;
      const sub = hasAudio ? s : 0.2;
      const mid = hasAudio ? m : 0.2;
      const high = hasAudio ? h : idle * 0.3;

      hueOffset = (hueOffset + (0.2 + energy) * dt * 60) % 360;

      const events = [];
      // Mid energy randomly triggers per-column speed bursts (credit-batched).
      const columns = clamp(Math.round(Number(params.columns) || 40), 1, 80);
      burstCredit += columns * mid * 0.02 * 60 * dt;
      let count = Math.floor(burstCredit);
      burstCredit -= count;
      if (random() < burstCredit) {
        count += 1;
        burstCredit = 0;
      }
      count = Math.min(count, 80);
      if (count > 0) events.push(event('column-burst', { count }));

      // RGB-split glitch slice tears on highs
      const glitch = Number.isFinite(params.glitch) ? params.glitch : 1;
      if (high > 0.3 && chanceForRate(high * 0.3 * glitch * 60, dt)) {
        events.push(event('glitch-slice'));
      }

      return {
        continuous: {
          energy: clamp(energy, 0, 1.6),
          sub: clamp(sub, 0, 1.6),
          high: clamp(high, 0, 1.6),
          hueOffset,
        },
        arrays: {},
        events,
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  const CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ01<>/\\|+=*#';
  let columns = [];
  let hueOffset = 0;
  const audioControls = runtimeContext?.audioControls || null;
  const getBands = makeBands();

  function ensureColumns(n) {
    while (columns.length < n) {
      columns.push({
        y: p.random(-p.height, 0),
        speed: p.random(2, 7),
        burst: 0,
        len: Math.floor(p.random(10, 26)),
      });
    }
    columns.length = Math.min(columns.length, n);
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    p.textFont('monospace');
  };

  function drawRain({ energy, sub, hueOffset }) {
    const P = params || {};
    const colCount = Math.floor(P.columns ?? 40);
    const speedMul = P.speed ?? 1;
    const trail = P.trail ?? 1;

    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 16 + trail * 14);
    p.rect(0, 0, p.width, p.height);
    p.blendMode(p.ADD);

    ensureColumns(colCount);

    const colW = p.width / colCount;
    const size = Math.max(12, colW * 0.9);
    p.textSize(size);
    p.textAlign(p.CENTER, p.TOP);

    for (let i = 0; i < colCount; i++) {
      const col = columns[i];
      col.burst *= 0.96;
      col.y += (col.speed + col.burst * 14) * speedMul * (0.5 + energy);
      if (col.y - col.len * size > p.height) {
        col.y = p.random(-p.height * 0.4, -size);
        col.speed = p.random(2, 7);
        col.len = Math.floor(p.random(10, 26));
      }
      const x = i * colW + colW / 2;
      const hue = (hueOffset + i * 2) % 360;
      for (let j = 0; j < col.len; j++) {
        const y = col.y - j * size;
        if (y < -size || y > p.height + size) continue;
        const tt = 1 - j / col.len;
        const ch = CHARS[Math.floor(p.random(CHARS.length))];
        if (j === 0) {
          // Glowing head: bright core + colored halo pass
          p.fill(hue, 40, 100, 255);
          p.text(ch, x, y);
          p.fill(hue, 90, 100, 90 + sub * 120);
          p.text(ch, x, y);
        } else {
          p.fill(hue, 85, 60 + tt * 35, tt * 220);
          p.text(ch, x, y);
        }
      }
    }
  }

  function drawSlice(high, glitchAmt) {
    const sy = p.random(p.height * 0.7);
    const sh = p.random(8, 40);
    const dx = p.random(-40, 40) * glitchAmt * high;
    const img = p.get(0, sy, p.width, sh);
    p.blendMode(p.BLEND);
    p.tint(0, 100, 100, 120);
    p.image(img, dx, sy);
    p.tint(180, 100, 100, 120);
    p.image(img, -dx, sy);
    p.noTint();
  }

  function drawMigrated() {
    const P = params || {};
    const glitchAmt = P.glitch ?? 1;

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const events = audioControls.consumeEvents();
    let slices = 0;
    for (const item of events) {
      if (item.type === 'column-burst') {
        const count = Math.min(item.count, columns.length);
        for (let n = 0; n < count; n++) {
          columns[Math.floor(p.random(columns.length))].burst = 1;
        }
      } else if (item.type === 'glitch-slice') {
        slices += 1;
      }
    }

    drawRain({ energy: C.energy, sub: C.sub, hueOffset: C.hueOffset });
    for (let s = 0; s < slices; s++) drawSlice(C.high, glitchAmt);

    vignette(p, 0.5);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    const P = params || {};
    const glitchAmt = P.glitch ?? 1;

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const idle = 0.5 + 0.5 * p.sin(p.frameCount * 0.02);
    const energy = freqs ? b.energy : 0.2 + idle * 0.2;
    const sub = freqs ? b.sub : 0.2;
    const mid = freqs ? b.mid : 0.2;
    const high = freqs ? b.high : idle * 0.3;

    hueOffset = (hueOffset + 0.2 + energy) % 360;

    // Mid energy randomly triggers per-column speed bursts
    for (let i = 0; i < columns.length; i++) {
      if (p.random() < mid * 0.02) columns[i].burst = 1;
    }

    drawRain({ energy, sub, hueOffset });

    // RGB-split glitch slice tears on highs
    if (high > 0.3 && p.random() < high * 0.3 * glitchAmt) {
      drawSlice(high, glitchAmt);
    }

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
