// Infinity Mirror — an endless neon mirror room. The marching position is
// folded through a triangle-wave domain so every wall automatically becomes
// a perfect reflection: emissive neon objects and glowing mirror seams tile
// to infinity. Bass inflates the central fixture, mids spin the geometry, and
// kicks open the depth gate so the reflections plunge further into the void.
// The legacy raw-frame path stays intact; opted-in renderers consume final
// controls (header audio uniforms + params) from a capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uMirrors;
  uniform float uGlow;
  uniform float uSpin;
  uniform float uDepth;

  // Triangle-wave fold on one axis: reflects the coordinate into [-h, h],
  // producing a perfect infinite mirror tiling at the walls (period 4h).
  float mirrorFold(float x, float h) {
    x = mod(x + h, 4.0 * h);
    x = abs(x - 2.0 * h);
    return x - h;
  }

  // The neon fixtures that live inside one mirrored room cell.
  float sdTorus(vec3 p, vec2 t) {
    vec2 q = vec2(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
  }

  // Scene = emissive neon surfaces, evaluated in folded (room-local) space.
  // Returns distance; \\\\\"emissive\\\\\" is a hint packed separately by the caller.
  float mapFixture(vec3 p, float time, out float emissive) {
    emissive = 0.0;
    float t = time * (0.4 + uSpin * 0.9);

    // Central neon torus that breathes with the bass.
    vec3 c = p;
    c.xz = rotate2d(t * 0.6) * c.xz;
    c.xy = rotate2d(sin(t * 0.4) * 0.5) * c.xy;
    float expand = 1.0 + uSub * 0.12 + uKick * 0.18 + uBeat * 0.06;
    float torus = sdTorus(c / expand, vec2(0.42, 0.045));

    // A small orbiting neon sphere cluster.
    vec3 orb = p - vec3(cos(t) * 0.35, sin(t * 0.7) * 0.3, sin(t) * 0.35);
    float sphere = length(orb) - (0.06 + uHigh * 0.01 + uHat * 0.03);
    emissive = step(sphere, torus); // 1 near the sphere, 0 near the torus
    return min(torus, sphere);
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.16 + uSpin * 0.4);

    // Camera wanders and slowly rotates inside the mirror room.
    vec3 ro = vec3(sin(time * 0.13) * 0.3, cos(time * 0.11) * 0.25, time * 0.18);
    vec3 rd = normalize(vec3(uv, -1.3));
    rd.xz = rotate2d(sin(time * 0.09) * 0.12 + uMid * 0.03) * rd.xz;
    rd.yz = rotate2d(cos(time * 0.07) * 0.06) * rd.yz;

    vec3 color = vec3(0.001, 0.002, 0.008);
    float opacity = 0.0;
    float h = 0.5; // room half-width

    for (int i = 0; i < 72; i++) {
      float travel = float(i) * 0.045;
      vec3 pos = ro + rd * travel;
      // Fold into the mirrored room — this is what makes the reflections.
      vec3 folded = vec3(mirrorFold(pos.x, h), mirrorFold(pos.y, h), mirrorFold(pos.z, h));

      float emissive;
      float d = mapFixture(folded, time, emissive);
      // Thin emissive shell around both fixtures.
      float shell = exp(-abs(d) * (28.0 + uDepth * 6.0));

      // Mirror seams glow where a folded axis sits right at the wall.
      vec3 w = abs(folded);
      float seamX = exp(-abs(w.x - (h - 0.004)) * 220.0);
      float seamY = exp(-abs(w.y - (h - 0.004)) * 220.0);
      float seamZ = exp(-abs(w.z - (h - 0.004)) * 220.0);
      float seam = max(max(seamX, seamY), seamZ);

      // Palette: fixtures cycle hue by depth + time; seams are a colder neon.
      float hue = fract(0.55 + travel * 0.06 + folded.y * 0.2 + time * 0.02);
      vec3 fixColor = hsv2rgb(vec3(hue, 0.9, 1.0));
      vec3 seamColor = hsv2rgb(vec3(fract(hue + 0.4), 0.85, 1.0));

      float density = shell * (0.5 + emissive * 1.5) + seam * (0.9 * uMirrors);
      float frontLight = 0.35 + 0.65 * saturate(1.0 - travel / 3.0);
      float contrib = density * (1.0 - opacity) * frontLight * 0.5;

      vec3 c = fixColor * (shell * (0.6 + emissive * 1.2))
             + seamColor * (seam * uMirrors);
      color += c * contrib * (1.6 + uEnergy * 1.4 + uKick * 2.2 + uSnare * 0.7) * uGlow;
      opacity += contrib * 0.4;
      if (opacity > 0.96) break;
    }

    // A deep ambient floor glow so the infinite vanishing point reads as void.
    float vanish = exp(-length(uv) * 2.2);
    color += mix(vec3(0.02, 0.0, 0.08), vec3(0.0, 0.05, 0.1), 0.5 + 0.5 * sin(time * 0.5))
      * vanish * (0.06 + uSub * 0.2 + uEnergy * 0.1);

    // The kick opens a depth gate: an expanding ring pushes the view deeper.
    float gateR = 0.2 + (1.0 - saturate(uBeat)) * 0.7;
    float gate = exp(-abs(length(uv) - gateR) * 40.0) * uBeat;
    color += mix(vec3(0.1, 0.7, 1.0), vec3(1.0, 0.1, 0.6), saturate(length(uv)))
      * gate * (0.7 + uGlow);

    float vignette = 1.0 - smoothstep(0.7, 1.5, length(uv * vec2(0.7, 1.0)));
    color *= 0.25 + 0.75 * vignette;
    color = filmicTone(color * 1.35);
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
          uMirrors: P.mirrors ?? 0.8,
          uGlow: P.glow ?? 1,
          uSpin: P.spin ?? 1,
          uDepth: P.depth ?? 1,
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
      uMirrors: P.mirrors ?? 0.8,
      uGlow: P.glow ?? 1,
      uSpin: P.spin ?? 1,
      uDepth: P.depth ?? 1,
    }),
  );
};
