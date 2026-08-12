// Ion Tempest — a volumetric electrical storm. Turbulent plasma clouds seed
// branching lightning bolts that fork on kicks, while mids thicken the arcs and
// highs spray corona sparks. Built for hard techno drops and festival LED walls.
// The legacy raw-frame shader path remains intact; the opted-in path consumes
// final uniforms produced by a DOM-free capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uStorm;
  uniform float uBranch;
  uniform float uSpeed;
  uniform float uGlow;

  float boltField(vec2 p, float seed, float time) {
    // Domain-warped vertical channels create readable lightning trunks that still
    // feel organic when the storm intensifies.
    float warp = fbm4(p * vec2(2.4, 1.1) + vec2(seed * 3.1, time * 0.55));
    float trunk = abs(p.x + (warp - 0.5) * (0.55 + uBranch * 0.45));
    float mainBolt = exp(-trunk * (38.0 + uHigh * 10.0 - uStorm * 6.0));

    float forkWarp = fbm4(p * vec2(5.5, 2.2) - vec2(time * 1.3, seed * 7.0));
    float forks = exp(-abs(p.x + (forkWarp - 0.5) * 1.4 + sin(p.y * 9.0 + seed) * 0.08)
      * (52.0 - uBranch * 10.0));
    forks *= smoothstep(0.15, 0.75, abs(p.y));

    float micro = exp(-abs(sin(p.y * 28.0 + warp * 12.0 - time * 8.0 + seed))
      * (4.0 + uHat * 5.0)) * mainBolt;
    return mainBolt * 1.15 + forks * (0.45 + uBranch * 0.55) + micro * 0.35;
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.22 + uSpeed * 0.7);
    float impact = max(uKick, uBeat * 0.9);
    vec2 p = uv;
    p.y += 0.08;
    p *= 1.0 - impact * 0.04;

    // Rolling storm body from layered fbm — denser near the horizon line.
    float cloud = fbm4(p * vec2(1.6, 2.4) + vec2(time * 0.18, -time * 0.09));
    cloud += fbm4(p * vec2(3.4, 5.1) - vec2(time * 0.31, time * 0.14)) * 0.45;
    float cloudMask = pow(saturate(cloud * 0.62 + 0.18 - abs(p.y) * 0.22), 1.7);
    cloudMask *= 0.55 + uStorm * 0.55 + uSub * 0.25;

    vec3 color = vec3(0.001, 0.004, 0.014);
    color += mix(vec3(0.02, 0.01, 0.08), vec3(0.0, 0.08, 0.18), cloud)
      * cloudMask * (0.55 + uEnergy * 0.7);

    // Three staggered bolt systems so the frame never feels empty between hits.
    float bolt = 0.0;
    bolt += boltField(p * vec2(1.15, 1.0) + vec2(0.12, 0.0), 1.7, time)
      * (0.35 + impact * 1.8 + uSnare * 0.55);
    bolt += boltField(p * vec2(0.92, 1.05) - vec2(0.35, 0.05), 4.2, time * 1.07)
      * (0.22 + uMid * 0.55 + uSnare * 1.1);
    bolt += boltField(rotate2d(0.4) * p * 1.1 + vec2(0.2, -0.1), 8.9, time * 0.93)
      * (0.12 + uHigh * 0.45 + uHat * 0.9);

    // Kick-gated flash bolts: sharp attack, readable decay via uBeat envelope.
    float flashGate = saturate(impact * 1.4 + uBeat * 0.5);
    bolt *= 0.25 + flashGate * 0.95 + uStorm * 0.2;

    vec3 boltCold = vec3(0.35, 0.7, 1.0);
    vec3 boltHot = vec3(0.85, 0.95, 1.0);
    vec3 boltPink = vec3(1.0, 0.25, 0.7);
    vec3 boltColor = mix(boltCold, boltPink, saturate(uMid * 0.35 + uSnare * 0.4));
    color += mix(boltColor, boltHot, saturate(bolt * 1.4)) * bolt * (1.4 + uGlow);

    // Soft bloom halo around the brightest channels.
    color += boltColor * pow(bolt, 1.6) * (0.55 + uGlow * 0.8);
    color += vec3(0.9, 0.95, 1.0) * pow(bolt, 4.5) * (0.4 + impact * 1.2);

    // Corona sparks ride the highs so hats glitter across the cloud deck.
    float sparkCell = floor((uv + 1.0) * vec2(42.0, 28.0)).x
      + floor((uv.y + 1.0) * 28.0) * 17.0;
    float spark = step(0.97 - uHigh * 0.03 - uHat * 0.12, hash11(sparkCell + floor(time * 11.0)));
    spark *= exp(-abs(uv.y - (hash11(sparkCell) * 1.4 - 0.7)) * 8.0);
    color += vec3(0.7, 0.85, 1.0) * spark * (0.15 + uHigh * 0.5 + uHat * 1.8) * uGlow;

    // Expanding shock ring on detected beats.
    float ringR = 0.18 + (1.0 - saturate(uBeat)) * 0.85;
    float ring = exp(-abs(length(uv) - ringR) * 48.0) * uBeat;
    color += mix(boltCold, boltPink, 0.45) * ring * (0.7 + uGlow * 0.5);

    // Ground glow / horizon sheet for stage depth.
    float ground = exp(-abs(uv.y + 0.72) * (6.0 - uSub * 1.5))
      * (0.08 + uSub * 0.2 + impact * 0.45);
    color += mix(vec3(0.0, 0.15, 0.45), vec3(0.45, 0.0, 0.35), 0.4) * ground * uStorm;

    float vignette = 1.0 - smoothstep(0.68, 1.5, length(uv * vec2(0.72, 1.0)));
    color *= 0.26 + 0.74 * vignette;
    color = filmicTone(color * 1.35);
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
    uStorm: { min: 0.3, max: 2, neutral: 1 },
    uBranch: { min: 0.2, max: 2, neutral: 1 },
    uSpeed: { min: 0, max: 2.5, neutral: 1 },
    uGlow: { min: 0.3, max: 2, neutral: 1 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: {
      uSub: 0, uMid: 0, uHigh: 0, uEnergy: 0,
      uKick: 0, uSnare: 0, uHat: 0, uBeat: 0,
      uStorm: 1, uBranch: 1, uSpeed: 1, uGlow: 1,
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
          uStorm: clamp(finite(params.storm, 1), 0.3, 2),
          uBranch: clamp(finite(params.branch, 1), 0.2, 2),
          uSpeed: clamp(finite(params.speed, 1), 0, 2.5),
          uGlow: clamp(finite(params.glow, 1), 0.3, 2),
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
      uStorm: P.storm ?? 1,
      uBranch: P.branch ?? 1,
      uSpeed: P.speed ?? 1,
      uGlow: P.glow ?? 1,
    }),
  );
};
