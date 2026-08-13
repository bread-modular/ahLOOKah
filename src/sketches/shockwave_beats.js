// Shockwave Beats — every kick detonates a triple chromatic shockwave.
// Three staggered rings per hit, alpha falling off with radius, screen shake
// on big kicks, and gravity sparks arcing off the blast. Highs dust the air.
// The opted-in path consumes hue/band/shake scalars plus one-shot kick events
// from a DOM-free capture-side controller; the legacy raw-frame path is kept.
import { makeBands, vignette } from './viz-utils.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    hueOffset: { min: 0, max: 360, neutral: 0 },
    sub: { min: 0, max: 1.6, neutral: 0 },
    high: { min: 0, max: 1.6, neutral: 0 },
    shake: { min: 0, max: 14, neutral: 0 },
  },
  arrays: {},
  events: {
    'kick': { fields: { power: { min: 0, max: 1.6, required: true } } },
  },
  neutral: {
    continuous: { hueOffset: 0, sub: 0, high: 0, shake: 0 },
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
// the screen-shake envelope. Wave and spark geometry stays visual.
export function createAudioController({ rng = Math.random } = {}) {
  const random = typeof rng === 'function' ? rng : Math.random;
  let eventCounter = 0;
  let hueOffset = 0;
  let prevSub = 0;
  let shake = 0;
  let s = 0, m = 0, h = 0, e = 0;
  const event = (type, values = {}) => ({ id: `${type}-${++eventCounter}`, type, ...values });

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

      const threshold = Number(params.threshold ?? 0.3);
      hueOffset = (hueOffset + (0.4 + b.energy * 2) * dt * 60) % 360;

      const events = [];
      // Kick: rising edge fires the triple shockwave, shake and sparks.
      if (b.sub > threshold && b.sub > prevSub + 0.02) {
        shake = Math.min(14, b.sub * 22);
        events.push(event('kick', { power: b.sub }));
      }
      prevSub = b.sub;
      // Legacy per-frame shake decay (0.85) calibrated to elapsed seconds.
      shake *= Math.pow(0.85, 60 * dt);

      return {
        continuous: {
          hueOffset,
          sub: clamp(b.sub, 0, 1.6),
          high: clamp(b.high, 0, 1.6),
          shake: clamp(shake, 0, 14),
        },
        arrays: {},
        events,
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  const waves = [];
  const sparks = [];
  let hueOffset = 0;
  let prevSub = 0;
  let shake = 0;
  const getBands = makeBands();
  const audioControls = runtimeContext?.audioControls || null;

  function spawnKick(power) {
    const P = params || {};
    const hue = (hueOffset + p.random(-20, 20) + 360) % 360;
    for (let k = 0; k < 3; k++) {
      waves.push({ r: -k * 14, hue: (hue + k * 24) % 360, power, w: (3 - k) * 3 });
    }
    const n = Math.floor(10 + power * 30);
    const cx = p.width / 2;
    const cy = p.height / 2;
    for (let i = 0; i < n; i++) {
      const a = p.random(p.TWO_PI);
      const sp = p.random(2, 9) * (0.5 + power);
      sparks.push({ x: cx, y: cy, vx: p.cos(a) * sp, vy: p.sin(a) * sp - 1, life: 1, hue });
    }
  }

  function drawScene(high) {
    const P = params || {};
    const speed = P.speed ?? 1;
    const chroma = P.chroma ?? 1;

    const cx = p.width / 2;
    const cy = p.height / 2;
    const maxR = Math.hypot(p.width, p.height) * 0.6;

    // Screen shake (decays on the control side; amplitude arrives as a scalar)
    p.translate(p.random(-shake, shake), p.random(-shake, shake));

    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 26);
    p.rect(-20, -20, p.width + 40, p.height + 40);
    p.blendMode(p.ADD);

    // Shockwave rings with chromatic edges
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      w.r += (3 + w.power * 9) * speed;
      if (w.r < 0) continue;
      const life = 1 - w.r / maxR;
      if (life <= 0) {
        waves.splice(i, 1);
        continue;
      }
      const alpha = life * life * 255;
      for (let cIdx = -1; cIdx <= 1; cIdx++) {
        const rr = w.r + cIdx * chroma * 6 * (1 + w.r * 0.01);
        if (rr <= 0) continue;
        const hue = (w.hue + cIdx * 60 * chroma + 360) % 360;
        p.stroke(hue, 80, 95, alpha * (cIdx === 0 ? 0.9 : 0.4));
        p.strokeWeight(Math.max(0.5, w.w * life * (cIdx === 0 ? 1.6 : 1)));
        p.noFill();
        p.circle(cx, cy, rr * 2);
      }
    }

    // Gravity sparks
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.12;
      s.vx *= 0.99;
      s.life -= 0.02;
      if (s.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      p.noStroke();
      p.fill(s.hue, 60, 100, s.life * 240);
      p.circle(s.x, s.y, 1 + s.life * 3);
    }

    // High-frequency dust in the air
    if (high > 0.3) {
      p.noStroke();
      for (let i = 0; i < high * 12; i++) {
        p.fill((hueOffset + 180) % 360, 40, 100, high * 160);
        p.circle(p.random(p.width), p.random(p.height), p.random(1, 2.5));
      }
    }

    vignette(p, 0.5);
  }

  function drawMigrated() {
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    hueOffset = C.hueOffset;
    shake = C.shake;

    const P = params || {};
    const maxWaves = Math.floor(P.max ?? 24);

    const events = audioControls.consumeEvents();
    for (const item of events) {
      if (item.type === 'kick' && waves.length < maxWaves) {
        spawnKick(item.power);
      }
    }

    drawScene(C.high);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    const P = params || {};
    const threshold = P.threshold ?? 0.3;
    const maxWaves = Math.floor(P.max ?? 24);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, params);
    const t = p.frameCount;
    const idle = 0.5 + 0.5 * p.sin(t * 0.05);
    const sub = freqs ? b.sub : (idle > 0.85 ? idle * 0.5 : 0.1);
    const high = freqs ? b.high : idle * 0.3;

    hueOffset = (hueOffset + 0.4 + b.energy * 2) % 360;

    // Kick: spawn triple staggered rings + shake + gravity sparks
    if (sub > threshold && sub > prevSub + 0.02 && waves.length < maxWaves) {
      spawnKick(sub);
      shake = Math.min(14, sub * 22);
    }
    prevSub = sub;

    drawScene(high);
    shake *= 0.85;
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
