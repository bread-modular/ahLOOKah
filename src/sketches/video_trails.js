// Video Trails — feedback/motion trails on the live camera. Each frame lays a
// translucent black wash over the previous one (trail decay) and stamps the
// fresh capture through an ADD / LIGHTEST / DARKEST blend with a hue tint, so
// movement leaves glowing wakes. Bass stretches the trails and zooms the feed
// outward for a classic feedback spiral feel.
// The opted-in path consumes the smoothed sub-bass level produced by the
// DOM-free capture-side controller; the legacy raw-frame path is kept intact.
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const AUDIO_CONTROL_SCHEMA = Object.freeze({
  continuous: {
    subLevel: { min: 0, max: 1, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: {
    continuous: { subLevel: 0 },
  },
});

// The controller owns the smoothed sub-bass level. The old renderer averaged
// the first six byte-spectrum bins and smoothed the result with a 0.2 per-frame
// lerp at ~60fps; the exponential form reproduces that exact rate from elapsed
// seconds, so the smoothing no longer depends on render FPS.
export function createAudioController({ rng = Math.random } = {}) {
  let smoothSub = 0;
  return {
    update({ shared, params = {}, deltaSeconds = 1 / 30 }) {
      const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
      const freqs = shared?.getByteFrequencies?.() || { left: null };
      const left = freqs.left;
      let target = 0;
      if (left?.length) {
        let sum = 0;
        for (let i = 0; i < 6 && i < left.length; i++) sum += left[i] || 0;
        target = sum / (6 * 255);
      }
      const alpha = 1 - Math.pow(1 - 0.2, 60 * dt);
      smoothSub += (target - smoothSub) * alpha;
      return {
        continuous: { subLevel: clamp(smoothSub, 0, 1) },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export default (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
  let capture;
  let isCaptureReady = false;
  let smoothSub = 0;
  let trailBuffer = null;
  const audioControls = runtimeContext?.audioControls || null;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    p.background(0);
    p.noStroke();

    const constraints = {
      video: {
        deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    };

    capture = runtimeContext?.createCapture(p, constraints, () => {
      isCaptureReady = true;
      runtimeContext?.reportMediaReady?.();
    }) || p.createCapture(constraints, () => {
      isCaptureReady = true;
      runtimeContext?.reportMediaReady?.();
    });
    capture.hide();

    if (runtimeContext?.addCleanup) {
      runtimeContext.addCleanup(() => {
        try { capture?.elt?.pause?.(); } catch {}
        try { capture = null; } catch {}
        isCaptureReady = false;
        if (trailBuffer) {
          try { trailBuffer.remove(); } catch {}
          trailBuffer = null;
        }
      });
    }
  };

  // Smoothed sub-bass level (0..1); always safe when audio is unavailable.
  function subLevel() {
    if (!audio || !audio.isStarted || typeof audio.getFrequencies !== 'function') return 0;
    const freqs = audio.getFrequencies();
    if (!freqs || !freqs.left) return 0;
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += freqs.left[i];
    return sum / (6 * 255);
  }

  function drawMigrated() {
    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const decay = P.decay ?? 0.6;            // 0 = short trails, 1 = endless
    const tintHue = ((P.tintHue ?? 0.6) % 1 + 1) % 1;
    const blendSel = Math.round(P.blend ?? 0);
    const audioDecay = P.audioDecay ?? 1;

    if (!isCaptureReady || !capture?.loadedmetadata || !capture?.width) {
      p.blendMode(p.BLEND);
      p.background(0);
      return;
    }

    const controls = audioControls.read();
    const C = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) };
    const smoothSub = C.subLevel;

    // Fade pass: translucent black erases old trails; bass holds them longer
    p.blendMode(p.BLEND);
    const fade = p.map(decay, 0, 1, 110, 5)
      * (1 - Math.min(0.85, smoothSub * audioDecay));
    p.fill(0, 0, 0, fade);
    p.rect(0, 0, p.width, p.height);

    // Cover mapping + slight bass zoom pump (feedback drift)
    const cover = Math.max(p.width / capture.width, p.height / capture.height);
    const zoom = 1 + smoothSub * audioDecay * 0.035;
    const w = capture.width * cover * zoom;
    const h = capture.height * cover * zoom;

    const mode = blendSel === 1 ? p.LIGHTEST : blendSel === 2 ? p.DARKEST : p.ADD;
    p.blendMode(mode);
    p.tint(tintHue * 360, 72, 100, 210);

    // Mirrored (selfie) orientation
    p.push();
    p.translate(p.width / 2, p.height / 2);
    p.scale(-1, 1);
    p.image(capture, -w / 2, -h / 2, w, h);
    p.pop();

    p.noTint();
    p.blendMode(p.BLEND);
  }

  // Preserved raw-frame implementation for non-migrated/standalone callers.
  function drawLegacy() {
    // Read live params every frame so slider changes apply immediately
    const P = params || {};
    const decay = P.decay ?? 0.6;            // 0 = short trails, 1 = endless
    const tintHue = ((P.tintHue ?? 0.6) % 1 + 1) % 1;
    const blendSel = Math.round(P.blend ?? 0);
    const audioDecay = P.audioDecay ?? 1;

    if (!isCaptureReady || !capture?.loadedmetadata || !capture?.width) {
      p.blendMode(p.BLEND);
      p.background(0);
      return;
    }

    smoothSub = p.lerp(smoothSub, subLevel(), 0.2);

    // Fade pass: translucent black erases old trails; bass holds them longer
    p.blendMode(p.BLEND);
    const fade = p.map(decay, 0, 1, 110, 5)
      * (1 - Math.min(0.85, smoothSub * audioDecay));
    p.fill(0, 0, 0, fade);
    p.rect(0, 0, p.width, p.height);

    // Cover mapping + slight bass zoom pump (feedback drift)
    const cover = Math.max(p.width / capture.width, p.height / capture.height);
    const zoom = 1 + smoothSub * audioDecay * 0.035;
    const w = capture.width * cover * zoom;
    const h = capture.height * cover * zoom;

    const mode = blendSel === 1 ? p.LIGHTEST : blendSel === 2 ? p.DARKEST : p.ADD;
    p.blendMode(mode);
    p.tint(tintHue * 360, 72, 100, 210);

    // Mirrored (selfie) orientation
    p.push();
    p.translate(p.width / 2, p.height / 2);
    p.scale(-1, 1);
    p.image(capture, -w / 2, -h / 2, w, h);
    p.pop();

    p.noTint();
    p.blendMode(p.BLEND);
  }

  p.draw = () => {
    if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
    p.background(0);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
