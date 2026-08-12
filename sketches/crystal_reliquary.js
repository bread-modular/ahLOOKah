// Crystal Reliquary — ray-marched floating prism cluster with spectral
// refraction, internal caustics and a dark museum-void backdrop. Bass inflates
// the lattice, mids shear the facets, highs ignite rainbow edge fire.
// The legacy raw-frame path stays intact; opted-in renderers consume final
// controls (header audio uniforms + params) from a capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uScale;
  uniform float uFacet;
  uniform float uSpin;
  uniform float uCaustic;

  float sdOctahedron(vec3 p, float s) {
    p = abs(p);
    return (p.x + p.y + p.z - s) * 0.57735027;
  }

  float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
  }

  float smoothMin(float a, float b, float k) {
    float h = saturate(0.5 + 0.5 * (b - a) / k);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  float mapCrystals(vec3 p) {
    float time = uTime * (0.2 + uSpin * 0.55);
    p.yz = rotate2d(time * 0.21) * p.yz;
    p.xz = rotate2d(time * 0.17 + uMid * 0.08) * p.xz;

    float impact = uKick * 0.2 + uBeat * 0.08 + uSub * 0.07;
    float grow = (0.85 + impact) * uScale;

    float d = sdOctahedron(p, 0.72 * grow);
    d = smoothMin(d, sdBox(p - vec3(0.55, 0.2, -0.15) * grow, vec3(0.22, 0.42, 0.18) * grow), 0.12);
    d = smoothMin(d, sdOctahedron(p + vec3(0.48, -0.25, 0.3) * grow, 0.38 * grow), 0.1);
    vec3 q = p;
    q.xy = rotate2d(0.9) * q.xy;
    d = smoothMin(d, sdBox(q - vec3(-0.2, 0.5, 0.1) * grow, vec3(0.18, 0.34, 0.16) * grow), 0.09);

    // Facet corrugation: keeps the field mostly valid while reading as cut glass.
    float ridges = sin(p.x * (14.0 + uFacet * 8.0) + time)
      * sin(p.y * (12.0 + uFacet * 6.0) - time * 1.3)
      * sin(p.z * (13.0 + uFacet * 7.0) + time * 0.7);
    d -= ridges * (0.004 + uFacet * 0.006 + uSnare * 0.01);
    return d;
  }

  vec3 getNormal(vec3 p) {
    vec2 e = vec2(0.0015, -0.0015);
    return normalize(
      e.xyy * mapCrystals(p + e.xyy)
      + e.yyx * mapCrystals(p + e.yyx)
      + e.yxy * mapCrystals(p + e.yxy)
      + e.xxx * mapCrystals(p + e.xxx)
    );
  }

  vec3 envMap(vec3 r) {
    float bands = pow(max(0.0, sin(atan(r.z, r.x) * 10.0 + uTime * 0.6)), 14.0);
    float cap = pow(saturate(r.y * 0.5 + 0.5), 4.0);
    vec3 base = mix(vec3(0.01, 0.02, 0.06), vec3(0.08, 0.0, 0.12), cap);
    base += hsv2rgb(vec3(fract(atan(r.z, r.x) / TAU + uTime * 0.02), 0.85, 1.0))
      * bands * (0.35 + uHigh * 0.5 + uHat * 1.4);
    base += vec3(0.4, 0.7, 1.0) * pow(saturate(r.y), 8.0) * 0.35;
    return base;
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.2 + uSpin * 0.55);
    float impact = max(uKick, uBeat * 0.85);

    vec3 ro = vec3(0.0, 0.05, 2.85 - impact * 0.22);
    vec3 rd = normalize(vec3(uv, -1.55));
    ro.xz = rotate2d(sin(time * 0.15) * 0.12) * ro.xz;
    rd.xz = rotate2d(sin(time * 0.15) * 0.12) * rd.xz;

    float t = 0.0;
    float hitDist = -1.0;
    for (int i = 0; i < 64; i++) {
      vec3 pos = ro + rd * t;
      float d = mapCrystals(pos);
      if (d < 0.0015) {
        hitDist = t;
        break;
      }
      t += d * 0.7;
      if (t > 8.0) break;
    }

    // Deep void with faint dust motes.
    vec3 color = vec3(0.002, 0.004, 0.014);
    float dust = fbm4(rd.xy * 3.0 + time * 0.05);
    color += vec3(0.04, 0.02, 0.1) * pow(dust, 3.0) * 0.25;

    if (hitDist > 0.0) {
      vec3 pos = ro + rd * hitDist;
      vec3 n = getNormal(pos);
      vec3 view = -rd;
      float fres = pow(1.0 - max(dot(n, view), 0.0), 2.8);

      // Chromatic refraction approximation via slightly offset reflection vectors.
      vec3 refl = reflect(rd, n);
      vec3 colR = envMap(normalize(refl + n * 0.02));
      vec3 colG = envMap(normalize(refl));
      vec3 colB = envMap(normalize(refl - n * 0.025));
      vec3 spectral = vec3(colR.r, colG.g, colB.b);

      float edge = pow(fres, 1.2);
      vec3 gem = mix(vec3(0.08, 0.18, 0.35), spectral, 0.55 + uCaustic * 0.25);
      gem = mix(gem, hsv2rgb(vec3(fract(0.55 + fres * 0.2 + time * 0.015), 0.75, 1.0)), edge * 0.65);

      // Internal caustic filaments from cheap interference on the surface.
      float cau = sin(dot(pos, n) * (28.0 + uFacet * 20.0) + time * 3.0)
        * sin(dot(pos.zyx, n.xzy) * 19.0 - time * 2.2);
      cau = pow(saturate(cau * 0.5 + 0.5), 6.0);

      color += gem * (0.45 + fres * 1.3);
      color += spectral * fres * (0.8 + uEnergy * 0.9 + impact * 1.5);
      color += vec3(0.7, 0.9, 1.0) * cau * (0.2 + uCaustic * 0.9 + uHigh * 0.4 + uHat * 1.1);
      color += vec3(1.0) * pow(fres, 5.0) * (0.25 + impact * 0.8);

      // Specular sparkle on snare/hat.
      float spec = pow(max(dot(reflect(rd, n), normalize(vec3(0.4, 0.7, 0.3))), 0.0), 40.0);
      color += vec3(0.85, 0.95, 1.0) * spec * (0.3 + uHat * 2.0 + uSnare * 0.8);
    }

    // Orbiting god-ray shards in the background for depth even on misses.
    float rays = 0.0;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float ang = time * (0.3 + fi * 0.07) + fi * 1.2;
      vec2 dir = vec2(cos(ang), sin(ang));
      float strip = exp(-abs(dot(uv, vec2(-dir.y, dir.x))) * (18.0 - uSub * 2.0));
      strip *= smoothstep(-0.2, 0.8, dot(uv, dir));
      rays += strip * (0.04 + uEnergy * 0.03);
    }
    color += hsv2rgb(vec3(fract(0.58 + time * 0.02), 0.7, 1.0)) * rays * uCaustic;

    float ringR = 0.25 + (1.0 - saturate(uBeat)) * 0.7;
    float beatRing = exp(-abs(length(uv) - ringR) * 50.0) * uBeat;
    color += vec3(0.4, 0.75, 1.0) * beatRing * 0.85;

    float vignette = 1.0 - smoothstep(0.7, 1.5, length(uv * vec2(0.72, 1.0)));
    color *= 0.25 + 0.75 * vignette;
    color = filmicTone(color * 1.4);
    color = pow(color, vec3(0.88));
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
          uScale: P.scale ?? 1,
          uFacet: P.facet ?? 1,
          uSpin: P.spin ?? 1,
          uCaustic: P.caustic ?? 1,
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
      uScale: P.scale ?? 1,
      uFacet: P.facet ?? 1,
      uSpin: P.spin ?? 1,
      uCaustic: P.caustic ?? 1,
    }),
  );
};
