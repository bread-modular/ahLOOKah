// Plasma Waves — domain-warped liquid plasma. GPU shader port.
// Original rendered chunky cells via thousands of rects with ADD blending on black;
// shader quantizes to the same cell grid and replicates the domain-warp math,
// hueOffset/t accumulation, and vignette faithfully.
// The opted-in path receives the accumulated time, hue offset and band scalars
// from a DOM-free capture-side controller; the legacy raw-frame path is preserved.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uCell;
  uniform float uScaleBase;
  uniform float uT;
  uniform float uHueOffset;

  void main() {
    float cell = max(uCell, 4.0);
    vec2 fragCoord = vTexCoord * uResolution;
    vec2 cellCoord = floor(fragCoord / cell) * cell;

    float scale = 0.005 * uScaleBase * (1.0 + uSub * 0.8);
    float warp = 1.5 + uMid * 4.0;
    float cxS = uResolution.x * scale * 0.5;
    float cyS = uResolution.y * scale * 0.5;

    float sx = cellCoord.x * scale;
    float sy = cellCoord.y * scale;

    float wx = sin(sy * 1.7 + uT * 1.3) * warp;
    float wy = sin(sx * 1.3 - uT) * warp;

    float v = sin((sx + wx) * 2.0 + uT);
    v += sin((sy + wy) * 2.4 - uT * 1.2);
    v += sin(sx + sy + wx - wy + uT * 0.7);
    float dx = sx + wx * 0.5 - cxS;
    float dy = sy + wy * 0.5 - cyS;
    v += sin(sqrt(dx*dx + dy*dy) * 3.0 - uT * 1.5);

    float n = v / 8.0 + 0.5;
    float hue = mod(uHueOffset + n * 140.0, 360.0);
    float bri = 12.0 + n * n * 88.0 * (0.5 + uEnergy);
    vec3 col = hsv2rgb(vec3(hue / 360.0, 0.85, bri / 100.0));
    col *= 200.0 / 255.0;

    // Vignette 0.6 — same as CPU viz-utils radial gradient (inner 0.5*min, outer 1.35*max)
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);
    float vig = 1.0 - smoothstep(0.7, 1.52, length(uv * vec2(0.72, 1.0)));
    col *= 0.4 + 0.6 * vig;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    uT: { min: -1_000_000, max: 1_000_000, neutral: 0 },
    uHueOffset: { min: 0, max: 360, neutral: 0 },
    uSub: { min: 0, max: 1.6, neutral: 0 },
    uMid: { min: 0, max: 1.6, neutral: 0 },
    uEnergy: { min: 0, max: 1.6, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { uT: 0, uHueOffset: 0, uSub: 0, uMid: 0, uEnergy: 0 },
  },
});

// Legacy bands came from the shared feature extractor with live params boosts;
// the canonical shared view has no params, so boosts are applied here with the
// same clamps the extractor uses.
function boostedBands(features, params) {
  const bassGain = Math.max(0, Number(params.bass ?? 1));
  const midGain = Math.max(0, Number(params.mid ?? 1));
  const highGain = Math.max(0, Number(params.high ?? 1));
  return {
    sub: clamp((Number(features.sub) || 0) * bassGain, 0, 1.6),
    mid: clamp((Number(features.mid) || 0) * midGain, 0, 1.6),
    high: clamp((Number(features.high) || 0) * highGain, 0, 1.6),
    energy: clamp(
      (Number(features.energy) || 0) * (bassGain * 0.42 + midGain * 0.38 + highGain * 0.2),
      0,
      1.6,
    ),
  };
}

// The controller owns time accumulation, hue drift and the band scalars the
// shader reads (uSub/uMid/uEnergy). Cell geometry stays fully visual.
export function createAudioController() {
  let t = 0;
  let hueOffset = 0;
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const features = shared?.getFeatures?.() || {};
      const b = boostedBands(features, params);
      const speed = Math.max(0, Number(params.speed ?? 1));

      t += (0.008 + b.energy * 0.06) * speed * dt * 60;
      if (Math.abs(t) > 900_000) t %= 100_000;
      hueOffset = (hueOffset + (0.2 + b.high * 2.0) * dt * 60) % 360;

      return {
        continuous: {
          uT: t,
          uHueOffset: hueOffset,
          uSub: b.sub,
          uMid: b.mid,
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
  let t = 0;
  let hueOffset = 0;

  function legacyMapUniforms(P, bands) {
    const speed = P.speed ?? 1;
    const cell = Math.max(4, Math.floor(P.cell ?? 10));
    const scaleBase = P.scale ?? 1;
    t += (0.008 + bands.energy * 0.06) * speed;
    hueOffset = (hueOffset + 0.2 + bands.high * 2.0) % 360;
    return {
      uCell: Number(cell),
      uScaleBase: Number(scaleBase),
      uT: t,
      uHueOffset: hueOffset,
    };
  }

  function migratedMapUniforms(P, _bands, _p, controls) {
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls?.continuous || {}) };
    const cell = Math.max(4, Math.floor(P.cell ?? 10));
    const scaleBase = P.scale ?? 1;
    return {
      uCell: Number(cell),
      uScaleBase: Number(scaleBase),
      uT: C.uT,
      uHueOffset: C.uHueOffset,
      uSub: C.uSub,
      uMid: C.uMid,
      uEnergy: C.uEnergy,
    };
  }

  return makeAudioShader(
    audio,
    params,
    frag,
    audioControls ? migratedMapUniforms : legacyMapUniforms,
    audioControls ? { audioControls } : {},
  );
};
