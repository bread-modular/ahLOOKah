// Laser Cathedral — an endless ray-marched nave made from luminous arches,
// columns and reflective floor rails. Volumetric laser sheets sweep through
// the architecture while bass pushes the camera physically down the tunnel.
// GLSL lint: smoothstep must be smoothstep(low, high, x) with low < high.
// For falloffs use 1.0 - smoothstep(low, high, x), never smoothstep(high, low, x) (undefined).
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uSpeed;
  uniform float uBeams;
  uniform float uDepth;
  uniform float uStructure;

  float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
  }

  float mapCathedral(vec3 p) {
    float spacing = mix(2.8, 1.65, saturate((uStructure - 0.35) / 1.65));
    float localZ = mod(p.z + spacing * 0.5, spacing) - spacing * 0.5;

    float columns = sdBox(vec3(abs(p.x) - 1.38, p.y + 0.05, localZ), vec3(0.075, 1.03, 0.09));

    // A circular rib clipped to a narrow z slice creates the repeating arch.
    float archProfile = abs(length(vec2(p.x, p.y + 1.02)) - 1.47) - 0.052;
    float arches = max(archProfile, abs(localZ) - 0.065);

    float floorPlane = abs(p.y + 1.08) - 0.014;
    float floorRails = sdBox(vec3(abs(p.x) - 0.72, p.y + 1.035, localZ), vec3(0.018, 0.026, spacing * 0.5));
    float upperRail = sdBox(vec3(abs(p.x) - 1.38, p.y - 0.58, localZ), vec3(0.026, 0.025, spacing * 0.5));

    float scene = min(columns, arches);
    scene = min(scene, floorPlane);
    scene = min(scene, floorRails);
    scene = min(scene, upperRail);
    return scene;
  }

  vec3 getNormal(vec3 p) {
    vec2 e = vec2(0.0018, 0.0);
    float d = mapCathedral(p);
    return normalize(vec3(
      mapCathedral(p + e.xyy) - d,
      mapCathedral(p + e.yxy) - d,
      mapCathedral(p + e.yyx) - d
    ));
  }

  vec3 laserPalette(float h) {
    return hsv2rgb(vec3(fract(0.52 + h * 0.22 + uTime * 0.018), 0.9, 1.0));
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.25 + uSpeed * 0.72);
    float kickPush = uSub * 0.08 + uKick * 0.78 + uBeat * 0.24;
    vec3 ro = vec3(sin(time * 0.17) * 0.14, -0.18 + sin(time * 0.31) * 0.04, time * 3.0 + kickPush);
    vec3 rd = normalize(vec3(uv.x, uv.y * 0.86, mix(1.72, 0.95, saturate((uDepth - 0.4) / 1.8))));
    rd.xy = rotate2d(sin(time * 0.13) * 0.018) * rd.xy;

    float travel = 0.02;
    float distanceToScene = 0.0;
    float volumeCyan = 0.0;
    float volumePink = 0.0;
    bool hit = false;

    for (int i = 0; i < 72; i++) {
      vec3 pos = ro + rd * travel;
      distanceToScene = mapCathedral(pos);

      // Two animated laser planes plus a comb of overhead shafts. Accumulating
      // while marching gives the beams actual atmospheric depth and occlusion.
      float sweepA = sin(pos.z * 0.19 - time * 2.1) * 1.15;
      float sweepB = cos(pos.z * 0.14 + time * 1.6) * 0.72;
      float beamA = exp(-abs(pos.x - sweepA) * (10.0 - uMid * 1.2 - uSnare * 3.5));
      beamA *= exp(-abs(pos.y - 0.2) * 1.5);
      float beamB = exp(-abs(pos.y - sweepB) * (11.0 - uHigh - uHat * 3.8));
      beamB *= exp(-abs(pos.x) * 0.7);
      float comb = pow(max(0.0, sin(pos.z * 1.32 - time * 3.4)), 26.0)
        * exp(-abs(pos.x) * 0.85) * smoothstep(-1.0, 0.65, pos.y)
        * (0.65 + uHat * 2.4);
      float attenuation = exp(-travel * 0.075)
        * (0.013 + uEnergy * 0.009 + uSnare * 0.012 + uHat * 0.007) * uBeams;
      volumeCyan += (beamA + comb * 0.8) * attenuation;
      volumePink += (beamB + comb * 0.35) * attenuation;

      if (distanceToScene < 0.002) {
        hit = true;
        break;
      }
      travel += clamp(distanceToScene * 0.64, 0.018, 0.34);
      if (travel > 24.0) break;
    }

    vec3 color = vec3(0.001, 0.003, 0.012);
    color += vec3(0.0, 0.48, 1.0) * volumeCyan;
    color += vec3(1.0, 0.015, 0.42) * volumePink;

    if (hit) {
      vec3 pos = ro + rd * travel;
      vec3 normal = getNormal(pos);
      float fresnel = pow(1.0 - max(dot(normal, -rd), 0.0), 2.5);
      float spacing = mix(2.8, 1.65, saturate((uStructure - 0.35) / 1.65));
      float cell = floor(pos.z / spacing);
      float hue = fract(cell * 0.117 + time * 0.02);
      vec3 neon = laserPalette(hue);

      float zEdge = pow(1.0 - abs(fract(pos.z / spacing) - 0.5) * 2.0, 18.0);
      float verticalEdge = pow(max(0.0, sin((pos.y + 1.08) * 17.0)), 22.0);
      float floorMask = 1.0 - smoothstep(0.035, 0.12, abs(pos.y + 1.08));
      float floorGridX = pow(max(0.0, sin(pos.x * 8.0)), 28.0);
      float floorGridZ = pow(max(0.0, sin(pos.z * 2.7 - time)), 30.0);
      float grid = floorMask * max(floorGridX, floorGridZ);

      float light = 0.12 + fresnel * 0.95 + zEdge * 0.75 + verticalEdge * 0.18 + grid * 1.8;
      color += neon * light * (0.52 + uEnergy * 1.05 + uKick * 1.65 + uSnare * 0.72);
      color += vec3(0.65, 0.82, 1.0) * pow(max(dot(normal, normalize(vec3(-0.4, 0.8, -0.5))), 0.0), 12.0) * 0.35;
    }

    // Vanishing-point halo and rhythmic gate silhouettes reinforce depth.
    float vanishing = exp(-length(uv * vec2(1.0, 1.5)) * 4.0);
    color += mix(vec3(0.0, 0.18, 0.7), vec3(0.65, 0.0, 0.55), 0.5 + 0.5 * sin(time * 0.7))
      * vanishing * (0.16 + uSub * 0.32 + uKick * 1.5);

    // A kick opens a fast tunnel iris; the decaying beat envelope drives the
    // ring away from the vanishing point instead of merely raising brightness.
    float irisRadius = (1.0 - saturate(uBeat)) * 0.72;
    float beatIris = exp(-abs(length(uv * vec2(1.0, 1.45)) - irisRadius) * 48.0) * uBeat;
    color += mix(vec3(0.0, 0.65, 1.0), vec3(1.0, 0.04, 0.4), saturate(uv.y * 0.5 + 0.5))
      * beatIris * 1.35;

    float vignette = 1.0 - smoothstep(0.7, 1.55, length(uv * vec2(0.72, 1.0)));
    color *= 0.22 + 0.78 * vignette;
    color = filmicTone(color * 1.45);
    color = pow(color, vec3(0.88));
    gl_FragColor = vec4(color, 1.0);
  }
`;

export default (audio, videoDeviceId, params) => makeAudioShader(
  audio,
  params,
  frag,
  (P) => ({
    uSpeed: P.speed ?? 1,
    uBeams: P.beams ?? 1,
    uDepth: P.depth ?? 1,
    uStructure: P.structure ?? 1,
  }),
);
