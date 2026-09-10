// Expansion-only rendering helpers. Same proven transport architecture as the
// replacement wave (one band scan on the capture owner; renderers consume final
// controls), but fully self-contained: nothing imports from ../replacements/,
// and the controller factory has its own identity so existing provenance tests
// keep pinning exactly the 18 replacements to the shared band controller.
import { BAND_PARAMS, BAND_SCHEMA, bounded, makeBandReader, makeBandShader, responsiveBands } from '../band-reactive.js';
import { AUDIO_SHADER_HEADER } from '../shader-utils.js';

export const TAU = Math.PI * 2;

// Same bounded saturating response the replacement renderers use: 0.42 at
// modest real-world band levels (0.2 after the shared soft knee), 0.76 at the
// transport ceiling, so small signals already move structures.
export const response = (x) => { x = bounded(x, 0, 0, 3.2); return x / (1 + x); };

export const color = (hue, light = 65, saturation = 85, alpha = 1) =>
  alpha >= 1 ? `hsl(${hue * 360} ${saturation}% ${light}%)` : `hsl(${hue * 360} ${saturation}% ${light}% / ${alpha})`;

// Exact grayscale for the Alphas group (r=g=b by construction, opaque).
export const gray = (value, alpha = 1) => {
  const v = Math.round(bounded(value, 0, 0, 1) * 255);
  return alpha >= 1 ? `rgb(${v} ${v} ${v})` : `rgb(${v} ${v} ${v} / ${alpha})`;
};

// Deterministic per-index hash (sin-free would also do; this one is stable
// across frames so silent renders are bit-for-bit reproducible).
export const hash = (i, seed = 0) => {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453123;
  return x - Math.floor(x);
};

export function path(ctx, points, fill, stroke, width = .012) {
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  if (fill) { ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
}

export function circle(ctx, x, y, r, fill, stroke, width = .012) {
  ctx.beginPath(); ctx.arc(x, y, Math.max(.001, r), 0, TAU);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
}

// Every expansion pattern ships the final band controls on the capture owner.
// responsiveBands keeps the knee lift that makes modest analyzer levels
// structural, applies each slider AFTER shaping (zero is exactly silent), and
// never mixes bands, so mute/independence invariants hold by construction.
export function createExpansionController() {
  return {
    update({ shared, params = {} }) {
      return { continuous: responsiveBands(shared?.getFeatures?.(), params), arrays: {}, events: [] };
    },
    dispose() {},
  };
}

// Shared slider set: one pattern-specific "detail" control, autonomous motion
// speed, palette hue (skipped for Alphas/Video FX), then the three band gains.
export const expansionParams = (detailLabel, { hue = true } = {}) => [
  ...(detailLabel ? [{ key: 'detail', label: detailLabel, min: .5, max: 2, step: .05, default: 1 }] : []),
  { key: 'speed', label: 'Motion Speed', min: 0, max: 2, step: .05, default: .6 },
  ...(hue ? [{ key: 'hue', label: 'Palette Hue', min: 0, max: 1, step: .01, default: .53 }] : []),
  ...BAND_PARAMS,
];

export function expansionEntry({ id, name, group, description, factory, params, camera = false }) {
  return {
    id, name, group, factory, params, description,
    ...(camera ? { camera: true } : {}),
    audioReactive: true,
    audioTransport: 'pattern-controls',
    audioControlSchema: BAND_SCHEMA,
    createAudioController: createExpansionController,
  };
}

// Canvas scene in centered unit space (y ∈ [-1,1]); draw receives lifted,
// response-mapped bands b/m/h plus time and bounded params. Background is the
// shared deep stage blue unless a pattern needs pure black (Alphas).
export function canvasFactory(draw, { background = '#050811' } = {}) {
  return (audio, _device, params = {}, runtime = {}) => (p) => {
    let time = 0;
    const read = makeBandReader(audio, params, runtime);
    p.setup = () => { p.pixelDensity(1); p.createCanvas(p.windowWidth, p.windowHeight); };
    p.draw = () => {
      const dt = bounded(p.deltaTime / 1000, 1 / 60, 0, .1);
      time += dt * bounded(params.speed, .6, 0, 2);
      const c = read(dt), ctx = p.drawingContext;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = background; ctx.fillRect(0, 0, p.width, p.height);
      ctx.save(); ctx.translate(p.width / 2, p.height / 2); ctx.scale(p.height / 2, p.height / 2);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      draw(ctx, {
        t: time, b: response(c.bass), m: response(c.mid), h: response(c.high),
        aspect: p.width / Math.max(1, p.height),
        detail: bounded(params.detail, 1, .5, 2), hue: bounded(params.hue, .53, 0, 1),
      });
      ctx.restore();
    };
    p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
    p.mousePressed = () => audio?.resume?.(true);
  };
}

export const HEADER = `${AUDIO_SHADER_HEADER}
  uniform float uSpeed;
  uniform float uDetail;
  uniform float uHue;
  vec3 ink(float shift) { return hsv2rgb(vec3(fract(uHue + shift), .72, 1.0)); }
  float line(float distance, float width) { return 1.0 - smoothstep(width, width + .012, abs(distance)); }
`;

// Full-screen GPU looks read the same lifted band controls as the canvas
// scenes (uSub/uMid/uHigh are response-mapped by the factory).
export function shaderFactory(source) {
  return (audio, _device, params = {}, runtime = {}) => makeBandShader(audio, params, `${HEADER}\n${source}`, (P, c) => ({
    uSub: response(c.bass), uMid: response(c.mid), uHigh: response(c.high),
    uSpeed: bounded(P.speed, .6, 0, 2), uDetail: bounded(P.detail, 1, .5, 2), uHue: bounded(P.hue, .53, 0, 1),
  }), runtime);
}
