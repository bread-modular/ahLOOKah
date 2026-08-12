// Particle Storm — an additive particle system that explodes on every kick.
// GPU port: the particle physics (kick rising-edge burst, wind, center
// attraction, drag, life decay, edge wrap) still runs on the CPU exactly as
// before in mapUniforms; the shader just renders the pool as additive glow
// dots and the central kick flash, so there are no per-frame 2D draw calls.
// The opted-in path receives audio controls (bands, kick envelope, wind, hue)
// from a DOM-free capture-side controller and keeps the particle pool and its
// simulation on the renderer; the legacy raw-frame path is preserved.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const MAX_PARTICLES = 800;

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uParticles[${MAX_PARTICLES * 4}]; // x, y, size+hue, life
  uniform float uCount;
  uniform float uHueOffset;

  // CPU canvas semantics: pixel space, origin top-left, y down.
  vec2 toPx(vec2 uv) {
    return vec2((uv.x * 0.5 + 0.5) * uResolution.x, (1.0 - (uv.y * 0.5 + 0.5)) * uResolution.y);
  }

  float dotGlow(float d, float r) {
    return exp(-(d * d) / max(r * r, 0.001));
  }

  void main() {
    vec2 px = toPx(vTexCoord);
    vec3 color = vec3(0.0);

    for (int i = 0; i < ${MAX_PARTICLES}; i++) {
      if (float(i) >= uCount) break;
      float x = uParticles[i * 4 + 0];
      float y = uParticles[i * 4 + 1];
      float enc = uParticles[i * 4 + 2];
      float life = uParticles[i * 4 + 3];
      if (life > 0.001) {
        float size = floor(enc / 100.0) / 10.0;          // 2.0..6.0
        float hue = mod(enc, 100.0) * 3.6;               // 0..360
        float sizeD = size * (0.6 + uKick * 2.0 + uEnergy * 1.5); // diameter
        float d = length(px - vec2(x, y));
        color += hsv2rgb(vec3(hue / 360.0, 0.9, 1.0)) * (life * 220.0 / 255.0) * dotGlow(d, sizeD * 0.5);
      }
    }

    // Central flash on kick.
    if (uKick > 0.05) {
      color += hsv2rgb(vec3(uHueOffset / 360.0, 0.8, 1.0))
        * (uKick * 60.0 / 255.0) * dotGlow(length(px - uResolution * 0.5), 150.0 * uKick);
    }

    // CPU accumulates under a 22/255 fade rect (steady state ≈ 11.6x).
    color = filmicTone(color * 11.6);
    gl_FragColor = vec4(color, 1.0);
  }
`;

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

// Same raw band extraction as the original (no responsiveness params on
// this sketch — count/burst/wind/kick are the only controls).
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

// The controller owns band extraction, hue drift, the kick rising edge and
// the decaying kick envelope. The particle pool and its simulation remain on
// the renderer because positions are canvas-space visual state.
export function createAudioController({ rng = Math.random } = {}) {
  let eventCounter = 0;
  let hueOffset = 0;
  let kick = 0; // 0..1 kick envelope
  let prevSub = 0;
  const event = (type) => ({ id: `${type}-${++eventCounter}`, type });

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const b = analyzeParticleBands(freqs.left);
      const kickSensitivity = Math.max(0, Number(params.kick ?? 1));
      const windStrength = Math.max(0, Number(params.wind ?? 1));

      hueOffset = (hueOffset + (0.5 + b.energy * 3) * dt * 60) % 360;

      // Kick: rising edge of sub-bass triggers a full burst.
      const events = [];
      if (b.sub > 0.3 / kickSensitivity && b.sub > prevSub) {
        kick = 1;
        events.push(event('kick'));
      }
      prevSub = b.sub;
      // Legacy per-frame decay kick *= 0.92, calibrated to elapsed seconds.
      kick *= Math.pow(0.92, 60 * dt);

      const windX = (b.mid - 0.5) * 6 * windStrength;
      const windY = (b.high - 0.5) * 6 * windStrength;

      return {
        continuous: {
          uSub: clamp(b.sub, 0, 1.6),
          uMid: clamp(b.mid, 0, 1.6),
          uHigh: clamp(b.high, 0, 1.6),
          uEnergy: clamp(b.energy, 0, 1.6),
          uKick: clamp(kick, 0, 1),
          uHueOffset: hueOffset,
          windX: clamp(windX, -20, 20),
          windY: clamp(windY, -20, 20),
        },
        arrays: {},
        events,
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => {
  const particles = [];
  const audioControls = runtimeContext?.audioControls || null;
  let hueOffset = 0;
  let kick = 0; // 0..1 kick envelope
  let prevSub = 0;

  // Grow the particle pool lazily so the Particle Count slider works live.
  function ensureParticles(n, p) {
    while (particles.length < n) {
      particles.push({
        x: Math.random() * p.width,
        y: Math.random() * p.height,
        vx: Math.random() * 2 - 1,
        vy: Math.random() * 2 - 1,
        hue: Math.random() * 360,
        size: 2 + Math.random() * 4,
        life: 0.3 + Math.random() * 0.7,
      });
    }
  }

  // Migrated path: physics runs on the renderer exactly as before, but every
  // audio-derived input comes from the control packet instead of the facade.
  function packParticles(C, count, p) {
    const windX = C.windX;
    const windY = C.windY;
    const arr = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const pt = particles[i];
      // Wind + mild attraction toward the center keeps the storm dense.
      pt.vx += windX * 0.2 + (p.width / 2 - pt.x) * 0.002;
      pt.vy += windY * 0.2 + (p.height / 2 - pt.y) * 0.002;
      pt.vx *= 0.985;
      pt.vy *= 0.985;
      pt.x += pt.vx;
      pt.y += pt.vy;
      pt.life = Math.max(0, pt.life - 0.004 - C.uEnergy * 0.006);

      // Wrap around the edges.
      if (pt.x < -20) pt.x = p.width + 20;
      if (pt.x > p.width + 20) pt.x = -20;
      if (pt.y < -20) pt.y = p.height + 20;
      if (pt.y > p.height + 20) pt.y = -20;

      // Pack size (0.1 resolution) and hue percent into one float so a single
      // vec4 channel carries both (size*10 in the hundreds, huePct in 0..99).
      const enc = Math.round(pt.size * 10) * 100 + Math.floor(((pt.hue % 360) / 360) * 100);
      arr[i * 4 + 0] = pt.x;
      arr[i * 4 + 1] = pt.y;
      arr[i * 4 + 2] = enc;
      arr[i * 4 + 3] = pt.life;
    }
    return arr;
  }

  const legacyMapUniforms = (P, _bands, p) => {
    // Read live params every frame so slider changes apply immediately.
    const count = Math.floor(P.count ?? 320);
    const kickSensitivity = P.kick ?? 1;
    const windStrength = P.wind ?? 1;
    ensureParticles(count, p);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = analyzeParticleBands(freqs ? freqs.left : null);
    hueOffset = (hueOffset + 0.5 + b.energy * 3) % 360;

    // Kick: rising edge of sub-bass triggers a full burst.
    if (b.sub > 0.3 / kickSensitivity && b.sub > prevSub) {
      kick = 1;
      const strength = P.burst ?? 1;
      for (const pt of particles) {
        const angle = Math.random() * Math.PI * 2;
        const speed = (2 + Math.random() * 10) * (0.5 + b.sub * 2.5) * strength;
        pt.vx = Math.cos(angle) * speed;
        pt.vy = Math.sin(angle) * speed;
        pt.hue = Math.random() * 360;
        pt.life = 1;
      }
    }
    prevSub = b.sub;
    kick = kick + (0 - kick) * 0.08;

    const windX = (b.mid - 0.5) * 6 * windStrength;
    const windY = (b.high - 0.5) * 6 * windStrength;

    const arr = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const pt = particles[i];
      // Wind + mild attraction toward the center keeps the storm dense.
      pt.vx += windX * 0.2 + (p.width / 2 - pt.x) * 0.002;
      pt.vy += windY * 0.2 + (p.height / 2 - pt.y) * 0.002;
      pt.vx *= 0.985;
      pt.vy *= 0.985;
      pt.x += pt.vx;
      pt.y += pt.vy;
      pt.life = Math.max(0, pt.life - 0.004 - b.energy * 0.006);

      // Wrap around the edges.
      if (pt.x < -20) pt.x = p.width + 20;
      if (pt.x > p.width + 20) pt.x = -20;
      if (pt.y < -20) pt.y = p.height + 20;
      if (pt.y > p.height + 20) pt.y = -20;

      // Pack size (0.1 resolution) and hue percent into one float so a single
      // vec4 channel carries both (size*10 in the hundreds, huePct in 0..99).
      const enc = Math.round(pt.size * 10) * 100 + Math.floor(((pt.hue % 360) / 360) * 100);
      arr[i * 4 + 0] = pt.x;
      arr[i * 4 + 1] = pt.y;
      arr[i * 4 + 2] = enc;
      arr[i * 4 + 3] = pt.life;
    }

    return {
      uParticles: arr,
      uCount: count,
      uHueOffset: hueOffset,
      uSub: b.sub,
      uMid: b.mid,
      uHigh: b.high,
      uEnergy: b.energy,
      uKick: kick,
    };
  };

  const migratedMapUniforms = (P, _bands, p, controls) => {
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls?.continuous || {}) };
    const count = Math.floor(P.count ?? 320);
    ensureParticles(count, p);

    // One-shot kick burst, triggered only by the capture-side controller.
    const events = audioControls.consumeEvents();
    if (events.some((item) => item.type === 'kick')) {
      const strength = P.burst ?? 1;
      for (const pt of particles) {
        const angle = p.random() * Math.PI * 2;
        const speed = (2 + p.random() * 10) * (0.5 + C.uSub * 2.5) * strength;
        pt.vx = Math.cos(angle) * speed;
        pt.vy = Math.sin(angle) * speed;
        pt.hue = p.random() * 360;
        pt.life = 1;
      }
    }

    return {
      uParticles: packParticles(C, count, p),
      uCount: count,
      uHueOffset: C.uHueOffset,
      uSub: C.uSub,
      uMid: C.uMid,
      uHigh: C.uHigh,
      uEnergy: C.uEnergy,
      uKick: C.uKick,
    };
  };

  return makeAudioShader(
    audio,
    params,
    frag,
    audioControls ? migratedMapUniforms : legacyMapUniforms,
    audioControls ? { audioControls } : {},
  );
};
