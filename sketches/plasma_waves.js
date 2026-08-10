// Plasma Waves — domain-warped liquid plasma. GPU shader port.
// Original rendered chunky cells via thousands of rects with ADD blending on black;
// shader quantizes to the same cell grid and replicates the domain-warp math,
// hueOffset/t accumulation, and vignette faithfully.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uCell;
  uniform float uScaleBase;
  uniform float uT;
  uniform float uHueOffset;

  void main() {
    float cell = max(uCell, 4.0);
    vec2 fragCoord = vTexCoord * uResolution;
    vec2 cellCoord = floor(fragCoord / cell) * cell;

    float scale = 0.005 * uScaleBase * (1.0 + uSub * 0.8);
    float warp = 1.5 + uMid * 4.0;
    float cxS = uResolution.x * scale * 0.5;
    float cyS = uResolution.y * scale * 0.5;

    float sx = cellCoord.x * scale;
    float sy = cellCoord.y * scale;

    float wx = sin(sy * 1.7 + uT * 1.3) * warp;
    float wy = sin(sx * 1.3 - uT) * warp;

    float v = sin((sx + wx) * 2.0 + uT);
    v += sin((sy + wy) * 2.4 - uT * 1.2);
    v += sin(sx + sy + wx - wy + uT * 0.7);
    float dx = sx + wx * 0.5 - cxS;
    float dy = sy + wy * 0.5 - cyS;
    v += sin(sqrt(dx*dx + dy*dy) * 3.0 - uT * 1.5);

    float n = v / 8.0 + 0.5;
    float hue = mod(uHueOffset + n * 140.0, 360.0);
    float bri = 12.0 + n * n * 88.0 * (0.5 + uEnergy);
    vec3 col = hsv2rgb(vec3(hue / 360.0, 0.85, bri / 100.0));
    col *= 200.0 / 255.0;

    // Vignette 0.6 — same as CPU viz-utils radial gradient (inner 0.5*min, outer 1.35*max)
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);
    float vig = 1.0 - smoothstep(0.7, 1.52, length(uv * vec2(0.72, 1.0)));
    col *= 0.4 + 0.6 * vig;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export default (audio, videoDeviceId, params) => {
  let t = 0;
  let hueOffset = 0;
  return makeAudioShader(audio, params, frag, (P, bands) => {
    const speed = P.speed ?? 1;
    const cell = Math.max(4, Math.floor(P.cell ?? 10));
    const scaleBase = P.scale ?? 1;
    t += (0.008 + bands.energy * 0.06) * speed;
    hueOffset = (hueOffset + 0.2 + bands.high * 2.0) % 360;
    return {
      uCell: Number(cell),
      uScaleBase: Number(scaleBase),
      uT: t,
      uHueOffset: hueOffset,
    };
  });
};
