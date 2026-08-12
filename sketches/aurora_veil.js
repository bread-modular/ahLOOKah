// Aurora Veil — a volumetric aurora borealis of vertical light curtains that
// dance over a starlit horizon. Bass lifts the curtain ceiling, mids drive
// the rippling folds, and highs ignite the curtain-edge shimmer. A short
// vertical ray march gives the ribbons genuine atmospheric depth and parallax.
// GLSL lint: smoothstep must be smoothstep(low, high, x) with low < high.
// For falloffs use 1.0 - smoothstep(low, high, x), never smoothstep(high, low, x) (undefined).
//
// The opted-in path consumes final header audio uniforms produced by a
// DOM-free capture-side controller; the legacy raw-frame path stays intact.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uCurtain;
  uniform float uFlow;
  uniform float uShimmer;
  uniform float uHaze;

  // A drifting, layerable curtain. The horizontal coordinate is warped so the
  // ribbons fold and breathe; the vertical coordinate shapes the curtain band.
  float curtainDensity(vec2 uv, float time, float seed) {
    float drift = time * (0.10 + uFlow * 0.30);
    // Domain-warp the horizontal axis so each curtain undulates independently.
    float warp = fbm4(vec2(uv.x * 1.7 + seed * 9.1, time * 0.12 + seed * 3.3)) - 0.5;
    float folds = sin((uv.x + warp * (0.45 + uMid * 0.35)) * (3.2 + seed * 1.6) + drift * (1.0 + seed));
    folds = folds * 0.5 + 0.5;

    // The curtain lives in a tilted band of the sky, climbing with the bass.
    float ceiling = 0.62 + uSub * 0.06 + uKick * 0.05 + seed * 0.04;
    float floor = ceiling - (0.30 + uCurtain * 0.16 + uSub * 0.04);
    float band = smoothstep(floor, floor + 0.05, uv.y) * (1.0 - smoothstep(ceiling - 0.05, ceiling, uv.y));

    // Vertical streaks: the aurora is brighter at its lower edge and rays up.
    float streaks = pow(folds, 1.6) * (1.0 - smoothstep(floor, ceiling, uv.y));
    streaks += fbm4(vec2(uv.x * 4.0 + drift * 1.4 + seed * 6.0, uv.y * 6.0)) * 0.22;
    return band * saturate(streaks);
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.18 + uFlow * 0.55);

    // A curved horizon: the world tilts slightly so the aurora arcs overhead.
    vec3 rd = normalize(vec3(uv.x * 0.9, uv.y, 1.0));
    rd.yz = rotate2d(-0.12 + sin(time * 0.07) * 0.015) * rd.yz;

    // Deep night-sky base with a faint Milky-Way band.
    vec3 color = vec3(0.004, 0.008, 0.02);
    float sky = smoothstep(0.05, 0.4, rd.y);
    color = mix(vec3(0.006, 0.004, 0.012), color, sky);

    float milkyway = fbm4(vec2(rd.x * 2.2 + time * 0.01, rd.y * 6.0 - 0.1));
    color += vec3(0.04, 0.06, 0.12) * pow(saturate(milkyway - 0.5), 2.0) * 0.5 * sky;

    // Stars: two hash layers with twinkle, denser near the band.
    vec2 starCell = floor(rd.xy * 110.0);
    float starSeed = hash21(starCell);
    float star = step(0.986, starSeed) * (1.0 - smoothstep(0.2, 0.55, abs(rd.y)));
    float twinkle = 0.6 + 0.4 * sin(time * 6.0 + starSeed * VIZ_TAU);
    vec3 starColor = mix(vec3(0.6, 0.78, 1.0), vec3(1.0, 0.7, 0.6), hash21(starCell + 5.0));
    color += starColor * star * twinkle;
    vec2 starCell2 = floor(rd.xy * 230.0 + 11.0);
    color += vec3(0.85, 0.92, 1.0) * step(0.992, hash21(starCell2)) * 0.7;

    // March a handful of vertical steps through the curtain volume so the light
    // has parallax depth rather than reading like a flat sprite on the LED wall.
    float volume = 0.0;
    vec3 volColor = vec3(0.0);
    float steps = 6.0;
    for (int i = 0; i < 6; i++) {
      float t = (float(i) + 0.5) / steps;
      // Sample a band of sky between y ~ 0.05 and 1.0 along the (tilted) ray.
      float y = mix(0.04, 1.0, t);
      vec2 cuv = vec2(rd.x + rd.z * (t - 0.5) * 0.6, y);
      float density = 0.0;
      float green = curtainDensity(cuv, time, 0.0);
      float violet = curtainDensity(cuv, time, 0.53);
      float teal = curtainDensity(cuv, time, 1.07);
      density = green * 0.55 + violet * 0.35 + teal * 0.45;

      // Color shifts from green near the floor to magenta/violet at the top.
      float hue = fract(0.33 + y * 0.18 + time * 0.012);
      vec3 c = hsv2rgb(vec3(hue, 0.85, 1.0));
      c = mix(c, vec3(0.2, 1.0, 0.6), green * 0.6);
      c = mix(c, vec3(0.6, 0.2, 1.0), violet * 0.5);

      float contribution = density * (1.0 - volume * 0.5) * (0.16 / steps);
      volume += contribution;
      volColor += c * contribution;
    }

    // Curtain-edge shimmer driven by highs; the whole veil brightens on energy.
    float shimmer = (0.5 + 0.5 * fbm4(vec2(rd.x * 8.0 + time * 1.5, rd.y * 8.0)));
    volColor *= 1.0 + uHigh * shimmer * 0.5 + uHat * shimmer * 1.2;
    volColor *= 0.6 + uEnergy * 1.3 + uMid * 0.6;
    color += volColor * (1.0 + uCurtain * 0.4);

    // Hazy atmospheric bloom near the curtain floor, like ground reflection.
    float horizonGlow = exp(-abs(rd.y - 0.08) * 4.5) * sky;
    color += mix(vec3(0.05, 0.4, 0.25), vec3(0.3, 0.08, 0.5), 0.5 + 0.5 * sin(time * 0.5))
      * horizonGlow * (0.1 + uSub * 0.25 + uKick * 0.6) * uHaze;

    // Ground silhouette of distant hills for scale and depth.
    float hills = fbm4(vec2(rd.x * 1.5 + 2.0, 0.0)) - 0.42;
    float ground = 1.0 - smoothstep(hills * 0.4, hills * 0.4 + 0.04, rd.y);
    color *= 1.0 - ground * 0.9;
    color += vec3(0.01, 0.03, 0.05) * ground * (0.2 + uEnergy * 0.3);

    // A kick launches one soft, ascending ripple through the veil.
    float kickRise = (1.0 - saturate(uBeat)) * 0.5;
    float beatLine = exp(-abs(rd.y - (0.1 + kickRise)) * 26.0) * uBeat;
    color += mix(vec3(0.1, 1.0, 0.7), vec3(1.0, 0.2, 0.6), kickRise)
      * beatLine * (0.5 + uHaze) * 0.7;

    float vignette = 1.0 - smoothstep(0.7, 1.5, length(uv * vec2(0.7, 1.0)));
    color *= 0.3 + 0.7 * vignette;
    color = filmicTone(color * 1.2);
    color = pow(color, vec3(0.92));
    gl_FragColor = vec4(color, 1.0);
  }
`;

// Final header audio uniforms this fragment reads (it never reads uSnare).
// The migrated path zeroes the header set inside makeAudioShader, so the
// controller emits every one of these and mapUniforms overrides the zeros
// from controls.continuous.
export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    uSub: { min: 0, max: 1.6, neutral: 0 },
    uMid: { min: 0, max: 1.6, neutral: 0 },
    uHigh: { min: 0, max: 1.6, neutral: 0 },
    uEnergy: { min: 0, max: 1.6, neutral: 0 },
    uKick: { min: 0, max: 1.4, neutral: 0 },
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
// parameter-only uniforms (uCurtain/uFlow/uShimmer/uHaze) never change with
// audio, so they stay out of the schema and are passed through by mapUniforms.
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
      const hat = clamp((Number(features.hat) || 0) * highGain * punch, 0, 1.4);
      const beat = clamp((Number(features.beat) || 0) * bassGain * punch, 0, 1.4);
      const energy = clamp(
        (Number(features.energy) || 0) * (bassGain * 0.42 + midGain * 0.38 + highGain * 0.2),
        0,
        1.6,
      );
      return {
        continuous: { uSub: sub, uMid: mid, uHigh: high, uEnergy: energy, uKick: kick, uHat: hat, uBeat: beat },
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
        uCurtain: P.curtain ?? 1,
        uFlow: P.flow ?? 1,
        uShimmer: P.shimmer ?? 1,
        uHaze: P.haze ?? 1,
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
      uCurtain: P.curtain ?? 1,
      uFlow: P.flow ?? 1,
      uShimmer: P.shimmer ?? 1,
      uHaze: P.haze ?? 1,
    }),
  );
};
