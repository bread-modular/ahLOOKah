// Canvas2D renderer for the focused core: style state, transforms, shapes,
// text, image/tint handling and the density contract.
//
// Density contract (verified against p5 2.3.x and pinned by
// tests/core-canvas2d-contract.spec.js):
//   * default density = ceil(devicePixelRatio); pixelDensity(v) resizes the
//     backing store and keeps `width`/`height` logical.
//   * resetMatrix() = setTransform(1,0,0,1,0,0) followed by scale(density) so
//     logical drawing coordinates always cover the whole backing store and
//     ctx.getTransform().a === density.
//   * canvas backing = logical * density, canvas inline CSS = logical px.
//   * styles (fill/stroke/blend/tint/text) persist between frames; only the
//     transform is reset at the start of every draw.

import { BLEND, CORNER, MULTIPLY } from './constants.js';
import { VizColor } from './color.js';
import { VizImage, resolveSource } from './media.js';

const TAU = Math.PI * 2;

export function defaultDensity() {
  return typeof window !== 'undefined' && window.devicePixelRatio
    ? Math.ceil(window.devicePixelRatio)
    : 1;
}

export class Renderer2D {
  constructor({ pInst, canvas = null, width = 100, height = 100, density = null, main = true }) {
    this._pInst = pInst;
    this._isMainCanvas = main;
    this.isP3D = false;
    this.canvas = canvas || document.createElement('canvas');
    this._pixelDensity = density ?? (main ? defaultDensity() : (pInst?._pixelDensity || defaultDensity()));
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.drawingContext = this.canvas.getContext('2d');

    this._doFill = true;
    this._doStroke = true;
    this._fillColor = new VizColor(255, 255, 255, 255);
    this._strokeColor = new VizColor(0, 0, 0, 255);
    this._strokeWeight = 1;
    this._tint = null;
    this._blendMode = BLEND;
    this._textAlignH = 'left';
    this._textAlignV = 'alphabetic';
    this._textSize = 12;
    this._textFont = 'sans-serif';
    this._textStyle = 'normal';
    this._imageMode = CORNER;
    this._rectMode = CORNER;
    this._ellipseMode = 'center';
    this._pushStack = [];
    this._shapePoints = null;
    this._shapeClosed = false;
    this._snapshot = null;
    this.pixels = null;

    this.resize(this.width, this.height);
  }

  // ---------------------------------------------------------------- lifecycle
  resize(width, height) {
    const w = Math.max(1, Math.round(Number(width) || 1));
    const h = Math.max(1, Math.round(Number(height) || 1));
    this.width = w;
    this.height = h;
    this.canvas.width = Math.max(1, Math.floor(w * this._pixelDensity));
    this.canvas.height = Math.max(1, Math.floor(h * this._pixelDensity));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.drawingContext = this.canvas.getContext('2d');
    this.resetMatrix();
    this._applyStyle();
    return this;
  }

  pixelDensity(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      if (value !== this._pixelDensity) {
        this._pixelDensity = value;
        this.resize(this.width, this.height);
      }
      return this;
    }
    return this._pixelDensity;
  }

  /** Release any unbalanced push() and restore the density transform. */
  resetFrame() {
    while (this._pushStack.length) this.pop();
    this._shapePoints = null;
    this.resetMatrix();
    this._applyStyle();
  }

  resetMatrix() {
    const ctx = this.drawingContext;
    if (!ctx) return this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(this._pixelDensity, this._pixelDensity);
    return this;
  }

  remove() {
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  finishDraw() { return Promise.resolve(); }

  // ------------------------------------------------------------------- styles
  _applyStyle() {
    const ctx = this.drawingContext;
    if (!ctx) return;
    ctx.globalCompositeOperation = this._blendMode;
    if (this._fillColor) ctx.fillStyle = this._fillColor.css();
    if (this._strokeColor) ctx.strokeStyle = this._strokeColor.css();
    ctx.lineWidth = this._strokeWeight;
  }

  fill(color) {
    this._doFill = true;
    this._fillColor = color;
    return this;
  }

  noFill() {
    this._doFill = false;
    return this;
  }

  stroke(color) {
    this._doStroke = true;
    this._strokeColor = color;
    return this;
  }

  noStroke() {
    this._doStroke = false;
    return this;
  }

  strokeWeight(weight) {
    this._strokeWeight = Number(weight) || 0;
    return this;
  }

  blendMode(mode) {
    this._blendMode = mode || BLEND;
    // Apply immediately, as p5 does. background() and direct context drawing
    // do not pass through _applyStyle(); deferring this leaves last frame's
    // ADD active even after an explicit BLEND, so black cannot erase/fade it.
    this.drawingContext.globalCompositeOperation = this._blendMode;
    return this;
  }

  tint(color) {
    this._tint = color || null;
    return this;
  }

  noTint() {
    this._tint = null;
    return this;
  }

  textAlign(horizontal, vertical) {
    if (horizontal) this._textAlignH = horizontal;
    if (vertical) this._textAlignV = vertical;
    return this;
  }

  textSize(size) {
    this._textSize = Number(size) || 0;
    return this;
  }

  textFont(font, size) {
    if (typeof font === 'string') this._textFont = font;
    else if (font) this._textFont = font.family || String(font);
    if (size !== undefined) this._textSize = Number(size) || 0;
    return this;
  }

  textStyle(style) {
    this._textStyle = style === 'normal' ? 'normal' : style;
    return this;
  }

  imageMode(mode) { this._imageMode = mode || CORNER; return this; }

  rectMode(mode) { this._rectMode = mode || CORNER; return this; }

  ellipseMode(mode) { this._ellipseMode = mode || 'center'; return this; }

  // -------------------------------------------------------------- transform
  push() {
    this._pushStack.push({
      _doFill: this._doFill,
      _doStroke: this._doStroke,
      _fillColor: this._fillColor,
      _strokeColor: this._strokeColor,
      _strokeWeight: this._strokeWeight,
      _tint: this._tint,
      _blendMode: this._blendMode,
      _textAlignH: this._textAlignH,
      _textAlignV: this._textAlignV,
      _textSize: this._textSize,
      _textFont: this._textFont,
      _textStyle: this._textStyle,
      _imageMode: this._imageMode,
      _rectMode: this._rectMode,
      _ellipseMode: this._ellipseMode,
    });
    this.drawingContext.save();
    return this;
  }

  pop() {
    const state = this._pushStack.pop();
    if (!state) return this;
    this.drawingContext.restore();
    Object.assign(this, state);
    this._applyStyle();
    return this;
  }

  translate(x, y = 0) { this.drawingContext.translate(x, y); return this; }

  rotate(angle) { this.drawingContext.rotate(angle); return this; }

  scale(x, y = x) { this.drawingContext.scale(x, y); return this; }

  applyMatrix(a, b, c, d, e, f) { this.drawingContext.transform(a, b, c, d, e, f); return this; }

  // ------------------------------------------------------------------ output
  clear() {
    const ctx = this.drawingContext;
    ctx.save();
    this.resetMatrix();
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.restore();
    return this;
  }

  background(color) {
    const ctx = this.drawingContext;
    if (!ctx) return this;
    ctx.save();
    this.resetMatrix();
    ctx.fillStyle = color ? color.css() : 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
    return this;
  }

  // ------------------------------------------------------------------ shapes
  _rectCoords(x, y, w, h) {
    if (this._rectMode === 'center') return [x - w / 2, y - h / 2, w, h];
    if (this._rectMode === 'radius') return [x - w, y - h, w * 2, h * 2];
    return [x, y, w, h];
  }

  rect(x, y, w, h) {
    const [rx, ry, rw, rh] = this._rectCoords(x, y, w, h);
    const ctx = this.drawingContext;
    this._applyStyle();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    if (this._doFill) ctx.fill();
    if (this._doStroke) ctx.stroke();
    return this;
  }

  _ellipseArgs(x, y, w, h) {
    if (this._ellipseMode === 'corner') return [x + w / 2, y + h / 2, w / 2, h / 2];
    if (this._ellipseMode === 'corners') return [(x + w) / 2, (y + h) / 2, Math.abs(w - x) / 2, Math.abs(h - y) / 2];
    if (this._ellipseMode === 'radius') return [x, y, w, h];
    return [x, y, w / 2, h / 2];
  }

  ellipse(x, y, w, h = w) {
    const [cx, cy, rx, ry] = this._ellipseArgs(x, y, w, h);
    const ctx = this.drawingContext;
    if (rx <= 0 || ry <= 0) return this;
    this._applyStyle();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    if (this._doFill) ctx.fill();
    if (this._doStroke) ctx.stroke();
    return this;
  }

  circle(x, y, d) {
    return this.ellipse(x, y, d, d);
  }

  line(x1, y1, x2, y2) {
    const ctx = this.drawingContext;
    if (!this._doStroke) return this;
    this._applyStyle();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    return this;
  }

  triangle(x1, y1, x2, y2, x3, y3) {
    const ctx = this.drawingContext;
    this._applyStyle();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.closePath();
    if (this._doFill) ctx.fill();
    if (this._doStroke) ctx.stroke();
    return this;
  }

  beginShape() {
    this._shapePoints = [];
    return this;
  }

  vertex(x, y) {
    if (!this._shapePoints) this._shapePoints = [];
    this._shapePoints.push([x, y]);
    return this;
  }

  endShape(mode) {
    const points = this._shapePoints || [];
    this._shapePoints = null;
    if (points.length < 2) return this;
    const ctx = this.drawingContext;
    this._applyStyle();
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
    if (mode === 'close') ctx.closePath();
    if (this._doFill) ctx.fill();
    if (this._doStroke) ctx.stroke();
    return this;
  }

  // -------------------------------------------------------------------- text
  text(value, x, y) {
    const ctx = this.drawingContext;
    const str = value === undefined || value === null ? '' : String(value);
    if (!str) return this;
    // Text honours the current transform (p5 does not reset it here).
    ctx.font = `${this._textStyle} ${this._textSize}px ${this._textFont}`;
    ctx.textAlign = this._textAlignH;
    ctx.textBaseline = this._textAlignV;
    ctx.globalCompositeOperation = this._blendMode;
    if (this._doFill && this._fillColor) {
      ctx.fillStyle = this._fillColor.css();
      ctx.fillText(str, x, y);
    }
    if (this._doStroke && this._strokeColor) {
      ctx.strokeStyle = this._strokeColor.css();
      ctx.lineWidth = this._strokeWeight;
      ctx.strokeText(str, x, y);
    }
    return this;
  }

  // ------------------------------------------------------------------- image
  /** p5-compatible tint: multiply the RGB channels and restore alpha. */
  _tintedImageCanvas(img) {
    const source = img?.canvas;
    if (!source) return null;
    if (!img.tintCanvas) img.tintCanvas = document.createElement('canvas');
    if (img.tintCanvas.width !== source.width) img.tintCanvas.width = source.width;
    if (img.tintCanvas.height !== source.height) img.tintCanvas.height = source.height;
    const ctx = img.tintCanvas.getContext('2d');
    const tint = this._tint || new VizColor(255, 255, 255, 255);
    ctx.save();
    ctx.clearRect(0, 0, source.width, source.height);
    if (tint.r < 255 || tint.g < 255 || tint.b < 255) {
      ctx.drawImage(source, 0, 0);
      ctx.globalCompositeOperation = 'luminosity';
      ctx.drawImage(source, 0, 0);
      ctx.globalCompositeOperation = 'color';
      ctx.drawImage(source, 0, 0);
      ctx.globalCompositeOperation = MULTIPLY;
      ctx.fillStyle = `rgb(${Math.round(tint.r)}, ${Math.round(tint.g)}, ${Math.round(tint.b)})`;
      ctx.fillRect(0, 0, source.width, source.height);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.globalAlpha = tint.a / 255;
      ctx.drawImage(source, 0, 0);
    } else {
      ctx.globalAlpha = tint.a / 255;
      ctx.drawImage(source, 0, 0);
    }
    ctx.restore();
    return img.tintCanvas;
  }

  image(img, x, y, w, h) {
    if (!img) return this;
    if (img._ensureCanvas) img._ensureCanvas();
    let source = resolveSource(img);
    if (!source) return this;
    if (this._tint && img && img.canvas) {
      const tinted = this._tintedImageCanvas(img);
      if (tinted) source = tinted;
    }
    const sourceWidth = img.width ?? source.width ?? 0;
    const sourceHeight = img.height ?? source.height ?? 0;
    const dw = w === undefined ? sourceWidth : w;
    const dh = h === undefined ? sourceHeight : h;
    if (!dw || !dh) return this;
    try {
      this.drawingContext.drawImage(
        source,
        0,
        0,
        source.width || sourceWidth,
        source.height || sourceHeight,
        x,
        y,
        dw,
        dh,
      );
    } catch {
      // A media element that is not yet decodable simply produces no pixels.
    }
    return this;
  }

  get(x = 0, y = 0, w = this.width, h = this.height) {
    const d = this._pixelDensity;
    const out = new VizImage(w, h);
    out.drawingContext.drawImage(
      this.canvas,
      Math.round(x * d),
      Math.round(y * d),
      Math.round(w * d),
      Math.round(h * d),
      0,
      0,
      Math.round(w),
      Math.round(h),
    );
    return out;
  }

  /**
   * p5's copy() semantics (source rect in logical units, destination in the
   * current transform). The source region is snapshotted first so overlapping
   * self-copies cannot read partially overwritten pixels.
   */
  copy(sx, sy, sw, sh, dx, dy, dw = sw, dh = sh) {
    const d = this._pixelDensity;
    if (!this._snapshot) this._snapshot = document.createElement('canvas');
    const snap = this._snapshot;
    const pw = Math.max(1, Math.round(sw * d));
    const ph = Math.max(1, Math.round(sh * d));
    if (snap.width !== pw || snap.height !== ph) {
      snap.width = pw;
      snap.height = ph;
    }
    const sctx = snap.getContext('2d');
    sctx.clearRect(0, 0, pw, ph);
    sctx.drawImage(this.canvas, Math.round(sx * d), Math.round(sy * d), pw, ph, 0, 0, pw, ph);
    this.drawingContext.drawImage(snap, 0, 0, pw, ph, dx, dy, dw, dh);
    return this;
  }
}
