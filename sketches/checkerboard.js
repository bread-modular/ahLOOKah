// Checkerboard — two-color checker pattern with diagonal drift and audio-reactive
// scale pulse. GPU shader port replicates the same HSB colors (1,1,1), phase
// accumulation, and seamless wrapping.
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

export default (audio, videoDeviceId, params) => {
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
