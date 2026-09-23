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
  let borrowedImage = null;
  let lastFrameId = null;
  let lastGeneration = null;
  let lastInputWidth = 0;
  let lastInputHeight = 0;
  const fxMode = runtimeContext?.inputMode === 'fx';
  const audioControls = runtimeContext?.audioControls || null;

  p.setup = () => {
    if (fxMode) p.pixelDensity(1);
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.colorMode(p.HSB, 360, 100, 100, 255);
    if (fxMode) {
      // The feedback surface is separate from the output: a disconnected FX
      // can clear both without resurrecting old trails on a later draw.
      p.clear();
      trailBuffer = p.createGraphics(p.width, p.height);
    } else p.background(0);
    p.noStroke();

    if (!fxMode) {
      const constraints = {
        video: {
          deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      };

      capture = runtimeContext?.createCapture?.(p, constraints, () => {
        isCaptureReady = true;
        runtimeContext?.reportMediaReady?.();
      }) || p.createCapture(constraints, () => {
        isCaptureReady = true;
        runtimeContext?.reportMediaReady?.();
      });
      capture.hide();
    }

    if (runtimeContext?.addCleanup) {
      runtimeContext.addCleanup(() => {
        try { capture?.elt?.pause?.(); } catch {}
        try { capture = null; } catch {}
        isCaptureReady = false;
        if (trailBuffer) {
          try { trailBuffer.remove(); } catch {}
          trailBuffer = null;
        }
        borrowedImage = null;
        lastFrameId = null;
        lastGeneration = null;
        lastInputWidth = 0;
        lastInputHeight = 0;
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

  function drawFx() {
    const frame = runtimeContext?.getImageInput?.();
    p.clear();
    if (!frame?.source || frame.width <= 0 || frame.height <= 0
      || frame.source.width !== frame.width || frame.source.height !== frame.height) {
      trailBuffer?.clear();
      lastFrameId = null;
      lastGeneration = null;
      lastInputWidth = 0;
      lastInputHeight = 0;
      return;
    }
    if (!trailBuffer || trailBuffer.width !== p.width || trailBuffer.height !== p.height) {
      trailBuffer?.remove();
      trailBuffer = p.createGraphics(p.width, p.height);
      lastFrameId = null;
    }
    // A different input aspect must not leave trails where the new image has
    // transparent contain bars. Preserve feedback across same-sized frames.
    if (frame.width !== lastInputWidth || frame.height !== lastInputHeight) {
      trailBuffer.clear();
      lastFrameId = null;
      lastInputWidth = frame.width;
      lastInputHeight = frame.height;
    }

    // The graph can ask for the same frame more than once (e.g. multiple
    // consumers). A temporal effect must fade/stamp it only once, while still
    // republishing the accumulated image on each draw.
    if (frame.frameId == null || frame.frameId !== lastFrameId || frame.generation !== lastGeneration) {
      const P = params || {};
      const decay = P.decay ?? 0.6;
      const tintHue = ((P.tintHue ?? 0.6) % 1 + 1) % 1;
      const blendSel = Math.round(P.blend ?? 0);
      let sub = 0;
      if (audioControls) {
        const controls = audioControls.read();
        sub = { ...AUDIO_CONTROL_SCHEMA.neutral.continuous, ...(controls.continuous || {}) }.subLevel;
      } else {
        smoothSub = p.lerp(smoothSub, subLevel(), 0.2);
        sub = smoothSub;
      }
      const fade = p.map(decay, 0, 1, 110, 5)
        * (1 - Math.min(0.85, sub * (P.audioDecay ?? 1)));
      const ctx = trailBuffer.drawingContext;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0, 1 - fade / 255)})`;
      ctx.fillRect(0, 0, p.width, p.height);
      ctx.restore();

      const scale = Math.min(p.width / frame.width, p.height / frame.height);
      const zoom = 1 + sub * (P.audioDecay ?? 1) * 0.035;
      const w = frame.width * scale * zoom;
      const h = frame.height * scale * zoom;
      trailBuffer.blendMode(blendSel === 1 ? p.LIGHTEST : blendSel === 2 ? p.DARKEST : p.ADD);
      trailBuffer.tint(tintHue * 360, 72, 100, 255);
      // Wrapping only the canvas reference enables the 2D tint pipeline; the
      // graph still owns the actual source and may repaint it in the next frame.
      if (!borrowedImage) borrowedImage = { canvas: frame.source };
      borrowedImage.canvas = frame.source;
      borrowedImage.width = frame.width;
      borrowedImage.height = frame.height;
      ctx.save();
      ctx.globalAlpha = 210 / 255; // stamp opacity, including upstream alpha
      trailBuffer.image(borrowedImage, (p.width - w) / 2, (p.height - h) / 2, w, h);
      ctx.restore();
      trailBuffer.noTint();
      trailBuffer.blendMode(p.BLEND);
      lastFrameId = frame.frameId;
      lastGeneration = frame.generation;
    }
    p.image(trailBuffer, 0, 0, p.width, p.height);
  }

  p.draw = () => {
    if (fxMode) drawFx();
    else if (audioControls) drawMigrated();
    else drawLegacy();
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
    if (fxMode) {
      trailBuffer?.resize(p.width, p.height);
      trailBuffer?.clear();
      lastFrameId = null;
      lastGeneration = null;
      p.clear();
    } else p.background(0);
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };
};
