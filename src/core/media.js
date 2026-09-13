// Image + media element wrappers for the focused core.
//
// VizImage backs createImage()/get()/loadImage() and loadPixels()/updatePixels();
// VizMediaElement backs createVideo()/createCapture(). Both are deliberately
// duck-compatible with the p5 objects the pattern library expects:
//   * image sources resolve through `.canvas` (Image) or `.elt` (media), the
//     same fallback order p5 uses for `image()` and `setUniform(texture)`.
//   * media elements expose `.elt`, `.width`/`.height`, `.loadedmetadata`,
//     `.hide()`, `.remove()`, `.stop()` and `._pInst` (the camera ownership code
//     detaches them from the sketch's `_elements` registry).
//
// The element is appended to the sketch's user node (document.body by default),
// exactly like p5.addElement: the media and camera patterns call hide()
// immediately, but the placement itself is part of what callers (and the
// mapping tests' `document.querySelectorAll('video')` probes) rely on.
// Narrow deviation: the element starts `display: none` (p5 leaves media
// visible until the sketch calls hide()); every media/camera call site here
// hides immediately, so the visible-frame difference is unobservable.

export class VizImage {
  constructor(width, height) {
    const w = Math.max(1, Math.round(Number(width) || 1));
    const h = Math.max(1, Math.round(Number(height) || 1));
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;
    this.drawingContext = this.canvas.getContext('2d');
    this.pixels = new Uint8ClampedArray(w * h * 4);
    this._loaded = false;
    this._textureDirty = true;
    this.gifProperties = null;
    this.tintCanvas = null;
  }

  loadPixels() {
    const data = this.drawingContext.getImageData(0, 0, this.width, this.height).data;
    if (this.pixels.length !== data.length) this.pixels = new Uint8ClampedArray(data.length);
    this.pixels.set(data);
    this._loaded = true;
  }

  updatePixels() {
    let data = this.pixels;
    if (!(data instanceof Uint8ClampedArray) || data.length !== this.width * this.height * 4) {
      data = new Uint8ClampedArray(this.width * this.height * 4);
    }
    this.drawingContext.putImageData(new ImageData(data, this.width, this.height), 0, 0);
    this._textureDirty = true;
  }

  get(x = 0, y = 0, w = this.width, h = this.height) {
    const out = new VizImage(w, h);
    out.drawingContext.drawImage(this.canvas, x, y, w, h, 0, 0, w, h);
    return out;
  }

  set(x, y, value) {
    if (value?.canvas) this.drawingContext.drawImage(value.canvas, x, y);
    else {
      const [r, g, b, a] = Array.isArray(value) ? value : [value, value, value, 255];
      this.drawingContext.fillStyle = `rgba(${r},${g},${b},${(a ?? 255) / 255})`;
      this.drawingContext.fillRect(x, y, 1, 1);
    }
    this._textureDirty = true;
  }

  resize(width, height) {
    const w = Math.max(1, Math.round(Number(width) || 1));
    const h = Math.max(1, Math.round(Number(height) || 1));
    if (w === this.width && h === this.height) return;
    const snapshot = document.createElement('canvas');
    snapshot.width = this.width;
    snapshot.height = this.height;
    snapshot.getContext('2d').drawImage(this.canvas, 0, 0);
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;
    this.drawingContext = this.canvas.getContext('2d');
    this.drawingContext.drawImage(snapshot, 0, 0);
    this.pixels = new Uint8ClampedArray(w * h * 4);
    this._textureDirty = true;
  }

  remove() {
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  /** The tint path (see Renderer2D._tintedImageCanvas) requires a dirty flag. */
  _markDirty() { this._textureDirty = true; }
}

export class VizMediaElement {
  constructor(pInst, src, { loop = false } = {}) {
    this._pInst = pInst || null;
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = false;
    video.loop = Boolean(loop);
    video.preload = 'auto';
    video.style.display = 'none';
    if (typeof src === 'string' && src) video.src = src;
    // p5.addElement(elt, pInst, true) parents media elements to the sketch's
    // user node; keep that placement so DOM probes and camera ownership code
    // behave the same as they did under p5.
    const host = (pInst && pInst._userNode) || (typeof document !== 'undefined' ? document.body : null);
    if (host && typeof host.appendChild === 'function') host.appendChild(video);
    this.elt = video;
    this.canvas = null;
    this._loadedMetadata = false;
    this._removed = false;
    this._displayed = false;
    this._onLoadedMetadata = () => { this._loadedMetadata = true; };
    this._onLoadedData = () => { this._loadedMetadata = true; };
    video.addEventListener('loadedmetadata', this._onLoadedMetadata);
    video.addEventListener('loadeddata', this._onLoadedData);
  }

  get width() { return this.elt.videoWidth || this.elt.width || 0; }

  get height() { return this.elt.videoHeight || this.elt.height || 0; }

  get loadedmetadata() { return this._loadedMetadata || this.elt.readyState >= 1; }

  get currentTime() { return this.elt.currentTime; }

  set currentTime(value) { try { this.elt.currentTime = value; } catch { /* not seekable yet */ } }

  get playbackRate() { return this.elt.playbackRate; }

  set playbackRate(value) { try { this.elt.playbackRate = value; } catch { /* detached element */ } }

  get muted() { return this.elt.muted; }

  set muted(value) { this.elt.muted = Boolean(value); }

  get loop() { return this.elt.loop; }

  set loop(value) { this.elt.loop = Boolean(value); }

  hide() {
    this.elt.style.display = 'none';
    this._displayed = false;
    return this;
  }

  show() {
    this.elt.style.display = '';
    this._displayed = true;
    return this;
  }

  size(width, height) {
    this.elt.style.width = `${Math.round(width)}px`;
    this.elt.style.height = `${Math.round(height)}px`;
    return this;
  }

  play() {
    const result = this.elt.play?.();
    if (result?.catch) result.catch(() => { /* autoplay policy: readiness events still fire */ });
    return this;
  }

  pause() {
    try { this.elt.pause?.(); } catch { /* already paused */ }
    return this;
  }

  stop() {
    try { this.elt.pause?.(); } catch { /* already paused */ }
  }

  /** Copies the current video frame into a 2D canvas (needed by the tint path). */
  _ensureCanvas() {
    const w = this.width;
    const h = this.height;
    if (!w || !h) return null;
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.getContext('2d');
    }
    try {
      this.canvas.getContext('2d').drawImage(this.elt, 0, 0, w, h);
    } catch { /* frame not ready */ }
    return this.canvas;
  }

  remove() {
    if (this._removed) return;
    this._removed = true;
    try { this.elt.pause?.(); } catch { /* noop */ }
    try { this.elt.srcObject = null; } catch { /* noop */ }
    try { this.elt.removeAttribute?.('src'); } catch { /* noop */ }
    try { if (this.elt.parentNode) this.elt.parentNode.removeChild(this.elt); } catch { /* noop */ }
    try {
      this.elt.removeEventListener('loadedmetadata', this._onLoadedMetadata);
      this.elt.removeEventListener('loadeddata', this._onLoadedData);
    } catch { /* noop */ }
    this.canvas = null;
  }
}

/**
 * Resolve a drawable source for Canvas2D/WebGL from any of the supported
 * image-like inputs. Returns null when nothing drawable is available.
 */
export function resolveSource(value) {
  if (!value) return null;
  if (value instanceof VizImage) return value.canvas || null;
  if (value instanceof VizMediaElement) return value.elt || null;
  if (typeof HTMLVideoElement !== 'undefined' && value instanceof HTMLVideoElement) return value;
  if (typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement) return value;
  if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) return value;
  if (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement) return value;
  if (value.canvas) return value.canvas;
  if (value.elt) return value.elt;
  return null;
}
