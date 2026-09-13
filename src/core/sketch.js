// VizCore — the focused, dependency-free replacement for the p5.js instance the
// pattern library is written against. It keeps the p-style sketch interface
// (`p.setup`, `p.draw`, `p.createCanvas`, `p.fill`, `p.rect`, ...) and the
// lifecycle semantics ProgramRuntime depends on:
//
//   * construction calls the sketch function synchronously, then setup() runs on
//     the next animation frame (a default 100x100 canvas exists before setup,
//     exactly like p5 2.x).
//   * after setup completes exactly one draw always runs — even when setup()
//     called noLoop() — then the rAF loop continues while `_loop` is true.
//   * deltaTime (ms) is set before every draw; redraw() resets the transform,
//     increments frameCount, awaits draw() and awaits renderer finishDraw().
//   * noLoop()/loop()/isLooping()/redraw()/remove() are promise-aware and are
//     defined before user code runs, because patterns capture `p.remove`.
//
// Deliberately NOT reimplemented (nothing in the 91 patterns uses them): global
// mode, preload/FES, DOM element factories beyond video/image, save*, shaders
// other than the vertex+fragment pair, framebuffers, curves/arcs/bezier, and
// pixel-level filters.

import {
  ADD, BASELINE, BLEND, BOTTOM, CENTER, CLOSE, CORNERS, CORNER, DARKEST, DEFAULT_COLOR_MAXES, HALF_PI,
  HSB, LEFT, LIGHTEST, MULTIPLY, OPEN, P2D, PI, QUARTER_PI, RADIUS, RGB, RIGHT, SCREEN, TAU, TOP,
  TWO_PI, WEBGL,
} from './constants.js';
import { installDrawingApi } from './api.js';
import { Graphics } from './graphics.js';
import { Renderer2D, defaultDensity } from './renderer-2d.js';
import { RendererGL } from './renderer-gl.js';
import { VizImage, VizMediaElement } from './media.js';
import {
  constrainValue, distValue, lerpValue, magValue, mapValue, noiseValue, noiseSeedValue, noiseDetailValue, randomValue,
} from './math.js';

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function viewportWidth() {
  return typeof window !== 'undefined' ? window.innerWidth : 1;
}

function viewportHeight() {
  return typeof window !== 'undefined' ? window.innerHeight : 1;
}

export class VizCore {
  constructor(sketch, hostNode = null) {
    this._userNode = hostNode || (typeof document !== 'undefined' ? document.body : null);
    this._setupDone = false;
    this._loop = true;
    this._inUserDraw = false;
    this._removed = false;
    this._error = null;
    this._requestAnimId = 0;
    this._targetFrameRate = 60;
    this._lastTargetFrameTime = 0;
    this._lastRealFrameTime = 0;
    this._millisStart = now();
    this._frameRate = 0;

    this.frameCount = 0;
    this.deltaTime = 0;
    this._pixelDensity = defaultDensity();
    this.width = 0;
    this.height = 0;
    this.windowWidth = viewportWidth();
    this.windowHeight = viewportHeight();
    this.canvas = null;
    this.drawingContext = null;
    this._renderer = null;
    this._rendererMode = null;
    this._elements = [];
    this._canvasListeners = [];
    this.mouseX = 0;
    this.mouseY = 0;

    this._colorMode = RGB;
    this._colorMaxesByMode = {
      [RGB]: [...DEFAULT_COLOR_MAXES[RGB]],
      [HSB]: [...DEFAULT_COLOR_MAXES[HSB]],
    };
    this._colorMaxes = this._colorMaxesByMode[RGB];

    this._handleWindowResize = () => {
      this.windowWidth = viewportWidth();
      this.windowHeight = viewportHeight();
      if (!this._removed && typeof this.windowResized === 'function') this.windowResized();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._handleWindowResize);
    }

    // Readiness promise: resolves once setup() has completed (even if it threw —
    // inspect `_error`). ProgramRuntime polls instead, but deterministic tests
    // and offscreen tooling can await this directly.
    this._readyPromise = new Promise((resolve) => { this._resolveReady = resolve; });

    // p5 executes the sketch function synchronously with the instance.
    try { sketch(this); } catch (error) { this.remove(); throw error; }
    if (this._removed) return;
    this._requestAnimId = requestAnimationFrame(() => {
      this._requestAnimId = 0;
      this._start();
    });
  }

  /** Resolves after setup() has run (see `_error` for a failed setup). */
  whenReady() {
    return this._readyPromise;
  }

  // ------------------------------------------------------------------ boot
  async _start() {
    if (this._removed || this._error) {
      this._resolveReady?.(this);
      return;
    }
    try {
      await this._setup();
    } catch (error) {
      this._fail(error);
      this._resolveReady?.(this);
      return;
    }
    this._resolveReady?.(this);
    if (this._removed || this._error) return;
    // Always draw once after setup: noLoop() inside setup must not swallow the
    // first frame (deterministic render fixtures depend on it).
    this._draw();
  }

  async _setup() {
    // p5 creates a default 100x100 canvas before setup runs.
    if (!this.canvas) this.createCanvas(100, 100, P2D);
    this._millisStart = now();
    if (typeof this.setup === 'function') await this.setup();
    if (this._removed) return;
    this._lastTargetFrameTime = now();
    this._lastRealFrameTime = this._lastTargetFrameTime;
    this._setupDone = true;
  }

  _draw(timestamp) {
    if (this._removed || this._error) return;
    const stamp = typeof timestamp === 'number' ? timestamp : now();
    const targetTimeBetweenFrames = 1000 / this._targetFrameRate;
    if (this.frameCount === 0 || !this._loop || stamp - this._lastTargetFrameTime >= targetTimeBetweenFrames - 5) {
      this.deltaTime = stamp - this._lastRealFrameTime;
      this._frameRate = this.deltaTime > 0 ? 1000 / this.deltaTime : 0;
      const drawing = this.redraw();
      this._lastTargetFrameTime = Math.max(this._lastTargetFrameTime + targetTimeBetweenFrames, stamp);
      this._lastRealFrameTime = stamp;
      // Never let a rejected draw promise surface as an unhandled rejection.
      Promise.resolve(drawing).catch((error) => this._fail(error));
    }
    if (this._loop && !this._removed) {
      this._requestAnimId = requestAnimationFrame((next) => {
        this._requestAnimId = 0;
        this._draw(next);
      });
    }
  }

  _fail(error) {
    if (this._error) return;
    this._error = error instanceof Error ? error : new Error(String(error));
    this._loop = false;
    if (typeof console !== 'undefined') console.error('[viz-core]', this._error);
  }

  // -------------------------------------------------------------- lifecycle
  noLoop() {
    this._loop = false;
  }

  loop() {
    if (!this._loop && !this._removed && !this._error) {
      this._loop = true;
      if (this._setupDone) this._draw();
    }
  }

  isLooping() {
    return this._loop;
  }

  async redraw(count) {
    if (this._redrawing || !this._setupDone || this._removed || this._error) return undefined;
    let numberOfRedraws = parseInt(count, 10);
    if (!Number.isFinite(numberOfRedraws) || numberOfRedraws < 1) numberOfRedraws = 1;
    this._redrawing = true;
    try {
      for (let i = 0; i < numberOfRedraws; i += 1) {
        if (this._removed) break;
        this._renderer?.resetFrame?.();
        this.frameCount += 1;
        this._inUserDraw = true;
        try { await this.draw(); } finally { this._inUserDraw = false; }
      }
      if (!this._removed) await this._renderer?.finishDraw?.();
      return this;
    } catch (error) {
      this._fail(error);
      return undefined;
    } finally {
      this._redrawing = false;
    }
  }

  remove() {
    if (this._removed) return Promise.resolve();
    this._removed = true;
    this._resolveReady?.(this);
    this._loop = false;
    if (this._requestAnimId) cancelAnimationFrame(this._requestAnimId);
    this._requestAnimId = 0;
    if (typeof window !== 'undefined') window.removeEventListener('resize', this._handleWindowResize);
    this._detachCanvasListeners();
    this._elements.slice().forEach((element) => {
      try { element?.remove?.(); } catch { /* already gone */ }
    });
    this._elements.length = 0;
    const renderer = this._renderer;
    if (renderer) {
      try { renderer.loseContext?.(); } catch { /* already lost */ }
      try { renderer.dispose?.(); } catch { /* already disposed */ }
      try { renderer.remove?.(); } catch { /* noop */ }
    }
    try { this.canvas?.remove(); } catch { /* detached */ }
    this.canvas = null;
    this.drawingContext = null;
    this._renderer = null;
    return Promise.resolve();
  }

  millis() { return now() - this._millisStart; }

  /** p5 API: context attributes are chosen when the canvas is created. */
  setAttributes() { return this; }

  frameRate(fps) {
    if (typeof fps === 'number' && Number.isFinite(fps) && fps > 0) {
      this._targetFrameRate = fps;
      return this;
    }
    return this._frameRate;
  }

  getTargetFrameRate() { return this._targetFrameRate; }

  // Harmless p5 no-ops kept so future pattern code cannot crash the core.
  noSmooth() { return this; }

  smooth() { return this; }

  describe() { return this; }

  print(...args) {
    if (typeof console !== 'undefined') console.log(...args);
    return this;
  }

  // ----------------------------------------------------------------- canvas
  createCanvas(width, height, mode = P2D) {
    if (this._removed) return null;
    const w = Math.max(1, Math.round(Number(width) || 1));
    const h = Math.max(1, Math.round(Number(height) || 1));
    const target = mode === WEBGL ? 'gl' : '2d';
    if (this._renderer && this._rendererMode !== target) {
      this._detachCanvasListeners();
      try { this._renderer.loseContext?.(); } catch { /* noop */ }
      try { this._renderer.dispose?.(); } catch { /* noop */ }
      this._renderer = null;
      if (this.canvas) {
        try { this.canvas.remove(); } catch { /* detached */ }
        this.canvas = null;
      }
    }
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      const host = this._userNode || document.body;
      try { host.appendChild(this.canvas); } catch { /* host detached */ }
      this._attachCanvasListeners();
    }
    if (!this._renderer) {
      this._renderer = target === 'gl'
        ? new RendererGL({ pInst: this, canvas: this.canvas, width: w, height: h, density: this._pixelDensity })
        : new Renderer2D({ pInst: this, canvas: this.canvas, width: w, height: h, density: this._pixelDensity });
      this._rendererMode = target;
    } else {
      this._renderer.resize(w, h);
      this._renderer.pixelDensity?.(this._pixelDensity);
    }
    this.width = this._renderer.width;
    this.height = this._renderer.height;
    this.canvas = this._renderer.canvas;
    this.drawingContext = this._renderer.drawingContext;
    return this._renderer;
  }

  resizeCanvas(width, height, noRedraw = false) {
    if (!this._renderer) return;
    this._renderer.resize(width, height);
    this.width = this._renderer.width;
    this.height = this._renderer.height;
    if (!noRedraw && this._setupDone && !this._removed) this.redraw();
  }

  pixelDensity(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      this._pixelDensity = value;
      if (this._renderer) {
        this._renderer.pixelDensity(value);
        this.width = this._renderer.width;
        this.height = this._renderer.height;
      }
      return this;
    }
    return this._renderer ? this._renderer._pixelDensity : this._pixelDensity;
  }

  // ------------------------------------------------------- offscreen assets
  createGraphics(width, height) {
    if (this._removed) return null;
    return new Graphics(this, width, height, this._pixelDensity);
  }

  createImage(width, height) {
    return new VizImage(width, height);
  }

  loadImage(url, successCallback, failureCallback) {
    const image = new VizImage(1, 1);
    if (typeof Image === 'undefined') {
      failureCallback?.(new Error('Images are unavailable in this environment.'));
      return image;
    }
    const element = new Image();
    if (/^(https?:)?\/\//.test(String(url)) || String(url).startsWith('/')) element.crossOrigin = 'anonymous';
    element.onload = () => {
      image.resize(element.naturalWidth || element.width || 1, element.naturalHeight || element.height || 1);
      image.drawingContext.drawImage(element, 0, 0, image.width, image.height);
      image._markDirty?.();
      successCallback?.(image);
    };
    element.onerror = () => {
      failureCallback?.(new Error(`Unable to load image: ${url}`));
    };
    element.src = url;
    return image;
  }

  createVideo(src, callback) {
    if (this._removed) return null;
    const element = new VizMediaElement(this, typeof src === 'string' ? src : null);
    this._elements.push(element);
    if (typeof callback === 'function') {
      const done = () => callback(element);
      if (element.loadedmetadata) done();
      else element.elt.addEventListener('loadeddata', done, { once: true });
    }
    return element;
  }

  createCapture(constraints = {}, callback) {
    if (this._removed) return null;
    const element = new VizMediaElement(this, null);
    this._elements.push(element);
    const video = element.elt;
    const done = () => { element._loadedMetadata = true; callback?.(element); };
    video.addEventListener('loadeddata', done, { once: true });
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia(constraints)
        .then((stream) => {
          if (element._removed) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          element._stream = stream;
          video.srcObject = stream;
          const played = video.play?.();
          if (played?.catch) played.catch(() => { /* muted autoplay is best effort */ });
        })
        .catch((error) => {
          if (typeof console !== 'undefined') console.error('[viz-core] camera unavailable', error);
        });
    }
    return element;
  }

  createShader(vertexSource, fragmentSource) {
    if (!this._renderer?.createShader) {
      throw new Error('createShader() requires a WebGL canvas.');
    }
    return this._renderer.createShader(vertexSource, fragmentSource);
  }

  // ------------------------------------------------------------------ events
  _attachCanvasListeners() {
    if (!this.canvas || this._canvasListeners.length) return;
    const record = (event) => {
      this.mouseX = event.clientX ?? this.mouseX;
      this.mouseY = event.clientY ?? this.mouseY;
    };
    const pressed = (event) => {
      record(event);
      if (typeof this.mousePressed === 'function') {
        try { this.mousePressed(event); } catch { /* user callback error */ }
      }
    };
    const listeners = [
      ['mousedown', pressed],
      ['touchstart', pressed],
      ['mousemove', record],
      ['touchmove', record],
    ];
    listeners.forEach(([type, handler]) => {
      try {
        this.canvas.addEventListener(type, handler, { passive: true });
        this._canvasListeners.push([type, handler]);
      } catch { /* noop */ }
    });
  }

  _detachCanvasListeners() {
    this._canvasListeners.forEach(([type, handler]) => {
      try { this.canvas?.removeEventListener(type, handler); } catch { /* noop */ }
    });
    this._canvasListeners.length = 0;
  }
}

// Drawing API (fill/stroke/shapes/text/image/3D delegation).
installDrawingApi(VizCore.prototype);

// Prototype-level lifecycle defaults so user code can capture them
// (`const remove = p.remove.bind(p)`) during construction.
VizCore.prototype.setup = function setup() {};
VizCore.prototype.draw = function draw() {};
VizCore.prototype.windowResized = function windowResized() {};
VizCore.prototype.mousePressed = function mousePressed() {};
VizCore.prototype.finishDraw = function finishDraw() {};

// Math helpers (p5 names).
Object.assign(VizCore.prototype, {
  random: randomValue,
  noise: noiseValue,
  noiseSeed: noiseSeedValue,
  noiseDetail: noiseDetailValue,
  map: mapValue,
  lerp: lerpValue,
  constrain: constrainValue,
  dist: distValue,
  mag: magValue,
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  pow: Math.pow,
  sqrt: Math.sqrt,
  sq: (value) => value * value,
  exp: Math.exp,
  log: Math.log,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan2: Math.atan2,
  atan: Math.atan,
  hypot: Math.hypot,
  radians: (degrees) => (degrees * PI) / 180,
  degrees: (radians) => (radians * 180) / PI,
});

// Constants exposed on every instance (p5-compatible names).
Object.assign(VizCore.prototype, {
  P2D, WEBGL,
  RGB, HSB,
  BLEND, ADD, LIGHTEST, DARKEST, MULTIPLY, SCREEN,
  CENTER, LEFT, RIGHT, TOP, BOTTOM, BASELINE,
  CORNER, CORNERS, RADIUS, CLOSE, OPEN,
  PI, TWO_PI, TAU, HALF_PI, QUARTER_PI,
});

export default VizCore;
