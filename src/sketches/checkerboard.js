// Checkerboard is intentionally NOT audio reactive. Keep its compact parameter
// controller for the existing CUE/TAKE protocol, but never inspect audio. The
// Canvas2D renderer caches a tiny repeat tile and skips unchanged static frames.
import { bounded } from './band-reactive.js';

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    uHueA: { min: 0, max: 1, neutral: 0.58 },
    uHueB: { min: 0, max: 1, neutral: 0.08 },
    uCell: { min: 4, max: 400, neutral: 48 },
    uPhase: { min: -1_000_000, max: 1_000_000, neutral: 0 },
  },
  arrays: {}, events: {},
  neutral: { continuous: { uHueA: 0.58, uHueB: 0.08, uCell: 48, uPhase: 0 } },
});

export function createAudioController() {
  let phase = 0;
  return {
    update({ params = {}, deltaSeconds = 1 / 30 }) {
      phase += bounded(params.speed, 0, 0, 3) * bounded(deltaSeconds, 1 / 30, 0, 0.1) * 60;
      if (phase > 900_000) phase %= 100_000;
      return {
        continuous: {
          uHueA: bounded(params.hueA, 0.58, 0, 1),
          uHueB: bounded(params.hueB, 0.08, 0, 1),
          uCell: bounded(params.cell, 48, 4, 400),
          uPhase: phase,
        },
        arrays: {}, events: [],
      };
    },
    dispose() {},
  };
}

export default (_audio, _videoDeviceId, params = {}, runtimeContext = {}) => (p) => {
  let phase = 0;
  let tile, pattern, tileKey, drawKey;
  p.setup = () => {
    p.pixelDensity(1);
    p.createCanvas(p.windowWidth, p.windowHeight);
    tile = document.createElement('canvas');
  };
  p.draw = () => {
    // Read once for the program's consumed-revision barrier, not for animation.
    // Local parameter values deliberately survive audio loss / neutral decay.
    runtimeContext.audioControls?.read();
    const cell = Math.round(bounded(params.cell, 48, 12, 160));
    const speed = bounded(params.speed, 0, 0, 3);
    phase = (phase + speed * bounded(p.deltaTime / 1000, 1 / 60, 0, 0.1) * 60) % (cell * 4);
    const sat = bounded(params.saturation, 0, 0, 1) * 100;
    const colorA = `hsl(${bounded(params.hueA, 0.58, 0, 1) * 360} ${sat}% ${bounded(params.brightnessA, 1, 0, 1) * 100}%)`;
    const colorB = `hsl(${bounded(params.hueB, 0.08, 0, 1) * 360} ${sat}% ${bounded(params.brightnessB, 0, 0, 1) * 100}%)`;
    const nextTile = `${cell}:${colorA}:${colorB}`;
    const ctx = p.drawingContext;
    if (tileKey !== nextTile) {
      tile.width = tile.height = cell * 2;
      const t = tile.getContext('2d');
      t.fillStyle = colorA;
      t.fillRect(0, 0, cell * 2, cell * 2);
      t.fillStyle = colorB;
      t.fillRect(cell, 0, cell, cell);
      t.fillRect(0, cell, cell, cell);
      pattern = ctx.createPattern(tile, 'repeat');
      tileKey = nextTile;
    }
    const nextDraw = `${tileKey}:${phase}:${p.width}:${p.height}`;
    if (drawKey === nextDraw) return;
    drawKey = nextDraw;
    ctx.save();
    const x = -(phase % (cell * 2)), y = -((phase * 0.5) % (cell * 2));
    ctx.translate(x, y);
    ctx.fillStyle = pattern;
    ctx.fillRect(-x, -y, p.width, p.height);
    ctx.restore();
  };
  p.windowResized = () => {
    drawKey = null;
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };
};
