// Noise Static — analog TV snow. GPU fragment shader port.
// Original per-pixel CPU path used a tiny offscreen buffer + loadPixels/updatePixels
// and a drifting hold band. The shader replicates block-quantized hash per block,
// independent R/G/B hashing for chroma mode, and the same hold band via valueNoise.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uIntensity;
  uniform float uBlock;
  uniform float uColorMode;
  uniform float uPulse;
  uniform float uLevel;

  void main() {
    float hot = clamp(uIntensity + uLevel * uPulse * 0.4, 0.0, 1.0);
    vec2 fragCoord = vTexCoord * uResolution;
    vec2 blockCoord = floor(fragCoord / max(uBlock, 1.0));
    float frameSeed = mod(floor(uTime * 60.0), 4096.0);

    vec3 base;
    if (uColorMode > 0.5) {
      float r = hash21(blockCoord + vec2(frameSeed, 17.0));
      float g = hash21(blockCoord + vec2(frameSeed, 41.0));
      float b = hash21(blockCoord + vec2(frameSeed, 79.0));
      float cr = 0.50196 + (r * 2.0 - 1.0) * 0.498 * hot;
      float cg = 0.50196 + (g * 2.0 - 1.0) * 0.498 * hot;
      float cb = 0.50196 + (b * 2.0 - 1.0) * 0.498 * hot;
      base = vec3(cr, cg, cb);
    } else {
      float h = hash21(blockCoord + vec2(frameSeed, 0.0));
      float v = 0.50196 + (h * 2.0 - 1.0) * 0.498 * hot;
      base = vec3(v);
    }

    float n = valueNoise(vec2(uTime * 0.24, 0.0));
    float bandY = n * (uResolution.y + 160.0) - 80.0;
    float bandH = 20.0 + uLevel * 40.0;
    float fy = fragCoord.y;
    vec3 col = base;
    if (fy >= bandY && fy < bandY + bandH) {
      col = mix(col, vec3(0.0), 46.0/255.0);
    } else if (fy >= bandY + bandH && fy < bandY + bandH + 3.0) {
      float ea = (20.0 + uLevel * 30.0)/255.0;
      col = mix(col, vec3(1.0), ea);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

export default (audio, videoDeviceId, params) => {
  let level = 0;
  return makeAudioShader(audio, params, frag, (P, bands) => {
    const target = bands.energy;
    level += (target - level) * 0.16;
    return {
      uIntensity: P.intensity ?? 0.7,
      uBlock: Math.max(1, Math.round(P.density ?? 3)),
      uColorMode: (P.color ?? 0) >= 0.5 ? 1 : 0,
      uPulse: P.pulse ?? 1,
      uLevel: level,
    };
  });
};
