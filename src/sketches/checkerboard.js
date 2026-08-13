// Checkerboard — two-color checker pattern with diagonal drift and audio-reactive
// scale pulse. The legacy shader path remains intact; the opted-in path consumes
// final uniforms produced by a DOM-free capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uHueA;
  uniform float uHueB;
  uniform float uCell;
  uniform float uPhase;

  void main() {
    vec3 colA = hsv2rgb(vec3(uHueA, 0.85, 0.95));
    vec3 colB = hsv2rgb(vec3(uHueB, 0.85, 0.95));
    float cell = max(uCell, 4.0);
    float ox = -mod(uPhase, cell * 2.0);
    float oy = -mod(uPhase * 0.5, cell * 2.0);
    vec2 fragCoord = vTexCoord * uResolution;
    vec2 p = fragCoord - vec2(ox, oy);
    vec2 idx = floor(p / cell);
    float checker = mod(idx.x + idx.y, 2.0);
    vec3 col = checker < 0.5 ? colA : colB;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    uHueA: { min: 0, max: 1, neutral: 0.58 },
    uHueB: { min: 0, max: 1, neutral: 0.08 },
    uCell: { min: 4, max: 400, neutral: 48 },
    uPhase: { min: -1_000_000, max: 1_000_000, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { uHueA: 0.58, uHueB: 0.08, uCell: 48, uPhase: 0 },
  },
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const hue = (value, fallback) => ((Number.isFinite(value) ? value : fallback) % 1 + 1) % 1;

// This controller intentionally owns phase and feature mapping. The 60 factor
// calibrates the old frame-step phase increment to elapsed seconds, so controller
// cadence can vary without changing visual speed.
export function createAudioController() {
  let phase = 0;
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const bands = shared?.getFeatures?.({}) || { energy: 0 };
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const cellBase = Math.max(8, Number(params.cell) || 48);
      const speed = Number.isFinite(params.speed) ? params.speed : 0.5;
      const pulse = Number.isFinite(params.pulse) ? params.pulse : 1;
      const energy = clamp(Number(bands.energy) || 0, 0, 1.6);
      phase += (speed + energy * pulse * 2) * dt * 60;
      // Keep the value finite during a long-running set while preserving the
      // shader's seamless modulo behavior.
      if (Math.abs(phase) > 900_000) phase %= 100_000;
      return {
        continuous: {
          uHueA: hue(params.hueA, 0.58),
          uHueB: hue(params.hueB, 0.08),
          uCell: clamp(cellBase * (1 + energy * pulse * 0.35), 4, 400),
          uPhase: phase,
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
      (_P, _bands, _p, controls) => controls?.continuous || AUDIO_CONTROL_SCHEMA.neutral.continuous,
      { audioControls },
    );
  }

  // Existing raw-frame shader path for standalone use and any un-migrated
  // registry entry. It continues to own local feature mapping exactly as before.
  let phase = 0;
  return makeAudioShader(audio, params, frag, (P, bands) => {
    const cellBase = Math.max(8, P.cell ?? 48);
    const hueA = ((P.hueA ?? 0.58) % 1 + 1) % 1;
    const hueB = ((P.hueB ?? 0.08) % 1 + 1) % 1;
    const speed = P.speed ?? 0.5;
    const pulse = P.pulse ?? 1;
    const level = bands.energy;
    phase += speed + level * pulse * 2;
    const cell = cellBase * (1 + level * pulse * 0.35);
    return {
      uHueA: hueA,
      uHueB: hueB,
      uCell: Number(cell),
      uPhase: phase,
    };
  });
};
