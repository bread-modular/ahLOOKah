// Film Grain — tinted color field with subtle animated grain. GPU shader port.
// Replicates HSB background (hue tint, saturation 0.45, flicker) plus block-quantized
// grain specks with amount-driven alpha, speed-cadenced refresh, and a soft upscale.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uTint;
  uniform float uBgBri;
  uniform float uAmount;
  uniform float uSize;
  uniform float uSpeed;

  void main() {
    float flicker = 1.0 + (valueNoise(vec2(uTime * 3.0, 0.0)) - 0.5) * 0.14 + uEnergy * 0.08;
    float bBri = clamp(uBgBri * flicker, 0.0, 1.0);
    vec3 bg = hsv2rgb(vec3(uTint, 0.45, bBri));

    // Grain refresh cadence: interval = max(1, round(4/speed)); grain holds for interval frames.
    float interval = max(1.0, floor(4.0 / max(uSpeed, 0.05) + 0.5));
    float grainFrame = mod(floor(uTime * 60.0 / interval), 4096.0);
    float eff = clamp(uAmount + uEnergy * 0.3, 0.0, 1.0);

    // Bilinear interpolation of neighbouring block specks (matches imageSmoothingEnabled=true)
    vec2 fragCoord = vTexCoord * uResolution;
    vec2 gv = fragCoord / max(uSize, 1.0);
    vec2 i = floor(gv);
    vec2 f = fract(gv);

    float a00 = hash21(i + vec2(0.0,0.0) + vec2(grainFrame*7.0, 0.0));
    float a10 = hash21(i + vec2(1.0,0.0) + vec2(grainFrame*7.0, 0.0));
    float a01 = hash21(i + vec2(0.0,1.0) + vec2(grainFrame*7.0, 0.0));
    float a11 = hash21(i + vec2(1.0,1.0) + vec2(grainFrame*7.0, 0.0));

    float b00 = hash21(i + vec2(0.0,0.0) + vec2(grainFrame*13.0, 19.0));
    float b10 = hash21(i + vec2(1.0,0.0) + vec2(grainFrame*13.0, 19.0));
    float b01 = hash21(i + vec2(0.0,1.0) + vec2(grainFrame*13.0, 19.0));
    float b11 = hash21(i + vec2(1.0,1.0) + vec2(grainFrame*13.0, 19.0));

    float s00 = step(0.5, a00);
    float s10 = step(0.5, a10);
    float s01 = step(0.5, a01);
    float s11 = step(0.5, a11);

    float al00 = b00 * eff;
    float al10 = b10 * eff;
    float al01 = b01 * eff;
    float al11 = b11 * eff;

    float s0 = mix(s00, s10, f.x);
    float s1 = mix(s01, s11, f.x);
    float speck = mix(s0, s1, f.y);

    float a0 = mix(al00, al10, f.x);
    float a1 = mix(al01, al11, f.x);
    float grainAlpha = mix(a0, a1, f.y);

    vec3 grainCol = vec3(speck);
    vec3 col = mix(bg, grainCol, grainAlpha);

    // Vignette strength 0.4
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);
    float vig = 1.0 - smoothstep(0.7, 1.52, length(uv * vec2(0.72, 1.0)));
    col *= 0.6 + 0.4 * vig;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export default (audio, videoDeviceId, params) => makeAudioShader(
  audio,
  params,
  frag,
  (P) => ({
    uTint: ((P.tint ?? 0.08) % 1 + 1) % 1,
    uBgBri: P.bgBrightness ?? 0.25,
    uAmount: P.amount ?? 0.5,
    uSize: Math.max(1, Math.round(P.size ?? 2)),
    uSpeed: P.speed ?? 1,
  }),
);
