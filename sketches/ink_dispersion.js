// Ink Dispersion — coloured ink billowing through dark water. The ink is a
// domain-warped multi-octave density field; each kick injects an outward
// dispersion shockwave that tears the pigment into filaments. Bass swells
// the cloud, mids churn it, and highs sharpen the caustic shimmer.
//
// The opted-in path consumes final header audio uniforms produced by a
// DOM-free capture-side controller; the legacy raw-frame path stays intact.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uViscosity;
  uniform float uDensity;
  uniform float uSpread;
  uniform float uBloom;

  // A drifting, domain-warped ink blob at origin \\"seed\\" with the given hue.
  // Domain warping gives the ink its turbulent, cauliflower-edged tendrils.
  vec3 inkField(vec2 uv, float time, vec2 seed, float hue) {
    vec2 q = uv - seed * 0.0;
    // Slow advective drift unique per blob.
    q += vec2(
      fbm4(q * 0.8 + vec2(time * 0.06, seed.x)) - 0.5,
      fbm4(q * 0.8 + vec2(seed.y, time * 0.05)) - 0.5
    ) * (0.5 + uMid * 0.4) * (0.4 + uViscosity);

    // Nested domain warp for fine tendril detail.
    float warpA = fbm4(q * 1.6 + vec2(time * 0.08, seed.x * 3.0));
    float warpB = fbm4(rotate2d(1.2) * q * 2.1 - vec2(time * 0.06, seed.y * 2.0));
    q += (vec2(warpA, warpB) - 0.5) * (0.35 + uMid * 0.25 + uSnare * 0.2);

    // Kick dispersion: an expanding ring that shears the ink outward.
    float kickR = length(uv - seed);
    float shock = 0.0;
    if (uSpread > 0.001) {
      float shockPhase = fract(time * 0.5 + seed.x);
      float sr = shockPhase * 0.9;
      float intensity = uBeat * 0.9 + uKick * 0.5;
      float ring = exp(-abs(kickR - sr) * 8.0) * intensity * uSpread;
      // Shear ink tangentially along the shockwave.
      q += vec2(-uv.y + seed.y, uv.x - seed.x) * ring * 1.5;
      shock = ring * 0.4;
    }

    float blobR = length(q - seed * 0.0);
    float falloff = exp(-blobR * blobR * (2.2 + uDensity * 1.5));
    float tendrils = fbm4(q * 2.2 + time * 0.04);
    float density = falloff * (0.5 + tendrils * 0.9);

    vec3 col = hsv2rgb(vec3(fract(hue + time * 0.01), 0.85, 1.0));
    return col * (density + shock);
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.15 + uViscosity * 0.25);

    // Several ink sources at wandering centres; mids agitate their positions.
    vec2 p0 = vec2(sin(time * 0.21) * 0.5, cos(time * 0.17) * 0.4);
    vec2 p1 = vec2(cos(time * 0.13 + 1.5) * 0.55, sin(time * 0.19 + 0.7) * 0.45);
    vec2 p2 = vec2(sin(time * 0.11 + 3.1) * 0.5, cos(time * 0.23 + 2.0) * 0.5);

    vec3 ink = vec3(0.0);
    ink += inkField(uv, time, p0, 0.55) * 0.55;
    ink += inkField(uv, time, p1, 0.92) * 0.45;
    ink += inkField(uv, time, p2, 0.04) * 0.4;

    // Dark water base with a slow caustic shimmer and faint backlight.
    vec3 water = vec3(0.005, 0.012, 0.022);
    float caustics = fbm4(uv * 3.0 + time * 0.08) * fbm4(uv * 7.0 - time * 0.05);
    water += vec3(0.02, 0.05, 0.09) * pow(caustics, 2.0) * (0.2 + uHigh * 0.4 + uHat * 0.8);
    // A soft backlight bloom from the centre so the ink is always legible.
    float backlight = exp(-length(uv) * 1.2);
    water += mix(vec3(0.02, 0.08, 0.12), vec3(0.06, 0.02, 0.1), 0.5 + 0.5 * sin(time * 0.3))
      * backlight * (0.15 + uSub * 0.25 + uEnergy * 0.2);

    // Premultiplied ink over water: ink absorbs/adds with the back light.
    vec3 color = water;
    float inkAlpha = saturate(length(ink) * 1.4);
    color = mix(water, ink, inkAlpha);
    // Additive bloom for the glowing pigment edges.
    color += ink * (0.4 + uBloom * 0.8) * (0.6 + uEnergy * 0.9 + uKick * 1.2);

    // Hot cores where ink concentrates — reads like pigment catching light.
    float core = pow(saturate(length(ink) * 2.0 - 0.4), 2.0);
    color += vec3(0.7, 0.9, 1.0) * core * (0.2 + uHigh * 0.5 + uHat * 1.6) * uBloom;

    // A kick launches a clean dispersion ring across the whole frame.
    float kickR = length(uv);
    float dispRing = exp(-abs(kickR - (0.2 + (1.0 - saturate(uBeat)) * 0.7)) * 30.0) * uBeat;
    color += hsv2rgb(vec3(fract(time * 0.05), 0.7, 1.0)) * dispRing * (0.4 + uSpread);

    float vignette = 1.0 - smoothstep(0.7, 1.5, length(uv * vec2(0.7, 1.0)));
    color *= 0.3 + 0.7 * vignette;
    color = filmicTone(color * 1.2);
    color = pow(color, vec3(0.9));
    gl_FragColor = vec4(color, 1.0);
  }
`;

// Final header audio uniforms this fragment reads. The migrated path zeroes the
// header set inside makeAudioShader, so the controller emits every one of these
// and mapUniforms overrides the zeros from controls.continuous.
export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    uSub: { min: 0, max: 1.6, neutral: 0 },
    uMid: { min: 0, max: 1.6, neutral: 0 },
    uHigh: { min: 0, max: 1.6, neutral: 0 },
    uEnergy: { min: 0, max: 1.6, neutral: 0 },
    uKick: { min: 0, max: 1.4, neutral: 0 },
    uSnare: { min: 0, max: 1.4, neutral: 0 },
    uHat: { min: 0, max: 1.4, neutral: 0 },
    uBeat: { min: 0, max: 1.4, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: {
      uSub: 0,
      uMid: 0,
      uHigh: 0,
      uEnergy: 0,
      uKick: 0,
      uSnare: 0,
      uHat: 0,
      uBeat: 0,
    },
  },
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// The capture-owner controller reproduces the legacy feature mapping exactly.
// The shared analyser runs with unity gains (params {}), while the legacy
// renderer applied the pattern's bass/mid/high/punch gains inside the
// extractor — so those gains and their clamps are re-applied here. The
// parameter-only uniforms (uViscosity/uDensity/uSpread/uBloom) never change
// with audio, so they stay out of the schema and are passed through by
// mapUniforms.
export function createAudioController({ rng = Math.random } = {}) {
  return {
    update({ shared, params = {} }) {
      const features = shared?.getFeatures?.() || {};
      const bassGain = Math.max(0, Number(params.bass ?? 1));
      const midGain = Math.max(0, Number(params.mid ?? 1));
      const highGain = Math.max(0, Number(params.high ?? 1));
      const punch = Math.max(0, Number(params.punch ?? 1));
      const sub = clamp((Number(features.sub) || 0) * bassGain, 0, 1.6);
      const mid = clamp((Number(features.mid) || 0) * midGain, 0, 1.6);
      const high = clamp((Number(features.high) || 0) * highGain, 0, 1.6);
      const kick = clamp((Number(features.kick) || 0) * bassGain * punch, 0, 1.4);
      const snare = clamp((Number(features.snare) || 0) * midGain * punch, 0, 1.4);
      const hat = clamp((Number(features.hat) || 0) * highGain * punch, 0, 1.4);
      const beat = clamp((Number(features.beat) || 0) * bassGain * punch, 0, 1.4);
      const energy = clamp(
        (Number(features.energy) || 0) * (bassGain * 0.42 + midGain * 0.38 + highGain * 0.2),
        0,
        1.6,
      );
      return {
        continuous: { uSub: sub, uMid: mid, uHigh: high, uEnergy: energy, uKick: kick, uSnare: snare, uHat: hat, uBeat: beat },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => {
  const audioControls = runtimeContext?.audioControls;
  if (audioControls) {
    // Migrated path: the controller already produced every audio-derived
    // uniform (header ones included). Return them merged with the pure-param
    // uniforms; custom entries override the neutral header set set by
    // makeAudioShader before this callback runs.
    return makeAudioShader(
      audio,
      params,
      frag,
      (P, _bands, _p, controls) => ({
        ...AUDIO_CONTROL_SCHEMA.neutral.continuous,
        ...(controls?.continuous || {}),
        uViscosity: P.viscosity ?? 1,
        uDensity: P.density ?? 1,
        uSpread: P.spread ?? 1,
        uBloom: P.bloom ?? 1,
      }),
      { audioControls },
    );
  }

  // Existing raw-frame shader path for standalone use and any un-migrated
  // registry entry. It continues to own local feature mapping exactly as before.
  return makeAudioShader(
    audio,
    params,
    frag,
    (P) => ({
      uViscosity: P.viscosity ?? 1,
      uDensity: P.density ?? 1,
      uSpread: P.spread ?? 1,
      uBloom: P.bloom ?? 1,
    }),
  );
};
