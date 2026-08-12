// Vortex Spiral — a hypnotic spiral galaxy with real depth.
// GPU port: the whole galaxy is computed per-pixel in the fragment shader
// using the same math as the original Canvas 2D version — spiral arms with
// depth falloff, faint stitching lines, a bloom core breathing with the sub,
// and drifting stardust. There are no per-frame object loops left on the CPU;
// the rotation/hue state advances in mapUniforms exactly as before.
// The legacy raw-frame path stays intact; opted-in renderers consume final
// controls (bands, rotation, hue) produced by a capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';
import { makeBands } from './viz-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uRotation;
  uniform float uHueOffset;
  uniform float uArms;
  uniform float uDensity;
  uniform float uTwist;
  uniform float uSparkle;

  // CPU canvas semantics: pixel space, origin top-left, y down.
  vec2 toPx(vec2 uv) {
    return vec2((uv.x * 0.5 + 0.5) * uResolution.x, (1.0 - (uv.y * 0.5 + 0.5)) * uResolution.y);
  }

  // Soft additive dot glow (a hard ADD circle with a gentler edge).
  float dotGlow(float d, float r) {
    return exp(-(d * d) / max(r * r, 0.001));
  }

  // Point-to-segment distance for the faint stitching lines.
  float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
    return length(p - (a + ab * t));
  }

  void main() {
    vec2 px = toPx(vTexCoord);
    vec2 center = uResolution * 0.5;
    float maxR = min(uResolution.x, uResolution.y) * 0.48 * (1.0 + uSub * 0.25);
    float twistAmt = (2.0 + uMid * 6.0) * uTwist;
    float hueBase = mod(uHueOffset, 360.0);

    vec3 color = vec3(0.0);

    // Bloom core breathing with the sub (4-layer additive glow).
    float coreR = 12.0 + uSub * 40.0;
    float coreA = 0.5 + uSub;
    float dc = length(px - center);
    float coreHue = hueBase / 360.0;
    color += hsv2rgb(vec3(coreHue, 0.8, 1.0)) * (16.0 * coreA / 255.0) * dotGlow(dc, coreR * 3.0);
    color += hsv2rgb(vec3(coreHue, 0.8, 1.0)) * (32.0 * coreA / 255.0) * dotGlow(dc, coreR * 1.6);
    color += hsv2rgb(vec3(coreHue, 0.4, 1.0)) * (90.0 * coreA / 255.0) * dotGlow(dc, coreR * 0.8);
    color += hsv2rgb(vec3(coreHue, 0.2, 1.0)) * (200.0 * coreA / 255.0) * dotGlow(dc, coreR * 0.4);

    // Spiral arms: dots are analytic functions of the rotation + radius, so the
    // fragment only inspects the three dots nearest its own radius per arm.
    vec2 q = vec2(px.x - center.x, (px.y - center.y) / 0.82);
    float r = length(q);
    float ang = atan(q.y, q.x);
    float tt = clamp(r / maxR, 0.0, 1.0);
    float i0 = clamp(floor(tt * uDensity + 0.5), 0.0, uDensity - 1.0);

    for (int a = 0; a < 12; a++) {
      if (float(a) >= uArms) break;
      float armOff = (float(a) / uArms) * VIZ_TAU;
      for (int k = 0; k < 3; k++) {
        float i = i0 + float(k) - 1.0;
        if (i >= 0.0 && i < uDensity) {
          float tti = i / uDensity;
          float angI = uRotation + armOff + tti * twistAmt;
          float rI = tti * maxR;
          vec2 dotPx = center + vec2(cos(angI) * rI, sin(angI) * rI * 0.82);
          float depth = 0.3 + tti * 0.7;
          float hue = mod(hueBase + tti * 120.0 + float(a) * 20.0, 360.0) / 360.0;
          float size = (1.0 + tti * 4.0) * (1.0 + uEnergy * 0.8);
          float d = length(px - dotPx);
          color += hsv2rgb(vec3(hue, 0.8, 0.95)) * ((50.0 + depth * 150.0) / 255.0) * dotGlow(d, size * 1.1);
          color += hsv2rgb(vec3(hue, 0.4, 1.0)) * ((110.0 + depth * 130.0) / 255.0) * dotGlow(d, size * 0.5);
          // Faint stitching line from the previous dot (k=1 and k=2 cover the
          // segments straddling the fragment's radius).
          if (k >= 1 && i >= 1.0) {
            float ttp = (i - 1.0) / uDensity;
            float angP = uRotation + armOff + ttp * twistAmt;
            float rP = ttp * maxR;
            vec2 prevPx = center + vec2(cos(angP) * rP, sin(angP) * rP * 0.82);
            float sd = segDist(px, prevPx, dotPx);
            color += hsv2rgb(vec3(hue, 0.7, 0.8)) * ((24.0 + depth * 40.0) / 255.0) * exp(-(sd * sd) / 0.24);
          }
        }
      }
    }

    // Stardust sparkles drifting between the arms: one hash-driven sparkle per
    // cell, re-randomized every frame like the original p.random() loop.
    float sparkleCount = floor(40.0 * uSparkle * (0.4 + uHigh));
    if (sparkleCount > 0.5) {
      float cells = 12.0;
      float cellW = (maxR * 2.0) / cells;
      float cellH = (maxR * 0.82 * 2.0) / cells;
      float gx = floor((px.x - (center.x - maxR)) / cellW);
      float gy = floor((px.y - (center.y - maxR * 0.82)) / cellH);
      float frame = floor(uTime * 60.0);
      float seed = hash21(vec2(gx * 7.13 + frame * 13.7, gy * 3.17 + frame * 7.31));
      float presence = min(1.0, sparkleCount / (cells * cells));
      if (seed < presence) {
        vec2 sp = vec2(
          center.x - maxR + (gx + hash21(vec2(gx * 1.1 + frame * 3.3, gy * 5.7 + frame * 9.9))) * cellW,
          center.y - maxR * 0.82 + (gy + hash21(vec2(gx * 2.2 + frame * 6.6, gy * 8.8 + frame * 4.4))) * cellH
        );
        vec2 sq = sp - center;
        if (length(vec2(sq.x, sq.y / 0.82)) <= maxR) {
          float tw = 0.5 + 0.5 * sin(uTime * 6.0 + seed * 40.0);
          float alpha = (80.0 + uHigh * 140.0) * tw / 255.0;
          float rad = 0.5 + uHigh * 1.25;
          color += hsv2rgb(vec3(mod(hueBase + 180.0, 360.0) / 360.0, 0.3, 1.0))
            * alpha * dotGlow(length(px - sp), rad);
        }
      }
    }

    // Vignette (CPU: vignette(p, 0.5)).
    float v0 = min(center.x, center.y) * 0.5;
    float v1 = max(center.x, center.y) * 1.35;
    color *= 1.0 - 0.5 * smoothstep(v0, v1, length(px - center));

    // The CPU version accumulates each frame under a 30/255 fade rect
    // (steady state ≈ 8.5x one frame); reproduce that exposure here.
    color = filmicTone(color * 8.5);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    uSub: { min: 0, max: 2.5, neutral: 0 },
    uMid: { min: 0, max: 2.5, neutral: 0 },
    uHigh: { min: 0, max: 2.5, neutral: 0 },
    uEnergy: { min: 0, max: 2.5, neutral: 0 },
    uRotation: { min: -1_000_000, max: 1_000_000, neutral: 0 },
    uHueOffset: { min: 0, max: 360, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { uSub: 0, uMid: 0, uHigh: 0, uEnergy: 0, uRotation: 0, uHueOffset: 0 },
  },
});

// Envelope-smoothed bands matching viz-utils.makeBands, but calibrated to
// deltaSeconds: the old per-frame attack/release factors (0.6 / 0.14 at 60 fps)
// become exponential per-second factors so cadence does not change the feel.
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

// The controller owns band extraction (with the same envelope smoothing the old
// renderer used), the time-based rotation and hue state. No renderer-side math.
export function createAudioController({ rng = Math.random } = {}) {
  let rotation = 0;
  let hueOffset = 0;
  const getBands = makeBandsController();

  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const b = getBands(freqs.left && freqs.left.length ? freqs.left : null, params, dt);

      rotation += (0.004 + b.energy * 0.05) * dt * 60;
      if (Math.abs(rotation) > 900_000) rotation %= 100_000;
      hueOffset = (hueOffset + (0.3 + b.energy * 2) * dt * 60) % 360;

      return {
        continuous: {
          uSub: b.sub,
          uMid: b.mid,
          uHigh: b.high,
          uEnergy: b.energy,
          uRotation: rotation,
          uHueOffset: hueOffset,
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
  let rotation = 0;
  let hueOffset = 0;
  let frameCount = 0;
  const getBands = makeBands();

  // Opted-in path: bands/rotation/hue arrive as final controls; only the visual
  // params (arms/density/twist/sparkle) are mapped locally.
  const mapUniformsMigrated = (P, bands_, p, controls) => {
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls?.continuous || {}) };
    return {
      uSub: C.uSub,
      uMid: C.uMid,
      uHigh: C.uHigh,
      uEnergy: C.uEnergy,
      uRotation: C.uRotation,
      uHueOffset: C.uHueOffset,
      uArms: Math.floor(P.arms ?? 5),
      uDensity: Math.floor(P.density ?? 90),
      uTwist: P.twist ?? 1,
      uSparkle: P.sparkle ?? 1,
    };
  };

  const mapUniformsLegacy = (P) => {
    const freqs = audio && audio.isStarted ? audio.getFrequencies() : null;
    const b = getBands(freqs ? freqs.left : null, P);
    const t = frameCount++;
    const idle = 0.5 + 0.5 * Math.sin(t * 0.02);
    const energy = freqs ? b.energy : 0.18 + idle * 0.2;
    const sub = freqs ? b.sub : 0.2 + idle * 0.2;
    const mid = freqs ? b.mid : 0.2;
    const high = freqs ? b.high : idle * 0.3;

    rotation += 0.004 + energy * 0.05;
    hueOffset = (hueOffset + 0.3 + energy * 2) % 360;

    return {
      uSub: sub,
      uMid: mid,
      uHigh: high,
      uEnergy: energy,
      uRotation: rotation,
      uHueOffset: hueOffset,
      uArms: Math.floor(P.arms ?? 5),
      uDensity: Math.floor(P.density ?? 90),
      uTwist: P.twist ?? 1,
      uSparkle: P.sparkle ?? 1,
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
