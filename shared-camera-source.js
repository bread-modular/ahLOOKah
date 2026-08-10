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

export class SharedCameraSource {
  constructor() {
    this.sources = new Map();
  }

  _ensureSource(deviceId, constraints) {
    const key = deviceKey(deviceId);
    let source = this.sources.get(key);
    if (source) return source;

    source = {
      key,
      deviceId: deviceId || null,
      consumers: new Set(),
      stream: null,
      stopped: false,
      promise: null,
    };
    source.promise = navigator.mediaDevices.getUserMedia(videoConstraints(deviceId, constraints))
      .then((stream) => {
        if (source.stopped) {
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
    const source = this._ensureSource(deviceId, constraints);
    // createVideo creates a p5.MediaElement without touching getUserMedia. An
    // empty source list is intentional; the shared stream is assigned below.
    let capture;
    try {
      capture = p.createVideo([]);
    } catch {
      capture = p.createVideo('');
    }
    capture.hide();

    const video = capture.elt;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;

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
      if (source.consumers.size === 0) this._stopSource(source);
    };

    source.promise
      .then((stream) => {
        if (consumer.released) return;
        let reported = false;
        const reportReady = () => {
          if (consumer.released || reported || !video.videoWidth || !video.videoHeight) return;
          reported = true;
          onReady?.();
        };
        video.addEventListener('loadeddata', reportReady, { once: true });
        video.addEventListener('canplay', reportReady, { once: true });
        video.srcObject = stream;
        const play = video.play?.();
        if (play?.catch) play.catch(() => {
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
        } catch {
          // Ignore browser shutdown timing.
        }
      });
      source.consumers.clear();
      this._stopSource(source);
    });
    this.sources.clear();
  }

  diagnostics() {
    return {
      streams: this.sources.size,
      consumers: [...this.sources.values()].reduce((count, source) => count + source.consumers.size, 0),
      devices: [...this.sources.values()].map((source) => source.deviceId),
    };
  }
}
