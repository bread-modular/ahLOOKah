// Cosmic Web — a plexus constellation that breathes with the music.
// This renderer deliberately uses Canvas 2D: the former shader uploaded nodes,
// links and pulses as large fragment uniform arrays, exceeding WebGL's uniform
// limit on common Chrome GPUs. Audio remains fully pattern-controls driven.

import { makeBands, glowCircle, vignette } from './viz-utils.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    uSub: { min: 0, max: 1.6, neutral: 0 },
    uMid: { min: 0, max: 1.6, neutral: 0 },
    uHigh: { min: 0, max: 1.6, neutral: 0 },
    uEnergy: { min: 0, max: 1.6, neutral: 0 },
    uHueOffset: { min: 0, max: 360, neutral: 0 },
  },
  arrays: {},
  events: {
    'kick': { fields: {} },
    'shooting-star': { fields: {} },
  },
  neutral: {
    continuous: { uSub: 0, uMid: 0, uHigh: 0, uEnergy: 0, uHueOffset: 0 },
  },
});

function boostedBands(freqs, params) {
  if (!freqs?.length) return { sub: 0, mid: 0, high: 0, energy: 0 };
  const bassGain = Math.max(0, Number(params?.bass ?? 1));
  const midGain = Math.max(0, Number(params?.mid ?? 1));
  const highGain = Math.max(0, Number(params?.high ?? 1));
  let sub = 0, mid = 0, high = 0;
  for (let i = 0; i < 4; i++) sub += freqs[i] || 0;
  for (let i = 40; i < 150; i++) mid += freqs[i] || 0;
  for (let i = 150; i < 500; i++) high += freqs[i] || 0;
  sub = clamp((sub / (4 * 255)) * bassGain, 0, 1.6);
  mid = clamp((mid / (110 * 255)) * midGain, 0, 1.6);
  high = clamp((high / (350 * 255)) * highGain, 0, 1.6);
  return { sub, mid, high, energy: clamp((sub + mid + high) / 3, 0, 1.6) };
}

export function createAudioController({ rng = Math.random } = {}) {
  const random = typeof rng === 'function' ? rng : Math.random;
  let eventCounter = 0;
  let hueOffset = 0;
  let prevSub = 0;
  const event = (type) => ({ id: `${type}-${++eventCounter}`, type });
  const chanceForRate = (ratePerSecond, dt) => random() < 1 - Math.exp(-Math.max(0, ratePerSecond) * dt);

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const bands = boostedBands(freqs.left, params);
      hueOffset = (hueOffset + (0.25 + bands.energy * 1.5) * dt * 60) % 360;
      const events = [];
      if (bands.sub > 0.4 && bands.sub > prevSub + 0.03) events.push(event('kick'));
      prevSub = bands.sub;
      if (bands.high > 0.35 && chanceForRate(bands.high * 0.1 * 60, dt)) {
        events.push(event('shooting-star'));
      }
      return {
        continuous: {
          uSub: bands.sub,
          uMid: bands.mid,
          uHigh: bands.high,
          uEnergy: bands.energy,
          uHueOffset: hueOffset,
        },
        arrays: {},
        events,
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  const nodes = [];
  const pulses = [];
  const audioControls = runtimeContext?.audioControls || null;
  const getBands = makeBands();
  let hueOffset = 0;
  let prevSub = 0;

  function ensureNodes(count) {
    while (nodes.length < count) {
      nodes.push({
        x: p.random(p.width),
        y: p.random(p.height),
        vx: p.random(-0.4, 0.4),
        vy: p.random(-0.4, 0.4),
        z: p.random(0.4, 1),
        hue: p.random(360),
      });
    }
    nodes.length = Math.min(nodes.length, count);
  }

  function drawScene({ sub, mid, high, energy, kicked, shootingStar }) {
    const P = params || {};
    const count = Math.floor(P.nodes ?? 90);
    const linkBase = P.link ?? 130;
    const scatter = P.scatter ?? 1;
    const drift = P.drift ?? 1;

    p.blendMode(p.BLEND);
    p.background(0, 0, 0, 255);
    p.blendMode(p.ADD);

    ensureNodes(count);
    const linkDist = linkBase * (1 + mid * 0.6);
    const centerX = p.width / 2;
    const centerY = p.height / 2;

    for (const node of nodes) {
      node.x += node.vx * drift * (0.4 + energy) * node.z;
      node.y += node.vy * drift * (0.4 + energy) * node.z;
      if (kicked) {
        const dx = node.x - centerX;
        const dy = node.y - centerY;
        const distance = Math.hypot(dx, dy) + 1;
        node.vx += (dx / distance) * sub * 2.4 * scatter;
        node.vy += (dy / distance) * sub * 2.4 * scatter;
      }
      node.vx *= 0.985;
      node.vy *= 0.985;
      if (node.x < -20) node.x = p.width + 20;
      if (node.x > p.width + 20) node.x = -20;
      if (node.y < -20) node.y = p.height + 20;
      if (node.y > p.height + 20) node.y = -20;
    }

    for (let i = 0; i < nodes.length; i++) {
      const from = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const to = nodes[j];
        const dx = from.x - to.x;
        const dy = from.y - to.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared >= linkDist * linkDist) continue;
        const distance = Math.sqrt(distanceSquared);
        const alpha = (1 - distance / linkDist) * (50 + energy * 150);
        const hue = (hueOffset + (from.hue + to.hue) / 2) % 360;
        p.stroke(hue, 75, 90, alpha);
        p.strokeWeight(0.8);
        p.line(from.x, from.y, to.x, to.y);
        if (kicked && p.random() < 0.06) {
          pulses.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y, t: 0, hue });
        }
      }
    }

    for (let i = pulses.length - 1; i >= 0; i--) {
      const pulse = pulses[i];
      pulse.t += 0.06 + energy * 0.1;
      if (pulse.t >= 1) {
        pulses.splice(i, 1);
        continue;
      }
      glowCircle(
        p,
        pulse.x1 + (pulse.x2 - pulse.x1) * pulse.t,
        pulse.y1 + (pulse.y2 - pulse.y1) * pulse.t,
        2.5,
        pulse.hue,
        50,
        100,
        1 - pulse.t,
      );
    }

    for (const node of nodes) {
      glowCircle(
        p,
        node.x,
        node.y,
        (1.5 + sub * 5) * node.z,
        (hueOffset + node.hue) % 360,
        75,
        95,
        0.35 + node.z * 0.4 + energy * 0.3,
      );
    }

    if (shootingStar && nodes.length > 1) {
      const from = nodes[Math.floor(p.random(nodes.length))];
      const to = nodes[Math.floor(p.random(nodes.length))];
      const progress = p.random();
      p.noStroke();
      p.fill(0, 0, 100, 240);
      p.circle(
        from.x + (to.x - from.x) * progress,
        from.y + (to.y - from.y) * progress,
        2 + high * 3,
      );
    }

    vignette(p, 0.5);
  }

  function drawMigrated() {
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    hueOffset = C.uHueOffset;
    const events = audioControls.consumeEvents();
    drawScene({
      sub: C.uSub,
      mid: C.uMid,
      high: C.uHigh,
      energy: C.uEnergy,
      kicked: events.some((item) => item.type === 'kick'),
      shootingStar: events.some((item) => item.type === 'shooting-star'),
    });
  }

  function drawLegacy() {
    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const bands = getBands(freqs ? freqs.left : null, params);
    const idle = 0.5 + 0.5 * p.sin(p.frameCount * 0.02);
    const energy = freqs ? bands.energy : 0.18 + idle * 0.2;
    const sub = freqs ? bands.sub : 0.2 + idle * 0.2;
    const mid = freqs ? bands.mid : 0.2;
    const high = freqs ? bands.high : idle * 0.3;
    hueOffset = (hueOffset + 0.25 + energy * 1.5) % 360;
    const kicked = sub > 0.4 && sub > prevSub + 0.03;
    prevSub = sub;
    drawScene({
      sub,
      mid,
      high,
      energy,
      kicked,
      shootingStar: high > 0.35 && p.random() < high * 0.1,
    });
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
  };

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
