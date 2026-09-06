// Media pattern — renders a user-supplied image or video file as a fullscreen
// VJ layer. Not audio-reactive by design; it exists to put local content on the
// output with predictable framing.
//
// The file itself stays on disk. IndexedDB keeps only a path-equivalent
// FileSystemFileHandle (see media/media-store.js); when the sketch is
// instantiated the file is loaded from disk into RAM via handle.getFile() and
// a blob object URL. Until the media arrives the sketch draws a black frame,
// plus a hint when the file needs a read permission grant ("click to grant")
// or is missing on disk.
//
// Scaling params (read live every frame):
//   scaleMode — 0 Fit Width, 1 Fit Height, 2 Fit Screen (contain), 3 Fill Screen (cover)
//   zoom      — multiplier on top of the base fit (0.2..4)
//   panX/panY — offset in fractions of the canvas size (-1..1)
//   speed     — video playback rate (video patterns only, 0.25..3)
import { getMediaRecord, loadMediaUrl } from '../media/media-store.js';

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

// Media patterns are not audio-reactive, but the pattern-controls transport
// still requires a controller per live slot so packets keep flowing and the
// CUE/TAKE fresh-frame gate can observe rendered control revisions (see
// program-runtime.js _controlFreshMarkers). This controller emits a neutral
// packet every tick — the renderer reads it and ignores the values.
export function createAudioController() {
  return {
    update() {
      return {
        continuous: { subLevel: 0 },
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}

export function mediaParamsFor(kind) {
  const params = [
    {
      key: 'scaleMode',
      label: 'Scaling',
      // `options` makes the parameter panel render a dropdown instead of a
      // slider. Values stay numeric so persisted params remain compatible.
      options: [
        { value: 0, label: 'Fit Width' },
        { value: 1, label: 'Fit Height' },
        { value: 2, label: 'Fit Screen' },
        { value: 3, label: 'Fill Screen' },
      ],
      min: 0,
      max: 3,
      step: 1,
      default: 2,
    },
    { key: 'zoom', label: 'Zoom', min: 0.2, max: 4, step: 0.05, default: 1 },
    { key: 'panX', label: 'Pan X', min: -1, max: 1, step: 0.01, default: 0 },
    { key: 'panY', label: 'Pan Y', min: -1, max: 1, step: 0.01, default: 0 },
  ];
  if (kind === 'video') {
    params.push({ key: 'speed', label: 'Playback Speed', min: 0.25, max: 3, step: 0.05, default: 1 });
  }
  return params;
}

// meta: { id, name, kind } — the media-registry metadata for this pattern.
export default function createMediaPatternFactory(meta) {
  return (audio, videoDeviceId, params, runtimeContext = {}) => (p) => {
    let media = null;          // p5.Image (images) or p5.MediaElement (videos)
    let mediaWidth = 0;
    let mediaHeight = 0;
    let objectUrl = null;
    let videoElt = null;
    // 'loading' | 'ready' | 'permission' | 'missing'
    let loadState = 'loading';
    let cleaned = false;

    p.setup = () => {
      p.createCanvas(p.windowWidth, p.windowHeight);
      p.colorMode(p.RGB, 255, 255, 255, 255);
      p.background(0);
      p.noStroke();
      loadMedia();
      if (runtimeContext?.addCleanup) runtimeContext.addCleanup(cleanup);
    };

    function cleanup() {
      cleaned = true;
      try { videoElt?.pause?.(); } catch {}
      if (videoElt) {
        try { videoElt.srcObject = null; } catch {}
        try { videoElt.removeAttribute('src'); } catch {}
        try { if (videoElt.parentNode) videoElt.parentNode.removeChild(videoElt); } catch {}
      }
      videoElt = null;
      media = null;
      if (objectUrl) {
        try { URL.revokeObjectURL(objectUrl); } catch {}
        objectUrl = null;
      }
    }

    async function loadMedia() {
      let result = { status: 'missing' };
      try {
        const record = await getMediaRecord(meta.id);
        if (cleaned) return;
        result = await loadMediaUrl(record);
      } catch {
        result = { status: 'missing' };
      }
      if (cleaned) return;
      if (result.status !== 'ready' || !result.url) {
        loadState = result.status === 'permission' ? 'permission' : 'missing';
        runtimeContext?.reportMediaSettled?.();
        return;
      }
      loadState = 'ready';
      objectUrl = result.url;
      if (meta.kind === 'image') {
          p.loadImage(objectUrl, (img) => {
            if (cleaned) return;
            media = img;
            mediaWidth = img.width || 1;
            mediaHeight = img.height || 1;
            runtimeContext?.reportMediaReady?.();
          }, () => {
            loadState = 'missing';
            runtimeContext?.reportMediaSettled?.();
          });
          return;
        }

        // Video: a hidden, looping, muted element (Chrome autoplay policy).
        let capture;
        try {
          capture = p.createVideo([]);
        } catch {
          capture = p.createVideo('');
        }
        if (cleaned) {
          try { capture?.remove?.(); } catch {}
          return;
        }
        capture.hide();
        videoElt = capture.elt;
        videoElt.muted = true;
        videoElt.playsInline = true;
        videoElt.loop = true;
        videoElt.preload = 'auto';

        const onReady = () => {
          if (cleaned || !videoElt?.videoWidth) return;
          media = capture;
          mediaWidth = videoElt.videoWidth || 1;
          mediaHeight = videoElt.videoHeight || 1;
          runtimeContext?.reportMediaReady?.();
          const play = videoElt.play?.();
          if (play?.catch) play.catch(() => {
            // Muted inline video normally autoplays; loadeddata above remains
            // the authoritative readiness path if a gesture is required.
          });
        };
        videoElt.addEventListener('loadeddata', onReady, { once: true });
        videoElt.addEventListener('error', () => { loadState = 'missing'; runtimeContext?.reportMediaSettled?.(); }, { once: true });
        videoElt.src = objectUrl;
        try { videoElt.load?.(); } catch {}
    }

    function drawPlaceholder() {
      p.blendMode(p.BLEND);
      p.background(0);
      if (loadState !== 'permission' && loadState !== 'missing') return;
      p.fill(120);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(Math.max(14, p.width * 0.02));
      const message = loadState === 'permission'
        ? `Click to grant file access — "${meta.name}"`
        : `Media unavailable — re-add "${meta.name}" from the library.`;
      p.text(message, p.width / 2, p.height / 2);
    }

    function drawMedia() {
      // Read live params every frame so slider changes apply immediately.
      const P = params || {};
      const mode = clamp(Math.round(P.scaleMode ?? 2), 0, 3);
      const zoom = clamp(Number(P.zoom ?? 1), 0.05, 8);
      const panX = clamp(Number(P.panX ?? 0), -1, 1);
      const panY = clamp(Number(P.panY ?? 0), -1, 1);
      if (videoElt) {
        const speed = clamp(Number(P.speed ?? 1), 0.25, 3);
        try { if (Number.isFinite(videoElt.playbackRate) && videoElt.playbackRate !== speed) videoElt.playbackRate = speed; } catch {}
      }

      const fitWidth = p.width / mediaWidth;
      const fitHeight = p.height / mediaHeight;
      const base = mode === 0
        ? fitWidth
        : mode === 1
          ? fitHeight
          : mode === 2
            ? Math.min(fitWidth, fitHeight)
            : Math.max(fitWidth, fitHeight);
      const scale = base * zoom;
      const w = mediaWidth * scale;
      const h = mediaHeight * scale;
      const x = (p.width - w) / 2 + panX * p.width * 0.5;
      const y = (p.height - h) / 2 + panY * p.height * 0.5;

      p.blendMode(p.BLEND);
      p.background(0);
      p.image(media, x, y, w, h);
    }

    p.draw = () => {
      // Keep the pattern-controls slot fresh for the CUE/TAKE frame gate.
      if (runtimeContext?.audioControls) runtimeContext.audioControls.read();
      if (!media || !mediaWidth || !mediaHeight) {
        drawPlaceholder();
        return;
      }
      drawMedia();
    };

    p.windowResized = () => {
      p.resizeCanvas(p.windowWidth, p.windowHeight);
      p.background(0);
    };

    p.mousePressed = () => {
      if (audio) audio.resume();
      // Retry the disk load inside this user gesture — requestPermission needs
      // one, and the screen window boots without any gesture.
      if (loadState === 'permission' || loadState === 'missing') {
        loadState = 'loading';
        loadMedia();
      }
    };
  };
}
