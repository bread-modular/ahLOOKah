// Event Horizon — a cinematic black hole with a turbulent accretion disc,
// gravitationally bent star field, photon ring, and polar energy jets. Bass
// expands the horizon, mids roughen the disc, and highs ignite stellar flares.
// GLSL lint: smoothstep must be smoothstep(low, high, x) with low < high.
// For falloffs use 1.0 - smoothstep(low, high, x), never smoothstep(high, low, x) (undefined).
//
// The opted-in path consumes final header audio uniforms produced by a
// DOM-free capture-side controller; the legacy raw-frame path stays intact.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  // lint: smoothstep(low, high, x) — inverted falloff uses 1.0 - smoothstep(low, high, x)
  uniform float uGravity;
  uniform float uDisk;
  uniform float uSpin;
  uniform float uBloom;

  float starLayer(vec2 p, float scale, float threshold) {
    vec2 cell = floor(p * scale);
    vec2 local = fract(p * scale) - 0.5;
    float seed = hash21(cell);
    vec2 offset = vec2(hash21(cell + 17.3), hash21(cell + 41.7)) - 0.5;
    float d = length(local - offset * 0.65);
    float core = 1.0 - smoothstep(0.012, 0.055, d);
    float rays = (1.0 - smoothstep(0.0, 0.035, abs(local.x - offset.x * 0.65)))
      + (1.0 - smoothstep(0.0, 0.035, abs(local.y - offset.y * 0.65)));
    return step(threshold, seed) * (core + rays * core * 0.28) * mix(0.45, 1.4, seed);
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.18 + uSpin * 0.42);
    float radius = length(uv);
    float angle = atan(uv.y, uv.x);
    float impact = max(uKick, uBeat * 0.85);
    float horizon = 0.135 + (uSub * 0.026 + impact * 0.052) * uGravity;

    // Lens the sky harder as it approaches the event horizon.
    float lens = uGravity * 0.075 / (radius * radius + 0.045);
    vec2 skyUv = rotate2d(lens + time * 0.012) * uv;
    skyUv *= 1.0 + uGravity * 0.055 / (radius + 0.055);

    vec3 color = vec3(0.0004, 0.001, 0.004);
    float nebula = fbm4(skyUv * 1.25 + vec2(time * 0.035, -time * 0.021));
    float nebulaMask = pow(saturate(nebula - 0.48), 2.2);
    color += mix(vec3(0.08, 0.01, 0.18), vec3(0.0, 0.13, 0.25), nebula) * nebulaMask * 0.55;

    float stars = starLayer(skyUv + vec2(time * 0.004, 0.0), 43.0, 0.955);
    stars += starLayer(rotate2d(0.37) * skyUv - vec2(time * 0.002), 87.0, 0.982) * 0.65;
    float starTwinkle = 0.72 + 0.28 * sin(time * 7.0 + hash21(floor(skyUv * 43.0)) * TAU);
    color += stars * starTwinkle * mix(vec3(0.5, 0.72, 1.0), vec3(1.0, 0.55, 0.85), hash21(floor(skyUv * 29.0)));

    // The disc is a thin, tilted turbulent plane. A radial falloff and moving
    // logarithmic streaks make it read as matter orbiting at extreme speed.
    vec2 q = rotate2d(-0.055 + sin(time * 0.19) * 0.018) * uv;
    float discRadius = length(vec2(q.x, q.y * 4.8));
    float innerCut = smoothstep(horizon * 1.45, horizon * 2.2, discRadius);
    float outerCut = 1.0 - smoothstep(0.66, 1.08, discRadius);
    float turbulence = fbm4(vec2(angle * 2.2 - time * 2.4, discRadius * 11.0));
    float corrugation = sin(q.x * 33.0 - time * 5.0 + turbulence * 5.0)
      * (0.004 + uMid * 0.006 + uSnare * 0.014);
    float plane = exp(-abs(q.y + corrugation) * (85.0 / max(uDisk, 0.25)));
    float streaks = 0.56 + 0.44 * sin(discRadius * 82.0 - angle * 5.0 - time * 10.0 + turbulence * 8.0);
    streaks = mix(0.48, 1.25, smoothstep(-0.45, 0.8, streaks));
    float disc = plane * innerCut * outerCut * streaks;

    float heat = 1.0 - smoothstep(horizon * 1.6, 0.82, discRadius);
    vec3 discColor = mix(vec3(1.0, 0.035, 0.18), vec3(0.08, 0.36, 1.0), heat);
    discColor = mix(discColor, vec3(1.0, 0.88, 0.72), pow(heat, 5.0));
    color += discColor * disc * (1.7 + uEnergy * 1.5 + impact * 2.6) * uBloom;
    color += discColor * exp(-abs(q.y) * 25.0) * innerCut * outerCut
      * (0.11 + impact * 0.16) * uBloom;

    // Lensed echo of the far side of the disc, bent above and below the hole.
    float lensedArc = exp(-abs(radius - horizon * 1.42) * 78.0);
    lensedArc *= 0.3 + 0.7 * pow(abs(cos(angle)), 2.0);
    color += mix(vec3(0.18, 0.45, 1.0), vec3(1.0, 0.15, 0.45), saturate(cos(angle) * 0.5 + 0.5))
      * lensedArc * (0.6 + uMid * 0.7 + uSnare * 1.4) * uDisk;

    // Polar jets wake up in the upper frequencies without becoming a strobe.
    float jetCore = exp(-abs(q.x) * (75.0 - uHigh * 12.0 - uHat * 17.0));
    float jetBody = smoothstep(horizon * 0.8, horizon * 2.0, abs(q.y))
      * (1.0 - smoothstep(0.38, 1.15, abs(q.y)));
    float jetNoise = 0.4 + 0.6 * fbm4(vec2(q.x * 35.0, q.y * 7.0 - time * 4.0));
    float jet = jetCore * jetBody * jetNoise * (0.12 + uHigh * 0.85 + uHat * 2.3);
    color += vec3(0.15, 0.42, 1.0) * jet * uBloom;

    // Absolute black center, followed by a razor-hot photon ring.
    float core = 1.0 - smoothstep(horizon * 0.88, horizon * 1.04, radius);
    color *= 1.0 - core;
    float photon = exp(-abs(radius - horizon * 1.075) * (150.0 / max(uBloom, 0.35)));
    float photonHalo = exp(-abs(radius - horizon * 1.09) * 34.0) * 0.22;
    vec3 photonColor = mix(vec3(0.12, 0.5, 1.0), vec3(1.0, 0.18, 0.5), 0.5 + 0.5 * sin(angle + time));
    color += photonColor * (photon * 2.2 + photonHalo)
      * (0.78 + uSub * 0.65 + impact * 1.9) * uBloom;
    color += vec3(1.0) * photon * photon * (0.9 + impact * 1.4);

    // High-frequency microlensing flashes dotted around the photon ring.
    float flareSeed = hash21(floor(vec2(angle * 18.0, time * 3.0)));
    float flare = step(0.91 - uHigh * 0.055 - uHat * 0.17, flareSeed)
      * exp(-abs(radius - horizon * 1.1) * 95.0)
      * pow(max(0.0, sin(angle * 18.0 + time * 8.0)), 18.0);
    color += vec3(0.65, 0.82, 1.0) * flare * (0.7 + uHigh * 1.2 + uHat * 4.2);

    // Every detected kick launches one short, outward-moving lens ripple.
    float echoRadius = horizon * 1.45 + (1.0 - saturate(uBeat)) * 0.46;
    float beatEcho = exp(-abs(radius - echoRadius) * 58.0) * uBeat;
    color += mix(vec3(0.08, 0.42, 1.0), vec3(1.0, 0.08, 0.42), saturate(radius))
      * beatEcho * (0.8 + uBloom);

    float vignette = 1.0 - smoothstep(0.65, 1.45, length(uv * vec2(0.72, 1.0)));
    color *= 0.3 + 0.7 * vignette;
    color = filmicTone(color * 1.18);
    color = pow(color, vec3(0.92));
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
// parameter-only uniforms (uGravity/uDisk/uSpin/uBloom) never change with
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
        uGravity: P.gravity ?? 1,
        uDisk: P.disk ?? 1,
        uSpin: P.spin ?? 1,
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
      uGravity: P.gravity ?? 1,
      uDisk: P.disk ?? 1,
      uSpin: P.spin ?? 1,
      uBloom: P.bloom ?? 1,
    }),
  );
};
