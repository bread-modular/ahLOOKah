// Crystal Cavern — a raymarched underground grotto studded with towering
// crystal formations. Each crystal refracts light into prismatic caustic
// patterns that dance across the cavern walls. Bass makes crystals pulse and
// grow, mids shift the internal refraction colors, and highs trigger
// sparkling facet flashes. Volumetric light shafts pierce through cracks above.
// The legacy raw-frame path stays intact; opted-in renderers consume final
// controls (header audio uniforms + params) from a capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uCrystalSize;
  uniform float uRefraction;
  uniform float uCaustics;
  uniform float uSpeed;

  // SDF for a hexagonal crystal prism (elongated hexagonal column with pointed tip)
  float sdCrystal(vec3 p, float height, float radius) {
    // Hexagonal cross-section
    vec2 q = abs(p.xz);
    float hex = max(q.x * 0.866025 + q.y * 0.5, q.y) - radius;
    // Taper toward the tip
    float taper = 1.0 - smoothstep(height * 0.6, height, p.y) * 0.7;
    hex /= max(taper, 0.15);
    // Vertical bounds
    float vert = max(-p.y, p.y - height);
    // Pointed tip
    float tip = length(p - vec3(0.0, height, 0.0)) - radius * 0.3;
    float body = max(hex, vert);
    return min(body, tip);
  }

  // Scene: multiple crystals growing from the floor at various positions
  float sceneSDF(vec3 p, float time) {
    float impact = max(uKick, uBeat * 0.6);
    float d = 1e10;

    // Crystal cluster positions (deterministic layout)
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      float angle = fi * 2.399 + 0.5; // golden angle spread
      float dist = 0.8 + fi * 0.45;
      vec3 center = vec3(
        sin(angle) * dist,
        -1.0,
        cos(angle) * dist - 2.0
      );

      vec3 lp = p - center;
      // Each crystal has a unique tilt
      float tiltX = sin(fi * 1.7) * 0.25;
      float tiltZ = cos(fi * 2.3) * 0.2;
      lp.xy = rotate2d(tiltX) * lp.xy;
      lp.zy = rotate2d(tiltZ) * lp.zy;

      // Audio-reactive growth
      float growth = 1.0 + uSub * 0.15 + impact * 0.25
        + sin(time * 0.5 + fi * 1.3) * 0.08;
      float h = (1.2 + fi * 0.25) * growth * uCrystalSize;
      float r = (0.12 + fi * 0.02) * uCrystalSize;

      float crystal = sdCrystal(lp, h, r);
      d = min(d, crystal);
    }

    // Cavern floor
    float floor = p.y + 1.0;
    d = min(d, floor);

    // Cavern ceiling (rough)
    float ceiling = 2.5 - p.y + fbm4(p.xz * 0.8) * 0.6;
    d = min(d, ceiling);

    return d;
  }

  vec3 calcNormal(vec3 p, float time) {
    vec2 e = vec2(0.001, -0.001);
    return normalize(
      e.xyy * sceneSDF(p + e.xyy, time) +
      e.yyx * sceneSDF(p + e.yyx, time) +
      e.yxy * sceneSDF(p + e.yxy, time) +
      e.xxx * sceneSDF(p + e.xxx, time)
    );
  }

  // Prismatic caustic pattern projected on surfaces
  vec3 causticPattern(vec2 p, float time) {
    float impact = max(uKick, uBeat * 0.5);
    vec3 caustic = vec3(0.0);

    // Three overlapping Voronoi-like caustic layers with chromatic separation
    for (int c = 0; c < 3; c++) {
      float chromaOffset = float(c) * 0.015 * uRefraction;
      vec2 cp = p * (3.0 + float(c) * 1.5) + vec2(chromaOffset, -chromaOffset);
      cp += vec2(time * 0.15 * (1.0 + float(c) * 0.3), time * 0.1);

      vec2 cell = floor(cp);
      vec2 local = fract(cp) - 0.5;
      float minDist = 1.0;
      float secondDist = 1.0;

      for (int dx = -1; dx <= 1; dx++) {
        for (int dy = -1; dy <= 1; dy++) {
          vec2 neighbor = vec2(float(dx), float(dy));
          vec2 point = vec2(
            hash21(cell + neighbor),
            hash21(cell + neighbor + 47.0)
          ) - 0.5;
          // Animate the Voronoi points
          point += 0.3 * vec2(
            sin(time * 1.5 + hash21(cell + neighbor) * TAU),
            cos(time * 1.2 + hash21(cell + neighbor + 13.0) * TAU)
          );
          float d = length(local - neighbor - point);
          if (d < minDist) {
            secondDist = minDist;
            minDist = d;
          } else if (d < secondDist) {
            secondDist = d;
          }
        }
      }

      // Caustic brightness at cell edges (where light concentrates)
      float edge = secondDist - minDist;
      float causticLine = pow(max(0.0, 1.0 - edge * 4.0), 3.0);
      causticLine *= 0.5 + 0.5 * sin(time * 2.0 + float(c) * 2.1);

      // Chromatic dispersion: each channel offset slightly
      vec3 channelColor = vec3(0.0);
      channelColor[c] = 1.0;
      caustic += channelColor * causticLine;
    }

    return caustic * uCaustics * (0.5 + uEnergy * 0.8 + impact * 1.0);
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.15 + uSpeed * 0.5);
    float impact = max(uKick, uBeat * 0.7);

    // Camera: slow dolly through the cavern
    vec3 ro = vec3(
      sin(time * 0.12) * 0.5,
      0.2 + sin(time * 0.09) * 0.15,
      1.5 - time * 0.08
    );
    vec3 target = ro + vec3(sin(time * 0.1) * 0.3, -0.1, -1.0);
    vec3 fwd = normalize(target - ro);
    vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, fwd);
    vec3 rd = normalize(fwd * 1.4 + right * uv.x + up * uv.y);

    // Raymarch
    vec3 color = vec3(0.0);
    float t = 0.0;
    bool hit = false;
    vec3 hitPos = vec3(0.0);
    vec3 hitNormal = vec3(0.0);
    float glow = 0.0;

    for (int i = 0; i < 80; i++) {
      vec3 pos = ro + rd * t;
      float d = sceneSDF(pos, time);

      // Crystal interior glow accumulation
      glow += exp(-abs(d) * 8.0) * 0.012;

      if (d < 0.001) {
        hit = true;
        hitPos = pos;
        hitNormal = calcNormal(pos, time);
        break;
      }
      t += d * 0.75;
      if (t > 12.0) break;
    }

    // Ambient cavern color
    vec3 ambient = vec3(0.01, 0.012, 0.025);

    if (hit) {
      // Determine if we hit a crystal or the cavern wall
      float floorDist = hitPos.y + 1.0;
      bool isCrystal = floorDist > 0.05;

      if (isCrystal) {
        // Crystal surface: glassy with internal refraction colors
        vec3 lightDir = normalize(vec3(0.3, 1.0, -0.2));
        float diff = max(dot(hitNormal, lightDir), 0.0);
        vec3 halfVec = normalize(lightDir - rd);
        float spec = pow(max(dot(hitNormal, halfVec), 0.0), 80.0);

        // Fresnel
        float fresnel = pow(1.0 - max(dot(hitNormal, -rd), 0.0), 4.0);

        // Internal refraction color: prismatic based on view angle and normals
        float refractAngle = dot(hitNormal, rd);
        float hue = fract(
          refractAngle * uRefraction * 0.8
          + length(hitPos) * 0.15
          + time * 0.03
          + uMid * 0.25
          + uSnare * 0.15
        );
        vec3 refractColor = hsv2rgb(vec3(hue, 0.75, 0.95));

        // Crystal body color: subtle tint
        vec3 crystalTint = hsv2rgb(vec3(
          fract(0.55 + hitPos.x * 0.05 + hitPos.z * 0.03),
          0.3, 0.15
        ));

        color = crystalTint + refractColor * (0.3 + fresnel * 0.7);
        color += vec3(1.0) * spec * (0.8 + impact * 1.5);
        color += refractColor * diff * 0.4;

        // Facet flash: individual facets light up with high frequencies
        float facetSeed = hash21(floor(hitNormal.xy * 20.0 + hitPos.xz * 5.0));
        float facetFlash = step(0.92 - uHigh * 0.05 - uHat * 0.12, facetSeed)
          * pow(max(0.0, sin(time * 10.0 + facetSeed * TAU)), 12.0);
        color += vec3(0.8, 0.9, 1.0) * facetFlash * (0.5 + uHat * 3.0);

        // Caustic projection from this crystal onto nearby surfaces
        vec2 causticUv = hitPos.xz * 0.5 + hitPos.y * 0.3;
        color += causticPattern(causticUv, time) * 0.3 * fresnel;

      } else {
        // Cavern wall / floor: dark rock with projected caustics
        vec3 lightDir = normalize(vec3(0.3, 1.0, -0.2));
        float diff = max(dot(hitNormal, lightDir), 0.0) * 0.3;

        vec3 rockColor = vec3(0.04, 0.035, 0.05);
        rockColor += vec3(0.02) * fbm4(hitPos.xz * 2.0);
        color = rockColor * (0.3 + diff);

        // Caustic light patterns dancing on the rock
        vec2 causticUv = hitPos.xz * 0.8 + hitPos.y * 0.2;
        color += causticPattern(causticUv, time) * 0.6;
      }
    } else {
      color = ambient;
    }

    // Volumetric light shafts from cracks in the ceiling
    float shaftAngle = atan(rd.z, rd.x);
    float shafts = pow(max(0.0, sin(shaftAngle * 5.0 + time * 0.3)), 8.0);
    float shaftMask = smoothstep(0.2, 0.8, rd.y); // only from above
    float shaftNoise = fbm4(vec2(shaftAngle * 3.0, time * 0.2));
    color += vec3(0.15, 0.12, 0.2) * shafts * shaftMask * shaftNoise
      * (0.3 + uMid * 0.4);

    // Crystal interior volumetric glow
    vec3 glowColor = hsv2rgb(vec3(fract(time * 0.02 + uMid * 0.2), 0.7, 1.0));
    color += glowColor * glow * (0.8 + impact * 1.5) * uRefraction;

    // Beat pulse: all crystals flash
    color *= 1.0 + impact * 0.3;

    // Floating dust motes in the light shafts
    vec3 dustUv = rd * 8.0 + vec3(time * 0.1, -time * 0.05, time * 0.08);
    vec3 dustCell = floor(dustUv);
    float dustSeed = hash21(dustCell.xy + dustCell.z * 17.0);
    float dust = step(0.96, dustSeed) * (0.5 + 0.5 * sin(time * 4.0 + dustSeed * TAU));
    color += vec3(0.4, 0.35, 0.5) * dust * 0.15 * shaftMask;

    float vignette = 1.0 - smoothstep(0.6, 1.5, length(uv * vec2(0.72, 1.0)));
    color *= 0.2 + 0.8 * vignette;
    color = filmicTone(color * 1.35);
    color = pow(color, vec3(0.9));
    gl_FragColor = vec4(color, 1.0);
  }
`;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: {
      uSub: 0, uMid: 0, uHigh: 0, uEnergy: 0,
      uKick: 0, uSnare: 0, uHat: 0, uBeat: 0,
    },
  },
});

// The controller consumes the canonical feature frame and applies the accepted
// band/punch gains exactly like the legacy shader path did, producing the final
// header audio uniforms. No renderer-side feature analysis on the opted-in path.
export function createAudioController({ rng = Math.random } = {}) {
  return {
    update({ shared, params = {} }) {
      const f = shared?.getFeatures?.() || {};
      const bassGain = Math.max(0, Number(params.bass ?? 1));
      const midGain = Math.max(0, Number(params.mid ?? 1));
      const highGain = Math.max(0, Number(params.high ?? 1));
      const punch = Math.max(0, Number(params.punch ?? 1));
      return {
        continuous: {
          uSub: clamp((f.sub ?? 0) * bassGain, 0, 1.6),
          uMid: clamp((f.mid ?? 0) * midGain, 0, 1.6),
          uHigh: clamp((f.high ?? 0) * highGain, 0, 1.6),
          uEnergy: clamp((f.energy ?? 0) * (bassGain * 0.42 + midGain * 0.38 + highGain * 0.2), 0, 1.6),
          uKick: clamp((f.kick ?? 0) * bassGain * punch, 0, 1.4),
          uSnare: clamp((f.snare ?? 0) * midGain * punch, 0, 1.4),
          uHat: clamp((f.hat ?? 0) * highGain * punch, 0, 1.4),
          uBeat: clamp((f.beat ?? 0) * bassGain * punch, 0, 1.4),
        },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => {
  const audioControls = runtimeContext?.audioControls || null;
  if (audioControls) {
    // Opted-in path: header audio uniforms come from the controller; only the
    // visual params are mapped locally.
    return makeAudioShader(
      audio,
      params,
      frag,
      (P, _bands, _p, controls) => {
        const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls?.continuous || {}) };
        return {
          uCrystalSize: P.crystalSize ?? 1,
          uRefraction: P.refraction ?? 1,
          uCaustics: P.caustics ?? 1,
          uSpeed: P.speed ?? 1,
          uSub: C.uSub,
          uMid: C.uMid,
          uHigh: C.uHigh,
          uEnergy: C.uEnergy,
          uKick: C.uKick,
          uSnare: C.uSnare,
          uHat: C.uHat,
          uBeat: C.uBeat,
        };
      },
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
      uCrystalSize: P.crystalSize ?? 1,
      uRefraction: P.refraction ?? 1,
      uCaustics: P.caustics ?? 1,
      uSpeed: P.speed ?? 1,
    }),
  );
};
