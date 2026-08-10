// Aurora Storm — volumetric northern lights curtains rippling across a polar
// sky. Multiple layered curtain sheets with magnetic field-aligned striations,
// a reflective frozen lake below, and a deep star field. Bass drives curtain
// intensity and vertical reach, mids shift the color palette between green and
// violet, and highs create shimmering particle precipitation.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uCurtains;
  uniform float uPalette;
  uniform float uShimmer;
  uniform float uSpeed;

  // Layered curtain noise: stretched fbm that reads as magnetic field lines
  float curtainNoise(vec2 p, float time) {
    float n = 0.0;
    n += 0.50 * valueNoise(p * vec2(1.0, 0.15) + vec2(time * 0.3, 0.0));
    n += 0.25 * valueNoise(p * vec2(2.3, 0.35) - vec2(time * 0.5, time * 0.1));
    n += 0.15 * valueNoise(p * vec2(4.7, 0.7) + vec2(time * 0.8, -time * 0.15));
    n += 0.10 * valueNoise(p * vec2(9.1, 1.4) - vec2(time * 1.2, time * 0.2));
    return n;
  }

  // Single aurora curtain layer
  vec3 auroraLayer(vec2 uv, float time, float layerOffset, float intensity) {
    float impact = max(uKick, uBeat * 0.6);

    // Horizontal position of the curtain band
    float bandCenter = sin(time * 0.13 + layerOffset * 2.1) * 0.35
      + cos(time * 0.09 + layerOffset) * 0.2;
    float bandWidth = 0.18 + uCurtains * 0.12 + uSub * 0.06;

    // Distance from the curtain center line
    float x = uv.x - bandCenter;
    float bandMask = exp(-x * x / (2.0 * bandWidth * bandWidth));

    // Vertical curtain shape: rises from horizon, fades at top
    float horizon = -0.15;
    float height = uv.y - horizon;
    float verticalMask = smoothstep(0.0, 0.12, height)
      * (1.0 - smoothstep(0.5 + uSub * 0.25 + impact * 0.3, 1.1, height));

    // Curtain folds: the characteristic draping structure
    float foldFreq = 6.0 + uCurtains * 8.0;
    float folds = sin(x * foldFreq + time * 1.5 + layerOffset * 3.0
      + curtainNoise(vec2(x * 3.0, time * 0.2), time) * 4.0);
    folds = 0.5 + 0.5 * folds;
    folds = pow(folds, 1.5 + uMid * 1.5);

    // Vertical striations (magnetic field lines)
    float striations = 0.6 + 0.4 * sin(height * 28.0 - time * 2.0
      + curtainNoise(vec2(x * 5.0, height * 2.0), time) * 6.0);
    striations = pow(striations, 2.0);

    // Turbulent edge detail
    float turbulence = curtainNoise(vec2(x * 8.0 + layerOffset, height * 3.0), time);
    float edgeDetail = 0.7 + 0.3 * turbulence;

    float curtain = bandMask * verticalMask * folds * striations * edgeDetail;
    curtain *= intensity * (0.6 + uEnergy * 0.8 + impact * 1.2);

    // Color: green-to-violet palette shift driven by mids and the palette param
    float hueBase = 0.33 + uPalette * 0.15; // green base
    float hueShift = uMid * 0.22 + uSnare * 0.15 + height * 0.12;
    float hue = fract(hueBase + hueShift + layerOffset * 0.08);
    float sat = 0.75 + 0.2 * sin(height * 8.0 + time);
    vec3 curtainColor = hsv2rgb(vec3(hue, sat, 1.0));

    // Brighten the lower edge (the "foot" of the aurora)
    float footGlow = exp(-height * 12.0) * smoothstep(0.0, 0.08, height);
    curtainColor = mix(curtainColor, vec3(0.4, 1.0, 0.6), footGlow * 0.5);

    return curtainColor * curtain;
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.15 + uSpeed * 0.5);
    float impact = max(uKick, uBeat * 0.7);

    // Sky gradient: deep polar night
    float skyGrad = smoothstep(-1.0, 1.2, uv.y);
    vec3 color = mix(vec3(0.01, 0.015, 0.04), vec3(0.0, 0.005, 0.02), skyGrad);

    // Star field with twinkle
    vec2 starUv = uv * vec2(1.0, 0.7) + vec2(0.0, 0.3);
    for (int layer = 0; layer < 3; layer++) {
      float scale = 40.0 + float(layer) * 35.0;
      vec2 cell = floor(starUv * scale);
      vec2 local = fract(starUv * scale) - 0.5;
      float seed = hash21(cell + float(layer) * 100.0);
      vec2 offset = vec2(hash21(cell + 13.7), hash21(cell + 47.3)) - 0.5;
      float d = length(local - offset * 0.7);
      float star = (1.0 - smoothstep(0.01, 0.04 + float(layer) * 0.01, d));
      float twinkle = 0.6 + 0.4 * sin(time * (3.0 + seed * 5.0) + seed * TAU);
      float brightness = step(0.93 - float(layer) * 0.015, seed) * twinkle;
      vec3 starColor = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.9, 0.7), seed);
      color += starColor * star * brightness * (0.5 + uHigh * 0.5);
    }

    // Multiple aurora curtain layers
    float numCurtains = 3.0 + uCurtains * 2.0;
    for (int i = 0; i < 5; i++) {
      if (float(i) >= numCurtains) break;
      float layerOffset = float(i) / numCurtains;
      float layerIntensity = 0.35 + 0.25 * sin(layerOffset * TAU + time * 0.3);
      layerIntensity *= 1.0 - float(i) * 0.12; // back layers dimmer
      color += auroraLayer(uv, time, layerOffset * 6.28, layerIntensity);
    }

    // Shimmer particles: high-frequency precipitation along field lines
    float shimmerCount = uShimmer * 3.0;
    for (int s = 0; s < 3; s++) {
      if (float(s) >= shimmerCount) break;
      float sOffset = float(s) * 2.09;
      vec2 shimmerUv = uv * vec2(12.0 + float(s) * 5.0, 20.0 + float(s) * 8.0);
      shimmerUv.y -= time * (1.5 + float(s) * 0.7);
      vec2 sCell = floor(shimmerUv);
      float sSeed = hash21(sCell + sOffset * 50.0);
      vec2 sLocal = fract(shimmerUv) - 0.5;
      float sDist = length(sLocal);
      float particle = (1.0 - smoothstep(0.02, 0.08, sDist));
      float sBright = step(0.88 - uHigh * 0.06 - uHat * 0.15, sSeed);
      float sTwinkle = pow(max(0.0, sin(time * 8.0 + sSeed * TAU)), 8.0);
      float heightMask = smoothstep(-0.1, 0.2, uv.y) * (1.0 - smoothstep(0.6, 1.0, uv.y));
      color += vec3(0.5, 1.0, 0.7) * particle * sBright * sTwinkle
        * heightMask * (0.4 + uHat * 2.5) * uShimmer;
    }

    // Frozen lake reflection below the horizon
    float horizon = -0.15;
    if (uv.y < horizon) {
      float reflY = horizon + (horizon - uv.y) * 0.6;
      vec2 reflUv = vec2(uv.x + sin(time * 0.5 + uv.x * 8.0) * 0.008, reflY);

      // Reflect the aurora
      vec3 reflColor = vec3(0.0);
      for (int i = 0; i < 3; i++) {
        float layerOffset = float(i) / 3.0;
        reflColor += auroraLayer(reflUv, time, layerOffset * 6.28, 0.2);
      }

      // Ice surface: dark with subtle blue tint and ripple distortion
      float iceNoise = valueNoise(uv * vec2(30.0, 8.0) + time * 0.1);
      float ripple = sin(uv.x * 40.0 + time * 2.0 + iceNoise * 6.0) * 0.5 + 0.5;
      vec3 iceColor = vec3(0.008, 0.015, 0.035) + reflColor * (0.25 + ripple * 0.15);

      // Fresnel-like fade: reflection stronger at grazing angles
      float fresnel = 1.0 - smoothstep(horizon - 0.5, horizon, uv.y);
      color = mix(color, iceColor, 0.7 + fresnel * 0.3);

      // Specular highlights on ice ridges
      float iceSpec = pow(ripple, 12.0) * (0.3 + uHigh * 0.5);
      color += vec3(0.3, 0.5, 0.7) * iceSpec * 0.3;
    }

    // Horizon glow line
    float horizonGlow = exp(-abs(uv.y - horizon) * 35.0);
    vec3 horizonColor = hsv2rgb(vec3(fract(0.35 + uMid * 0.2 + time * 0.01), 0.7, 1.0));
    color += horizonColor * horizonGlow * (0.15 + uSub * 0.3 + impact * 0.5);

    // Beat pulse: the whole sky brightens momentarily
    color *= 1.0 + impact * 0.25;

    // Subtle chromatic aberration at edges for a cinematic feel
    float caAmount = 0.002 + uHigh * 0.001;
    float caR = length(uv - vec2(caAmount, 0.0));
    float caB = length(uv + vec2(caAmount, 0.0));
    // (Applied as a subtle tint shift rather than full re-render for perf)
    color.r *= 1.0 + (caR - length(uv)) * 2.0;
    color.b *= 1.0 + (caB - length(uv)) * 2.0;

    float vignette = 1.0 - smoothstep(0.65, 1.5, length(uv * vec2(0.7, 1.0)));
    color *= 0.22 + 0.78 * vignette;
    color = filmicTone(color * 1.35);
    color = pow(color, vec3(0.88));
    gl_FragColor = vec4(color, 1.0);
  }
`;

export default (audio, videoDeviceId, params) => makeAudioShader(
  audio,
  params,
  frag,
  (P) => ({
    uCurtains: P.curtains ?? 1,
    uPalette: P.palette ?? 1,
    uShimmer: P.shimmer ?? 1,
    uSpeed: P.speed ?? 1,
  }),
);
