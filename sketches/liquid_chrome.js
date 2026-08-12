// Liquid Chrome — a ray-marched cluster of smoothly fused metallic bodies.
// The living SDF catches an iridescent neon environment: bass inflates it,
// mids destabilize the surface, and highs sharpen its spectral reflections.
//
// The opted-in path consumes final header audio uniforms produced by a
// DOM-free capture-side controller; the legacy raw-frame path stays intact.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uMorph;
  uniform float uReflect;
  uniform float uSpeed;
  uniform float uIridescence;

  float smoothMin(float a, float b, float k) {
    float h = saturate(0.5 + 0.5 * (b - a) / k);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  float mapScene(vec3 p) {
    float time = uTime * (0.28 + uSpeed * 0.52);
    p.xz = rotate2d(time * 0.22) * p.xz;
    p.xy = rotate2d(sin(time * 0.31) * 0.16) * p.xy;

    float expansion = 1.0 + uSub * 0.1 + uKick * 0.22 + uBeat * 0.08;
    float travel = 0.25 + uMorph * 0.18 + uSnare * 0.045;
    vec3 a = vec3(sin(time * 1.13), cos(time * 0.91), sin(time * 0.63)) * travel;
    vec3 b = vec3(cos(time * 0.73), sin(time * 1.27), cos(time * 1.01)) * travel;
    vec3 c = vec3(sin(time * 0.57 + 2.1), cos(time * 0.83 + 1.2), sin(time * 1.19)) * travel;

    float d = length(p - a) - 0.61 * expansion;
    d = smoothMin(d, length(p - b) - 0.57 * expansion, 0.26 + uMorph * 0.1);
    d = smoothMin(d, length(p - c) - 0.53 * expansion, 0.24 + uMorph * 0.09);

    // A restrained displacement preserves a valid-ish distance field while
    // giving the chrome a soft, molten skin.
    float ripple = sin(p.x * 5.1 + time * 1.8)
      * sin(p.y * 4.6 - time * 1.3)
      * sin(p.z * 5.4 + time);
    d += ripple * (0.008 + (uMid * 0.018 + uSnare * 0.043) * uMorph);
    return d;
  }

  vec3 getNormal(vec3 p) {
    vec2 e = vec2(0.0016, -0.0016);
    return normalize(
      e.xyy * mapScene(p + e.xyy)
      + e.yyx * mapScene(p + e.yyx)
      + e.yxy * mapScene(p + e.yxy)
      + e.xxx * mapScene(p + e.xxx)
    );
  }

  vec3 neonEnvironment(vec3 d) {
    float longitude = atan(d.z, d.x) / VIZ_TAU + 0.5;
    float latitude = asin(clamp(d.y, -1.0, 1.0)) / VIZ_PI + 0.5;
    float bands = pow(max(0.0, sin(longitude * 32.0 + uTime * 0.7)), 18.0);
    float horizon = exp(-abs(d.y) * 8.0);
    float panels = pow(max(0.0, sin(latitude * 19.0 - longitude * 9.0)), 28.0);
    vec3 base = mix(vec3(0.012, 0.018, 0.06), vec3(0.08, 0.005, 0.11), latitude);
    base += hsv2rgb(vec3(fract(longitude + uTime * 0.015), 0.82, 1.0))
      * bands * (0.4 + uHigh * 0.55 + uHat * 1.8);
    base += mix(vec3(0.05, 0.45, 1.0), vec3(1.0, 0.05, 0.42), longitude) * horizon * 0.8;
    base += vec3(0.45, 0.7, 1.0) * panels * 0.35;
    return base;
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    // Small scan-slice refraction gives high hats a holographic edge.
    float scanId = floor((uv.y + 1.0) * 38.0);
    float scanNoise = hash21(vec2(scanId, floor(uTime * 8.0)));
    uv.x += (scanNoise - 0.5)
      * step(0.94 - uHigh * 0.025 - uHat * 0.18, scanNoise)
      * (uHigh * 0.008 + uHat * 0.052);

    float time = uTime * (0.28 + uSpeed * 0.52);
    vec3 ro = vec3(0.0, 0.0, 3.35 - uKick * 0.24 - uBeat * 0.08);
    vec3 rd = normalize(vec3(uv, -1.72));
    rd.xz = rotate2d(sin(time * 0.23) * 0.12) * rd.xz;
    ro.xz = rotate2d(sin(time * 0.23) * 0.12) * ro.xz;

    float distanceTravelled = 0.0;
    float distanceToScene = 0.0;
    bool hit = false;
    for (int i = 0; i < 64; i++) {
      vec3 samplePoint = ro + rd * distanceTravelled;
      distanceToScene = mapScene(samplePoint);
      if (distanceToScene < 0.0014) {
        hit = true;
        break;
      }
      distanceTravelled += distanceToScene * 0.72;
      if (distanceTravelled > 7.0) break;
    }

    vec3 bgDirection = normalize(vec3(uv * 0.65, -1.0));
    vec3 color = neonEnvironment(bgDirection) * 0.15;
    float backdropGlow = exp(-length(uv) * 1.7)
      * (0.03 + uEnergy * 0.055 + uKick * 0.11);
    color += hsv2rgb(vec3(fract(0.61 + time * 0.012), 0.85, backdropGlow));

    // Sparse optical bokeh in the environment.
    vec2 bokehCell = floor((uv + vec2(time * 0.01, 0.0)) * 24.0);
    vec2 bokehUv = fract((uv + vec2(time * 0.01, 0.0)) * 24.0) - 0.5;
    float bokehSeed = hash21(bokehCell);
    float bokeh = (1.0 - smoothstep(0.025, 0.12, length(bokehUv))) * step(0.94, bokehSeed);
    color += hsv2rgb(vec3(bokehSeed, 0.7, 1.0)) * bokeh
      * (0.2 + uHigh * 0.35 + uHat * 2.2);

    if (hit) {
      vec3 pos = ro + rd * distanceTravelled;
      vec3 normal = getNormal(pos);
      vec3 view = -rd;
      vec3 lightA = normalize(vec3(-0.5, 0.75, 0.8));
      vec3 lightB = normalize(vec3(0.7, -0.2, 0.55));
      float diffuse = max(dot(normal, lightA), 0.0);
      float secondary = max(dot(normal, lightB), 0.0);
      float fresnel = pow(1.0 - max(dot(normal, view), 0.0), 3.2);
      vec3 reflected = neonEnvironment(reflect(rd, normal));

      float hue = fract(
        0.58
        + dot(normal, vec3(0.13, 0.21, 0.34)) * uIridescence
        + fresnel * 0.34 * uIridescence
        + time * 0.018
      );
      vec3 spectral = hsv2rgb(vec3(hue, 0.74, 1.0));
      vec3 chrome = reflected * (0.75 + uReflect * 0.75);
      chrome += spectral * fresnel * (0.45 + uIridescence * 0.65);
      chrome += vec3(1.0, 0.88, 0.8)
        * pow(max(dot(reflect(-lightA, normal), view), 0.0), 48.0)
        * (0.8 + uHigh * 0.8 + uHat * 3.6);
      chrome += vec3(0.05, 0.14, 0.2) * diffuse + vec3(0.16, 0.02, 0.12) * secondary;

      // Thin internal emissive contour — reads like subsurface neon liquid.
      float contour = pow(1.0 - abs(dot(normal, view)), 7.0);
      chrome += mix(vec3(0.0, 0.65, 1.0), vec3(1.0, 0.02, 0.42), 0.5 + 0.5 * sin(time + pos.y * 4.0))
        * contour * (0.3 + uMid * 0.6 + uSnare * 1.7);
      // Kick transients travel across the whole surface as a clean metallic
      // exposure change, making the hit readable even from the back of a room.
      chrome += spectral * (0.12 + fresnel * 0.42) * (uKick * 1.25 + uBeat * 0.5);
      color = chrome;
    }

    float vignette = 1.0 - smoothstep(0.72, 1.55, length(uv * vec2(0.72, 1.0)));
    color *= 0.25 + 0.75 * vignette;
    color = filmicTone(color * 1.25);
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
// parameter-only uniforms (uMorph/uReflect/uSpeed/uIridescence) never change
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
        uMorph: P.morph ?? 1,
        uReflect: P.reflect ?? 1,
        uSpeed: P.speed ?? 1,
        uIridescence: P.iridescence ?? 1,
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
      uReflect: P.reflect ?? 1,
      uSpeed: P.speed ?? 1,
      uIridescence: P.iridescence ?? 1,
    }),
  );
};
