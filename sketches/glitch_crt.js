// CRT Glitch — dying tube television. A procedural test card is warped by
// barrel curvature, striped with scanlines + aperture grille, flickered,
// ghosted and swept by a roll bar. Bass warps rows, kicks shake the frame.
// Everything lives in one fragment shader, so it stays smooth at any size.
// Opted-in renderers consume sub/mid/high/kick uniforms from the capture
// owner; the legacy raw-frame shader path is kept for all other callers.
import { makeAudioFeatures } from './audio-features.js';
import { FULLSCREEN_VERT } from './shader-utils.js';

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    sub: { min: 0, max: 1.6, neutral: 0.12 },
    mid: { min: 0, max: 1.6, neutral: 0.12 },
    high: { min: 0, max: 1.6, neutral: 0.08 },
    kick: { min: 0, max: 1.4, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { sub: 0.12, mid: 0.12, high: 0.08, kick: 0 },
  },
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// The controller reproduces the legacy extractor bands and the idle-mode tube
// twitch (a slow internal kick) when no capture frame is available.
export function createAudioController({ rng = Math.random } = {}) {
  let elapsed = 0;
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      elapsed += dt;

      const features = shared?.getFeatures?.() || {};
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const hasFrame = Boolean(freqs?.left?.length);
      const idleKick = Math.exp(-((elapsed * 2) % 1) * 14);

      const sub = hasFrame ? clamp(Number(features.sub) || 0, 0, 1.6) : clamp(0.12 + idleKick * 0.4, 0, 1.6);
      const mid = hasFrame ? clamp(Number(features.mid) || 0, 0, 1.6) : 0.12;
      const high = hasFrame ? clamp(Number(features.high) || 0, 0, 1.6) : 0.08;
      const kick = hasFrame ? clamp(Number(features.kick) || 0, 0, 1.4) : idleKick;

      return {
        continuous: { sub, mid, high, kick },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let crt;
  let elapsed = 0;
  const audioControls = runtimeContext?.audioControls || null;
  let getFeatures = null; // constructed lazily only for the legacy path

  const frag = `
    precision highp float;
    varying vec2 vTexCoord;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uSub;
    uniform float uMid;
    uniform float uHigh;
    uniform float uKick;
    uniform float uCurvature;
    uniform float uScan;
    uniform float uFlicker;
    uniform float uRoll;
    uniform float uGhost;
    uniform float uPulse;

    #define PI 3.141592653589793

    float hash21(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
        mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
        f.y
      );
    }

    vec3 hsv2rgb(vec3 c) {
      vec3 q = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
      vec3 rgb = clamp(q - 1.0, 0.0, 1.0);
      rgb = rgb * rgb * (3.0 - 2.0 * rgb);
      return c.z * mix(vec3(1.0), rgb, c.y);
    }

    // Procedural broadcast test card
    vec3 testCard(vec2 uv, float tm) {
      float col = floor(uv.x * 8.0);
      vec3 c = hsv2rgb(vec3(fract(col * 0.125 + tm * 0.035), 0.72, 0.88));
      c *= 0.9 + 0.1 * sin(uv.y * 10.0 + tm * 1.6);
      if (uv.y > 0.70) {
        float wave = sin(uv.x * 42.0 - tm * 9.0);
        float line = 1.0 - smoothstep(0.0, 0.018, abs(uv.y - 0.80 - wave * 0.05));
        c = mix(c * 0.22, vec3(0.35, 1.0, 0.72), line);
        float chk = mod(floor(uv.x * 22.0) + floor((uv.y - tm * 0.12) * 22.0), 2.0);
        c = mix(c, vec3(0.10 + chk * 0.14), smoothstep(0.88, 0.92, uv.y));
      }
      return c;
    }

    void main() {
      vec2 uv = vTexCoord;
      vec2 cUv = uv * 2.0 - 1.0;
      float r2 = dot(cUv, cUv);

      // Barrel curvature of the tube
      vec2 dUv = cUv * (1.0 + uCurvature * 0.26 * r2);

      // Audio-driven row warp + kick vertical shake
      float rowWarp = valueNoise(vec2(dUv.y * 7.0, uTime * 2.6)) - 0.5;
      dUv.x += rowWarp * (uSub * 0.07 + uHigh * 0.035) * uPulse;
      dUv.y += sin(uTime * 43.0) * uKick * 0.014 * uPulse;

      vec3 col = vec3(0.0);
      if (abs(dUv.x) <= 1.0 && abs(dUv.y) <= 1.0) {
        vec2 suv = dUv * 0.5 + 0.5;

        // Ghosting: offset second phosphor pass
        vec3 base = testCard(suv, uTime);
        vec3 ghost = testCard(suv + vec2(0.004 + uGhost * 0.014, 0.0), uTime);
        col = base + ghost * uGhost * 0.5;

        // Scanlines + faint aperture grille
        col *= 1.0 - uScan * 0.34 * (0.5 + 0.5 * sin(uv.y * uResolution.y * PI * 0.85));
        col *= 1.0 - uScan * 0.10 * (0.5 + 0.5 * sin(uv.x * uResolution.x * PI * 0.9));

        // Flicker (frame-quantized noise + bass breathing)
        float fl = hash21(vec2(floor(uTime * 60.0), 7.3));
        col *= 1.0 - uFlicker * (0.05 + 0.10 * fl + uSub * 0.09);

        // Roll bar sweeping down the tube
        float rollY = fract(uTime * (0.06 + uRoll * 0.13));
        float d = abs(uv.y - rollY);
        col += vec3(0.85, 0.92, 1.0) * uRoll * 0.15 * (1.0 - smoothstep(0.0, 0.10, d));
        col *= 1.0 - uRoll * 0.20 * (1.0 - smoothstep(0.0, 0.16, d));

        // Grain
        col += (hash21(uv * uResolution + fract(uTime) * 91.7) - 0.5) * 0.05;
      }

      // Tube vignette (dark corners beyond the curved glass)
      col *= 1.0 - smoothstep(0.62, 1.55, r2 * (0.9 + uCurvature * 0.35));

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  p.setup = () => {
    p.pixelDensity(1);
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    p.noStroke();
    crt = p.createShader(FULLSCREEN_VERT, frag);
  };

  function drawUniforms(C) {
    const P = params || {};
    const speed = P.speed ?? 1;
    const tm = elapsed * (0.35 + speed * 0.65);

    p.shader(crt);
    crt.setUniform('uResolution', [p.width, p.height]);
    crt.setUniform('uTime', tm);
    crt.setUniform('uSub', C.sub);
    crt.setUniform('uMid', C.mid);
    crt.setUniform('uHigh', C.high);
    crt.setUniform('uKick', C.kick);
    crt.setUniform('uCurvature', P.curvature ?? 0.6);
    crt.setUniform('uScan', P.scanlines ?? 0.7);
    crt.setUniform('uFlicker', P.flicker ?? 0.5);
    crt.setUniform('uRoll', P.roll ?? 0.5);
    crt.setUniform('uGhost', P.ghost ?? 0.4);
    crt.setUniform('uPulse', P.pulse ?? 1);
    p.rect(0, 0, p.width, p.height);
  }

  // Opted-in path: all audio uniforms come from the capture-side controller.
  function drawMigrated() {
    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    elapsed += dt;
    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    drawUniforms(C);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    const P = params || {};
    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    elapsed += dt;

    getFeatures = getFeatures || makeAudioFeatures();
    const frame = audio && audio.isStarted && typeof audio.getAnalysisFrame === 'function'
      ? audio.getAnalysisFrame()
      : null;
    const measured = getFeatures(frame, P, dt);
    // Idle mode: a slow internal beat keeps the tube twitching before audio
    const idleKick = Math.exp(-((elapsed * 2) % 1) * 14);
    const bands = frame
      ? measured
      : { sub: 0.12 + idleKick * 0.4, mid: 0.12, high: 0.08, kick: idleKick };

    drawUniforms({
      sub: bands.sub,
      mid: bands.mid,
      high: bands.high,
      kick: bands.kick ?? 0,
    });
  }

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);

  p.mousePressed = () => {
    if (audio) audio.resume(true);
  };
};
