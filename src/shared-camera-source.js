// Output-screen camera ownership for LIVE + CUE runtimes. Every consumer gets
// its own p5.MediaElement/video element (so independent renderers can texture
// it), while all of them share one underlying MediaStream for a physical device.

function deviceKey(deviceId) {
  return deviceId || '__default_camera__';
}

function videoConstraints(deviceId, constraints = {}) {
  const requested = constraints.video && typeof constraints.video === 'object'
    ? { ...constraints.video }
    : {};
  if (deviceId) requested.deviceId = { exact: deviceId };
  return { video: requested, audio: false };
}

function isCameraOwner() {
  try {
    const params = new URLSearchParams(window.location.search);
    // Only the screen window owns the physical camera. Control windows use
    // a placeholder/no-op path to avoid double capture and hardware contention.
    return params.get('role') === 'screen';
  } catch {
    return false;
  }
}

export class SharedCameraSource {
  constructor() {
    this.sources = new Map();
    this.epoch = 0;
  }

  _ensureSource(deviceId, constraints) {
    const key = deviceKey(deviceId);
    let source = this.sources.get(key);
    if (source) return source;

    const epoch = ++this.epoch;
    source = {
      key,
      deviceId: deviceId || null,
      consumers: new Set(),
      stream: null,
      stopped: false,
      promise: null,
      epoch,
    };
    source.promise = navigator.mediaDevices.getUserMedia(videoConstraints(deviceId, constraints))
      .then((stream) => {
        if (source.stopped || this.sources.get(key) !== source || this.epoch !== epoch) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error('Camera source was released before it became ready.');
        }
        source.stream = stream;
        return stream;
      })
      .catch((error) => {
        if (this.sources.get(key) === source) this.sources.delete(key);
        throw error;
      });
    this.sources.set(key, source);
    return source;
  }

  acquire({ p, deviceId, constraints, onReady, onError }) {
    // Explicit camera owner policy: the screen owns the camera.
    if (!isCameraOwner()) {
      let placeholder;
      try {
        placeholder = p.createVideo([]);
      } catch {
        try {
          placeholder = p.createVideo('');
        } catch {
          const v = document.createElement('video');
          v.muted = true;
          v.playsInline = true;
          v.autoplay = true;
          placeholder = {
            elt: v,
            hide() {},
            remove() {
              try { v.pause?.(); } catch {}
              try { v.srcObject = null; } catch {}
              try { if (v.parentNode) v.parentNode.removeChild(v); } catch {}
            },
            get width() { return v.videoWidth || 0; },
            get height() { return v.videoHeight || 0; },
            get loadedmetadata() { return false; },
          };
        }
      }
      try { placeholder.hide?.(); } catch {}
      try {
        if (p._elements && Array.isArray(p._elements)) {
          const idx = p._elements.indexOf(placeholder);
          if (idx !== -1) p._elements.splice(idx, 1);
        }
      } catch {}
      const video = placeholder.elt;
      if (video) {
        try { video.muted = true; video.playsInline = true; video.autoplay = true; } catch {}
        const origRemove = placeholder.remove?.bind(placeholder);
        placeholder.remove = () => {
          try { video.pause?.(); } catch {}
          try { video.srcObject = null; } catch {}
          try { if (video.parentNode) video.parentNode.removeChild(video); } catch {}
        };
      }
      queueMicrotask(() => onError?.(new Error('Camera owned by screen window')));
      return { capture: placeholder, release: () => { try { placeholder.remove?.(); } catch {} } };
    }

    const source = this._ensureSource(deviceId, constraints);
    let capture;
    try {
      capture = p.createVideo([]);
    } catch {
      capture = p.createVideo('');
    }
    capture.hide();

    // Detach from p5's element registry so p5's Element.remove() cannot
    // stop the shared MediaStream when one layer is removed.
    try {
      if (p._elements && Array.isArray(p._elements)) {
        const idx = p._elements.indexOf(capture);
        if (idx !== -1) p._elements.splice(idx, 1);
      }
      let sketch = capture._pInst;
      if (sketch && sketch !== p && sketch._elements && Array.isArray(sketch._elements)) {
        const j = sketch._elements.indexOf(capture);
        if (j !== -1) sketch._elements.splice(j, 1);
      }
    } catch {}

    const video = capture.elt;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;

    // Neutralize MediaElement.remove/stop so only the manager's lease count
    // controls track lifetime.
    capture.remove = () => {
      try { video.pause?.(); } catch {}
      try { video.srcObject = null; } catch {}
      try { if (video.parentNode) video.parentNode.removeChild(video); } catch {}
    };
    if (typeof capture.stop === 'function') {
      capture.stop = () => {
        try { video.pause?.(); } catch {}
      };
    }

    const consumer = { capture, video, released: false, source };
    source.consumers.add(consumer);

    const release = () => {
      if (consumer.released) return;
      consumer.released = true;
      source.consumers.delete(consumer);
      try {
        video.pause?.();
        video.srcObject = null;
      } catch {
        // Browser media teardown is best effort.
      }
      try { if (video.parentNode) video.parentNode.removeChild(video); } catch {}
      if (source.consumers.size === 0) this._stopSource(source);
    };

    source.promise
      .then((stream) => {
        if (consumer.released) return;
        if (this.sources.get(source.key) !== source || source.stopped) return;
        let reported = false;
        const reportReady = () => {
          if (consumer.released || reported || !video.videoWidth || !video.videoHeight) return;
          reported = true;
          onReady?.();
        };
        const reportError = (err) => {
          if (!consumer.released && !reported) {
            reported = true;
            onError?.(err instanceof Error ? err : new Error(String(err)));
          }
        };
        video.addEventListener('loadeddata', reportReady, { once: true });
        video.addEventListener('canplay', reportReady, { once: true });
        video.addEventListener('error', () => reportError(new Error('Camera video error')), { once: true });
        video.srcObject = stream;
        const play = video.play?.();
        if (play?.catch) play.catch((err) => {
          if (err && (err.name === 'NotAllowedError' || err.name === 'NotFoundError' || err.name === 'OverconstrainedError' || err.name === 'NotReadableError')) {
            reportError(err);
          }
          // muted / inline video normally plays without a gesture. The loaded
          // data events remain the authoritative readiness path if it does not.
        });
        if (typeof video.requestVideoFrameCallback === 'function') {
          video.requestVideoFrameCallback(() => reportReady());
        }
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) reportReady();
      })
      .catch((error) => {
        if (!consumer.released) onError?.(error instanceof Error ? error : new Error(String(error)));
      });

    return { capture, release };
  }

  _stopSource(source) {
    if (source.stopped) return;
    source.stopped = true;
    if (this.sources.get(source.key) === source) this.sources.delete(source.key);
    if (source.stream) source.stream.getTracks().forEach((track) => track.stop());
  }

  dispose() {
    [...this.sources.values()].forEach((source) => {
      source.consumers.forEach((consumer) => {
        consumer.released = true;
        try {
          consumer.video.pause?.();
          consumer.video.srcObject = null;
          if (consumer.video.parentNode) consumer.video.parentNode.removeChild(consumer.video);
        } catch {
          // Ignore browser shutdown timing.
        }
      });
      source.consumers.clear();
      this._stopSource(source);
    });
    this.sources.clear();
    this.epoch++;
  }

  diagnostics() {
    return {
      streams: this.sources.size,
      consumers: [...this.sources.values()].reduce((count, source) => count + source.consumers.size, 0),
      devices: [...this.sources.values()].map((source) => source.deviceId),
    };
  }
}
