// Second wave of Basics building blocks: vignette framing, a two-tone split,
// a traveling light band, and graph-paper lines. Bounded Canvas2D only — no
// pixel readback, shaders, offscreen buffers, or unbounded loops. Every look
// stays visible in silence and wires bass/mid/high multiplicatively, so a
// band at 0 removes exactly its own contribution.
import { BAND_PARAMS, bounded, makeBandReader, reactiveEntry } from './band-reactive.js';

const TAU = Math.PI * 2;

function basicsFactory(kind) {
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
      phase = (phase + dt * bounded(params.speed, 0.4, 0, 3)) % (TAU * 100);
      const hue = bounded(params.hue, 0.6, 0, 1) * 360;
      const ctx = p.drawingContext;
      const w = p.width, h = p.height;
      const cx = w / 2, cy = h / 2;

      if (kind === 'vignette') {
        const strength = bounded(params.strength, 0.65, 0, 1);
        const size = bounded(params.size, 0.55, 0.1, 1);
        ctx.fillStyle = `hsl(${hue} 45% 11%)`;
        ctx.fillRect(0, 0, w, h);
        const driftX = Math.sin(phase * 0.7) * w * 0.03;
        const driftY = Math.cos(phase * 0.5) * h * 0.03;
        const open = Math.min(w, h) * 0.8 * size * (1 + C.bass * 0.25);
        const glow = ctx.createRadialGradient(cx + driftX, cy + driftY, 0, cx + driftX, cy + driftY, Math.max(1, open * 0.7));
        glow.addColorStop(0, `hsla(${hue} 60% 26% / 0.5)`);
        glow.addColorStop(1, 'hsla(0 0% 0% / 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
        const squeeze = 1 + C.mid * 0.3;
        const gradient = ctx.createRadialGradient(0, 0, open * 0.55, 0, 0, Math.max(1, open));
        gradient.addColorStop(0, 'rgba(0,0,0,0)');
        gradient.addColorStop(0.75, `hsla(${hue} 60% 4% / ${strength * 0.55})`);
        gradient.addColorStop(1, `hsla(${hue} 70% 3% / ${strength})`);
        ctx.save();
        ctx.translate(cx + driftX, cy + driftY);
        ctx.scale(squeeze, 1 / squeeze);
        ctx.fillStyle = gradient;
        ctx.fillRect(-w, -h, w * 2, h * 2);
        ctx.restore();
        if (C.high > 0) {
          ctx.strokeStyle = `hsla(${(hue + 180) % 360} 90% 60% / ${Math.min(1, C.high * 0.35)})`;
          ctx.lineWidth = Math.max(1, open * 0.02);
          ctx.beginPath();
          ctx.ellipse(cx + driftX, cy + driftY, open * 0.72 * squeeze, open * 0.72 / squeeze, 0, 0, TAU);
          ctx.stroke();
        }
        return;
      }

      if (kind === 'split-tone') {
        const soft = bounded(params.soft, 0.35, 0.05, 1);
        const angle = phase * 0.3 + C.mid * 0.5;
        const hueB = (hue + 180 + C.high * 40) % 360;
        const gradientA = ctx.createLinearGradient(0, 0, w, h);
        gradientA.addColorStop(0, `hsl(${hue} 70% ${16 + C.bass * 10}%)`);
        gradientA.addColorStop(1, `hsl(${hue} 70% 5%)`);
        ctx.fillStyle = gradientA;
        ctx.fillRect(0, 0, w, h);
        const reach = Math.hypot(w, h);
        const shift = C.bass * w * 0.08;
        const band = Math.max(1, soft * reach * 0.25);
        const gradientB = ctx.createLinearGradient(shift - band, 0, shift + band, 0);
        gradientB.addColorStop(0, `hsla(${hueB} 85% 60% / 0)`);
        gradientB.addColorStop(1, `hsla(${hueB} 85% 60% / 1)`);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.fillStyle = gradientB;
        ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
        ctx.restore();
        return;
      }

      if (kind === 'sweep-band') {
        const width = bounded(params.width, 0.4, 0.1, 1);
        ctx.fillStyle = `hsl(${hue} 50% 5%)`;
        ctx.fillRect(0, 0, w, h);
        const angle = -0.35 + Math.sin(phase * 0.2) * 0.2 + C.mid * 0.4;
        const pos = 0.5 + 0.45 * Math.sin(phase * 0.6);
        const half = Math.max(4, width * w * 0.25 * (1 + C.bass * 0.5));
        const reach = Math.hypot(w, h);
        const peak = Math.min(1, 0.5 + C.high * 0.4);
        const gradient = ctx.createLinearGradient(pos * w - half, 0, pos * w + half, 0);
        gradient.addColorStop(0, `hsla(${hue} 90% 65% / 0)`);
        gradient.addColorStop(0.5, `hsla(${hue} 90% 65% / ${peak})`);
        gradient.addColorStop(1, `hsla(${hue} 90% 65% / 0)`);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.translate(-cx, -cy);
        ctx.fillStyle = gradient;
        ctx.fillRect(-reach, -reach, reach * 2 + w, reach * 2 + h);
        ctx.restore();
        return;
      }

      // grid-lines: graph paper with glowing nodes.
      const cell = bounded(params.cell, 56, 16, 120);
      ctx.fillStyle = `hsl(${hue} 40% 6%)`;
      ctx.fillRect(0, 0, w, h);
      ctx.lineWidth = 1 + C.bass * 2;
      ctx.beginPath();
      for (let x = 0, i = 0; x <= w; x += cell, i++) {
        const sway = Math.sin(i * 0.7 + phase * 2) * C.mid * 4;
        ctx.moveTo(x + sway, 0);
        ctx.lineTo(x - sway, h);
      }
      for (let y = 0, i = 0; y <= h; y += cell, i++) {
        const sway = Math.sin(i * 0.7 + phase * 2 + 1.3) * C.mid * 4;
        ctx.moveTo(0, y + sway);
        ctx.lineTo(w, y - sway);
      }
      ctx.strokeStyle = `hsla(${hue} 70% 60% / 0.35)`;
      ctx.stroke();
      if (C.high > 0) {
        ctx.fillStyle = `hsla(${(hue + C.high * 30) % 360} 90% 70% / ${Math.min(1, C.high * 0.55)})`;
        const radius = 1.5 + C.high * 3;
        ctx.beginPath();
        for (let x = 0; x <= w; x += cell * 4) {
          for (let y = 0; y <= h; y += cell * 4) {
            ctx.moveTo(x + radius, y);
            ctx.arc(x, y, radius, 0, TAU);
          }
        }
        ctx.fill();
      }
    };
    p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
    p.mousePressed = () => audio?.resume?.(true);
  };
}

const LOOKS = [
  {
    id: 'vignette', name: 'Vignette',
    description: 'A soft dark frame: bass opens the center, mids squeeze the ellipse, highs trace a rim glow.',
    params: [
      { key: 'strength', label: 'Vignette Strength', min: 0, max: 1, step: 0.01, default: 0.65 },
      { key: 'size', label: 'Opening Size', min: 0.1, max: 1, step: 0.01, default: 0.55 },
      { key: 'speed', label: 'Drift Speed', min: 0, max: 3, step: 0.05, default: 0.4 },
      { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.01, default: 0.62 },
      ...BAND_PARAMS,
    ],
  },
  {
    id: 'split-tone', name: 'Split Tone',
    description: 'A two-tone diagonal split: bass slides the seam, mids tilt it, highs recolor the far side.',
    params: [
      { key: 'soft', label: 'Seam Softness', min: 0.05, max: 1, step: 0.01, default: 0.35 },
      { key: 'speed', label: 'Drift Speed', min: 0, max: 3, step: 0.05, default: 0.4 },
      { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.01, default: 0.58 },
      ...BAND_PARAMS,
    ],
  },
  {
    id: 'sweep-band', name: 'Sweep Band',
    description: 'A soft light band crossing a dark field: bass widens it, mids lean it, highs raise the peak.',
    params: [
      { key: 'width', label: 'Band Width', min: 0.1, max: 1, step: 0.01, default: 0.4 },
      { key: 'speed', label: 'Sweep Speed', min: 0, max: 3, step: 0.05, default: 0.6 },
      { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.01, default: 0.52 },
      ...BAND_PARAMS,
    ],
  },
  {
    id: 'grid-lines', name: 'Grid Lines',
    description: 'Graph-paper lines: bass thickens the rules, mids sway them, highs light the intersections.',
    params: [
      { key: 'cell', label: 'Cell Size', min: 16, max: 120, step: 1, default: 56 },
      { key: 'speed', label: 'Drift Speed', min: 0, max: 3, step: 0.05, default: 0.4 },
      { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.01, default: 0.55 },
      ...BAND_PARAMS,
    ],
  },
];

export const BASICS_PATTERNS = LOOKS.map(({ id, name, description, params }) => reactiveEntry({
  id, name, description, group: 'Basics', params, factory: basicsFactory(id),
}));
