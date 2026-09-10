// Camera expansion: nine single-pass shaders, at most five texture samples per
// pixel. All use ProgramRuntime's shared camera lease for LIVE/CUE/mapping;
// no second microphone/camera, CPU pixel readback, or accumulating trail buffers.
import { AUDIO_SHADER_HEADER, FULLSCREEN_VERT } from './shader-utils.js';
import { BAND_PARAMS, bounded, makeBandReader, reactiveEntry } from './band-reactive.js';

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
    return hsv2rgb(vec3(fract(uHue + shift + uHigh * 0.08), 0.9, value));
  }
`;

const LOOKS = [
  {
    id: 'video-edge-glow', name: 'Video Edge Glow', detail: 'Edge Width',
    description: 'Neon camera contours: bass thickens edges, mids raise contrast, highs change neon color.',
    body: `
      vec2 uv = vTexCoord;
      vec2 d = uTexel * uDetail * (1.0 + uSub * 0.6);
      float gx = luma(cameraAt(uv + vec2(d.x, 0.0))) - luma(cameraAt(uv - vec2(d.x, 0.0)));
      float gy = luma(cameraAt(uv + vec2(0.0, d.y))) - luma(cameraAt(uv - vec2(0.0, d.y)));
      float edge = clamp(length(vec2(gx, gy)) * (3.0 + uMid * 3.0), 0.0, 1.0);
      vec3 col = cameraAt(uv) * (1.0 - uAmount * 0.85) + tint(0.0, edge) * uAmount;
      gl_FragColor = vec4(col, 1.0);
    `,
  },
  {
    id: 'video-thermal', name: 'Video Thermal', detail: 'Thermal Bands',
    description: 'False-color heat vision (not a heat sensor): bass shifts levels, mids posterize, highs rotate color.',
    body: `
      vec3 raw = cameraAt(vTexCoord);
      float value = clamp((luma(raw) - 0.5) * (1.2 + uMid * 0.6) + 0.5 + uSub * 0.12, 0.0, 1.0);
      float levels = max(2.0, uDetail * 2.0);
      value = floor(value * levels) / levels;
      vec3 heat = tint((1.0 - value) * 0.7, 0.2 + value * 0.9);
      gl_FragColor = vec4(mix(raw, heat, uAmount), 1.0);
    `,
  },
  {
    id: 'video-prism-split', name: 'Video Prism Split', detail: 'Prism Distance',
    description: 'Chromatic camera ghosts: bass separates channels, mids rotate their axis, highs widen blue fringes.',
    body: `
      float angle = uPhase * 0.4 + uMid * 2.0 + uHue * VIZ_TAU;
      vec2 axis = vec2(cos(angle), sin(angle));
      vec2 offset = axis * uDetail * 0.003 * uAmount * (1.0 + uSub * 3.0);
      vec3 c = cameraAt(vTexCoord);
      c.r = cameraAt(vTexCoord + offset).r;
      c.b = cameraAt(vTexCoord - offset * (1.0 + uHigh * 2.5)).b;
      gl_FragColor = vec4(c, 1.0);
    `,
  },
  {
    id: 'video-ripple-lens', name: 'Video Ripple Lens', detail: 'Ripple Frequency',
    description: 'Liquid lens ripples: bass pushes distortion, mids change wave shape, highs add prismatic highlights.',
    body: `
      vec2 aspect = vec2(uResolution.x / max(1.0, uResolution.y), 1.0);
      vec2 q = (vTexCoord - 0.5) * aspect;
      float r = length(q);
      float wave = sin(r * uDetail * 8.0 - uPhase * 4.0 + uMid * 3.0);
      vec2 direction = q / max(r, 0.001);
      vec2 uv = vTexCoord + direction / aspect * wave * uAmount * (0.012 + uSub * 0.025);
      vec3 col = cameraAt(uv);
      col += tint(0.25, 1.0) * uHigh * uAmount * pow(0.5 + wave * 0.5, 12.0) * 0.18;
      gl_FragColor = vec4(col, 1.0);
    `,
  },
  {
    id: 'video-mirror-tiles', name: 'Video Mirror Tiles', detail: 'Mirror Tiles',
    description: 'Mirrored camera wall: bass zooms each tile, mids rotate the wall, highs tint the reflections.',
    body: `
      vec2 aspect = vec2(uResolution.x / max(1.0, uResolution.y), 1.0);
      vec2 q = (vTexCoord - 0.5) * aspect;
      q = rotate2d(sin(uPhase * 0.4) * uAmount * 0.2 + uMid * uAmount * 0.2) * q;
      vec2 tile = abs(mod(q * max(1.0, floor(uDetail)) + 1.0, 2.0) - 1.0);
      vec2 uv = 0.5 + (tile - 0.5) / (1.0 + uSub * uAmount * 0.3);
      vec3 c = cameraAt(uv);
      c = mix(c, c * (tint(0.0, 1.0) + 0.4), min(0.8, uHigh * uAmount * 0.3));
      gl_FragColor = vec4(mix(cameraAt(vTexCoord), c, uAmount), 1.0);
    `,
  },
  // Second camera wave: print/signal looks, still one pass and few samples.
  {
    id: 'video-halftone', name: 'Video Halftone', detail: 'Dot Size',
    description: 'Newsprint dot screen: bass swells the dots, mids soften their edges, highs tint the print.',
    body: `
      float cellPx = max(2.0, 24.0 - uDetail * 1.8);
      vec2 grid = vTexCoord * uResolution / cellPx;
      vec2 cell = floor(grid);
      vec2 q = fract(grid) - 0.5;
      vec3 c = cameraAt((cell + 0.5) * cellPx / uResolution);
      float l = luma(c);
      float r = l * (0.55 + uSub * 0.25);
      float soft = 0.30 / (1.0 + uMid * 0.8);
      float dot2 = 1.0 - smoothstep(max(0.0, r - soft), r + soft, length(q));
      vec3 ink = mix(c, tint(0.0, 1.0), uAmount * 0.6);
      vec3 col = ink * dot2 * (0.4 + l) * (0.7 + uHigh * 0.5);
      gl_FragColor = vec4(mix(c, col, uAmount), 1.0);
    `,
  },
  {
    id: 'video-solarize', name: 'Video Solarize', detail: 'Solarize Pivot',
    description: 'Darkroom solarization: bass lifts the curves, mids pick the tone hue, highs rim the brightest bands.',
    body: `
      vec3 c = cameraAt(vTexCoord);
      float l = luma(c);
      float pivot = 0.28 + uDetail * 0.05;
      float curve = l < pivot ? l : mix(l, 1.0 - l, uAmount);
      float boost = 1.0 + uSub * 0.6;
      vec3 mapped = mix(c, tint(uMid * 0.2, clamp(curve * boost, 0.0, 1.0)), 0.85);
      vec3 col = mix(c, mapped, 0.35 + uAmount * 0.65);
      col += tint(0.5, 1.0) * uHigh * pow(curve, 12.0) * 0.4;
      gl_FragColor = vec4(col, 1.0);
    `,
  },
  {
    id: 'video-wave-warp', name: 'Video Wave Warp', detail: 'Wave Frequency',
    description: 'Liquid horizontal warp: bass pushes the swell, mids detune the wave, highs split color fringes.',
    body: `
      float amp = uAmount * (0.010 + uSub * 0.030);
      float wave = sin(vTexCoord.y * uDetail * 6.0 + uPhase * 3.0 + uMid * 2.0);
      vec2 uv = vTexCoord + vec2(wave * amp, 0.0);
      vec3 c = cameraAt(uv);
      float fringe = 0.004 * uAmount;
      c.r = cameraAt(uv + vec2(fringe, 0.0)).r;
      c.b = cameraAt(uv - vec2(fringe * (1.0 + uHigh), 0.0)).b;
      c *= 0.85 + 0.15 * wave * uAmount + uHigh * 0.10;
      gl_FragColor = vec4(c, 1.0);
    `,
  },
  {
    id: 'video-duotone', name: 'Video Duotone', detail: 'Tone Split',
    description: 'Two-tone poster light: bass lifts the shadows, mids move the split point, highs flare the highlights.',
    body: `
      vec3 c = cameraAt(vTexCoord);
      float l = luma(c);
      float split = clamp(0.30 + uDetail * 0.04 + uMid * 0.15, 0.0, 0.9);
      vec3 shadow = tint(0.55, 0.15 + uSub * 0.20);
      vec3 high = tint(0.0, 0.95);
      vec3 duo = mix(shadow, high, smoothstep(split - 0.25, split + 0.25, l));
      vec3 col = mix(c, duo, uAmount);
      col += high * uHigh * pow(l, 10.0) * 0.4;
      gl_FragColor = vec4(col, 1.0);
    `,
  },
];

function cameraFactory(body) {
  const fragment = `${HEADER}\nvoid main() {\n${body}\n}`;
  return (audio, videoDeviceId, params = {}, runtimeContext = {}) => (p) => {
    let capture, effect;
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
      phase = (phase + dt * bounded(params.speed, 0.6, 0, 3)) % 10000;
      p.background(0);
      const video = capture?.elt;
      if (!ready || !video || video.readyState < 2 || !video.videoWidth) return;
      const aspect = p.width / Math.max(1, p.height);
      const sourceAspect = video.videoWidth / Math.max(1, video.videoHeight);
      const cover = aspect > sourceAspect ? [1, sourceAspect / aspect] : [aspect / sourceAspect, 1];
      p.shader(effect);
      effect.setUniform('uTex', capture);
      effect.setUniform('uResolution', [p.width, p.height]);
      effect.setUniform('uCover', cover);
      effect.setUniform('uTexel', [1 / (video.videoWidth * cover[0]), 1 / (video.videoHeight * cover[1])]);
      effect.setUniform('uSub', C.bass);
      effect.setUniform('uMid', C.mid);
      effect.setUniform('uHigh', C.high);
      effect.setUniform('uPhase', phase);
      effect.setUniform('uMirror', bounded(params.mirror, 1, 0, 1));
      effect.setUniform('uAmount', bounded(params.amount, 0.8, 0, 1));
      effect.setUniform('uDetail', bounded(params.detail, 4, 1, 12));
      effect.setUniform('uHue', bounded(params.hue, 0.52, 0, 1));
      p.rect(0, 0, p.width, p.height);
    };
    p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
    p.mousePressed = () => audio?.resume?.(true);
  };
}

export const CAMERA_PATTERNS = LOOKS.map(({ id, name, description, detail, body }) => reactiveEntry({
  id, name, description, group: 'Video FX', camera: true, factory: cameraFactory(body),
  params: [
    { key: 'amount', label: 'FX Amount', min: 0, max: 1, step: 0.01, default: 0.8 },
    { key: 'detail', label: detail, min: 1, max: 12, step: 1, default: 4 },
    ...(['video-edge-glow', 'video-thermal', 'video-halftone', 'video-solarize', 'video-duotone'].includes(id) ? [] : [
      { key: 'speed', label: 'Motion Speed', min: 0, max: 3, step: 0.05, default: 0.6 },
    ]),
    { key: 'hue', label: 'Tint / Prism Hue', min: 0, max: 1, step: 0.01, default: 0.52 },
    { key: 'mirror', label: 'Mirror Camera', min: 0, max: 1, step: 1, default: 1 },
    ...BAND_PARAMS,
  ],
}));
