// Aurora Reactor — a magnetic containment core wrapped in flowing aurora
// curtains and field-line filaments. Sub bass swells the reactor, snares shear
// the curtains, hats glitter as ion sparks. Club-ready cosmic techno energy.
// The legacy raw-frame shader path remains intact; the opted-in path consumes
// final uniforms produced by a DOM-free capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uField;
  uniform float uCurtain;
  uniform float uCore;
  uniform float uSpeed;

  float fieldLine(vec2 p, float seed, float time) {
    // Dipole-like curved strokes: x offset grows with |y| for magnetic flare shape.
    float flare = p.x + sin(p.y * 2.8 + seed + time * 0.7) * (0.18 + abs(p.y) * 0.35);
    flare += (fbm4(vec2(p.y * 1.8 + seed, time * 0.25)) - 0.5) * 0.22;
    return exp(-abs(flare) * (16.0 + uField * 10.0));
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.2 + uSpeed * 0.7);
    float impact = max(uKick, uBeat * 0.9);
    vec2 p = rotate2d(sin(time * 0.12) * 0.08) * uv;
    float radial = length(p);
    float angle = atan(p.y, p.x);

    vec3 color = vec3(0.001, 0.004, 0.012);

    // Deep space dust + faint stars.
    float stars = step(0.985, hash21(floor(p * 90.0 + time * 0.5)));
    color += vec3(0.55, 0.75, 1.0) * stars * (0.25 + uHigh * 0.4);

    // Reactor core — hot elliptic body with breathing radius.
    float coreR = (0.14 + uSub * 0.03 + impact * 0.07) * uCore;
    float core = exp(-radial * radial / max(coreR * coreR * 2.2, 1e-4));
    float coreRing = exp(-abs(radial - coreR * 1.35) * (40.0 / max(uCore, 0.3)));
    vec3 coreHot = mix(vec3(0.1, 0.45, 1.0), vec3(1.0, 0.35, 0.1), saturate(impact + uSub));
    color += coreHot * core * (1.2 + uEnergy * 1.4 + impact * 2.2) * uCore;
    color += vec3(1.0, 0.9, 0.75) * pow(core, 3.0) * (0.5 + impact);
    color += mix(vec3(0.0, 0.6, 1.0), vec3(1.0, 0.2, 0.5), 0.4)
      * coreRing * (0.55 + uMid * 0.6 + uSnare * 1.2);

    // Aurora curtains: vertical sheets warped by fbm, stacked in depth layers.
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float layerZ = 0.55 + fi * 0.22;
      vec2 q = p * (1.0 + fi * 0.08);
      q.x += sin(q.y * (2.0 + fi * 0.4) + time * (0.8 + fi * 0.15) + fi) * 0.2;
      q.x += (fbm4(vec2(q.y * 1.5 + fi * 2.0, time * 0.3 + fi)) - 0.5)
        * (0.35 + uCurtain * 0.25 + uMid * 0.15);

      float sheet = exp(-abs(q.x - sin(time * 0.4 + fi * 1.3) * 0.15) * (7.0 + uCurtain * 5.0));
      sheet *= 1.0 - smoothstep(0.1, 1.2, abs(q.y));
      // Vertical striations like real aurora rays.
      float rays = 0.55 + 0.45 * sin(q.y * (18.0 + fi * 3.0) - time * 2.5 + fbm4(q) * 6.0);
      sheet *= rays;
      sheet *= 0.35 + 0.65 * exp(-abs(radial - (0.35 + fi * 0.12)) * 2.5);

      float hue = fract(0.42 + fi * 0.08 + time * 0.012 + uHigh * 0.03);
      vec3 curtainCol = hsv2rgb(vec3(hue, 0.78, 1.0));
      curtainCol = mix(curtainCol, vec3(0.2, 1.0, 0.55), 0.25 + 0.25 * sin(fi + time));
      color += curtainCol * sheet * uCurtain
        * (0.22 + uEnergy * 0.25 + uSnare * 0.35 + uHat * 0.2)
        / layerZ;
    }

    // Magnetic field lines looping over the poles.
    float lines = 0.0;
    for (int j = 0; j < 7; j++) {
      float fj = float(j);
      float seed = fj * 1.37;
      vec2 lp = p;
      lp.x *= 1.0 + fj * 0.04;
      // Stretch vertically for polar loops.
      lp.y *= 0.75;
      lines += fieldLine(lp - vec2(sin(seed + time * 0.2) * 0.05, 0.0), seed, time)
        * (0.35 + 0.65 * abs(sin(angle * 2.0 + fj)));
    }
    lines *= smoothstep(0.05, 0.25, radial) * (1.0 - smoothstep(0.85, 1.35, radial));
    color += mix(vec3(0.2, 0.7, 1.0), vec3(1.0, 0.3, 0.8), 0.4)
      * lines * uField * (0.35 + uMid * 0.4 + impact * 0.9 + uSnare * 0.5);

    // Orbiting containment rings.
    for (int r = 0; r < 3; r++) {
      float fr = float(r);
      float rr = 0.32 + fr * 0.14 + uSub * 0.02 + impact * 0.03;
      float tilt = sin(time * (0.5 + fr * 0.1) + fr) * (0.35 + fr * 0.08);
      vec2 rp = p;
      rp.y /= max(0.25 + abs(cos(tilt)), 0.2);
      float ring = exp(-abs(length(rp) - rr) * (55.0 - uCore * 8.0));
      float dash = 0.5 + 0.5 * sin(atan(rp.y, rp.x) * (8.0 + fr * 2.0) - time * 3.0);
      ring *= mix(0.35, 1.0, pow(dash, 4.0));
      color += hsv2rgb(vec3(fract(0.55 + fr * 0.12 + time * 0.02), 0.75, 1.0))
        * ring * (0.2 + uEnergy * 0.3 + uKick * 0.5);
    }

    // Ion sparkle on highs.
    float spark = step(0.972 - uHat * 0.14, hash21(floor(p * 55.0) + floor(time * 10.0)));
    color += vec3(0.7, 0.95, 1.0) * spark * (0.1 + uHigh * 0.35 + uHat * 1.4);

    // Beat shockwave through the field.
    float waveR = coreR * 1.2 + (1.0 - saturate(uBeat)) * 0.75;
    float wave = exp(-abs(radial - waveR) * 46.0) * uBeat;
    color += coreHot * wave * 1.1;

    float vignette = 1.0 - smoothstep(0.68, 1.48, length(uv * vec2(0.72, 1.0)));
    color *= 0.28 + 0.72 * vignette;
    color = filmicTone(color * 1.32);
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
    uField: { min: 0.25, max: 2, neutral: 1 },
    uCurtain: { min: 0.25, max: 2, neutral: 1 },
    uCore: { min: 0.35, max: 2, neutral: 1 },
    uSpeed: { min: 0, max: 2.5, neutral: 1 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: {
      uSub: 0, uMid: 0, uHigh: 0, uEnergy: 0,
      uKick: 0, uSnare: 0, uHat: 0, uBeat: 0,
      uField: 1, uCurtain: 1, uCore: 1, uSpeed: 1,
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
          uField: clamp(finite(params.field, 1), 0.25, 2),
          uCurtain: clamp(finite(params.curtain, 1), 0.25, 2),
          uCore: clamp(finite(params.core, 1), 0.35, 2),
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
      uField: P.field ?? 1,
      uCurtain: P.curtain ?? 1,
      uCore: P.core ?? 1,
      uSpeed: P.speed ?? 1,
    }),
  );
};
