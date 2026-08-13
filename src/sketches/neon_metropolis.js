// Neon Metropolis — a sprawling synthwave cyberpunk cityscape at night.
// A massive neon sun sets behind a procedural skyline of glowing towers,
// while a reflective wet grid road stretches toward the horizon. Holographic
// billboards flicker, flying vehicles streak through the sky, and neon signs
// pulse with the music. Bass drives the sun pulse and road vibration, mids
// control the skyline density and hologram flicker, and highs trigger
// vehicle streaks and sign flashes.
// The legacy raw-frame shader path remains intact; the opted-in path consumes
// final uniforms produced by a DOM-free capture-side controller.
import { AUDIO_SHADER_HEADER, makeAudioShader } from './shader-utils.js';

const frag = `${AUDIO_SHADER_HEADER}
  uniform float uSkyline;
  uniform float uNeon;
  uniform float uTraffic;
  uniform float uSpeed;

  // Procedural building height at a given x position
  float buildingHeight(float x, float seed) {
    float h = 0.0;
    h += 0.35 * valueNoise(vec2(x * 0.8, seed));
    h += 0.25 * valueNoise(vec2(x * 2.1, seed + 10.0));
    h += 0.15 * valueNoise(vec2(x * 5.3, seed + 20.0));
    h += 0.08 * valueNoise(vec2(x * 11.7, seed + 30.0));
    return h * (0.6 + uSkyline * 0.8);
  }

  // Neon sign color palette
  vec3 neonColor(float id, float time) {
    float hue = fract(id * 0.618 + time * 0.02);
    return hsv2rgb(vec3(hue, 0.9, 1.0));
  }

  void main() {
    vec2 uv = vTexCoord * 2.0 - 1.0;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    float time = uTime * (0.12 + uSpeed * 0.45);
    float impact = max(uKick, uBeat * 0.75);

    // Horizon line
    float horizon = -0.1;

    // === SKY ===
    vec3 color = vec3(0.0);
    float skyGrad = smoothstep(horizon, 1.0, uv.y);

    // Deep night sky gradient: dark purple to deep blue
    vec3 skyTop = vec3(0.02, 0.0, 0.06);
    vec3 skyBottom = vec3(0.08, 0.01, 0.15);
    color = mix(skyBottom, skyTop, skyGrad);

    // === NEON SUN ===
    vec2 sunPos = vec2(0.0, horizon + 0.28);
    float sunRadius = 0.22 + uSub * 0.04 + impact * 0.06;
    float sunDist = length(uv - sunPos);

    // Sun body with horizontal scan lines (classic synthwave look)
    float sunMask = 1.0 - smoothstep(sunRadius * 0.95, sunRadius, sunDist);
    float scanLines = step(0.0, sin((uv.y - sunPos.y) * 80.0 - time * 3.0));
    float scanMask = mix(1.0, scanLines, smoothstep(sunRadius * 0.1, sunRadius * 0.7, sunDist));
    sunMask *= scanMask;

    // Sun gradient: yellow-orange at bottom, hot pink at top
    float sunGrad = (uv.y - sunPos.y + sunRadius) / (sunRadius * 2.0);
    vec3 sunColor = mix(
      vec3(1.0, 0.85, 0.1),   // golden yellow
      vec3(1.0, 0.1, 0.4),    // hot pink
      clamp(sunGrad, 0.0, 1.0)
    );
    sunColor = mix(sunColor, vec3(1.0, 0.4, 0.1), 0.3); // orange bias

    // Sun glow halo
    float sunGlow = exp(-sunDist * sunDist / (sunRadius * sunRadius * 1.5));
    vec3 glowColor = mix(vec3(1.0, 0.3, 0.15), vec3(0.8, 0.1, 0.5), sunGrad);
    color += glowColor * sunGlow * (0.4 + uEnergy * 0.4 + impact * 0.6) * uNeon;
    color += sunColor * sunMask * (1.2 + impact * 0.8);

    // === STARS ===
    vec2 starUv = uv * 60.0;
    vec2 starCell = floor(starUv);
    float starSeed = hash21(starCell);
    vec2 starLocal = fract(starUv) - 0.5;
    float starDist = length(starLocal - (vec2(hash21(starCell + 7.0), hash21(starCell + 13.0)) - 0.5) * 0.6);
    float star = (1.0 - smoothstep(0.01, 0.04, starDist)) * step(0.94, starSeed);
    float twinkle = 0.5 + 0.5 * sin(time * 4.0 + starSeed * VIZ_TAU);
    color += vec3(0.7, 0.75, 1.0) * star * twinkle * smoothstep(horizon + 0.3, horizon + 0.6, uv.y) * 0.6;

    // === SKYLINE (procedural buildings) ===
    float buildingLayer = 0.0;
    vec3 buildingColor = vec3(0.0);

    // Two depth layers of buildings
    for (int layer = 0; layer < 2; layer++) {
      float layerDepth = float(layer);
      float parallax = 1.0 + layerDepth * 0.5;
      float bx = uv.x * parallax + time * 0.02 * (1.0 + layerDepth);
      float seed = 100.0 + layerDepth * 50.0;

      // Building width and gap
      float blockWidth = 0.08 + layerDepth * 0.04;
      float blockIndex = floor(bx / blockWidth);
      float blockLocal = fract(bx / blockWidth);

      // Each block has a building with random height
      float bSeed = hash21(vec2(blockIndex, seed));
      float bHeight = buildingHeight(blockIndex * 0.3, seed) * (0.5 + layerDepth * 0.3);
      float bTop = horizon + bHeight;

      // Building mask
      float gap = 0.15 + bSeed * 0.1;
      float bMask = step(gap, blockLocal) * step(blockLocal, 1.0 - gap * 0.5);
      bMask *= step(uv.y, bTop) * step(horizon - 0.02, uv.y);

      // Building body: dark with subtle gradient
      float bodyShade = 0.02 + 0.02 * (1.0 - (uv.y - horizon) / max(bHeight, 0.01));
      vec3 bColor = vec3(bodyShade * 0.8, bodyShade * 0.6, bodyShade * 1.2);

      // Window grid
      float winX = fract(blockLocal * (8.0 + bSeed * 6.0));
      float winY = fract((uv.y - horizon) * (20.0 + bSeed * 15.0));
      float window = step(0.25, winX) * step(winX, 0.75)
        * step(0.2, winY) * step(winY, 0.8);
      float winSeed = hash21(vec2(floor(blockLocal * 10.0) + blockIndex * 7.0,
        floor((uv.y - horizon) * 25.0)));
      float winLit = step(0.45, winSeed);
      float winFlicker = 0.7 + 0.3 * sin(time * 2.0 + winSeed * VIZ_TAU);
      vec3 winColor = mix(vec3(1.0, 0.85, 0.5), vec3(0.5, 0.8, 1.0), winSeed);
      bColor += winColor * window * winLit * winFlicker * 0.15 * uNeon;

      // Neon edge lighting on building tops and sides
      float edgeTop = 1.0 - smoothstep(0.0, 0.008, abs(uv.y - bTop));
      float edgeSide = 1.0 - smoothstep(0.0, 0.004, abs(blockLocal - gap));
      edgeSide += 1.0 - smoothstep(0.0, 0.004, abs(blockLocal - (1.0 - gap * 0.5)));
      vec3 edgeColor = neonColor(bSeed + layerDepth * 0.3, time);
      bColor += edgeColor * (edgeTop + edgeSide * 0.5) * (0.4 + uNeon * 0.6 + impact * 0.8);

      // Neon signs on building faces
      float signY = horizon + bHeight * (0.3 + bSeed * 0.4);
      float signMask = step(abs(uv.y - signY), 0.015) * bMask;
      float signFlicker = step(0.3, sin(time * (3.0 + bSeed * 5.0) + bSeed * VIZ_TAU));
      float signBuzz = 0.8 + 0.2 * sin(time * 30.0 + bSeed * 100.0);
      vec3 signColor = neonColor(bSeed * 3.7, time);
      bColor += signColor * signMask * signFlicker * signBuzz
        * (0.5 + uHigh * 0.8 + uHat * 1.5) * uNeon;

      float layerMask = bMask * (1.0 - buildingLayer);
      buildingColor = mix(buildingColor, bColor, layerMask);
      buildingLayer = max(buildingLayer, bMask * (1.0 - layerDepth * 0.3));
    }
    color = mix(color, buildingColor, buildingLayer);

    // === WET GRID ROAD ===
    if (uv.y < horizon) {
      float roadDepth = (horizon - uv.y);
      float perspective = 1.0 / max(roadDepth, 0.01);

      // Grid lines
      float gridScale = 2.0 + uSkyline * 1.0;
      float gridX = uv.x * perspective * gridScale;
      float gridZ = perspective * 0.5 - time * 2.0;

      float lineX = pow(max(0.0, sin(gridX * 3.14159)), 24.0);
      float lineZ = pow(max(0.0, sin(gridZ * 3.14159)), 24.0);
      float grid = max(lineX, lineZ);

      // Grid color: neon pink/cyan
      vec3 gridColor = mix(
        vec3(1.0, 0.05, 0.5),  // hot pink
        vec3(0.0, 0.8, 1.0),   // cyan
        0.5 + 0.5 * sin(gridZ * 0.5 + time)
      );
      float gridFade = smoothstep(0.0, 0.05, roadDepth) * (1.0 - smoothstep(0.3, 0.8, roadDepth));
      color += gridColor * grid * gridFade * (0.3 + uNeon * 0.5 + impact * 0.6);

      // Wet reflection of the sun and skyline
      float reflY = horizon + roadDepth * 0.4;
      vec2 reflUv = vec2(uv.x + sin(time + uv.x * 20.0) * 0.003, reflY);
      float reflSunDist = length(reflUv - sunPos);
      float reflSun = exp(-reflSunDist * reflSunDist / (sunRadius * sunRadius * 2.0));
      color += sunColor * reflSun * 0.2 * gridFade;

      // Road surface: dark wet asphalt
      vec3 roadColor = vec3(0.01, 0.008, 0.02);
      float puddle = fbm4(uv * vec2(8.0, 3.0) + time * 0.05);
      roadColor += vec3(0.02, 0.015, 0.03) * puddle;
      color = mix(color, roadColor, 0.5 * gridFade);
    }

    // === FLYING VEHICLES (traffic streaks) ===
    float numVehicles = 4.0 + uTraffic * 6.0;
    for (int v = 0; v < 10; v++) {
      if (float(v) >= numVehicles) break;
      float vSeed = hash21(vec2(float(v), 42.0));
      float vY = horizon + 0.15 + vSeed * 0.5;
      float vSpeed = (0.3 + vSeed * 0.7) * (1.0 + uTraffic * 0.5);
      float vX = fract(time * vSpeed * 0.15 + vSeed) * 2.4 - 1.2;
      float vDir = step(0.5, vSeed) * 2.0 - 1.0;
      vX *= vDir;

      // Vehicle streak
      vec2 vPos = vec2(vX, vY);
      float vDist = length((uv - vPos) * vec2(1.0, 4.0));
      float streak = exp(-vDist * vDist * 800.0);

      // Tail light trail
      float trailX = (uv.x - vX) * vDir;
      float trail = exp(-abs(uv.y - vY) * 80.0)
        * exp(-max(0.0, trailX) * 15.0)
        * step(0.0, trailX * vDir);

      vec3 vColor = mix(vec3(1.0, 0.1, 0.1), vec3(0.1, 0.5, 1.0), step(0.5, vSeed));
      float vBright = streak * 2.0 + trail * 0.4;
      vBright *= (0.3 + uHigh * 0.5 + uHat * 1.5) * uTraffic;

      // High-frequency trigger: vehicles appear more with hats
      float vAppear = step(0.3 - uHat * 0.2, sin(time * 2.0 + vSeed * VIZ_TAU) * 0.5 + 0.5);
      color += vColor * vBright * vAppear;
    }

    // === HOLOGRAPHIC BILLBOARDS ===
    float holoCount = 2.0 + uSkyline * 2.0;
    for (int h = 0; h < 4; h++) {
      if (float(h) >= holoCount) break;
      float hSeed = hash21(vec2(float(h), 77.0));
      float hX = (hSeed - 0.5) * 1.6;
      float hY = horizon + 0.2 + hSeed * 0.35;
      float hW = 0.08 + hSeed * 0.06;
      float hH = 0.05 + hSeed * 0.04;

      // Billboard rectangle
      vec2 hLocal = (uv - vec2(hX, hY)) / vec2(hW, hH);
      float hMask = step(max(abs(hLocal.x), abs(hLocal.y)), 1.0);

      // Holographic content: animated scan lines + color shift
      float hScan = sin(hLocal.y * 30.0 - time * 8.0) * 0.5 + 0.5;
      float hFlicker = 0.7 + 0.3 * sin(time * 15.0 + hSeed * 50.0);
      float hGlitch = step(0.95 - uHigh * 0.03 - uHat * 0.08,
        hash21(vec2(floor(hLocal.y * 10.0), floor(time * 5.0))));

      vec3 hColor = neonColor(hSeed * 5.0 + float(h) * 0.25, time);
      float hBright = hMask * hScan * hFlicker * (0.3 + uMid * 0.5 + uSnare * 0.8);
      hBright *= 1.0 + hGlitch * 2.0;

      // Hologram transparency effect
      hBright *= 0.6 + 0.4 * sin(time * 0.5 + hSeed * VIZ_TAU);
      color += hColor * hBright * uNeon * 0.5;

      // Hologram projection cone (faint light below the billboard)
      float coneDist = abs(uv.x - hX) - (uv.y - (hY - hH)) * 0.3;
      float cone = exp(-max(0.0, coneDist) * 30.0)
        * (1.0 - smoothstep(hY - hH - 0.15, hY - hH, uv.y))
        * step(uv.y, hY - hH);
      color += hColor * cone * 0.08 * uNeon;
    }

    // === ATMOSPHERIC HAZE ===
    float haze = exp(-abs(uv.y - horizon) * 4.0);
    vec3 hazeColor = mix(vec3(0.15, 0.02, 0.2), vec3(0.2, 0.05, 0.1),
      0.5 + 0.5 * sin(time * 0.1));
    color += hazeColor * haze * (0.15 + uEnergy * 0.15);

    // === BEAT FLASH: city-wide neon surge ===
    color *= 1.0 + impact * 0.2;

    // Chromatic aberration at screen edges
    float caStr = 0.003 + uHigh * 0.002;
    float rShift = length(uv - vec2(caStr, 0.0)) - length(uv);
    float bShift = length(uv + vec2(caStr, 0.0)) - length(uv);
    color.r *= 1.0 + rShift * 3.0;
    color.b *= 1.0 + bShift * 3.0;

    float vignette = 1.0 - smoothstep(0.6, 1.5, length(uv * vec2(0.7, 1.0)));
    color *= 0.2 + 0.8 * vignette;
    color = filmicTone(color * 1.3);
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
    uSkyline: { min: 0.2, max: 2, neutral: 1 },
    uNeon: { min: 0.2, max: 2, neutral: 1 },
    uTraffic: { min: 0, max: 2, neutral: 1 },
    uSpeed: { min: 0, max: 2.5, neutral: 1 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: {
      uSub: 0, uMid: 0, uHigh: 0, uEnergy: 0,
      uKick: 0, uSnare: 0, uHat: 0, uBeat: 0,
      uSkyline: 1, uNeon: 1, uTraffic: 1, uSpeed: 1,
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
          uSkyline: clamp(finite(params.skyline, 1), 0.2, 2),
          uNeon: clamp(finite(params.neon, 1), 0.2, 2),
          uTraffic: clamp(finite(params.traffic, 1), 0, 2),
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
      uSkyline: P.skyline ?? 1,
      uNeon: P.neon ?? 1,
      uTraffic: P.traffic ?? 1,
      uSpeed: P.speed ?? 1,
    }),
  );
};
