// Restored legacy camera looks: Video Thermal and Video Edge Glow, recovered
// from git history with their exact prior ids and names. The original 6fc98ac
// effect formulas and parameter schema (FX Amount / detail / hue / mirror) are
// preserved; the effect blend is biased so the camera image stays dominant and
// the band response is deliberately subtle — a shimmer on top of the picture,
// not a replacement. ProgramRuntime owns the source-mode capture lease; FX
// mode borrows the graph's current image canvas instead of opening a camera.
import { AUDIO_SHADER_HEADER, FULLSCREEN_VERT } from '../shader-utils.js';
import { BAND_PARAMS, bounded } from '../band-reactive.js';
import { FEATURE_SCHEMA } from '../feature-controls.js';
import { createExpansionController, makeExpansionReader } from './runtime.js';

const HEADER = `${AUDIO_SHADER_HEADER}
  uniform sampler2D uTex;
  uniform vec2 uCover;
  uniform vec2 uTexel;
  uniform float uMirror;
  uniform float uFxMode;
  uniform float uAmount;
  uniform float uDetail;
  uniform float uHue;
  uniform float uPhase;
  vec4 cameraAt(vec2 uv) {
    uv = 0.5 + (uv - 0.5) * uCover;
    // Preserve the selfie mirror only for the camera. Graph images have their
    // own orientation; both video and canvas uploads need a Y flip in p5 GL.
    if (uFxMode < 0.5 && uMirror > 0.5) uv.x = 1.0 - uv.x;
    uv.y = 1.0 - uv.y;
    vec4 texel = texture2D(uTex, clamp(uv, 0.001, 0.999));
    // Canvas uploads are premultiplied. Recover straight RGB before applying
    // luma/colour effects, but carry the incoming alpha through the FX output.
    return uFxMode > 0.5 ? vec4(texel.rgb / max(texel.a, 0.00001), texel.a)
                         : vec4(texel.rgb, 1.0);
  }
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  vec3 tint(float shift, float value) {
    return hsv2rgb(vec3(fract(uHue + shift + uHigh * 0.06), 0.9, value));
  }
`;

const LOOKS = [
  {
    id: 'video-edge-glow', name: 'Video Edge Glow', detail: 'Edge Width',
    description: 'Restored legacy neon camera contours, kept subtle: bass thickens edges slightly, mids raise edge contrast, highs drift the neon tint. The camera image stays dominant.',
    body: `
      vec2 uv = vTexCoord;
      vec2 fitUv = 0.5 + (uv - 0.5) * uCover;
      if (uFxMode > 0.5 && (any(lessThan(fitUv, vec2(0.0))) || any(greaterThan(fitUv, vec2(1.0))))) {
        gl_FragColor = vec4(0.0);
        return;
      }
      vec2 d = uTexel * uDetail * (1.0 + uSub * 0.45);
      float gx = luma(cameraAt(uv + vec2(d.x, 0.0)).rgb) - luma(cameraAt(uv - vec2(d.x, 0.0)).rgb);
      float gy = luma(cameraAt(uv + vec2(0.0, d.y)).rgb) - luma(cameraAt(uv - vec2(0.0, d.y)).rgb);
      float edge = clamp(length(vec2(gx, gy)) * (2.6 + uMid * 2.2), 0.0, 1.0);
      vec4 sampleColor = cameraAt(uv);
      vec3 raw = sampleColor.rgb;
      vec3 glow = raw * 0.35 + tint(0.0, edge) * 1.25;
      gl_FragColor = vec4(mix(raw, glow, uAmount * (0.2 + edge * 0.8)), sampleColor.a);
    `,
  },
  {
    id: 'video-thermal', name: 'Video Thermal', detail: 'Thermal Bands',
    description: 'Restored legacy false-color heat vision (not a heat sensor), kept subtle: bass shifts levels gently, mids posterize the bands, highs rotate the palette. The camera image stays readable.',
    body: `
      vec2 fitUv = 0.5 + (vTexCoord - 0.5) * uCover;
      if (uFxMode > 0.5 && (any(lessThan(fitUv, vec2(0.0))) || any(greaterThan(fitUv, vec2(1.0))))) {
        gl_FragColor = vec4(0.0);
        return;
      }
      vec4 sampleColor = cameraAt(vTexCoord);
      vec3 raw = sampleColor.rgb;
      float value = clamp((luma(raw) - 0.5) * (1.15 + uMid * 0.75) + 0.5 + uSub * 0.12, 0.0, 1.0);
      float levels = max(3.0, uDetail * 2.0);
      value = floor(value * levels + 0.5) / levels;
      vec3 heat = tint((1.0 - value) * 0.7, 0.25 + value * 0.85);
      gl_FragColor = vec4(mix(raw, heat, uAmount * 0.7), sampleColor.a);
    `,
  },
];

function restoredCameraFactory(body) {
  const fragment = `${HEADER}\nvoid main() {\n${body}\n}`;
  return (audio, videoDeviceId, params = {}, runtimeContext = {}) => (p) => {
    let capture, effect, texImage;
    let ready = false;
    let phase = 0;
    const fxMode = runtimeContext.inputMode === 'fx';
    const readBands = makeExpansionReader(audio, params, runtimeContext);
    p.setup = () => {
      p.pixelDensity(1);
      p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
      p.noStroke();
      effect = p.createShader(FULLSCREEN_VERT, fragment);
      // A graph FX only borrows a canvas during draw; never enter either the
      // shared-camera lease or p.createCapture fallback in this mode.
      if (fxMode) return;
      const constraints = {
        video: {
          ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}),
          width: { ideal: 640 }, height: { ideal: 480 },
        },
        audio: false,
      };
      const onReady = () => {
        ready = true;
        runtimeContext.reportMediaReady?.();
      };
      capture = runtimeContext.createCapture
        ? runtimeContext.createCapture(p, constraints, onReady)
        : p.createCapture(constraints, onReady);
      capture.hide();
    };
    p.draw = () => {
      const dt = bounded(p.deltaTime / 1000, 1 / 60, 0, 0.1);
      // Consume controls even while waiting for video so CUE revision tracking
      // works, but readiness still requires a real camera frame below.
      const C = readBands(dt);
      phase = (phase + dt) % 10000;
      if (fxMode) p.clear();
      else p.background(0);
      let tex, width, height;
      if (fxMode) {
        // Borrow only the current frame. Its canvas object can stay identical
        // across ticks; binding it each draw makes the core re-upload its pixels.
        const frame = runtimeContext.getImageInput?.();
        if (!frame?.source || !Number.isFinite(frame.width) || !Number.isFinite(frame.height)
          || frame.width <= 0 || frame.height <= 0
          || frame.source.width !== frame.width || frame.source.height !== frame.height) return;
        ({ width, height } = frame);
        tex = frame.source;
      } else {
        const video = capture?.elt;
        if (!ready || !video || video.readyState < 2 || !video.videoWidth) return;
        width = video.videoWidth;
        height = video.videoHeight;
        // Real captures (p5.MediaElement) upload straight to the sampler;
        // canvas sources (deterministic camera fixtures) use a p5.Image.
        tex = capture;
        if (typeof HTMLCanvasElement !== 'undefined' && video instanceof HTMLCanvasElement) {
          if (!texImage || texImage.width !== width || texImage.height !== height)
            texImage = p.createImage(width, height);
          texImage.drawingContext.drawImage(video, 0, 0, width, height);
          tex = texImage;
        }
      }
      const aspect = p.width / Math.max(1, p.height);
      const sourceAspect = width / height;
      // Camera: unchanged cover crop. FX: contain the entire graph image with
      // transparent bars rather than cropping or stretching it.
      const fit = fxMode
        ? (aspect > sourceAspect ? [aspect / sourceAspect, 1] : [1, sourceAspect / aspect])
        : (aspect > sourceAspect ? [1, sourceAspect / aspect] : [aspect / sourceAspect, 1]);
      p.shader(effect);
      effect.setUniform('uTex', tex);
      effect.setUniform('uResolution', [p.width, p.height]);
      effect.setUniform('uCover', fit);
      effect.setUniform('uTexel', [1 / (width * fit[0]), 1 / (height * fit[1])]);
      effect.setUniform('uFxMode', fxMode ? 1 : 0);
      effect.setUniform('uSub', C.bass * 0.6);   // subtle by design: dampened band gains
      effect.setUniform('uMid', C.mid * 0.6);
      effect.setUniform('uHigh', C.high * 0.6);
      effect.setUniform('uPhase', phase);
      effect.setUniform('uMirror', bounded(params.mirror, 1, 0, 1));
      effect.setUniform('uAmount', bounded(params.amount, 0.5, 0, 1));
      effect.setUniform('uDetail', bounded(params.detail, 4, 1, 12));
      effect.setUniform('uHue', bounded(params.hue, 0.52, 0, 1));
      p.rect(0, 0, p.width, p.height);
    };
    p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
    p.mousePressed = () => audio?.resume?.(true);
    const remove = p.remove.bind(p);
    p.remove = (...args) => { texImage = null; return remove(...args); };
  };
}

// Exact prior ids/names/labels; amount default lowered to 0.5 so the restored
// looks open tastefully. Band sliders stay independent: zero disables that
// band's contribution exactly.
export const RESTORED_CAMERA_PATTERNS = LOOKS.map(({ id, name, description, detail, body }) => ({
  id, name, description, group: 'Video FX', camera: true,
  fx: { input: 'image' },
  factory: restoredCameraFactory(body),
  audioReactive: true,
  audioTransport: 'pattern-controls',
  audioControlSchema: FEATURE_SCHEMA,
  createAudioController: createExpansionController,
  params: [
    { key: 'amount', label: 'FX Amount', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'detail', label: detail, min: 1, max: 12, step: 1, default: 4 },
    { key: 'hue', label: 'Tint / Prism Hue', min: 0, max: 1, step: 0.01, default: 0.52 },
    { key: 'mirror', label: 'Mirror Camera', min: 0, max: 1, step: 1, default: 1 },
    ...BAND_PARAMS,
  ],
}));
