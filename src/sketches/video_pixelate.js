// Video Pixelate — mosaic the camera feed into big crunchy blocks with
// optional posterization and hue rotation. Bass can swell the block size so
// the image collapses into chunk on the kick. Single shader pass.
// The opted-in path consumes the render-ready sub level produced by the
// DOM-free capture-side controller; the legacy raw-frame path is kept intact.
import { makeAudioFeatures } from './audio-features.js';
import { FULLSCREEN_VERT } from './shader-utils.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    sub: { min: 0, max: 1.6, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { sub: 0 },
  },
});

// The controller owns the canonical feature mapping. The renderer previously
// derived the sub level per frame through makeAudioFeatures(); the capture
// owner now supplies it through the shared analysis view. The block-size swell
// is applied screen-side from the supplied sub level and the audioBlocks
// parameter, exactly as before.
export function createAudioController({ rng = Math.random } = {}) {
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const features = shared?.getFeatures?.() || {};
      return {
        continuous: {
          sub: clamp(Number(features.sub) || 0, 0, 1.6),
        },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let capture;
  let isCaptureReady = false;
  let mosaic;
  let elapsed = 0;
  const audioControls = runtimeContext?.audioControls || null;
  const getFeatures = makeAudioFeatures();

  const frag = `
    precision highp float;
    varying vec2 vTexCoord;
    uniform sampler2D uTex;
    uniform vec2 uResolution;
    uniform vec2 uCover;
    uniform float uBlockSize;
    uniform float uLevels;
    uniform float uTint;
    uniform float uBright;

    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
      vec4 q = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
      vec4 r = mix(vec4(q.xyw, c.r), vec4(c.r, q.yzx), step(q.x, c.r));
      float d = r.x - min(r.w, r.y);
      float e = 1.0e-10;
      return vec3(abs(r.z + (r.w - r.y) / (6.0 * d + e)), d / (r.x + e), r.x);
    }

    vec3 hsv2rgb(vec3 c) {
      vec3 q = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
      vec3 rgb = clamp(q - 1.0, 0.0, 1.0);
      rgb = rgb * rgb * (3.0 - 2.0 * rgb);
      return c.z * mix(vec3(1.0), rgb, c.y);
    }

    void main() {
      // Snap to block centers before sampling -> mosaic
      vec2 pix = vTexCoord * uResolution;
      float bs = max(uBlockSize, 1.5);
      vec2 cell = (floor(pix / bs) + 0.5) * bs;
      vec2 uv = cell / uResolution;

      vec2 tuv = 0.5 + (uv - 0.5) * uCover;
      tuv = vec2(1.0 - tuv.x, 1.0 - tuv.y);
      vec3 c = texture2D(uTex, tuv).rgb;

      // Optional color quantization (posterize)
      if (uLevels > 1.5) {
        c = floor(c * uLevels + 0.5) / uLevels;
      }

      // Hue rotation tint
      if (uTint > 0.004) {
        vec3 hsv = rgb2hsv(c);
        hsv.x = fract(hsv.x + uTint);
        hsv.y = min(1.0, hsv.y * 1.15);
        c = hsv2rgb(hsv);
      }

      gl_FragColor = vec4(c * uBright, 1.0);
    }
  `;

  p.setup = () => {
    p.pixelDensity(1);
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    p.noStroke();
    mosaic = p.createShader(FULLSCREEN_VERT, frag);

    const constraints = {
      video: {
        deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    };

    capture = runtimeContext?.createCapture(p, constraints, () => {
      isCaptureReady = true;
      runtimeContext?.reportMediaReady?.();
    }) || p.createCapture(constraints, () => {
      isCaptureReady = true;
      runtimeContext?.reportMediaReady?.();
    });
    capture.hide();
  };

  function drawMigrated() {
    const P = params || {};
    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    elapsed += dt;

    p.background(0);
    if (!isCaptureReady || !capture?.loadedmetadata || !capture?.width) return;

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };

    const A = p.width / Math.max(1, p.height);
    const T = capture.width / Math.max(1, capture.height);
    const cover = A > T ? [1, T / A] : [A / T, 1];

    // Bass swells the blocks when audio-reactive blocks are enabled
    const block = (P.block ?? 14) * (1 + (P.audioBlocks ?? 0.8) * C.sub * 1.6);

    p.shader(mosaic);
    mosaic.setUniform('uTex', capture);
    mosaic.setUniform('uResolution', [p.width, p.height]);
    mosaic.setUniform('uCover', cover);
    mosaic.setUniform('uBlockSize', Math.min(block, Math.max(1.5, p.height / 4)));
    mosaic.setUniform('uLevels', Math.round(P.levels ?? 8));
    mosaic.setUniform('uTint', P.tint ?? 0);
    mosaic.setUniform('uBright', P.bright ?? 1);
    p.rect(0, 0, p.width, p.height);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    const P = params || {};
    const dt = Math.min(p.deltaTime || 16.667, 100) / 1000;
    elapsed += dt;

    p.background(0);
    if (!isCaptureReady || !capture?.loadedmetadata || !capture?.width) return;

    const frame = audio && audio.isStarted && typeof audio.getAnalysisFrame === 'function'
      ? audio.getAnalysisFrame()
      : null;
    const measured = getFeatures(frame, P, dt);
    const bands = frame
      ? measured
      : { sub: 0.15 + 0.12 * Math.sin(elapsed * 2.3), mid: 0.1, high: 0.07 };

    const A = p.width / Math.max(1, p.height);
    const T = capture.width / Math.max(1, capture.height);
    const cover = A > T ? [1, T / A] : [A / T, 1];

    // Bass swells the blocks when audio-reactive blocks are enabled
    const block = (P.block ?? 14) * (1 + (P.audioBlocks ?? 0.8) * bands.sub * 1.6);

    p.shader(mosaic);
    mosaic.setUniform('uTex', capture);
    mosaic.setUniform('uResolution', [p.width, p.height]);
    mosaic.setUniform('uCover', cover);
    mosaic.setUniform('uBlockSize', Math.min(block, Math.max(1.5, p.height / 4)));
    mosaic.setUniform('uLevels', Math.round(P.levels ?? 8));
    mosaic.setUniform('uTint', P.tint ?? 0);
    mosaic.setUniform('uBright', P.bright ?? 1);
    p.rect(0, 0, p.width, p.height);
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
