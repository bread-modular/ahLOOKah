// Replacement-only rendering helpers. No shared/older renderer behavior changes.
import { BAND_PARAMS, bounded, makeBandReader, makeBandShader, reactiveEntry } from '../band-reactive.js';
import { AUDIO_SHADER_HEADER } from '../shader-utils.js';

export const TAU = Math.PI * 2;
export const response = (x) => { x = bounded(x, 0, 0, 3.2); return x / (1 + x); };
export const color = (hue, light = 65, saturation = 85) => `hsl(${hue * 360} ${saturation}% ${light}%)`;
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
export function canvasFactory(draw) {
  return (audio, _device, params = {}, runtime = {}) => (p) => {
    let time = 0;
    const read = makeBandReader(audio, params, runtime);
    p.setup = () => { p.pixelDensity(1); p.createCanvas(p.windowWidth, p.windowHeight); };
    p.draw = () => {
      const dt = bounded(p.deltaTime / 1000, 1 / 60, 0, .1);
      time += dt * bounded(params.speed, .6, 0, 2);
      const c = read(dt), ctx = p.drawingContext;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#050811'; ctx.fillRect(0, 0, p.width, p.height);
      ctx.save(); ctx.translate(p.width / 2, p.height / 2); ctx.scale(p.height / 2, p.height / 2);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      draw(ctx, { t: time, b: response(c.bass), m: response(c.mid), h: response(c.high),
        aspect: p.width / Math.max(1, p.height), detail: bounded(params.detail, 1, .5, 2), hue: bounded(params.hue, .53, 0, 1) });
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
export function shaderFactory(source) {
  return (audio, _device, params = {}, runtime = {}) => makeBandShader(audio, params, `${HEADER}\n${source}`, (P, c) => ({
    uSub: response(c.bass), uMid: response(c.mid), uHigh: response(c.high),
    uSpeed: bounded(P.speed, .6, 0, 2), uDetail: bounded(P.detail, 1, .5, 2), uHue: bounded(P.hue, .53, 0, 1),
  }), runtime);
}
export function entry(id, name, group, description, factory, detailLabel, extra = {}) {
  return reactiveEntry({ id, name, group, description, factory, ...extra, params: [
    ...(detailLabel ? [{ key: 'detail', label: detailLabel, min: .5, max: 2, step: .05, default: 1 }] : []),
    { key: 'speed', label: 'Motion Speed', min: 0, max: 2, step: .05, default: .6 },
    ...(group === 'Alphas' || group === 'Video FX' ? [] : [{ key: 'hue', label: 'Palette Hue', min: 0, max: 1, step: .01, default: .53 }]),
    ...BAND_PARAMS,
  ] });
}
