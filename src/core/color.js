// Color state + p5-compatible color parsing (colorMode maxes, grayscale/alpha
// overloads, HSB -> RGB) for the focused core.
//
// The parsing rules mirror p5:
//   1 arg (number)  -> grayscale level in the current mode's first channel range
//   1 arg (string)  -> CSS color (parsed through a scratch 2D context)
//   2 args          -> RGB: (gray, alpha) | HSB: (hue, saturation)
//   3 args          -> RGB: (r, g, b)    | HSB: (hue, saturation, brightness)
//   4 args          -> same as 3 args + alpha
// Alpha is always scaled by the mode's alpha maximum (RGB default 255, HSB 1).

import { HSB, RGB, DEFAULT_COLOR_MAXES } from './constants.js';

let scratchContext = null;
function cssContext() {
  if (!scratchContext && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    scratchContext = canvas.getContext('2d');
  }
  return scratchContext;
}

function clampByte(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function hsbToRgb(hue, saturation, brightness) {
  const h = ((hue % 1) + 1) % 1;
  const s = saturation < 0 ? 0 : saturation > 1 ? 1 : saturation;
  const v = brightness < 0 ? 0 : brightness > 1 ? 1 : brightness;
  if (s === 0) return [v, v, v];
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

export function colorMaxesFor(mode, maxes) {
  const fallback = DEFAULT_COLOR_MAXES[mode] || DEFAULT_COLOR_MAXES[RGB];
  if (!Array.isArray(maxes)) return [...fallback];
  return [0, 1, 2, 3].map((i) => (Number.isFinite(maxes[i]) ? maxes[i] : fallback[i]));
}

function parseString(value) {
  const ctx = cssContext();
  if (ctx) {
    ctx.fillStyle = '#000';
    ctx.fillStyle = value;
    if (typeof ctx.fillStyle === 'string' && ctx.fillStyle !== '#000') {
      const resolved = ctx.fillStyle;
      if (resolved.startsWith('#')) {
        const hex = resolved.slice(1);
        return [
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16),
          255,
        ];
      }
      const match = resolved.match(/rgba?\(([^)]+)\)/i);
      if (match) {
        const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts.length > 3 ? (parts[3] * 255) : 255];
      }
    }
  }
  const named = { black: [0, 0, 0, 255], white: [255, 255, 255, 255], red: [255, 0, 0, 255], green: [0, 128, 0, 255], blue: [0, 0, 255, 255] };
  return named[String(value).toLowerCase()] || [0, 0, 0, 255];
}

/**
 * Parse p5-style color arguments into 0..255 RGBA channels.
 * @param {Array} args raw user arguments
 * @param {string} mode RGB or HSB
 * @param {Array} maxes active channel maxima ([h/r, s/g, b/b, alpha])
 */
export function parseColorArgs(args, mode = RGB, maxes = null) {
  const inArgs = Array.isArray(args) ? args : [args];
  const [max1, max2, max3, maxA] = colorMaxesFor(mode, maxes);
  const list = Array.isArray(inArgs[0]) ? inArgs[0] : inArgs;

  if (list.length === 1) {
    const only = list[0];
    if (typeof only === 'string') return parseString(only);
    const gray = clampByte((Number(only) || 0) / (max1 || 255) * 255);
    return [gray, gray, gray, 255];
  }

  const alpha = (value) => (value === undefined ? 255 : clampByte((Number(value) || 0) / (maxA || 255) * 255));

  if (mode === HSB) {
    let h; let s; let b; let a = 255;
    if (list.length === 2) { [h, s] = list; b = max3; a = 255; }
    else if (list.length === 3) { [h, s, b] = list; }
    else { [h, s, b, a] = list; a = alpha(a); }
    const rgb = hsbToRgb((Number(h) || 0) / (max1 || 360), (Number(s) || 0) / (max2 || 100), (Number(b) || 0) / (max3 || 100));
    return [clampByte(rgb[0] * 255), clampByte(rgb[1] * 255), clampByte(rgb[2] * 255), a];
  }

  if (list.length === 2) {
    const gray = clampByte((Number(list[0]) || 0) / (max1 || 255) * 255);
    return [gray, gray, gray, alpha(list[1])];
  }
  const scale = (value, max) => clampByte((Number(value) || 0) / (max || 255) * 255);
  return [
    scale(list[0], max1),
    scale(list[1], max2),
    scale(list[2], max3),
    list.length > 3 ? alpha(list[3]) : 255,
  ];
}

/** Immutable-ish RGBA color value with 0..255 channels. */
export class VizColor {
  constructor(r = 255, g = 255, b = 255, a = 255) {
    this.r = clampByte(r);
    this.g = clampByte(g);
    this.b = clampByte(b);
    this.a = clampByte(a);
    this._css = null;
  }

  get rgba() { return [this.r, this.g, this.b, this.a]; }

  /** 0..1 channels (used by the WebGL light/tint uniforms). */
  unit() { return [this.r / 255, this.g / 255, this.b / 255, this.a / 255]; }

  /** CSS string for the Canvas2D API. */
  css() {
    if (!this._css) {
      this._css = `rgba(${Math.round(this.r)},${Math.round(this.g)},${Math.round(this.b)},${this.a / 255})`;
    }
    return this._css;
  }

  toString() { return this.css(); }

  equals(other) {
    return Boolean(other)
      && other.r === this.r && other.g === this.g && other.b === this.b && other.a === this.a;
  }
}

export function colorFromArgs(args, mode, maxes) {
  if (args.length === 1 && args[0] instanceof VizColor) return args[0];
  const [r, g, b, a] = parseColorArgs(args, mode, maxes);
  return new VizColor(r, g, b, a);
}
