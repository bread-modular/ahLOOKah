// Particle Storm — an additive particle system that explodes on every kick.
// Particle physics and drawing intentionally stay in Canvas 2D: uploading the
// full particle pool as a fragment-uniform array exceeded WebGL's guaranteed
// uniform budget on real Chrome GPUs. The controller still owns every
// audio-derived value; this renderer only owns visual simulation and paint.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    uSub: { min: 0, max: 1.6, neutral: 0 },
    uMid: { min: 0, max: 1.6, neutral: 0 },
    uHigh: { min: 0, max: 1.6, neutral: 0 },
    uEnergy: { min: 0, max: 1.6, neutral: 0 },
    uKick: { min: 0, max: 1, neutral: 0 },
    uHueOffset: { min: 0, max: 360, neutral: 0 },
    windX: { min: -20, max: 20, neutral: 0 },
    windY: { min: -20, max: 20, neutral: 0 },
  },
  arrays: {},
  events: {
    'kick': { fields: {} },
  },
  neutral: {
    continuous: {
      uSub: 0,
      uMid: 0,
      uHigh: 0,
      uEnergy: 0,
      uKick: 0,
      uHueOffset: 0,
      windX: 0,
      windY: 0,
    },
  },
});

// Same raw band extraction as the original (no responsiveness params on this
// sketch — count/burst/wind/kick are the only controls).
export function analyzeParticleBands(freqs) {
  if (!freqs?.length) return { sub: 0, mid: 0, high: 0, energy: 0 };
  let sub = 0, mid = 0, high = 0;
  for (let i = 0; i < 4; i++) sub += freqs[i] || 0;
  for (let i = 40; i < 150; i++) mid += freqs[i] || 0;
  for (let i = 150; i < 500; i++) high += freqs[i] || 0;
  sub = sub / (4 * 255);
  mid = mid / (110 * 255);
  high = high / (350 * 255);
  return { sub, mid, high, energy: (sub + mid + high) / 3 };
}

// The controller owns band extraction, hue drift, the kick rising edge and the
// decaying kick envelope. The particle pool stays visual because positions are
// canvas-space state and never cross the audio transport.
export function createAudioController({ rng = Math.random } = {}) {
  let eventCounter = 0;
  let hueOffset = 0;
  let kick = 0;
  let prevSub = 0;
  const event = (type) => ({ id: `${type}-${++eventCounter}`, type });

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const b = analyzeParticleBands(freqs.left);
      const kickSensitivity = Math.max(0.2, Number(params.kick ?? 1));
      const windStrength = Math.max(0, Number(params.wind ?? 1));

      hueOffset = (hueOffset + (0.5 + b.energy * 3) * dt * 60) % 360;

      const events = [];
      if (b.sub > 0.3 / kickSensitivity && b.sub > prevSub) {
        kick = 1;
        events.push(event('kick'));
      }
      prevSub = b.sub;
      kick *= Math.pow(0.92, 60 * dt);

      return {
        continuous: {
          uSub: clamp(b.sub, 0, 1.6),
          uMid: clamp(b.mid, 0, 1.6),
          uHigh: clamp(b.high, 0, 1.6),
          uEnergy: clamp(b.energy, 0, 1.6),
          uKick: clamp(kick, 0, 1),
          uHueOffset: hueOffset,
          windX: clamp((b.mid - 0.5) * 6 * windStrength, -20, 20),
          windY: clamp((b.high - 0.5) * 6 * windStrength, -20, 20),
        },
        arrays: {},
        events,
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  const particles = [];
  const audioControls = runtimeContext?.audioControls || null;
  let hueOffset = 0;
  let kick = 0;
  let prevSub = 0;

  function makeParticle() {
    return {
      x: p.random(p.width),
      y: p.random(p.height),
      vx: p.random(-1, 1),
      vy: p.random(-1, 1),
      hue: p.random(360),
      size: p.random(2, 6),
      life: p.random(0.3, 1),
    };
  }

  // Grow/shrink the pool lazily so the full Particle Count slider range works.
  function ensureParticles(count) {
    while (particles.length < count) particles.push(makeParticle());
    if (particles.length > count) particles.length = count;
  }

  function burst(sub) {
    const strength = params?.burst ?? 1;
    for (const pt of particles) {
      const angle = p.random(p.TWO_PI);
      const speed = p.random(2, 12) * (0.5 + sub * 2.5) * strength;
      pt.vx = p.cos(angle) * speed;
      pt.vy = p.sin(angle) * speed;
      pt.hue = p.random(360);
      pt.life = 1;
    }
  }

  function drawScene(C) {
    const P = params || {};
    const count = Math.floor(P.count ?? 320);
    ensureParticles(count);

    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(0, 0, 0, 22);
    p.rect(0, 0, p.width, p.height);
    p.blendMode(p.ADD);

    p.noStroke();
    for (const pt of particles) {
      // Wind + mild attraction toward the center keeps the storm dense.
      pt.vx += C.windX * 0.2 + (p.width / 2 - pt.x) * 0.002;
      pt.vy += C.windY * 0.2 + (p.height / 2 - pt.y) * 0.002;
      pt.vx *= 0.985;
      pt.vy *= 0.985;
      pt.x += pt.vx;
      pt.y += pt.vy;
      pt.life = Math.max(0, pt.life - 0.004 - C.uEnergy * 0.006);

      if (pt.x < -20) pt.x = p.width + 20;
      if (pt.x > p.width + 20) pt.x = -20;
      if (pt.y < -20) pt.y = p.height + 20;
      if (pt.y > p.height + 20) pt.y = -20;

      const size = pt.size * (0.6 + C.uKick * 2 + C.uEnergy * 1.5);
      p.fill(pt.hue, 90, 100, pt.life * 220);
      p.circle(pt.x, pt.y, size);
    }

    if (C.uKick > 0.05) {
      p.fill(C.uHueOffset, 80, 100, C.uKick * 60);
      p.circle(p.width / 2, p.height / 2, 300 * C.uKick);
    }
  }

  function drawMigrated() {
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    hueOffset = C.uHueOffset;
    if (audioControls.consumeEvents().some((item) => item.type === 'kick')) burst(C.uSub);
    drawScene(C);
  }

  // Preserved raw-frame behavior for standalone callers.
  function drawLegacy() {
    const P = params || {};
    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = analyzeParticleBands(freqs ? freqs.left : null);
    const kickSensitivity = Math.max(0.2, P.kick ?? 1);
    const windStrength = P.wind ?? 1;

    hueOffset = (hueOffset + 0.5 + b.energy * 3) % 360;
    if (b.sub > 0.3 / kickSensitivity && b.sub > prevSub) {
      kick = 1;
      burst(b.sub);
    }
    prevSub = b.sub;
    kick *= 0.92;

    drawScene({
      uSub: b.sub,
      uMid: b.mid,
      uHigh: b.high,
      uEnergy: b.energy,
      uKick: kick,
      uHueOffset: hueOffset,
      windX: (b.mid - 0.5) * 6 * windStrength,
      windY: (b.high - 0.5) * 6 * windStrength,
    });
  }

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    ensureParticles(Math.floor(params?.count ?? 320));
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
