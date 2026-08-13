// Mandelbulb Drift — a ray-marched 3D Mandelbulb fractal, the centrepiece of
// modern shader art. The fractal orbits and slowly dives into itself; bass
// inflates the bulb, mids raise iteration detail, and the orbit-trap palette
// cycles so the surface reads as alien mineral terrain, not a flat blob.
// The legacy raw-frame path stays intact; opted-in renderers consume final
// controls (header audio uniforms + params) from a capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uPower;
  uniform float uDetail;
  uniform float uDrift;
  uniform float uGlow;

  // Classic 3D Mandelbulb distance estimator. A fixed iteration budget keeps
  // it WebGL1-compatible; the loop breaks as soon as the orbit escapes.
  float mandelbulbDE(vec3 pos, out float trap) {
    vec3 z = pos;
    float dr = 1.0;
    float r = 0.0;
    trap = 1e10;
    float power = uPower;
    for (int i = 0; i < 12; i++) {
      r = length(z);
      if (r > 2.0) break;
      float inv = 1.0 / max(r, 1e-5);
      float theta = acos(clamp(z.z * inv, -1.0, 1.0));
      float phi = atan(z.y, z.x);
      dr = pow(r, power - 1.0) * power * dr + 1.0;
      float zr = pow(r, power);
      theta *= power;
      phi *= power;
      z = zr * vec3(sin(theta) * cos(phi), sin(phi) * sin(theta), cos(theta));
      z += pos;
      // Orbit trap: closest approach to the origin colors the fractal veins.
      trap = min(trap, length(z) * 0.5 + float(i) * 0.02);
    }
    return 0.5 * log(max(r, 1e-4)) * r / max(dr, 1e-4);
  }

  float mapScene(vec3 pos, out float trap) {
    return mandelbulbDE(pos, trap);
  }

  vec3 getNormal(vec3 p) {
    vec2 e = vec2(0.0016, -0.0016);
    float t0, t1, t2, t3;
    return normalize(
      e.xyy * mapScene(p + e.xyy, t0)
      + e.yyx * mapScene(p + e.yyx, t1)
      + e.yxy * mapScene(p + e.yxy, t2)
      + e.xxx * mapScene(p + e.xxx, t3)
    );
  }

  // Filament detail: thin bright streaks following the fractal's curvature.
  float creases_fn(vec3 n, vec3 p) {
    float a = pow(max(0.0, sin(p.x * 40.0 + n.y * 12.0)), 16.0);
    float b = pow(max(0.0, sin(p.y * 38.0 - n.z * 10.0)), 16.0);
    return max(a, b);
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.10 + uDrift * 0.30);

    // The camera slowly orbits and breathes toward the fractal on kicks.
    float zoom = 2.9 - uKick * 0.28 - uBeat * 0.06 - sin(time * 0.13) * 0.12;
    vec3 ro = vec3(
      sin(time * 0.21) * 1.4,
      cos(time * 0.17) * 1.1,
      zoom
    );
    vec3 rd = normalize(vec3(uv * 0.7, -1.5));

    float travel = 0.0;
    float minTrap = 1e10;
    float surfaceTrap = 0.0;
    bool hit = false;
    float glow = 0.0;
    // Track closest approach to the surface for an ambient-glow pass.
    for (int i = 0; i < 90; i++) {
      vec3 pos = ro + rd * travel;
      float trap;
      float d = mapScene(pos, trap);
      minTrap = min(minTrap, trap);
      glow += exp(-d * 6.0) * 0.016;
      if (d < 0.0015) {
        hit = true;
        surfaceTrap = trap;
        break;
      }
      travel += d * (0.62 + uDetail * 0.06);
      if (travel > 6.5) break;
    }

    vec3 color = vec3(0.001, 0.002, 0.008);
    // Background nebula so the diving camera never hits pure black.
    vec3 bgDir = normalize(rd);
    float nebula = fbm4(bgDir.xy * 2.0 + time * 0.02);
    color += mix(vec3(0.01, 0.005, 0.03), vec3(0.02, 0.0, 0.05), nebula) * 0.4;

    if (hit) {
      vec3 pos = ro + rd * travel;
      vec3 normal = getNormal(pos);
      vec3 view = -rd;

      // Iteration/orbit-trap coloring -> alien mineral banding.
      float band = fract(surfaceTrap * 1.3 + time * 0.03);
      vec3 base = hsv2rgb(vec3(fract(0.58 + band * 0.4), 0.8, 1.0));
      vec3 vein = hsv2rgb(vec3(fract(0.08 + band * 0.5), 0.9, 1.0));

      float fresnel = pow(1.0 - max(dot(normal, view), 0.0), 3.0);
      float diff = max(dot(normal, normalize(vec3(0.6, 0.8, -0.4))), 0.0);
      float back = max(dot(normal, normalize(vec3(-0.5, -0.3, 0.6))), 0.0);
      float occlusion = pow(clamp(surfaceTrap, 0.0, 1.0), 1.4);

      vec3 col = base * (0.25 + diff * 0.6) + vein * back * 0.35;
      col += vein * fresnel * (0.5 + uGlow);
      col += base * occlusion * 0.25;
      // Pseudo-ambient-occlusion creases using a fine normal wobble.
      float crease = pow(max(0.0, 1.0 - abs(dot(normal, view))), 5.0);
      col += mix(base, vein, 0.5) * crease * (0.3 + uMid * 0.5 + uSnare * 1.6);

      // Kick exposure sweep rides across the whole surface for room readability.
      col += vein * (0.15 + fresnel * 0.4) * (uKick * 1.3 + uBeat * 0.5);
      // Highs etch bright filaments into the fractal detail.
      float filaments = pow(creases_fn(normal, pos), 1.0);
      col += vec3(0.7, 0.9, 1.0) * filaments * (uHigh * 0.4 + uHat * 1.8) * uGlow;
      color = col;
    }

    // Volumetric fractal glow around the silhouette (the "aura" of the bulb).
    vec3 glowColor = hsv2rgb(vec3(fract(0.55 + minTrap * 0.4 + time * 0.02), 0.85, 1.0));
    color += glowColor * glow * (0.5 + uEnergy * 1.2 + uKick * 1.4) * uGlow;

    float vignette = 1.0 - smoothstep(0.7, 1.5, length(uv * vec2(0.7, 1.0)));
    color *= 0.3 + 0.7 * vignette;
    color = filmicTone(color * 1.25);
    color = pow(color, vec3(0.9));
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
    uKick: { min: 0, max: 1.4, neutral: 0 },
    uSnare: { min: 0, max: 1.4, neutral: 0 },
    uHat: { min: 0, max: 1.4, neutral: 0 },
    uBeat: { min: 0, max: 1.4, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: {
      uSub: 0, uMid: 0, uHigh: 0, uEnergy: 0,
      uKick: 0, uSnare: 0, uHat: 0, uBeat: 0,
    },
  },
});

// The controller consumes the canonical feature frame and applies the accepted
// band/punch gains exactly like the legacy shader path did, producing the final
// header audio uniforms. No renderer-side feature analysis on the opted-in path.
export function createAudioController({ rng = Math.random } = {}) {
  return {
    update({ shared, params = {} }) {
      const f = shared?.getFeatures?.() || {};
      const bassGain = Math.max(0, Number(params.bass ?? 1));
      const midGain = Math.max(0, Number(params.mid ?? 1));
      const highGain = Math.max(0, Number(params.high ?? 1));
      const punch = Math.max(0, Number(params.punch ?? 1));
      return {
        continuous: {
          uSub: clamp((f.sub ?? 0) * bassGain, 0, 1.6),
          uMid: clamp((f.mid ?? 0) * midGain, 0, 1.6),
          uHigh: clamp((f.high ?? 0) * highGain, 0, 1.6),
          uEnergy: clamp((f.energy ?? 0) * (bassGain * 0.42 + midGain * 0.38 + highGain * 0.2), 0, 1.6),
          uKick: clamp((f.kick ?? 0) * bassGain * punch, 0, 1.4),
          uSnare: clamp((f.snare ?? 0) * midGain * punch, 0, 1.4),
          uHat: clamp((f.hat ?? 0) * highGain * punch, 0, 1.4),
          uBeat: clamp((f.beat ?? 0) * bassGain * punch, 0, 1.4),
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
  if (audioControls) {
    // Opted-in path: header audio uniforms come from the controller; only the
    // visual params are mapped locally.
    return makeAudioShader(
      audio,
      params,
      frag,
      (P, _bands, _p, controls) => {
        const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls?.continuous || {}) };
        return {
          uPower: P.power ?? 8,
          uDetail: P.detail ?? 1,
          uDrift: P.drift ?? 1,
          uGlow: P.glow ?? 1,
          uSub: C.uSub,
          uMid: C.uMid,
          uHigh: C.uHigh,
          uEnergy: C.uEnergy,
          uKick: C.uKick,
          uSnare: C.uSnare,
          uHat: C.uHat,
          uBeat: C.uBeat,
        };
      },
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
      uPower: P.power ?? 8,
      uDetail: P.detail ?? 1,
      uDrift: P.drift ?? 1,
      uGlow: P.glow ?? 1,
    }),
  );
};
