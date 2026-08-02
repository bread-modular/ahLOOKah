// Cymatic Bloom — a GPU kaleidoscope built from Chladni-style interference,
// recursive inversion and liquid caustics. It feels organic rather than merely
// geometric: bass opens the flower, mids warp it, highs reveal filament detail.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uSymmetry;
  uniform float uComplexity;
  uniform float uFlow;
  uniform float uBloom;

  vec2 kaleidoscope(vec2 p, float segments) {
    float radius = length(p);
    float sector = TAU / max(segments, 2.0);
    float angle = atan(p.y, p.x);
    angle = abs(mod(angle + sector * 0.5, sector) - sector * 0.5);
    return vec2(cos(angle), sin(angle)) * radius;
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.22 + uFlow * 0.7);
    float pulse = 1.0 + uSub * 0.1 + uKick * 0.26 + uBeat * 0.08;
    vec2 p = rotate2d(time * 0.09 + uMid * 0.045 + uSnare * 0.11) * uv / pulse;
    vec2 folded = kaleidoscope(p, floor(uSymmetry + 0.5));

    // Domain-warp the folded sector before evaluating the standing waves.
    float warpA = fbm4(folded * (2.2 + uComplexity) + vec2(time * 0.12, -time * 0.08));
    float warpB = fbm4(rotate2d(1.2) * folded * 3.1 - vec2(time * 0.09, time * 0.14));
    vec2 q = folded;
    q += vec2(warpA - 0.5, warpB - 0.5)
      * (0.12 + uMid * 0.12 + uSnare * 0.28) * uComplexity;

    float frequency = 8.0 + uComplexity * 5.5 + uHigh * 1.5 + uHat * 3.4;
    float chladniA = sin(q.x * frequency + sin(q.y * 3.0 + time))
      * sin(q.y * (frequency + 2.0) - time * 1.4);
    float chladniB = sin((q.x + q.y) * (frequency * 0.73) - time * 1.7)
      * cos((q.x - q.y) * (frequency * 0.61) + time);
    float field = chladniA - chladniB * (0.62 + uMid * 0.22 + uSnare * 0.32);
    float cymaticLine = exp(-abs(field) * (8.0 + uHigh * 5.0 + uHat * 8.0));

    // Recursive inversion adds glassy micro-branches within each petal.
    vec2 z = q * (1.5 + uComplexity * 0.62);
    float fractalGlow = 0.0;
    float orbit = 10.0;
    for (int i = 0; i < 5; i++) {
      float denominator = clamp(dot(z, z), 0.16, 2.6);
      z = abs(z) / denominator - vec2(0.68 + sin(time * 0.21) * 0.05, 0.44);
      z = rotate2d(0.27 + float(i) * 0.035) * z;
      float ring = abs(length(z) - (0.52 + float(i) * 0.045));
      fractalGlow += exp(-ring * (19.0 + uHigh * 7.0 + uHat * 12.0))
        * (0.28 - float(i) * 0.035);
      orbit = min(orbit, length(z));
    }

    float radial = length(p);
    float petals = pow(max(0.0, cos(atan(p.y, p.x) * uSymmetry + time * 0.8)), 8.0);
    float bassRing = exp(
      -abs(radial - (0.28 + uSub * 0.1 + uKick * 0.2))
      * (22.0 - uSub * 2.0 - uKick * 4.0)
    );
    float outerRing = exp(-abs(radial - (0.68 + sin(time * 0.37) * 0.06 + uSnare * 0.06)) * 18.0);
    float caustic = pow(saturate(1.0 - orbit * 0.52), 3.0) * (0.2 + warpA * 0.8);

    float hueBase = fract(
      0.54
      + radial * 0.19
      + field * 0.055
      + warpB * 0.18
      + time * 0.018
    );
    vec3 cold = hsv2rgb(vec3(hueBase, 0.9, 1.0));
    vec3 hot = hsv2rgb(vec3(fract(hueBase + 0.38), 0.82, 1.0));
    vec3 color = vec3(0.001, 0.002, 0.012);
    color += cold * cymaticLine * (0.4 + uBloom * 0.8) * (0.65 + radial);
    color += hot * fractalGlow * (0.5 + uBloom * 0.72);
    color += mix(vec3(0.0, 0.55, 1.0), vec3(1.0, 0.02, 0.42), petals)
      * bassRing * (0.28 + uSub * 0.65 + uKick * 1.9) * uBloom;
    color += hsv2rgb(vec3(fract(hueBase + 0.16), 0.65, 1.0))
      * outerRing * petals * (0.2 + uMid * 0.55 + uSnare * 1.5);
    color += vec3(0.5, 0.76, 1.0) * caustic
      * (0.1 + uHigh * 0.2 + uHat * 0.72);

    // Hot cores and soft halos are derived from the same field, so bloom stays
    // coherent instead of looking like a generic blur pass.
    float hotCore = pow(cymaticLine, 6.0) + pow(fractalGlow, 3.0);
    color += vec3(0.82, 0.92, 1.0) * hotCore
      * (0.28 + uHigh * 0.42 + uHat * 1.35);
    color += cold * cymaticLine * cymaticLine * uBloom * 0.65;

    float beatRingRadius = 0.22 + (1.0 - saturate(uBeat)) * 0.7;
    float beatRing = exp(-abs(radial - beatRingRadius) * 52.0) * uBeat;
    color += hsv2rgb(vec3(fract(hueBase + 0.48), 0.72, 1.0)) * beatRing * uBloom;

    float vignette = 1.0 - smoothstep(0.68, 1.45, length(uv * vec2(0.72, 1.0)));
    color *= 0.28 + 0.72 * vignette;
    color = filmicTone(color * 1.28);
    color = pow(color, vec3(0.9));
    gl_FragColor = vec4(color, 1.0);
  }
`;

export default (audio, videoDeviceId, params) => makeAudioShader(
  audio,
  params,
  frag,
  (P) => ({
    uSymmetry: P.symmetry ?? 10,
    uComplexity: P.complexity ?? 1,
    uFlow: P.flow ?? 1,
    uBloom: P.bloom ?? 1,
  }),
);
