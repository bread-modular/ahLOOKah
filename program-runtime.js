// A complete, independently composited output program. A program is either one
// sketch or a two-sketch merge, and owns the canvases, parameter resolver, CSS
// post-processing layer and lifecycle needed to prepare it safely off-program.
//
// p5 2.x creates its canvas asynchronously, so readiness deliberately waits for
// both canvas attachment and a completed draw from every child instance.

const DEFAULT_WARM_TIMEOUT_MS = 12_000;

function cloneSelection(selection = {}) {
  return {
    ids: Array.isArray(selection.ids) ? selection.ids.filter(Boolean).slice(0, 2) : [],
    merge: Boolean(selection.merge),
  };
}

// p5 removes the canvas but does not explicitly release its WebGL context. Keep
// this teardown shared by full-screen runtimes and the embedded control preview
// so neither path can exhaust Chrome's process-wide active-context allowance.
export function loseP5WebGLContext(instance) {
  if (!instance) return false;

  const renderers = [
    instance._renderer,
    instance._curElement?._renderer,
    instance._curElement,
  ].filter(Boolean);
  const contexts = new Set();
  for (const renderer of renderers) {
    for (const candidate of [renderer.GL, renderer.gl, renderer.drawingContext]) {
      if (candidate && typeof candidate.getExtension === 'function') contexts.add(candidate);
    }
  }
  if (instance.drawingContext && typeof instance.drawingContext.getExtension === 'function') {
    contexts.add(instance.drawingContext);
  }

  // Current p5 exposes RendererGL.GL. Only probe the canvas as a guarded
  // fallback for another p5 wrapper layout that still declares a 3D renderer;
  // probing an untyped/2D canvas could create the very context we are releasing.
  if (!contexts.size && renderers.some((renderer) => renderer.isP3D) && instance.canvas) {
    try {
      const gl = instance.canvas.getContext('webgl2')
        || instance.canvas.getContext('webgl')
        || instance.canvas.getContext('experimental-webgl');
      if (gl) contexts.add(gl);
    } catch {}
  }

  let released = false;
  for (const gl of contexts) {
    try {
      const extension = gl.getExtension('WEBGL_lose_context');
      if (extension) {
        extension.loseContext();
        released = true;
      }
    } catch {
      // Context loss is best-effort on browser shutdown or an already-lost GL.
    }
  }
  return released;
}

export function disposeP5Instance(instance) {
  if (!instance) return;
  try {
    instance.noLoop?.();
  } catch {
    // The instance may already be between p5 teardown phases.
  }
  loseP5WebGLContext(instance);
  try {
    const removal = instance.remove?.();
    // p5 2.x remove() is async. Keep teardown best-effort without leaking an
    // unhandled rejection into page shutdown or a rapid selection replacement.
    removal?.catch?.(() => {});
  } catch {
    // A removed p5 instance is already in the desired state.
  }
}

export class ProgramRuntime {
  constructor({
    p5Constructor,
    selection,
    sketches,
    audio,
    videoDeviceId,
    getParams,
    layer,
    cameraSource = null,
    generation = 0,
    warmTimeoutMs = DEFAULT_WARM_TIMEOUT_MS,
    onTiming = null,
  }) {
    this.p5Constructor = p5Constructor;
    this.selection = cloneSelection(selection);
    this.sketches = sketches;
    this.audio = audio;
    this.videoDeviceId = videoDeviceId;
    this.getParams = getParams;
    this.layer = layer;
    this.cameraSource = cameraSource;
    this.generation = generation;
    this.warmTimeoutMs = warmTimeoutMs;
    this.onTiming = onTiming;

    this.instances = [];
    this.disposed = false;
    this.ready = false;
    this.error = null;
    this.preparedAt = 0;
    this.readyAt = 0;
    this.drawCounts = [];
    this.attached = new Set();
    this.drawn = new Set();
    this.mediaReady = new Set();
    // Each camera must draw after its video source reports a current frame;
    // a black pre-media draw is not a valid READY acknowledgement.
    this.mediaDrawBaseline = new Map();
    this.cameraIndices = new Set();
    this.cleanup = [];
    // A fresh-frame request remains active until a compositor frame has run,
    // not merely until p5 calls draw(). Requests arriving during that compositor
    // gate are queued for a subsequent frame so an older frame can never be
    // mistaken for one rendered with newly-mutated cue params.
    this.freshWaiter = null;
    this.queuedFreshWaiter = null;
    this.timeoutId = 0;
    this._resolveReady = null;
    this._rejectReady = null;

    this.readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
  }

  get count() {
    return this.instances.length;
  }

  get primary() {
    return this.instances[0] || null;
  }

  get merge() {
    return this.selection.merge && this.selection.ids.length === 2;
  }

  _mark(name, detail = {}) {
    if (this.onTiming) this.onTiming(name, { generation: this.generation, ...detail });
  }

  prepare() {
    if (this.disposed) return this.readyPromise;

    const selected = this.selection.ids
      .map((id) => this.sketches.find((sketch) => sketch.id === id))
      .filter(Boolean);

    if (!selected.length || (this.selection.merge && selected.length !== 2)) {
      this._fail(new Error('The selected program is unavailable.'));
      return this.readyPromise;
    }

    this.cameraIndices = new Set(selected
      .map((sketch, index) => (sketch.camera ? index : -1))
      .filter((index) => index >= 0));
    this.preparedAt = performance.now();
    this._mark('runtime-construction-started', { ids: this.selection.ids });
    this.layer.replaceChildren();
    this.layer.dataset.programIds = this.selection.ids.join(',');
    this.layer.dataset.programMerge = this.merge ? 'true' : 'false';

    selected.forEach((sketch, index) => this._createInstance(sketch, index));
    this.applyBlendStyles();

    this.timeoutId = window.setTimeout(() => {
      this._fail(new Error(`Cue warm-up timed out after ${Math.round(this.warmTimeoutMs / 1000)} seconds.`));
    }, this.warmTimeoutMs);

    return this.readyPromise;
  }

  _createInstance(sketch, index) {
    const runtimeContext = {
      // Camera sketches use this instead of p.createCapture when the runtime is
      // on the output screen. It gives LIVE and CUE consumers one MediaStream.
      createCapture: (p, constraints, callback) => {
        if (!this.cameraSource) return p.createCapture(constraints, callback);
        const consumer = this.cameraSource.acquire({
          p,
          deviceId: this.videoDeviceId,
          constraints,
          onReady: () => {
            if (this.disposed) return;
            this._noteMediaReady(index, sketch.id);
            callback?.();
          },
          onError: (error) => {
            if (this.disposed) return;
            // Propagate permission denial as a real failure so the warm-up
            // promise rejects instead of timing out with no feedback.
            this.handleMediaError(error);
            // Also fail via _fail path if handleMediaError didn't (already handled)
          },
        });
        this.cleanup.push(() => consumer.release());
        return consumer.capture;
      },
      reportMediaReady: () => this._noteMediaReady(index, sketch.id),
      addCleanup: (cleanup) => {
        if (typeof cleanup === 'function') this.cleanup.push(cleanup);
      },
    };

    const factory = sketch.factory(
      this.audio,
      this.videoDeviceId,
      this.getParams(sketch.id),
      runtimeContext,
    );

    const wrappedSketch = (p) => {
      try {
        factory(p);

        const originalSetup = p.setup;
        if (typeof originalSetup === 'function') {
          p.setup = (...args) => {
            try {
              return originalSetup.apply(p, args);
            } catch (error) {
              this._fail(error);
              return undefined;
            }
          };
        }

        const originalDraw = p.draw;
        p.draw = (...args) => {
          try {
            const result = typeof originalDraw === 'function' ? originalDraw.apply(p, args) : undefined;
            this._noteDraw(index);
            return result;
          } catch (error) {
            this._fail(error);
            return undefined;
          }
        };
      } catch (error) {
        this._fail(error);
      }
    };

    // p5 may invoke draw during construction in some builds, so initialise the
    // counter before it gets a chance to call the wrapped callback.
    this.drawCounts[index] = 0;
    let instance;
    try {
      // Give p5 its program layer at construction time. p5 2.x creates the
      // canvas asynchronously, and constructing without a parent briefly puts
      // it in the document body where it can flash above LIVE before our attach
      // retry moves it into the hidden CUE layer.
      instance = new this.p5Constructor(wrappedSketch, this.layer);
    } catch (error) {
      this._fail(error);
      return;
    }

    this.instances[index] = instance;
    this._attachCanvas(instance, index);
  }

  _attachCanvas(instance, index) {
    const attach = () => {
      if (this.disposed || !instance || instance._removed) return;
      const canvas = instance.canvas;
      if (!canvas) {
        requestAnimationFrame(attach);
        return;
      }

      if (canvas.parentElement !== this.layer) this.layer.appendChild(canvas);
      canvas.classList.add('program-canvas');
      canvas.dataset.programLayer = String(index);
      canvas.style.zIndex = String(index);
      canvas.style.pointerEvents = 'auto';
      if (this.merge) canvas.classList.add('merge-canvas');
      else canvas.classList.remove('merge-canvas');

      this.attached.add(index);
      this._mark('canvas-attached', { sketchId: this.selection.ids[index] });
      this.applyBlendStyles();
      this._checkReady();
    };
    attach();
  }

  _noteDraw(index) {
    if (this.disposed) return;
    this.drawCounts[index] = (this.drawCounts[index] || 0) + 1;
    this.drawn.add(index);
    this._mark('first-draw-completed', {
      sketchId: this.selection.ids[index],
      count: this.drawCounts[index],
    });
    this._checkFreshFrame();
    this._checkReady();
  }

  _noteMediaReady(index, sketchId) {
    if (this.disposed) return;
    this.mediaReady.add(index);
    this.mediaDrawBaseline.set(index, this.drawCounts[index] || 0);
    this._mark('media-ready', { sketchId });
    this._checkReady();
  }

  _hasUsableCameraFrames() {
    return [...this.cameraIndices].every((index) =>
      this.mediaReady.has(index)
      && (this.drawCounts[index] || 0) > (this.mediaDrawBaseline.get(index) ?? Infinity),
    );
  }

  _checkReady() {
    if (this.disposed || this.ready || this.error) return;
    const count = this.instances.length;
    if (!count || this.attached.size < count || this.drawn.size < count) return;
    if (!this._hasUsableCameraFrames()) return;

    // One compositor frame after the successful draw makes a canvas existence
    // acknowledgement useful to operators, rather than merely observable in JS.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.disposed || this.ready || this.error) return;
        if (this.attached.size < this.instances.length || this.drawn.size < this.instances.length) return;
        if (!this._hasUsableCameraFrames()) return;
        this.ready = true;
        this.readyAt = performance.now();
        if (this.timeoutId) clearTimeout(this.timeoutId);
        this.timeoutId = 0;
        this._mark('runtime-ready', {
          duration: this.readyAt - this.preparedAt,
          ids: this.selection.ids,
        });
        this._resolveReady(this);
      });
    });
  }

  get hasPendingFreshFrame() {
    return Boolean(this.freshWaiter || this.queuedFreshWaiter);
  }

  _clearFreshWaiterTimeout(waiter) {
    if (waiter?.timeoutId) clearTimeout(waiter.timeoutId);
    if (waiter) waiter.timeoutId = 0;
  }

  _rejectFreshWaiter(waiter, error) {
    if (!waiter) return;
    this._clearFreshWaiterTimeout(waiter);
    if (waiter.compositorRaf) cancelAnimationFrame(waiter.compositorRaf);
    if (waiter.compositorConfirmRaf) cancelAnimationFrame(waiter.compositorConfirmRaf);
    waiter.compositorRaf = 0;
    waiter.compositorConfirmRaf = 0;
    waiter.waiters.forEach((entry) => entry.reject(error));
  }

  _rejectFreshRequests(error) {
    const active = this.freshWaiter;
    const queued = this.queuedFreshWaiter;
    this.freshWaiter = null;
    this.queuedFreshWaiter = null;
    this._rejectFreshWaiter(active, error);
    this._rejectFreshWaiter(queued, error);
  }

  _beginFreshWaiter(waiter) {
    if (this.disposed) {
      this._rejectFreshWaiter(waiter, new Error('Program runtime was disposed.'));
      return;
    }
    if (!this.instances.length) {
      this._rejectFreshWaiter(waiter, new Error('Program runtime has no renderer instances.'));
      return;
    }

    this.resume();
    waiter.before = this.instances.map((_, index) => this.drawCounts[index] || 0);
    waiter.state = 'waiting-for-draw';
    waiter.timeoutId = window.setTimeout(() => {
      if (this.freshWaiter !== waiter) return;
      const error = new Error('The staged program did not produce a fresh frame.');
      this._rejectFreshRequests(error);
    }, waiter.timeoutMs);
    this.freshWaiter = waiter;
    // p5 may draw synchronously in tests, before the waiter is installed.
    this._checkFreshFrame();
  }

  _completeFreshWaiter(waiter) {
    if (this.disposed || this.freshWaiter !== waiter) return;
    this.freshWaiter = null;
    this._clearFreshWaiterTimeout(waiter);

    // Start a request that arrived after the completed draw before resolving the
    // old one. This prevents a prior parkAfter request from pausing a runtime a
    // newer edit or TAKE already needs to keep running.
    const next = this.queuedFreshWaiter;
    this.queuedFreshWaiter = null;
    if (next) {
      this._beginFreshWaiter(next);
    } else if (waiter.parkAfter && this.ready) {
      // A warming camera must remain looping until media readiness and a later
      // draw have satisfied the runtime READY contract.
      this.pause();
    }

    this._mark('fresh-frame-completed');
    waiter.waiters.forEach(({ resolve }) => resolve(this));
  }

  _finishFreshCompositorFrame(waiter) {
    if (this.disposed || this.freshWaiter !== waiter || waiter.state !== 'awaiting-compositor') return;
    waiter.compositorRaf = requestAnimationFrame(() => {
      waiter.compositorRaf = 0;
      if (this.disposed || this.freshWaiter !== waiter || waiter.state !== 'awaiting-compositor') return;
      // The second rAF is the compositor-confirmation gate: a p5 draw observed
      // in JavaScript is not yet a safe visible frame until the browser has had
      // an opportunity to composite it.
      waiter.compositorConfirmRaf = requestAnimationFrame(() => {
        waiter.compositorConfirmRaf = 0;
        this._completeFreshWaiter(waiter);
      });
    });
  }

  _checkFreshFrame() {
    const waiter = this.freshWaiter;
    if (!waiter || this.disposed || waiter.state !== 'waiting-for-draw') return;
    const complete = this.instances.every((_, index) => (this.drawCounts[index] || 0) > waiter.before[index]);
    if (!complete) return;

    // Keep `freshWaiter` installed through the compositor gate. A request that
    // arrives now must wait for a new draw rather than resolving against this
    // already-completed one.
    waiter.state = 'awaiting-compositor';
    this._finishFreshCompositorFrame(waiter);
  }

  requestFreshFrame(timeoutMs = 4_000, { parkAfter = false } = {}) {
    if (this.disposed) return Promise.reject(new Error('Program runtime was disposed.'));

    return new Promise((resolve, reject) => {
      const request = {
        before: [],
        waiters: [{ resolve, reject }],
        timeoutId: 0,
        timeoutMs,
        parkAfter: Boolean(parkAfter),
        state: 'queued',
        compositorRaf: 0,
        compositorConfirmRaf: 0,
      };

      if (!this.freshWaiter) {
        this._beginFreshWaiter(request);
        return;
      }

      if (this.freshWaiter.state === 'waiting-for-draw') {
        // Both requests can be satisfied by the same not-yet-drawn frame. A
        // caller that needs a live TAKE always wins over standby parking.
        this.freshWaiter.parkAfter = this.freshWaiter.parkAfter && request.parkAfter;
        this.freshWaiter.waiters.push(...request.waiters);
        return;
      }

      // The existing frame has already drawn and may not contain this request's
      // latest params. Serialize a new frame after compositor completion.
      if (this.queuedFreshWaiter) {
        this.queuedFreshWaiter.parkAfter = this.queuedFreshWaiter.parkAfter && request.parkAfter;
        this.queuedFreshWaiter.waiters.push(...request.waiters);
      } else {
        this.queuedFreshWaiter = request;
      }
    });
  }

  pause() {
    if (this.disposed) return;
    this.instances.forEach((instance) => {
      try {
        instance?.noLoop?.();
      } catch {
        // A removed p5 instance can reject noLoop during teardown; it is safe.
      }
    });
  }

  resume() {
    if (this.disposed) return;
    this.instances.forEach((instance) => {
      try {
        instance?.loop?.();
      } catch {
        // Ignore an instance that is in the middle of p5 removal.
      }
    });
  }

  applyBlendStyles() {
    if (!this.merge || this.instances.length !== 2) return;
    const [base, overlay] = this.instances;
    if (!base?.canvas || !overlay?.canvas) return;

    const params = this.getParams('__merge') || {};
    const additive = params.mode === 1;
    const mix = typeof params.mix === 'number' ? params.mix : 0.5;
    const add = typeof params.add === 'number' ? params.add : 0.5;
    base.canvas.style.opacity = '1';
    base.canvas.style.mixBlendMode = 'normal';
    overlay.canvas.style.mixBlendMode = additive ? 'screen' : 'normal';
    overlay.canvas.style.opacity = String(additive ? add : mix);
  }

  setFilter(filter) {
    if (!this.layer || this.disposed) return;
    this.layer.style.filter = filter || 'none';
  }

  _fail(error) {
    if (this.disposed || this.error || this.ready) return;
    this.error = error instanceof Error ? error : new Error(String(error || 'Program warm-up failed.'));
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = 0;
    this._rejectFreshRequests(this.error);
    this._mark('runtime-error', { message: this.error.message });
    this._rejectReady(this.error);
  }

  // Camera permission denied must settle readiness immediately; otherwise
  // _fail's guard and the warm timeout leave CUE hanging forever.
  handleMediaError(error) {
    if (this.disposed || this.ready || this.error) return;
    const err = error instanceof Error ? error : new Error(String(error || 'Camera unavailable.'));
    this._mark('media-error', { message: err.message });
    this._fail(err);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const disposeError = new Error('Program runtime was disposed.');
    if (!this.ready && !this.error) {
      this.error = disposeError;
      this._rejectReady(disposeError);
    }
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = 0;
    // Reject active and compositor-queued callers before removing p5. Otherwise
    // a pending TAKE/parameter promise can hang forever after CANCEL or a
    // selection replacement disposes this runtime.
    this._rejectFreshRequests(disposeError);

    this.cleanup.splice(0).forEach((cleanup) => {
      try {
        cleanup();
      } catch {
        // Continue teardown even if a browser media object is already gone.
      }
    });

    // Stop rendering, release GL, then remove p5. remove() alone leaves WebGL
    // contexts active long enough for rapid LIVE/CUE switches to exhaust Chrome.
    this.instances.forEach((instance) => disposeP5Instance(instance));
    this.instances = [];
    if (this.layer) {
      this.layer.replaceChildren();
      delete this.layer.dataset.programIds;
      delete this.layer.dataset.programMerge;
      this.layer.style.filter = 'none';
    }
    this._mark('runtime-disposed');
  }
}

export function selectionsEqual(a, b) {
  const left = cloneSelection(a);
  const right = cloneSelection(b);
  return left.merge === right.merge
    && left.ids.length === right.ids.length
    && left.ids.every((id, index) => id === right.ids[index]);
}

export function copyProgramSelection(selection) {
  return cloneSelection(selection);
}
