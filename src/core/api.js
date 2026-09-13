// The p5-style drawing API shared by the main sketch instance (VizCore) and by
// offscreen Graphics buffers. Every method only touches `this._renderer`,
// `this._colorMode` and `this._colorMaxes*`, so the same implementation works
// for both hosts.

import { DEFAULT_COLOR_MAXES, HSB, RGB } from './constants.js';
import { colorFromArgs } from './color.js';

function delegate(name) {
  return function delegated(...args) {
    const renderer = this._renderer;
    if (!renderer) return this;
    const fn = renderer[name];
    if (typeof fn !== 'function') return this;
    const result = fn.apply(renderer, args);
    // p5 methods return the sketch for chaining, but value-returning calls
    // (get(), and renderer getters) must pass their result through.
    return result === undefined ? this : result;
  };
}

export const drawingApiMethods = {
  // ------------------------------------------------------------------ color
  colorMode(mode, max1, max2, max3, maxA) {
    if (mode === undefined) return this._colorMode;
    if (mode !== RGB && mode !== HSB) return this._colorMode;
    this._colorMode = mode;
    const maxes = this._colorMaxesByMode[mode] || [...DEFAULT_COLOR_MAXES[mode]];
    const count = arguments.length;
    if (count === 2) {
      maxes[0] = max1;
      maxes[1] = max1;
      maxes[2] = max1;
      maxes[3] = max1;
    } else if (count === 4) {
      maxes[0] = max1;
      maxes[1] = max2;
      maxes[2] = max3;
    } else if (count === 5) {
      maxes[0] = max1;
      maxes[1] = max2;
      maxes[2] = max3;
      maxes[3] = maxA;
    }
    this._colorMaxesByMode[mode] = maxes;
    this._colorMaxes = maxes;
    return this._colorMode;
  },

  _colorFromArgs(args) {
    const list = Array.isArray(args) ? args : [args];
    return colorFromArgs(list, this._colorMode, this._colorMaxes);
  },

  color(...args) {
    return this._colorFromArgs(args);
  },

  // ------------------------------------------------------------------ style
  fill(...args) {
    this._renderer?.fill(this._colorFromArgs(args));
    return this;
  },

  noFill() {
    this._renderer?.noFill();
    return this;
  },

  stroke(...args) {
    this._renderer?.stroke(this._colorFromArgs(args));
    return this;
  },

  noStroke() {
    this._renderer?.noStroke();
    return this;
  },

  strokeWeight: delegate('strokeWeight'),
  blendMode: delegate('blendMode'),

  tint(...args) {
    this._renderer?.tint(this._colorFromArgs(args));
    return this;
  },

  noTint() {
    this._renderer?.noTint();
    return this;
  },

  // -------------------------------------------------------------- transform
  push: delegate('push'),
  pop: delegate('pop'),
  translate: delegate('translate'),
  scale: delegate('scale'),
  rotate: delegate('rotate'),
  rotateX: delegate('rotateX'),
  rotateY: delegate('rotateY'),
  rotateZ: delegate('rotateZ'),
  resetMatrix: delegate('resetMatrix'),

  // ----------------------------------------------------------------- output
  background(...args) {
    if (!args.length) return this;
    this._renderer?.background(this._colorFromArgs(args));
    return this;
  },

  clear(...args) {
    this._renderer?.clear(...args);
    return this;
  },

  // ----------------------------------------------------------------- shapes
  rect: delegate('rect'),
  circle: delegate('circle'),
  ellipse: delegate('ellipse'),
  line: delegate('line'),
  triangle: delegate('triangle'),
  beginShape: delegate('beginShape'),
  vertex: delegate('vertex'),
  endShape: delegate('endShape'),
  rectMode: delegate('rectMode'),
  ellipseMode: delegate('ellipseMode'),

  // ------------------------------------------------------------------- text
  text: delegate('text'),
  textAlign: delegate('textAlign'),
  textSize: delegate('textSize'),
  textFont: delegate('textFont'),
  textStyle: delegate('textStyle'),

  // ------------------------------------------------------------------ image
  image: delegate('image'),
  imageMode: delegate('imageMode'),
  get: delegate('get'),
  copy: delegate('copy'),

  // -------------------------------------------------------------- 3D / GLSL
  box: delegate('box'),
  sphere: delegate('sphere'),
  plane: delegate('plane'),
  cone: delegate('cone'),
  ambientLight: delegate('ambientLight'),
  pointLight: delegate('pointLight'),
  noLights: delegate('noLights'),
  shader(shaderProgram) {
    this._renderer?.shader(shaderProgram);
    return this;
  },
};

/** Install the drawing API on a class prototype. */
export function installDrawingApi(prototype) {
  Object.assign(prototype, drawingApiMethods);
  return prototype;
}
