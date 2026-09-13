// Offscreen 2D buffer (p5's createGraphics). Owns a detached canvas plus its own
// renderer and color state, and exposes the same drawing API as the main sketch
// so the glitch/gradient patterns keep working unchanged.

import { DEFAULT_COLOR_MAXES, RGB } from './constants.js';
import { installDrawingApi } from './api.js';
import { Renderer2D, defaultDensity } from './renderer-2d.js';

export class Graphics {
  constructor(pInst, width, height, density = null) {
    this._pInst = pInst || null;
    this.canvas = document.createElement('canvas');
    this._renderer = new Renderer2D({
      pInst,
      canvas: this.canvas,
      width,
      height,
      density: density ?? (pInst?._pixelDensity || defaultDensity()),
      main: false,
    });
    this._colorMode = pInst?._colorMode || RGB;
    this._colorMaxesByMode = {
      [RGB]: [...DEFAULT_COLOR_MAXES[RGB]],
      hsb: [...DEFAULT_COLOR_MAXES.hsb],
    };
    this._colorMaxes = this._colorMaxesByMode[this._colorMode];
    this._removed = false;
  }

  get width() { return this._renderer.width; }

  get height() { return this._renderer.height; }

  get drawingContext() { return this._renderer.drawingContext; }

  /** p5 Graphics exposes pixelDensity() as a method (getter when called bare). */
  pixelDensity(value) {
    return this._renderer.pixelDensity(value);
  }

  resize(width, height) {
    this._renderer.resize(width, height);
    return this;
  }

  remove() {
    this._removed = true;
    this._renderer.remove();
  }
}

installDrawingApi(Graphics.prototype);
