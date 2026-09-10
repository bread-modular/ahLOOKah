// Restored legacy camera looks: Video Thermal and Video Edge Glow, recovered
// from git history with their exact prior ids and names. The original 6fc98ac
// shader bodies and parameter schema (FX Amount / detail / hue / mirror) are
// preserved; the effect blend is biased so the camera image stays dominant and
// the band response is deliberately subtle — a shimmer on top of the picture,
// not a replacement. ProgramRuntime owns the capture lease.
import { AUDIO_SHADER_HEADER, FULLSCREEN_VERT } from '../shader-utils.js';
import { BAND_PARAMS, BAND_SCHEMA, bounded, makeBandReader } from '../band-reactive.js';
import { createExpansionController } from './runtime.js';

const HEADER = `${AUDIO_SHADER_HEADER}
  uniform sampler2D uTex;
  uniform vec2 uCover;
  uniform vec2 uTexel;
  uniform float uMirror;
  uniform float uAmount;
  uniform float uDetail;
  uniform float uHue;
  uniform float uPhase;
  vec3 cameraAt(vec2 uv) {
    uv = 0.5 + (uv - 0.5) * uCover;
    if (uMirror > 0.5) uv.x = 1.0 - uv.x;
    uv.y = 1.0 - uv.y;
    return texture2D(uTex, clamp(uv, 0.001, 0.999)).rgb;
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
      vec2 d = uTexel * uDetail * (1.0 + uSub * 0.45);
      float gx = luma(cameraAt(uv + vec2(d.x, 0.0))) - luma(cameraAt(uv - vec2(d.x, 0.0)));
      float gy = luma(cameraAt(uv + vec2(0.0, d.y))) - luma(cameraAt(uv - vec2(0.0, d.y)));
      float edge = clamp(length(vec2(gx, gy)) * (2.6 + uMid * 2.2), 0.0, 1.0);
      vec3 raw = cameraAt(uv);
      vec3 glow = raw * 0.35 + tint(0.0, edge) * 1.25;
      gl_FragColor = vec4(mix(raw, glow, uAmount * (0.2 + edge * 0.8)), 1.0);
    `,
  },
  {
    id: 'video-thermal', name: 'Video Thermal', detail: 'Thermal Bands',
    description: 'Restored legacy false-color heat vision (not a heat sensor), kept subtle: bass shifts levels gently, mids posterize the bands, highs rotate the palette. The camera image stays readable.',
    body: `
      vec3 raw = cameraAt(vTexCoord);
      float value = clamp((luma(raw) - 0.5) * (1.15 + uMid * 0.45) + 0.5 + uSub * 0.09, 0.0, 1.0);
      float levels = max(3.0, uDetail * 2.0);
      value = floor(value * levels + 0.5) / levels;
      vec3 heat = tint((1.0 - value) * 0.7, 0.25 + value * 0.85);
      gl_FragColor = vec4(mix(raw, heat, uAmount * 0.7), 1.0);
    `,
  },
];

function restoredCameraFactory(body) {
  const fragment = `${HEADER}\nvoid main() {\n${body}\n}`;
  return (audio, videoDeviceId, params = {}, runtimeContext = {}) => (p) => {
    let capture, effect, texImage;
    let ready = false;
    let phase = 0;
    const readBands = makeBandReader(audio, params, runtimeContext);
    p.setup = () => {
      p.pixelDensity(1);
      p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
      p.noStroke();
      effect = p.createShader(FULLSCREEN_VERT, fragment);
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
      p.background(0);
      const video = capture?.elt;
      if (!ready || !video || video.readyState < 2 || !video.videoWidth) return;
      const aspect = p.width / Math.max(1, p.height);
      const sourceAspect = video.videoWidth / Math.max(1, video.videoHeight);
      const cover = aspect > sourceAspect ? [1, sourceAspect / aspect] : [aspect / sourceAspect, 1];
      // Real captures (p5.MediaElement) upload straight to the sampler; plain
      // canvas sources (deterministic test fixtures) go through a p5.Image.
      let tex = capture;
      if (typeof HTMLCanvasElement !== 'undefined' && video instanceof HTMLCanvasElement) {
        if (!texImage) texImage = p.createImage(video.videoWidth || video.width, video.videoHeight || video.height);
        texImage.drawingContext.drawImage(video, 0, 0, texImage.width, texImage.height);
        tex = texImage;
      }
      p.shader(effect);
      effect.setUniform('uTex', tex);
      effect.setUniform('uResolution', [p.width, p.height]);
      effect.setUniform('uCover', cover);
      effect.setUniform('uTexel', [1 / (video.videoWidth * cover[0]), 1 / (video.videoHeight * cover[1])]);
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
  factory: restoredCameraFactory(body),
  audioReactive: true,
  audioTransport: 'pattern-controls',
  audioControlSchema: BAND_SCHEMA,
  createAudioController: createExpansionController,
  params: [
    { key: 'amount', label: 'FX Amount', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'detail', label: detail, min: 1, max: 12, step: 1, default: 4 },
    { key: 'hue', label: 'Tint / Prism Hue', min: 0, max: 1, step: 0.01, default: 0.52 },
    { key: 'mirror', label: 'Mirror Camera', min: 0, max: 1, step: 1, default: 1 },
    ...BAND_PARAMS,
  ],
}));
