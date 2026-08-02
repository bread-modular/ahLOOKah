// Warp Loom — hyperspace threads woven into a living loom. Ribbons of spacetime
// braid through a tunnel while chromatic strands shear on snares and the whole
// weave tightens on kicks. Think IMAX jump-gate meets fiber-optic couture.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uThreads;
  uniform float uTwist;
  uniform float uSpeed;
  uniform float uBloom;

  float threadMask(vec2 p, float id, float time, float count) {
    float ang = atan(p.y, p.x);
    float rad = length(p);
    // Logarithmic spiral braid — each thread rides a unique phase offset.
    float phase = ang * (2.0 + uTwist * 1.8) - log(max(rad, 0.04)) * (4.5 + uTwist * 2.5)
      - time * (1.4 + uSpeed) - id * (TAU / max(count, 1.0));
    float ribbon = exp(-abs(sin(phase)) * (10.0 + uThreads * 6.0 - uMid * 2.0));
    // Soft radial envelope so threads concentrate toward the tunnel wall.
    float tube = exp(-abs(rad - (0.45 + uSub * 0.05 + uKick * 0.08)) * (5.5 - uSub));
    float corePull = exp(-rad * (1.2 - uKick * 0.3));
    return ribbon * mix(tube, corePull * 0.45, 0.25);
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.24 + uSpeed * 0.7);
    float impact = max(uKick, uBeat * 0.88);

    // Mild barrel warp + kick punch into the gate.
    float rad0 = length(uv);
    vec2 p = uv * (1.0 + rad0 * rad0 * 0.12 - impact * 0.06);
    p = rotate2d(time * 0.08 + uMid * 0.05) * p;

    vec3 color = vec3(0.001, 0.002, 0.01);

    // Star-streak background rushing toward the vanishing point.
    vec2 starUv = p * (1.2 + fract(time * 0.15));
    for (int s = 0; s < 3; s++) {
      float fs = float(s);
      vec2 su = rotate2d(fs * 0.7) * starUv * (1.0 + fs * 0.5);
      vec2 cell = floor(su * (12.0 + fs * 8.0));
      vec2 local = fract(su * (12.0 + fs * 8.0)) - 0.5;
      float seed = hash21(cell + fs * 19.0);
      if (seed > 0.82) {
        float streak = exp(-abs(local.x) * 40.0) * exp(-abs(local.y) * (4.0 + seed * 8.0));
        color += mix(vec3(0.4, 0.7, 1.0), vec3(1.0, 0.5, 0.85), seed)
          * streak * (0.08 + uHigh * 0.12 + uHat * 0.25);
      }
    }

    float count = clamp(floor(6.0 + uThreads * 10.0), 6.0, 18.0);
    float weave = 0.0;
    for (int i = 0; i < 18; i++) {
      float fi = float(i);
      if (fi >= count) break;

      float t1 = threadMask(p, fi, time, count);
      // Secondary thinner helix for multi-fiber look.
      float t2 = threadMask(p * 1.05, fi + 0.5, time * 1.07 + 0.4, count) * 0.55;
      float strand = t1 + t2;

      // Chromatic offset per thread id.
      float hue = fract(0.55 + fi / count * 0.55 + time * 0.02 + uSnare * 0.03);
      vec3 strandCol = hsv2rgb(vec3(hue, 0.85, 1.0));
      // RGB split along the angular direction for luxury fiber sheen.
      vec2 tangent = normalize(vec2(-p.y, p.x) + 1e-4);
      float split = (0.01 + uHigh * 0.008 + uHat * 0.02);
      float rCh = threadMask(p + tangent * split, fi, time, count);
      float bCh = threadMask(p - tangent * split, fi, time, count);

      color.r += strandCol.r * rCh * (0.55 + uBloom * 0.5);
      color.g += strandCol.g * strand * (0.55 + uBloom * 0.5);
      color.b += strandCol.b * bCh * (0.55 + uBloom * 0.5);

      color += strandCol * strand * (0.35 + uEnergy * 0.55 + impact * 0.9 + uSnare * 0.35);
      color += vec3(0.85, 0.95, 1.0) * pow(strand, 3.5) * (0.2 + uHat * 0.8);
      weave += strand;
    }

    // Central singularity glow / loom eye.
    float eye = exp(-length(p) * (6.0 - impact * 1.5 - uSub));
    color += mix(vec3(0.05, 0.2, 0.8), vec3(0.9, 0.1, 0.5), 0.45 + 0.2 * sin(time))
      * eye * (0.45 + uSub * 0.7 + impact * 1.8) * uBloom;
    color += vec3(1.0) * pow(eye, 4.0) * (0.25 + impact * 0.9);

    // Cross-weave interference rings.
    float rings = sin(log(max(length(p), 0.02)) * (14.0 + uTwist * 6.0) - time * 4.0);
    rings = pow(saturate(0.55 + 0.45 * rings), 8.0);
    color += hsv2rgb(vec3(fract(0.6 + time * 0.02), 0.65, 1.0))
      * rings * exp(-abs(length(p) - 0.5) * 3.0)
      * (0.08 + uMid * 0.15 + uSnare * 0.35) * uTwist;

    // Snare shear flash — sideways slice of the loom.
    float shear = exp(-abs(p.y - sin(time * 2.0) * 0.15) * (30.0 - uSnare * 8.0))
      * uSnare;
    color += vec3(0.7, 0.4, 1.0) * shear * 0.45;

    // Beat expands a braided shock ring.
    float waveR = 0.2 + (1.0 - saturate(uBeat)) * 0.75;
    float wave = exp(-abs(length(p) - waveR) * 50.0) * uBeat;
    color += mix(vec3(0.2, 0.6, 1.0), vec3(1.0, 0.15, 0.55), saturate(waveR))
      * wave * (0.9 + uBloom * 0.4);

    // Subtle scanline polish for LED walls.
    float scan = 0.94 + 0.06 * sin(uv.y * uResolution.y * 0.7 + time * 10.0);
    color *= scan;

    float vignette = 1.0 - smoothstep(0.68, 1.5, length(uv * vec2(0.72, 1.0)));
    color *= 0.26 + 0.74 * vignette;
    color = filmicTone(color * 1.38);
    color = pow(color, vec3(0.9));
    gl_FragColor = vec4(color, 1.0);
  }
`;

export default (audio, videoDeviceId, params) => makeAudioShader(
  audio,
  params,
  frag,
  (P) => ({
    uThreads: P.threads ?? 1,
    uTwist: P.twist ?? 1,
    uSpeed: P.speed ?? 1,
    uBloom: P.bloom ?? 1,
  }),
);
