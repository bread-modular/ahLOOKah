// Holo Swarm — a volumetric point cloud that continuously morphs between a
// torus, sphere, and crystalline shell. Particle cells, scan planes, chromatic
// depth and controlled data glitches create a large-scale hologram aesthetic.
//
// The opted-in path consumes final header audio uniforms produced by a
// DOM-free capture-side controller; the legacy raw-frame path stays intact.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uMorph;
  uniform float uDensity;
  uniform float uScan;
  uniform float uSpeed;

  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }

  float sdOctahedron(vec3 p, float size) {
    p = abs(p);
    return (p.x + p.y + p.z - size) * 0.57735027;
  }

  float morphingShell(vec3 p, float time) {
    p.xz = rotate2d(p.y * (0.5 + uMid * 0.38 + uSnare * 0.75) + time * 0.22) * p.xz;
    p.xy = rotate2d(time * 0.17) * p.xy;
    float impact = uKick + uBeat * 0.32;
    float sphere = length(p) - (0.83 + uSub * 0.06 + impact * 0.14);
    float torus = length(vec2(length(p.xz) - (0.66 + uSub * 0.04 + impact * 0.1), p.y)) - 0.25;
    float crystal = sdOctahedron(p, 1.16 + uSub * 0.08 + impact * 0.18);
    float cycle = 0.5 + 0.5 * sin(time * (0.42 + uMorph * 0.38));
    float firstMorph = mix(torus, sphere, smoothstep(0.05, 0.72, cycle));
    return mix(firstMorph, crystal, smoothstep(0.67, 1.0, cycle) * saturate(uMorph * 0.75));
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.24 + uSpeed * 0.68);

    // Horizontal data tears are deterministic per scan row, not random-frame
    // noise, so the hologram remains readable even at high sensitivity.
    float slice = floor((uv.y + 1.0) * 32.0);
    float glitchSeed = hash21(vec2(slice, floor(time * 7.0)));
    float tear = step(0.95 - uHigh * 0.025 - uHat * 0.2, glitchSeed)
      * (glitchSeed - 0.5) * (uHigh * 0.012 + uHat * 0.11);
    uv.x += tear;

    vec3 ro = vec3(0.0, 0.0, 2.65 - uKick * 0.16);
    vec3 rd = normalize(vec3(uv, -1.6));
    ro.xz = rotate2d(sin(time * 0.19) * 0.16) * ro.xz;
    rd.xz = rotate2d(sin(time * 0.19) * 0.16) * rd.xz;

    vec3 color = vec3(0.001, 0.004, 0.012);
    float opacity = 0.0;
    float gridScale = 7.0 + uDensity * 6.0;
    float stepSize = 0.066;

    for (int i = 0; i < 76; i++) {
      float travel = float(i) * stepSize;
      vec3 pos = ro + rd * travel;
      float shellDistance = morphingShell(pos, time);
      float shell = exp(-abs(shellDistance) * (24.0 + uDensity * 9.0));

      vec3 lattice = pos * gridScale;
      vec3 cell = floor(lattice);
      vec3 local = fract(lattice) - 0.5;
      vec3 jitter = (hash33(cell) - 0.5) * 0.68;
      float particle = exp(-length(local - jitter) * (7.5 + uDensity * 1.8));

      float scanPlane = pow(
        0.5 + 0.5 * sin(pos.y * (18.0 + uScan * 9.0 + uHat * 4.0) - time * 5.0),
        8.0
      );
      float longitudeBand = pow(
        0.5 + 0.5 * sin(atan(pos.z, pos.x) * 18.0 + time * 2.0 + uSnare * 2.5),
        14.0
      );
      // A faint continuous shell keeps the form legible on giant LED walls;
      // the brighter stochastic cells still provide the point-cloud character.
      float density = shell * (
        particle * (0.55 + scanPlane * 1.8)
        + longitudeBand * 0.12
        + scanPlane * 0.035
        + 0.018
      );
      density *= 0.38 + uScan * 0.18;

      float hue = fract(0.5 + pos.y * 0.16 + length(pos.xz) * 0.09 + time * 0.018 + hash21(cell.xy) * 0.08);
      vec3 sampleColor = hsv2rgb(vec3(hue, 0.84, 1.0));
      sampleColor = mix(sampleColor, vec3(0.7, 0.9, 1.0), scanPlane * 0.62);
      float frontLight = 0.35 + 0.65 * saturate(1.0 - travel / 5.0);
      float contribution = density * (1.0 - opacity) * frontLight;
      color += sampleColor * contribution
        * (1.8 + uEnergy * 1.55 + uKick * 2.4 + uSnare * 0.8);
      opacity += contribution * 0.3;
      if (opacity > 0.97) break;
    }

    // Perspective laser floor and a moving scan bar anchor the floating form.
    float floorY = uv.y + 0.67;
    float perspective = 1.0 / max(abs(floorY), 0.035);
    float floorLines = pow(max(0.0, sin(uv.x * perspective * 3.2)), 24.0)
      + pow(max(0.0, sin(perspective * 0.58 - time * 2.0)), 28.0);
    floorLines *= smoothstep(-0.02, 0.32, -floorY) * (1.0 - smoothstep(0.32, 0.95, -floorY));
    color += vec3(0.0, 0.2, 0.62) * floorLines * (0.14 + uBeat * 0.16);

    float scanBar = exp(-abs(uv.y - sin(time * 0.7) * 0.72) * (60.0 - uScan * 8.0));
    color += mix(vec3(0.0, 0.5, 1.0), vec3(1.0, 0.02, 0.5), 0.5 + 0.5 * sin(time))
      * scanBar * (0.035 + uHigh * 0.12 + uHat * 0.72) * uScan;

    // The detected kick reads as an expanding holographic acquisition ring.
    float lockRadius = 0.3 + (1.0 - saturate(uBeat)) * 0.62;
    float lockRing = exp(-abs(length(uv) - lockRadius) * 54.0) * uBeat;
    color += mix(vec3(0.0, 0.65, 1.0), vec3(1.0, 0.04, 0.48), saturate(uv.y + 0.5))
      * lockRing * 0.9;

    float vignette = 1.0 - smoothstep(0.7, 1.52, length(uv * vec2(0.72, 1.0)));
    color *= 0.24 + 0.76 * vignette;
    color = filmicTone(color * 1.42);
    color = pow(color, vec3(0.88));
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
// parameter-only uniforms (uMorph/uDensity/uScan/uSpeed) never change with
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
        uMorph: P.morph ?? 1,
        uDensity: P.density ?? 1,
        uScan: P.scan ?? 1,
        uSpeed: P.speed ?? 1,
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
      uMorph: P.morph ?? 1,
      uDensity: P.density ?? 1,
      uScan: P.scan ?? 1,
      uSpeed: P.speed ?? 1,
    }),
  );
};
