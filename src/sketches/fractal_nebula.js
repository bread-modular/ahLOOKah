// Fractal Nebula — a raymarched Mandelbulb fractal that continuously morphs
// its power parameter with the music. Bass inflates the structure, mids add
// turbulent surface detail, and highs ignite prismatic edge glow. The fractal
// floats in a volumetric nebula cloud with volumetric god-rays from a hidden sun.
// The legacy raw-frame shader path remains intact; the opted-in path consumes
// final uniforms produced by a DOM-free capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uPower;
  uniform float uDetail;
  uniform float uGlow;
  uniform float uSpeed;

  // Mandelbulb distance estimator with orbit-trap coloring data
  vec2 mandelbulbDE(vec3 pos, float power, float detail) {
    vec3 z = pos;
    float dr = 1.0;
    float r = 0.0;
    float trap = 1e10;
    float iterations = 6.0 + detail * 4.0;

    for (int i = 0; i < 10; i++) {
      if (float(i) >= iterations) break;
      r = length(z);
      if (r > 2.0) break;

      // Spherical coordinates for the power transform
      float theta = acos(clamp(z.z / max(r, 1e-7), -1.0, 1.0));
      float phi = atan(z.y, z.x);
      dr = pow(r, power - 1.0) * power * dr + 1.0;

      float zr = pow(r, power);
      theta *= power;
      phi *= power;

      z = zr * vec3(
        sin(theta) * cos(phi),
        sin(theta) * sin(phi),
        cos(theta)
      ) + pos;

      trap = min(trap, length(z));
    }
    return vec2(0.5 * log(r) * r / max(dr, 1e-7), trap);
  }

  // Scene SDF: the fractal plus a bounding sphere for early termination
  vec2 sceneSDF(vec3 p, float time, float power, float detail) {
    // Slow rotation for cinematic movement
    p.xz = rotate2d(time * 0.12) * p.xz;
    p.xy = rotate2d(sin(time * 0.08) * 0.3) * p.xy;

    // Audio-driven scale breathing
    float impact = max(uKick, uBeat * 0.7);
    float scale = 1.0 + uSub * 0.12 + impact * 0.22;
    vec3 sp = p / scale;

    vec2 bulb = mandelbulbDE(sp, power, detail);
    float d = bulb.x * scale;

    // Bounding sphere to limit ray march distance
    float bound = length(p) - 2.2 * scale;
    d = max(d, -bound);

    return vec2(d, bulb.y);
  }

  // Estimate normal via tetrahedron technique
  vec3 calcNormal(vec3 p, float time, float power, float detail) {
    vec2 e = vec2(0.0008, -0.0008);
    return normalize(
      e.xyy * sceneSDF(p + e.xyy, time, power, detail).x +
      e.yyx * sceneSDF(p + e.yyx, time, power, detail).x +
      e.yxy * sceneSDF(p + e.yxy, time, power, detail).x +
      e.xxx * sceneSDF(p + e.xxx, time, power, detail).x
    );
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.2 + uSpeed * 0.55);
    float impact = max(uKick, uBeat * 0.75);

    // Audio-reactive fractal power: oscillates between ~3 and ~9
    float basePower = 4.0 + uPower * 3.0;
    float power = basePower + sin(time * 0.7) * 1.5
      + uMid * 1.8 + uSnare * 2.2;
    power = clamp(power, 2.5, 12.0);
    float detail = uDetail;

    // Camera orbit
    float camDist = 2.8 - uSub * 0.3 - impact * 0.4;
    float camAngle = time * 0.15;
    vec3 ro = vec3(
      sin(camAngle) * camDist,
      sin(time * 0.11) * 0.8 + uMid * 0.3,
      cos(camAngle) * camDist
    );
    vec3 target = vec3(0.0, 0.0, 0.0);
    vec3 fwd = normalize(target - ro);
    vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, fwd);
    vec3 rd = normalize(fwd * 1.6 + right * uv.x + up * uv.y);

    // Raymarch the fractal
    vec3 color = vec3(0.0);
    float t = 0.0;
    float trap = 1e10;
    bool hit = false;
    vec3 hitPos = vec3(0.0);
    float glow = 0.0;

    for (int i = 0; i < 96; i++) {
      vec3 pos = ro + rd * t;
      vec2 result = sceneSDF(pos, time, power, detail);
      float d = result.x;
      trap = min(trap, result.y);

      // Accumulate volumetric glow near the surface
      glow += exp(-abs(d) * 12.0) * 0.018 * uGlow;

      if (d < 0.0008) {
        hit = true;
        hitPos = pos;
        break;
      }
      t += d * 0.72;
      if (t > 6.0) break;
    }

    // Background nebula
    vec3 bgDir = rd;
    float nebula1 = fbm4(bgDir.xy * 2.5 + vec2(time * 0.02, -time * 0.015));
    float nebula2 = fbm4(bgDir.yz * 3.2 - vec2(time * 0.018, time * 0.01));
    float nebulaMask = pow(saturate(nebula1 * 0.6 + nebula2 * 0.4 - 0.35), 2.0);
    vec3 nebulaColor = mix(
      vec3(0.12, 0.0, 0.25),
      vec3(0.0, 0.15, 0.3),
      nebula2
    ) + vec3(0.2, 0.05, 0.1) * nebula1;
    color += nebulaColor * nebulaMask * 0.6;

    // Star field
    float starSeed = hash21(floor(bgDir.xy * 80.0));
    float stars = step(0.992, starSeed) * (0.5 + 0.5 * sin(time * 5.0 + starSeed * VIZ_TAU));
    color += vec3(0.8, 0.85, 1.0) * stars * 0.7;

    if (hit) {
      vec3 n = calcNormal(hitPos, time, power, detail);
      vec3 lightDir = normalize(vec3(0.6, 0.8, -0.4));

      // Diffuse + specular
      float diff = max(dot(n, lightDir), 0.0);
      vec3 halfVec = normalize(lightDir - rd);
      float spec = pow(max(dot(n, halfVec), 0.0), 48.0);

      // Orbit-trap coloring: map the trap value to a neon palette
      float hue = fract(trap * 1.8 + time * 0.04 + uMid * 0.3);
      vec3 surfaceColor = hsv2rgb(vec3(hue, 0.85, 0.9));
      surfaceColor = mix(surfaceColor, vec3(1.0, 0.95, 0.9), spec * 0.6);

      // Fresnel rim glow
      float fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 3.5);
      vec3 rimColor = hsv2rgb(vec3(fract(hue + 0.35), 0.9, 1.0));

      color += surfaceColor * (0.15 + diff * 0.75) * (1.0 + uEnergy * 0.8);
      color += rimColor * fresnel * (0.8 + uHigh * 1.5 + uHat * 2.5) * uGlow;
      color += vec3(1.0) * spec * (0.5 + impact * 1.2);

      // Subsurface scattering approximation
      float sss = pow(max(dot(rd, lightDir), 0.0), 3.0) * 0.3;
      color += surfaceColor * sss * (0.5 + uSub * 0.8);
    }

    // Volumetric glow accumulation (the "nebula" around the fractal)
    vec3 glowColor = hsv2rgb(vec3(fract(time * 0.03 + trap * 0.5), 0.8, 1.0));
    color += glowColor * glow * (1.2 + impact * 2.0);

    // Beat-triggered shockwave ring
    float ringRadius = (1.0 - saturate(uBeat)) * 2.5;
    float ringDist = abs(length(hitPos.xz) - ringRadius);
    float ring = exp(-ringDist * 18.0) * uBeat;
    color += mix(vec3(0.1, 0.5, 1.0), vec3(1.0, 0.1, 0.5), 0.5 + 0.5 * sin(time))
      * ring * 1.5;

    // High-frequency sparkle on the fractal surface
    float sparkleSeed = hash21(floor(hitPos.xy * 60.0 + time * 2.0));
    float sparkle = step(0.94 - uHigh * 0.04 - uHat * 0.12, sparkleSeed)
      * pow(max(0.0, sin(sparkleSeed * VIZ_TAU + time * 12.0)), 16.0);
    color += vec3(0.7, 0.85, 1.0) * sparkle * (0.6 + uHat * 3.0) * float(hit);

    float vignette = 1.0 - smoothstep(0.6, 1.5, length(uv * vec2(0.72, 1.0)));
    color *= 0.25 + 0.75 * vignette;
    color = filmicTone(color * 1.3);
    color = pow(color, vec3(0.9));
    gl_FragColor = vec4(color, 1.0);
  }
`;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

// Header audio uniforms the fragment shader reads (uSub/uMid/uHigh/uEnergy/
// uKick/uSnare/uHat/uBeat) plus the pattern's own param uniforms. In the
// migrated path makeAudioShader hard-zeros the header uniforms, so the
// controller must supply every one of them as a continuous control.
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
    uPower: { min: 0, max: 2, neutral: 1 },
    uDetail: { min: 0.2, max: 2, neutral: 1 },
    uGlow: { min: 0.2, max: 2, neutral: 1 },
    uSpeed: { min: 0, max: 2.5, neutral: 1 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: {
      uSub: 0, uMid: 0, uHigh: 0, uEnergy: 0,
      uKick: 0, uSnare: 0, uHat: 0, uBeat: 0,
      uPower: 1, uDetail: 1, uGlow: 1, uSpeed: 1,
    },
  },
});

// The controller owns all audio interpretation on the capture owner: it maps
// the canonical musical features through the accepted param gains and, when no
// audio frame exists, reproduces makeAudioShader's musical idle bands so the
// effect stays stage-ready before an input is selected.
export function createAudioController({ rng = Math.random } = {}) {
  let elapsed = 0;
  return {
    update({ frame, shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(finite(deltaSeconds, 1 / 30), 1 / 240, 0.1);
      elapsed += dt;
      const bassGain = Math.max(0, finite(params.bass, 1));
      const midGain = Math.max(0, finite(params.mid, 1));
      const highGain = Math.max(0, finite(params.high, 1));
      const punch = Math.max(0, finite(params.punch, 1));
      const pulse = (rate, offset = 0, decay = 18) => {
        const phase = ((elapsed * rate + offset) % 1 + 1) % 1;
        return Math.exp(-phase * decay);
      };

      let bands;
      if (frame) {
        const f = shared?.getFeatures?.() || {};
        bands = {
          sub: clamp((f.sub ?? 0) * bassGain, 0, 1.6),
          mid: clamp((f.mid ?? 0) * midGain, 0, 1.6),
          high: clamp((f.high ?? 0) * highGain, 0, 1.6),
          energy: clamp((f.energy ?? 0) * (bassGain * 0.42 + midGain * 0.38 + highGain * 0.2), 0, 1.6),
          kick: clamp((f.kick ?? 0) * bassGain * punch, 0, 1.4),
          snare: clamp((f.snare ?? 0) * midGain * punch, 0, 1.4),
          hat: clamp((f.hat ?? 0) * highGain * punch, 0, 1.4),
          beat: clamp((f.beat ?? 0) * bassGain * punch, 0, 1.4),
        };
      } else {
        const rawKick = pulse(2.0);
        const idleKick = Math.min(1.4, rawKick * bassGain * punch);
        const idleSnare = Math.min(1.4, pulse(1.0, 0.5, 22) * midGain * punch);
        const idleHat = Math.min(1.4, pulse(4.0, 0.5, 28) * highGain * punch);
        const sway = 0.5 + 0.5 * Math.sin(elapsed * 1.37);
        bands = {
          sub: (0.14 + rawKick * 0.48) * bassGain,
          mid: (0.12 + sway * 0.14) * midGain,
          high: (0.08 + (1 - sway) * 0.16) * highGain,
          energy: 0.18 + rawKick * 0.16 + sway * 0.06,
          kick: idleKick,
          snare: idleSnare,
          hat: idleHat,
          beat: idleKick,
        };
      }

      return {
        continuous: {
          uSub: bands.sub,
          uMid: bands.mid,
          uHigh: bands.high,
          uEnergy: bands.energy,
          uKick: bands.kick,
          uSnare: bands.snare,
          uHat: bands.hat,
          uBeat: bands.beat,
          uPower: clamp(finite(params.power, 1), 0, 2),
          uDetail: clamp(finite(params.detail, 1), 0.2, 2),
          uGlow: clamp(finite(params.glow, 1), 0.2, 2),
          uSpeed: clamp(finite(params.speed, 1), 0, 2.5),
        },
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
    return makeAudioShader(
      audio,
      params,
      frag,
      (_P, _bands, _p, controls) => ({
        ...AUDIO_CONTROL_SCHEMA.neutral.continuous,
        ...(controls?.continuous || {}),
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
      uPower: P.power ?? 1,
      uDetail: P.detail ?? 1,
      uGlow: P.glow ?? 1,
      uSpeed: P.speed ?? 1,
    }),
  );
};
