// Starfield Rush — a warp-speed starfield tunnel.
// GPU port: the CPU keeps the exact star state (positions/velocity) and
// advances it in mapUniforms; the fragment shader derives scale, brightness,
// hue and the warp streaks per-pixel, so there are no per-frame 2D draw calls.
// The legacy raw-frame path stays intact; opted-in renderers consume final
// controls (warp speed, hue, bands) produced by a capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const MAX_STARS = 600;

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uStars[${MAX_STARS * 4}]; // x, y, z, size
  uniform float uCount;
  uniform float uSpeed;   // current warp speed (px/frame)
  uniform float uHueOffset;
  uniform float uSparkle;

  // CPU canvas semantics: pixel space, origin top-left, y down.
  vec2 toPx(vec2 uv) {
    return vec2((uv.x * 0.5 + 0.5) * uResolution.x, (1.0 - (uv.y * 0.5 + 0.5)) * uResolution.y);
  }

  float dotGlow(float d, float r) {
    return exp(-(d * d) / max(r * r, 0.001));
  }

  float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
    return length(p - (a + ab * t));
  }

  void main() {
    vec2 px = toPx(vTexCoord);
    vec2 center = uResolution * 0.5;
    float w = max(uResolution.x, 1.0);
    vec3 color = vec3(0.0);

    for (int i = 0; i < ${MAX_STARS}; i++) {
      if (float(i) >= uCount) break;
      float x = uStars[i * 4 + 0];
      float y = uStars[i * 4 + 1];
      float z = uStars[i * 4 + 2];
      float size = uStars[i * 4 + 3];

      float scale = mix(1.0, 0.02, z / w); // map(z, 0, w, 1, 0.02)
      vec2 pos = center + (vec2(x, y) - center) * scale;
      float brightness = mix(40.0, 255.0, 1.0 - z / w) + uHigh * 120.0 * uSparkle;
      float alpha = min(1.0, brightness / 255.0);
      float hue = mod(uHueOffset + z * 0.2, 360.0) / 360.0;

      // Long streak lines sell the warp speed on loud bass.
      if (uSpeed > 6.0) {
        float prevScale = mix(1.0, 0.02, (z + uSpeed) / w);
        vec2 prevPos = center + (vec2(x, y) - center) * prevScale;
        float sd = segDist(px, prevPos, pos);
        float weight = max(0.5, size * scale * 2.2);
        color += hsv2rgb(vec3(hue, 0.9, 1.0)) * alpha * exp(-(sd * sd) / max(weight * weight * 0.25, 0.001));
      } else {
        float d = length(px - pos);
        float radius = max(0.3, size * scale);
        color += hsv2rgb(vec3(hue, 0.9, 1.0)) * alpha * dotGlow(d, radius);
      }
    }

    // Center flash + random sparkles on loud highs.
    if (uHigh > 0.45 && uSparkle > 0.05) {
      float flash = (uHigh - 0.45) * uSparkle;
      color += hsv2rgb(vec3(uHueOffset / 360.0, 0.8, 1.0))
        * (flash * 180.0 / 255.0) * dotGlow(length(px - center), 210.0 * flash);
    }

    // The CPU version clears fully every frame (background()), so no exposure
    // multiplier is needed here — this is exactly one additive frame.
    color = filmicTone(color);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    hueOffset: { min: 0, max: 360, neutral: 0 },
    speed: { min: 0, max: 200, neutral: 2 },
    uSub: { min: 0, max: 1.6, neutral: 0 },
    uMid: { min: 0, max: 1.6, neutral: 0 },
    uHigh: { min: 0, max: 1.6, neutral: 0 },
    uEnergy: { min: 0, max: 1.6, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { hueOffset: 0, speed: 2, uSub: 0, uMid: 0, uHigh: 0, uEnergy: 0 },
  },
});

// Same raw band extraction as the original (warp/hue/sparkle controls only).
export function bands(freqs) {
  if (!freqs) return { sub: 0, mid: 0, high: 0, energy: 0 };
  let sub = 0, mid = 0, high = 0;
  for (let i = 0; i < 4; i++) sub += freqs[i];
  for (let i = 40; i < 150; i++) mid += freqs[i];
  for (let i = 150; i < 500; i++) high += freqs[i];
  sub = sub / (4 * 255);
  mid = mid / (110 * 255);
  high = high / (350 * 255);
  return { sub, mid, high, energy: (sub + mid + high) / 3 };
}

// The controller owns band extraction, the time-based hue drift and the warp
// speed. Star positions stay on the renderer; they only consume the final speed.
export function createAudioController({ rng = Math.random } = {}) {
  let hueOffset = 0;

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const b = bands(freqs.left);
      const warp = Math.max(0, Number(params.warp ?? 1));
      const hueDrift = Math.max(0, Number(params.hue ?? 1));

      hueOffset = (hueOffset + (0.2 + b.energy * 2) * hueDrift * dt * 60) % 360;

      return {
        continuous: {
          hueOffset,
          speed: (2 + b.sub * 18) * warp,
          uSub: b.sub,
          uMid: b.mid,
          uHigh: b.high,
          uEnergy: b.energy,
        },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => {
  const audioControls = runtimeContext?.audioControls || null;
  let stars = [];
  let hueOffset = 0;

  function makeStar(p) {
    return {
      x: Math.random() * 2 * p.width - p.width,   // p.random(-w, w)
      y: Math.random() * 2 * p.height - p.height, // p.random(-h, h)
      z: Math.random() * p.width,
      size: 1 + Math.random() * 2.5,              // p.random(1, 3.5)
    };
  }

  // Grow/shrink the pool lazily so the Star Count slider works live.
  function ensureStars(n, p) {
    while (stars.length < n) stars.push(makeStar(p));
    if (stars.length > n) stars.length = n;
  }

  // Opted-in path: stars are advanced by the controller's final warp speed and
  // the shader receives the controller's band/hue uniforms. No local analysis.
  const mapUniformsMigrated = (P, bands_, p, controls) => {
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls?.continuous || {}) };
    const count = Math.floor(P.count ?? 240);
    const sparkle = P.sparkle ?? 1;
    ensureStars(count, p);

    const speed = Number.isFinite(C.speed) ? C.speed : 2;

    const arr = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const s = stars[i];
      s.z -= speed;
      if (s.z <= 0) {
        const fresh = makeStar(p);
        s.x = fresh.x;
        s.y = fresh.y;
        s.size = fresh.size;
        s.z = p.width;
      }
      arr[i * 4 + 0] = s.x;
      arr[i * 4 + 1] = s.y;
      arr[i * 4 + 2] = s.z;
      arr[i * 4 + 3] = s.size;
    }

    return {
      uStars: arr,
      uCount: count,
      uSpeed: speed,
      uHueOffset: C.hueOffset,
      uSparkle: sparkle,
      uSub: C.uSub,
      uMid: C.uMid,
      uHigh: C.uHigh,
      uEnergy: C.uEnergy,
    };
  };

  const mapUniformsLegacy = (P, bands_, p) => {
    const count = Math.floor(P.count ?? 240);
    const warp = P.warp ?? 1;
    const hueDrift = P.hue ?? 1;
    const sparkle = P.sparkle ?? 1;
    ensureStars(count, p);

    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = bands(freqs ? freqs.left : null);
    hueOffset = (hueOffset + (0.2 + b.energy * 2) * hueDrift) % 360;

    const speed = (2 + b.sub * 18) * warp;

    const arr = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const s = stars[i];
      s.z -= speed;
      if (s.z <= 0) {
        const fresh = makeStar(p);
        s.x = fresh.x;
        s.y = fresh.y;
        s.size = fresh.size;
        s.z = p.width;
      }
      arr[i * 4 + 0] = s.x;
      arr[i * 4 + 1] = s.y;
      arr[i * 4 + 2] = s.z;
      arr[i * 4 + 3] = s.size;
    }

    return {
      uStars: arr,
      uCount: count,
      uSpeed: speed,
      uHueOffset: hueOffset,
      uSparkle: sparkle,
      uSub: b.sub,
      uMid: b.mid,
      uHigh: b.high,
      uEnergy: b.energy,
    };
  };

  return makeAudioShader(
    audio,
    params,
    frag,
    audioControls ? mapUniformsMigrated : mapUniformsLegacy,
    audioControls ? { audioControls } : {},
  );
};
