// Neural Cascade — a living 3D synapse field. Nodes pulse, axons fire along
// geodesic arcs, and activation waves cascade on kicks. The 2026 AI-club look:
// holographic graph geometry with data-stream particles and scan glitches.
// The legacy raw-frame shader path remains intact; the opted-in path consumes
// final uniforms produced by a DOM-free capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uNodes;
  uniform float uLinks;
  uniform float uPulse;
  uniform float uSpeed;

  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }

  // Fibonacci-ish direction from an index for stable node placement on a sphere.
  vec3 nodeDir(float i, float n) {
    float y = 1.0 - (i / max(n - 1.0, 1.0)) * 2.0;
    float radius = sqrt(max(0.0, 1.0 - y * y));
    float theta = 2.399963 * i;
    return normalize(vec3(cos(theta) * radius, y, sin(theta) * radius));
  }

  float axonGlow(vec3 ro, vec3 rd, vec3 a, vec3 b, float thickness) {
    // Distance from ray to segment AB (capsule approximation).
    vec3 ba = b - a;
    vec3 oa = ro - a;
    float baba = max(dot(ba, ba), 1e-4);
    float bard = dot(ba, rd);
    float baoa = dot(ba, oa);
    float rdoa = dot(rd, oa);
    float rdrd = max(dot(rd, rd), 1e-4);
    float denom = baba * rdrd - bard * bard;
    float t = clamp((baba * rdoa - baoa * bard) / max(denom, 1e-4), 0.0, 20.0);
    float s = clamp((baoa + t * bard) / baba, 0.0, 1.0);
    vec3 closest = ro + rd * t;
    vec3 onSeg = a + ba * s;
    float d = length(closest - onSeg);
    return exp(-d * thickness);
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.25 + uSpeed * 0.65);
    float impact = max(uKick, uBeat * 0.88);

    // Occasional row tear on hats keeps the hologram alive.
    float row = floor((uv.y + 1.0) * 36.0);
    float tear = step(0.96 - uHat * 0.18, hash21(vec2(row, floor(time * 9.0))));
    uv.x += (hash21(vec2(row, 3.1)) - 0.5) * tear * (0.02 + uHat * 0.08);

    vec3 ro = vec3(0.0, 0.0, 2.55 - impact * 0.18);
    vec3 rd = normalize(vec3(uv, -1.55));
    float camSpin = time * 0.16;
    ro.xz = rotate2d(camSpin) * ro.xz;
    rd.xz = rotate2d(camSpin) * rd.xz;
    ro.xy = rotate2d(sin(time * 0.11) * 0.08) * ro.xy;
    rd.xy = rotate2d(sin(time * 0.11) * 0.08) * rd.xy;

    float nodeCount = clamp(floor(8.0 + uNodes * 10.0), 8.0, 22.0);
    float radius = 0.78 + uSub * 0.06 + impact * 0.12;
    vec3 color = vec3(0.001, 0.006, 0.016);
    float depthFade = 0.0;

    // Accumulate node cores + axon links. Fixed loop budget for WebGL1.
    for (int i = 0; i < 22; i++) {
      float fi = float(i);
      if (fi >= nodeCount) break;

      vec3 dir = nodeDir(fi, nodeCount);
      // Breathing offset so the graph feels alive, not a rigid wireframe.
      float breath = 0.92 + 0.08 * sin(time * 1.7 + fi * 0.9)
        + uMid * 0.04 * sin(time * 2.3 + fi);
      vec3 pos = dir * radius * breath;

      // Ray-sphere style glow for the node.
      vec3 oc = ro - pos;
      float b = dot(oc, rd);
      float c = dot(oc, oc) - 0.01;
      float h = b * b - c;
      float node = 0.0;
      if (h > 0.0) {
        float d = max(-b - sqrt(h), 0.0);
        node = exp(-d * 0.15) * (0.6 + 0.4 * saturate(1.0 - d * 0.35));
      }
      // Soft billboard falloff when the ray only grazes.
      float side = length(oc - rd * max(dot(oc, -rd), 0.0));
      node = max(node, exp(-side * (28.0 + uPulse * 10.0)) * 0.85);

      float activation = 0.35 + 0.65 * abs(sin(time * (1.2 + uPulse * 0.8) + fi * 1.7));
      activation = mix(activation, 1.0, saturate(impact * 1.2 - fi * 0.04));
      float hue = fract(0.52 + fi * 0.045 + time * 0.015 + uMid * 0.03);
      vec3 nodeCol = hsv2rgb(vec3(hue, 0.82, 1.0));
      color += nodeCol * node * activation
        * (1.1 + uEnergy * 1.2 + impact * 1.8 + uPulse * 0.4);

      // Links to the next few nodes along the sphere.
      for (int k = 1; k <= 3; k++) {
        float fk = float(k);
        float j = mod(fi + fk * 3.0 + 1.0, nodeCount);
        vec3 dirB = nodeDir(j, nodeCount);
        float breathB = 0.92 + 0.08 * sin(time * 1.7 + j * 0.9);
        vec3 posB = dirB * radius * breathB;
        float link = axonGlow(ro, rd, pos, posB, 42.0 + uLinks * 18.0 - uMid * 4.0);
        float flow = 0.5 + 0.5 * sin(time * (3.0 + uSpeed) + fi * 2.0 + fk * 4.0 + uSnare * 3.0);
        float travel = pow(flow, 8.0);
        color += mix(nodeCol, vec3(0.5, 0.9, 1.0), travel)
          * link * uLinks
          * (0.12 + travel * 0.55 + uSnare * 0.25 + uHat * 0.15)
          * activation;
      }

      depthFade += node * 0.05;
    }

    // Drifting data particles along camera rays.
    for (int p = 0; p < 18; p++) {
      float fp = float(p);
      vec3 seed = hash33(vec3(fp * 1.7, floor(time * 0.5), 2.3));
      float z = fract(seed.z + time * (0.15 + uSpeed * 0.2)) * 3.5 + 0.4;
      vec3 ppos = vec3((seed.xy - 0.5) * 2.4, 0.0);
      ppos.xy = rotate2d(time * 0.1) * ppos.xy;
      vec3 world = ppos + ro * 0.0;
      // Project particle near the sphere shell.
      world = normalize(vec3(ppos.xy, 0.35)) * (radius * (0.7 + seed.x * 0.5));
      world.y += sin(time + fp) * 0.05;
      vec3 oc = ro - world;
      float side = length(oc - rd * max(dot(oc, -rd), 0.0));
      float blob = exp(-side * 55.0);
      color += hsv2rgb(vec3(fract(0.48 + seed.x * 0.2), 0.7, 1.0))
        * blob * (0.08 + uHigh * 0.2 + uHat * 0.55);
    }

    // Horizontal scan plane sweeping the graph.
    float scanY = sin(time * 0.9) * 0.85;
    float scan = exp(-abs(uv.y - scanY) * (40.0 - uPulse * 6.0));
    color += mix(vec3(0.0, 0.55, 1.0), vec3(1.0, 0.05, 0.55), 0.5 + 0.5 * sin(time))
      * scan * (0.04 + uHigh * 0.1 + uHat * 0.45) * uPulse;

    // Kick acquisition ring.
    float lockR = 0.28 + (1.0 - saturate(uBeat)) * 0.65;
    float lock = exp(-abs(length(uv) - lockR) * 52.0) * uBeat;
    color += vec3(0.3, 0.75, 1.0) * lock * 0.95;

    // Soft core haze so empty center never looks dead.
    color += vec3(0.02, 0.08, 0.18) * exp(-length(uv) * 2.5)
      * (0.35 + uSub * 0.5 + impact * 0.8);

    float vignette = 1.0 - smoothstep(0.7, 1.52, length(uv * vec2(0.72, 1.0)));
    color *= 0.24 + 0.76 * vignette;
    color = filmicTone(color * 1.45);
    color = pow(color, vec3(0.88));
    gl_FragColor = vec4(color, 1.0);
  }
`;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

// Header audio uniforms the fragment shader reads (uSub/uMid/uHigh/uEnergy/
// uKick/uSnare/uHat/uBeat) plus the pattern's own param uniforms. In the
// migrated path makeAudioShader hard-zeros the header uniforms, so the
// controller must supply every one of them as a continuous control.
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
    uNodes: { min: 0.35, max: 2, neutral: 1 },
    uLinks: { min: 0.2, max: 2, neutral: 1 },
    uPulse: { min: 0.2, max: 2, neutral: 1 },
    uSpeed: { min: 0, max: 2.5, neutral: 1 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: {
      uSub: 0, uMid: 0, uHigh: 0, uEnergy: 0,
      uKick: 0, uSnare: 0, uHat: 0, uBeat: 0,
      uNodes: 1, uLinks: 1, uPulse: 1, uSpeed: 1,
    },
  },
});

// The controller owns all audio interpretation on the capture owner: it maps
// the canonical musical features through the accepted param gains and, when no
// audio frame exists, reproduces makeAudioShader's musical idle bands so the
// effect stays stage-ready before an input is selected.
export function createAudioController({ rng = Math.random } = {}) {
  let elapsed = 0;
  return {
    update({ frame, shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(finite(deltaSeconds, 1 / 30), 1 / 240, 0.1);
      elapsed += dt;
      const bassGain = Math.max(0, finite(params.bass, 1));
      const midGain = Math.max(0, finite(params.mid, 1));
      const highGain = Math.max(0, finite(params.high, 1));
      const punch = Math.max(0, finite(params.punch, 1));
      const pulse = (rate, offset = 0, decay = 18) => {
        const phase = ((elapsed * rate + offset) % 1 + 1) % 1;
        return Math.exp(-phase * decay);
      };

      let bands;
      if (frame) {
        const f = shared?.getFeatures?.() || {};
        bands = {
          sub: clamp((f.sub ?? 0) * bassGain, 0, 1.6),
          mid: clamp((f.mid ?? 0) * midGain, 0, 1.6),
          high: clamp((f.high ?? 0) * highGain, 0, 1.6),
          energy: clamp((f.energy ?? 0) * (bassGain * 0.42 + midGain * 0.38 + highGain * 0.2), 0, 1.6),
          kick: clamp((f.kick ?? 0) * bassGain * punch, 0, 1.4),
          snare: clamp((f.snare ?? 0) * midGain * punch, 0, 1.4),
          hat: clamp((f.hat ?? 0) * highGain * punch, 0, 1.4),
          beat: clamp((f.beat ?? 0) * bassGain * punch, 0, 1.4),
        };
      } else {
        const rawKick = pulse(2.0);
        const idleKick = Math.min(1.4, rawKick * bassGain * punch);
        const idleSnare = Math.min(1.4, pulse(1.0, 0.5, 22) * midGain * punch);
        const idleHat = Math.min(1.4, pulse(4.0, 0.5, 28) * highGain * punch);
        const sway = 0.5 + 0.5 * Math.sin(elapsed * 1.37);
        bands = {
          sub: (0.14 + rawKick * 0.48) * bassGain,
          mid: (0.12 + sway * 0.14) * midGain,
          high: (0.08 + (1 - sway) * 0.16) * highGain,
          energy: 0.18 + rawKick * 0.16 + sway * 0.06,
          kick: idleKick,
          snare: idleSnare,
          hat: idleHat,
          beat: idleKick,
        };
      }

      return {
        continuous: {
          uSub: bands.sub,
          uMid: bands.mid,
          uHigh: bands.high,
          uEnergy: bands.energy,
          uKick: bands.kick,
          uSnare: bands.snare,
          uHat: bands.hat,
          uBeat: bands.beat,
          uNodes: clamp(finite(params.nodes, 1), 0.35, 2),
          uLinks: clamp(finite(params.links, 1), 0.2, 2),
          uPulse: clamp(finite(params.pulse, 1), 0.2, 2),
          uSpeed: clamp(finite(params.speed, 1), 0, 2.5),
        },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => {
  const audioControls = runtimeContext?.audioControls;
  if (audioControls) {
    return makeAudioShader(
      audio,
      params,
      frag,
      (_P, _bands, _p, controls) => ({
        ...AUDIO_CONTROL_SCHEMA.neutral.continuous,
        ...(controls?.continuous || {}),
      }),
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
      uNodes: P.nodes ?? 1,
      uLinks: P.links ?? 1,
      uPulse: P.pulse ?? 1,
      uSpeed: P.speed ?? 1,
    }),
  );
};
