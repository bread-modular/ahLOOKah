// Wormhole Transit — the viewer plunges through a twisting Einstein-Rosen
// bridge. Concentric spacetime rings warp and stretch with gravitational
// lensing, matter streams spiral along the throat, and the exit portal glows
// with Doppler-shifted light. Bass compresses the throat, mids twist the
// geometry, and highs ignite relativistic particle jets along the walls.
// The legacy raw-frame path stays intact; opted-in renderers consume final
// controls (header audio uniforms + params) from a capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uTwist;
  uniform float uThroat;
  uniform float uDoppler;
  uniform float uSpeed;

  // Tunnel coordinate transform: maps screen UV into a cylindrical tunnel
  // space with perspective depth. Returns (angle, depth, radius).
  vec3 tunnelCoords(vec2 uv, float time) {
    float radius = length(uv);
    float angle = atan(uv.y, uv.x);
    // Perspective depth: center = far away, edges = near
    float depth = 1.0 / max(radius, 0.04);
    return vec3(angle, depth, radius);
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.25 + uSpeed * 0.7);
    float impact = max(uKick, uBeat * 0.8);

    vec3 tc = tunnelCoords(uv, time);
    float angle = tc.x;
    float depth = tc.y;
    float radius = tc.z;

    // Throat radius: bass compresses it, creating a "squeezing" sensation
    float throatRadius = 0.08 + uThroat * 0.06 + uSub * 0.04 + impact * 0.06;
    float throatMask = smoothstep(throatRadius * 0.5, throatRadius * 1.8, radius);

    // Twist: the tunnel rotates as you go deeper, mids add extra twist
    float twistAmount = uTwist * 2.5 + uMid * 1.5 + uSnare * 2.0;
    float twist = angle + depth * twistAmount * 0.15 + time * 0.4;

    // === Tunnel wall structure ===
    vec3 color = vec3(0.001, 0.002, 0.008);

    // Concentric spacetime rings (Einstein ring echoes)
    float ringFreq = 3.0 + uThroat * 2.0;
    float ringPhase = depth * ringFreq - time * 3.0;
    float rings = pow(max(0.0, sin(ringPhase)), 6.0);
    float ringSpacing = pow(max(0.0, sin(ringPhase * 0.5 + 1.57)), 3.0);
    float ringPattern = rings * 0.7 + ringSpacing * 0.3;

    // Rings get brighter and more compressed near the throat
    float ringIntensity = ringPattern * throatMask
      * (0.4 + uEnergy * 0.6 + impact * 1.0);
    vec3 ringColor = hsv2rgb(vec3(
      fract(0.55 + depth * 0.02 + time * 0.015 + uMid * 0.1),
      0.8, 1.0
    ));
    color += ringColor * ringIntensity * 0.8;

    // Spiral matter streams flowing along the throat wall
    float spiralArms = 5.0 + floor(uTwist * 3.0);
    float spiral = sin(twist * spiralArms - depth * 8.0 + time * 4.0);
    spiral = pow(max(0.0, spiral), 4.0);
    float streamMask = throatMask * (1.0 - smoothstep(0.3, 0.9, radius));
    float streams = spiral * streamMask * (0.3 + uSub * 0.5 + impact * 0.8);
    vec3 streamColor = hsv2rgb(vec3(
      fract(0.08 + depth * 0.03 + angle * 0.05),
      0.9, 1.0
    ));
    color += streamColor * streams * 0.6;

    // Gravitational lensing distortion: the tunnel wall appears to bend
    // light around the throat. We simulate this with a radial warp pattern.
    float lensStrength = uThroat * 0.5 + uSub * 0.3 + impact * 0.4;
    float lensWarp = sin(radius * 25.0 - depth * 3.0 + time * 2.0)
      * exp(-radius * 4.0) * lensStrength;
    float lensRings = pow(max(0.0, sin(radius * 40.0 - time * 5.0 + lensWarp * 8.0)), 12.0);
    color += vec3(0.3, 0.5, 1.0) * lensRings * throatMask * 0.4;

    // === Throat / exit portal ===
    // The far end of the wormhole glows with Doppler-shifted light
    float portalRadius = throatRadius * (1.2 + impact * 0.5);
    float portalGlow = exp(-radius * radius / (portalRadius * portalRadius * 2.0));

    // Doppler shift: approaching side is blue, receding is red
    float dopplerAngle = angle + time * 0.3;
    float dopplerShift = sin(dopplerAngle) * uDoppler;
    vec3 portalColor = mix(
      vec3(1.0, 0.15, 0.1),  // red-shifted (receding)
      vec3(0.1, 0.3, 1.0),   // blue-shifted (approaching)
      0.5 + dopplerShift * 0.5
    );
    // Add white-hot core
    portalColor = mix(portalColor, vec3(1.0, 0.95, 0.9), portalGlow * 0.4);
    color += portalColor * portalGlow * (1.5 + uEnergy * 1.5 + impact * 2.5);

    // Einstein ring at the portal edge
    float einsteinRing = exp(-abs(radius - portalRadius * 1.3) * 60.0);
    vec3 erColor = hsv2rgb(vec3(fract(0.6 + time * 0.02 + dopplerShift * 0.1), 0.7, 1.0));
    color += erColor * einsteinRing * (0.8 + uMid * 1.0 + uSnare * 1.5) * uDoppler;

    // === Wall detail: hexagonal spacetime tessellation ===
    float hexScale = 8.0 + uThroat * 4.0;
    vec2 hexUv = vec2(twist * 2.0, depth * 0.5) * hexScale;
    // Simple hex-like grid using triangular coordinates
    vec2 hexCell = floor(hexUv);
    vec2 hexLocal = fract(hexUv) - 0.5;
    float hexDist = max(abs(hexLocal.x), abs(hexLocal.y * 0.866 + hexLocal.x * 0.5));
    float hexEdge = 1.0 - smoothstep(0.35, 0.42, hexDist);
    float hexPattern = (1.0 - hexEdge) * throatMask;
    float hexPulse = 0.5 + 0.5 * sin(hash21(hexCell) * VIZ_TAU + time * 3.0 + impact * 4.0);
    color += vec3(0.05, 0.15, 0.4) * hexPattern * hexPulse * 0.35;

    // === Relativistic particle jets along the walls ===
    float jetCount = 8.0;
    for (int j = 0; j < 8; j++) {
      if (float(j) >= jetCount) break;
      float jetAngle = float(j) / jetCount * VIZ_TAU + time * 0.5;
      float jetDist = abs(angle - jetAngle);
      jetDist = min(jetDist, VIZ_TAU - jetDist); // wrap around
      float jetWidth = 0.08 + uHigh * 0.04 + uHat * 0.08;
      float jet = exp(-jetDist * jetDist / (jetWidth * jetWidth));

      // Jets flow outward from the portal
      float jetFlow = sin(depth * 12.0 - time * 8.0 + float(j) * 1.7);
      jetFlow = pow(max(0.0, jetFlow), 3.0);

      float jetMask = throatMask * smoothstep(0.05, 0.2, radius)
        * (1.0 - smoothstep(0.5, 1.0, radius));
      float jetBright = jet * jetFlow * jetMask
        * (0.2 + uHigh * 0.8 + uHat * 2.0);

      vec3 jetColor = hsv2rgb(vec3(
        fract(float(j) / jetCount + time * 0.05 + uDoppler * 0.1),
        0.85, 1.0
      ));
      color += jetColor * jetBright;
    }

    // === Tidal force visualization: stretching lines near the throat ===
    float tidalLines = pow(max(0.0, sin(angle * 24.0 + time * 1.5)), 20.0);
    float tidalMask = exp(-radius * 6.0) * (uSub * 0.5 + impact * 0.8);
    color += vec3(0.6, 0.3, 1.0) * tidalLines * tidalMask * 0.5;

    // === Beat shockwave: expanding ring from the portal ===
    float shockRadius = portalRadius + (1.0 - saturate(uBeat)) * 0.8;
    float shockwave = exp(-abs(radius - shockRadius) * 45.0) * uBeat;
    color += mix(vec3(0.2, 0.5, 1.0), vec3(1.0, 0.2, 0.5),
      0.5 + 0.5 * sin(angle * 3.0 + time)) * shockwave * 1.8;

    // Depth fog: far parts of the tunnel fade into the portal glow
    float depthFog = smoothstep(2.0, 8.0, depth);
    color = mix(color, portalColor * 0.3, depthFog * 0.5);

    // Radial vignette
    float vignette = 1.0 - smoothstep(0.5, 1.4, radius);
    color *= 0.2 + 0.8 * vignette;

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
          uTwist: P.twist ?? 1,
          uThroat: P.throat ?? 1,
          uDoppler: P.doppler ?? 1,
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
      uTwist: P.twist ?? 1,
      uThroat: P.throat ?? 1,
      uDoppler: P.doppler ?? 1,
      uSpeed: P.speed ?? 1,
    }),
  );
};
