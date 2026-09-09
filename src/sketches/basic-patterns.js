// Bounded Canvas2D primitives: no pixel readback, offscreen buffers, shaders,
// particles or shadows. Density is capped independent of screen resolution.
import { BAND_PARAMS, bounded, makeBandReader, reactiveEntry } from './band-reactive.js';

const TAU = Math.PI * 2;
const PARAMS = [
  { key: 'density', label: 'Shape Count / Density', min: 4, max: 32, step: 1, default: 12 },
  { key: 'size', label: 'Shape Size', min: 0.1, max: 1, step: 0.025, default: 0.45 },
  { key: 'speed', label: 'Motion Speed', min: 0, max: 3, step: 0.05, default: 0.6 },
  { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.01, default: 0.53 },
  ...BAND_PARAMS,
];

const looks = [
  ['dot-grid', 'Dot Grid', 'A field of dots: bass grows dots, mids ripple the grid, highs brighten it.'],
  ['pulse-stripes', 'Pulse Stripes', 'Sliding stripes: bass widens them, mids bend their positions, highs shift color.'],
  ['cross-pulse', 'Cross Pulse', 'Rotating crosses: bass changes size, mids twist the grid, highs sharpen color.'],
  ['diamond-tiles', 'Diamond Tiles', 'Diamond tiles: bass expands them, mids ripple their size, highs light them up.'],
  ['radial-spokes', 'Radial Spokes', 'A rotating fan: bass extends rays, mids twist the fan, highs thicken the lines.'],
];

function basicFactory(kind) {
  return (audio, _videoDeviceId, params = {}, runtimeContext = {}) => (p) => {
    const readBands = makeBandReader(audio, params, runtimeContext);
    let phase = 0;
    p.setup = () => {
      p.pixelDensity(1);
      p.createCanvas(p.windowWidth, p.windowHeight);
    };
    p.draw = () => {
      const dt = bounded(p.deltaTime / 1000, 1 / 60, 0, 0.1);
      const C = readBands(dt);
      phase = (phase + dt * bounded(params.speed, 0.6, 0, 3)) % (TAU * 100);
      const count = Math.round(bounded(params.density, 12, 4, 32));
      const size = bounded(params.size, 0.45, 0.1, 1);
      const hue = (bounded(params.hue, 0.53, 0, 1) * 360 + C.high * 35) % 360;
      const ctx = p.drawingContext;
      const w = p.width, h = p.height;
      ctx.fillStyle = '#05070c';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = ctx.strokeStyle = `hsl(${hue} 90% ${Math.min(85, 55 + C.high * 12)}%)`;

      if (kind === 'pulse-stripes') {
        const step = w / count;
        const bar = step * Math.min(0.92, size * (1 + C.bass * 0.5));
        const offset = (phase * step * 0.6) % step;
        for (let i = -1; i <= count; i++) {
          const bend = Math.sin(i * 0.7 + phase) * C.mid * step * 0.2;
          ctx.fillRect(i * step + offset + bend, 0, bar, h);
        }
        return;
      }
      if (kind === 'radial-spokes') {
        const radius = Math.min(w, h) * 0.46;
        const inner = radius * 0.08;
        const outer = radius * Math.min(1, size + C.bass * 0.22);
        ctx.lineWidth = Math.max(1, radius * 0.012 * (1 + C.high));
        ctx.beginPath();
        for (let i = 0; i < count * 2; i++) {
          const a = i * TAU / (count * 2) + phase * 0.3 + C.mid * 0.3;
          const r = outer * (0.85 + 0.15 * Math.sin(i + phase));
          ctx.moveTo(w / 2 + Math.cos(a) * inner, h / 2 + Math.sin(a) * inner);
          ctx.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
        }
        ctx.stroke();
        return;
      }

      const cols = count;
      const rows = Math.max(1, Math.min(32, Math.round(count * h / Math.max(1, w))));
      const dx = w / cols, dy = h / rows;
      const unit = Math.min(dx, dy);
      const angle = phase * 0.35 + C.mid * 0.4;
      const sin = Math.sin(angle), cos = Math.cos(angle);
      ctx.lineWidth = Math.max(1, unit * 0.07 * (1 + C.high * 0.3));
      ctx.beginPath();
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const wave = Math.sin(x * 0.65 + y * 0.8 + phase * 2);
          const r = unit * 0.42 * Math.max(0.03, Math.min(1, size * (1 + C.bass * 0.65) + wave * C.mid * 0.07));
          const cx = (x + 0.5) * dx, cy = (y + 0.5) * dy;
          if (kind === 'dot-grid') {
            const radius = Math.max(0.5, r);
            ctx.moveTo(cx + radius, cy);
            ctx.arc(cx, cy, radius, 0, TAU);
          } else if (kind === 'diamond-tiles') {
            ctx.moveTo(cx, cy - r);
            ctx.lineTo(cx + r, cy);
            ctx.lineTo(cx, cy + r);
            ctx.lineTo(cx - r, cy);
            ctx.closePath();
          } else {
            ctx.moveTo(cx - cos * r, cy - sin * r);
            ctx.lineTo(cx + cos * r, cy + sin * r);
            ctx.moveTo(cx + sin * r, cy - cos * r);
            ctx.lineTo(cx - sin * r, cy + cos * r);
          }
        }
      }
      if (kind === 'cross-pulse') ctx.stroke();
      else ctx.fill();
    };
    p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
    p.mousePressed = () => audio?.resume?.(true);
  };
}

export const BASIC_PATTERNS = looks.map(([id, name, description]) => reactiveEntry({
  id, name, description, group: 'Simple', params: PARAMS, factory: basicFactory(id),
}));
