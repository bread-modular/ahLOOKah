import p5 from 'p5';
import './style.css';
import {
  getOrderedSketches,
  SKETCHES,
  BLEND_ID,
  BANDS_ID,
  POSTFX_ID,
  defaultParamValues,
  indexFromKey,
  saveSlotOrder,
} from './sketch-registry.js';
import { ConfigPanel } from './config-panel.js';
import { AudioManager } from './audio-manager.js';
import { PreviewAudio } from './preview-audio.js';
import { setBandSplit, computeLogSpectrum } from './sketches/audio-features.js';
import {
  loadNoiseFloor,
  clearNoiseFloor,
  startNoiseCapture,
  cancelNoiseCapture,
  isNoiseCapturing,
  getNoiseCaptureState,
  getNoiseFloorMeta,
  sampleNoiseFloorDb,
  NOISE_CAPTURE_DEFAULT_SECONDS,
} from './noise-floor.js';

// ---------------------------------------------------------------------------
// Window roles
//   ?screen  -> this window is the visualization screen
//   ?control -> this window is a control panel (DEFAULT — the root URL boots
//               the panel; use ?role=screen to boot straight into the stage)
// Screens are opened with ?role=screen (the Open Screen button in the panel
// or the Control Panel button on the screen toolbar); if two windows boot as
// screens, the older one demotes automatically.
// ---------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
let myRole = params.get('role') === 'screen' ? 'screen' : 'control';
const myId = Math.random().toString(36).slice(2);
const MY_BOOT_TIME = Date.now();

const channel = new BroadcastChannel('viz2_channel');
const audio = new AudioManager();
// Control windows render their own lightweight stage using the screen's
// broadcast analysis (or a musical idle signal until a screen is available).
const previewAudio = new PreviewAudio();

let currentP5 = null;
let currentIndex = 0;
// Stable id of the currently loaded sketch — survives reorders
let activeSketchId = null;
// Merge mode: two effects selected to blend (latched via the keyboard
// gesture). Both run simultaneously and are blended on screen. null = single
// effect.
let mergeIndices = null;
// Ids of the running merge pair — survives reorders (positions shift).
let mergeIds = null;
// The two p5 instances backing a merge (base + overlay). currentP5 is the
// base instance; these are tracked so teardown removes BOTH canvases.
let mergeP5 = [];
let currentVideoDeviceId = null;
let currentAudioDeviceId = null;
let screenOnline = myRole === 'screen';
let panel = null;

const STORAGE = {
  audio: 'viz2_audio_device_id',
  video: 'viz2_video_device_id',
  params: 'viz2_params',
};

// ---------------------------------------------------------------------------
// Effect parameters
// Each sketch can expose a set of live-adjustable params (see sketch-registry).
// `paramValues` is a per-sketch-id map of { key: value }. The same object that
// is handed to a sketch factory is mutated in place on 'params' messages, so
// running sketches pick up slider changes immediately.
// ---------------------------------------------------------------------------

let paramValues = loadParamValues();

// Raw (non-proxied) counterparts, used for serialization only — JSON.stringify
// of a Proxy would hit its get-trap and pollute the DEV read-log below.
const paramRawValues = { ...paramValues };

// DEV only: records which params the RUNNING sketch actually reads each frame.
// Lets e2e tests verify slider changes reach the sketch in realtime (a sketch
// that captured params once at creation never touches this object again).
let devReadLog = null;

function loadParamValues() {
  let raw = {};
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE.params)) || {};
  } catch {
    raw = {};
  }
  if (typeof raw !== 'object' || raw === null) raw = {};

  const out = {};
  const knownIds = new Set(SKETCHES.map((s) => s.id));

  for (const [key, value] of Object.entries(raw)) {
    // BLEND_ID is a reserved pseudo-sketch id that stores the global blend
    // params — keep it alongside the per-effect entries. Merge stored values
    // over the defaults so stores saved by older builds (no `mode`, add:0)
    // pick up the new keys instead of rendering with undefined.
    if (key === BLEND_ID) {
      out[key] = { ...defaultParamValues(BLEND_ID), ...(value || {}) };
    } else if (key === BANDS_ID) {
      // Global band-split crossovers (same reserved-id trick as BLEND_ID)
      out[key] = { ...defaultParamValues(BANDS_ID), ...(value || {}) };
    } else if (key === POSTFX_ID) {
      // Global post-processing trim (same reserved-id trick as BLEND_ID)
      out[key] = { ...defaultParamValues(POSTFX_ID), ...(value || {}) };
    } else if (knownIds.has(key)) {
      out[key] = value;
    }
  }

  // Migrate legacy numeric (position-keyed) entries to sketch ids so an
  // existing param store survives the upgrade (best effort — assumes the
  // default order, since the old format had no ids to resolve against).
  for (const [key, value] of Object.entries(raw)) {
    const n = parseInt(key, 10);
    if (!Number.isNaN(n) && SKETCHES[n] && !out[SKETCHES[n].id]) {
      out[SKETCHES[n].id] = value;
    }
  }

  return out;
}

function saveParamValues() {
  localStorage.setItem(STORAGE.params, JSON.stringify(paramRawValues));
}

// Returns the live param object for a sketch id (creating it from defaults).
// In DEV builds the object is wrapped in a Proxy that records property reads,
// so tests can prove the running sketch re-reads params every frame.
function getParams(id) {
  let v = paramValues[id];
  if (!v) {
    v = defaultParamValues(id);
    paramValues[id] = v;
    paramRawValues[id] = v;
  }

  if (import.meta.env.DEV && !v.__vizProxied) {
    Object.defineProperty(v, '__vizProxied', { value: true, enumerable: false, configurable: true });
    devReadLog = {};
    const proxy = new Proxy(v, {
      get(obj, prop) {
        if (typeof prop === 'string' && !prop.startsWith('__')) {
          devReadLog[prop] = performance.now();
        }
        return obj[prop];
      },
      set(obj, prop, value) {
        obj[prop] = value;
        return true;
      },
    });
    paramValues[id] = proxy;
    paramRawValues[id] = v;
  }

  return paramValues[id];
}

// ---------------------------------------------------------------------------
// Screen runtime
// ---------------------------------------------------------------------------

// Tear down whatever is running: a single sketch or both merge instances.
function removeCurrentP5() {
  if (currentP5) {
    currentP5.remove();
    currentP5 = null;
  }
  mergeP5.forEach((inst) => inst.remove());
  mergeP5 = [];
}

// Run two sketches side by side as stacked canvases and blend them purely in
// the GPU compositor: the overlay canvas' opacity drives the crossfade and
// mix-blend-mode:screen layers it additively. No per-frame pixel readback, so
// WEBGL/shader effects stay at full speed.
function loadMerged(indexA, indexB) {
  const ordered = getOrderedSketches();
  const skA = ordered[indexA];
  const skB = ordered[indexB];

  const p5A = new p5(skA.factory(audio, currentVideoDeviceId, getParams(skA.id)));
  const p5B = new p5(skB.factory(audio, currentVideoDeviceId, getParams(skB.id)));

  mergeP5 = [p5A, p5B];
  adoptCanvas(p5A);
  adoptCanvas(p5B);
  // p5 creates the canvas when setup() runs — after the constructor returns —
  // so tag each canvas as soon as it exists.
  tagMergeCanvas(p5A, '0');
  tagMergeCanvas(p5B, '1');
  applyBlendStyles();

  return p5A;
}

// Tag a merge sketch's canvas for stacking + tests. p5 2.x creates the canvas
// asynchronously (first frame), so retry until it appears.
function tagMergeCanvas(inst, zIndex) {
  const tag = () => {
    if (!inst.canvas || inst.canvas.__mergeTagged) return;
    inst.canvas.__mergeTagged = true;
    inst.canvas.classList.add('merge-canvas');
    // Both canvases are position:fixed via CSS; make the stacking explicit.
    inst.canvas.style.zIndex = zIndex;
    // Keep the stage clickable: the toolbar sits at z-index 2000.
    inst.canvas.style.pointerEvents = 'auto';
    applyBlendStyles();
  };
  tag();
  if (inst.canvas) return;
  const tick = () => {
    if (inst.canvas) {
      tag();
    } else {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}

// Push the current blend params onto the overlay canvas styles. Called when a
// merge loads and whenever a blend slider moves on any window.
function applyBlendStyles() {
  if (mergeP5.length !== 2) return;
  const [p5A, p5B] = mergeP5;
  if (!p5A.canvas || !p5B.canvas) return;

  const bp = getParams(BLEND_ID);
  const additive = bp.mode === 1;
  const mix = typeof bp.mix === 'number' ? bp.mix : 0.5;
  const add = typeof bp.add === 'number' ? bp.add : 0.5;

  if (additive) {
    // Additive layering: overlay is screened on top of the base
    p5B.canvas.style.mixBlendMode = 'screen';
    p5B.canvas.style.opacity = String(add);
  } else {
    // Crossfade: opacity 0 -> base only, 1 -> overlay only
    p5B.canvas.style.mixBlendMode = 'normal';
    p5B.canvas.style.opacity = String(mix);
  }
}

// ---------------------------------------------------------------------------
// Post-processing (global output trim: brightness / contrast / saturation)
// The screen moves its stage canvases into #screen-wrap and applies the trim
// as a CSS filter on the wrapper — GPU-composited AFTER the merge blend, no
// pixel readback, and it survives sketch teardown (canvases come and go, the
// wrapper stays). Sliders ride the shared param store under POSTFX_ID.
// ---------------------------------------------------------------------------

function ensureScreenWrap() {
  let wrap = document.getElementById('screen-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'screen-wrap';
    document.body.appendChild(wrap);
  }
  return wrap;
}

// Map the -100..+100 offsets onto CSS filter functions around the natural
// level (0 -> 1.0, +100 -> 2.0, -100 -> 0.0).
function postFxFilterString() {
  const p = getParams(POSTFX_ID);
  const b = Number(p.brightness) || 0;
  const c = Number(p.contrast) || 0;
  const s = Number(p.saturation) || 0;
  if (!b && !c && !s) return 'none'; // natural level — skip the GPU pass
  return `brightness(${(100 + b) / 100}) contrast(${(100 + c) / 100}) saturate(${(100 + s) / 100})`;
}

function applyPostFx() {
  if (myRole !== 'screen') return;
  ensureScreenWrap().style.filter = postFxFilterString();
}

// Move a sketch's canvas into the filter wrapper once p5 creates it (p5 2.x
// creates the canvas asynchronously, on the first frame — retry until it
// exists). Idempotent; safe for both single sketches and merge pairs.
function adoptCanvas(inst) {
  const adopt = () => {
    if (!inst.canvas || inst.canvas.__postfxAdopted) return;
    inst.canvas.__postfxAdopted = true;
    // The wrapper disables hit-testing; keep the stage itself interactive.
    inst.canvas.style.pointerEvents = 'auto';
    ensureScreenWrap().appendChild(inst.canvas);
  };
  adopt();
  if (inst.canvas || inst._removed) return;
  const tick = () => {
    if (inst.canvas) adopt();
    else if (!inst._removed) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Embedded control-panel preview
// ---------------------------------------------------------------------------
// A preview is a real, isolated p5 instance of the selected visual. Sketches
// were written for a full output window and call createCanvas(windowWidth,
// windowHeight), so the wrapper below intercepts create/resizeCanvas and
// substitutes the preview host's dimensions. This keeps all existing 2D and
// WebGL sketches unchanged while ensuring their canvas never escapes the panel.

let previewStage = null;
let previewP5 = [];
let previewSelection = { ids: [], merge: false };
let previewResizeObserver = null;
let previewRenderRaf = 0;
let previewResizeRaf = 0;
let previewGeneration = 0;

function getPreviewSize() {
  if (!previewStage) return [1, 1];
  return [
    Math.max(1, Math.round(previewStage.clientWidth)),
    Math.max(1, Math.round(previewStage.clientHeight)),
  ];
}

function applyPreviewCompositing() {
  if (!previewStage) return;

  // Match the output stage's post-processing trim without touching the
  // full-screen #screen-wrap that belongs only to the output window.
  previewStage.style.filter = postFxFilterString();

  previewP5.forEach((inst, index) => {
    const canvas = inst && inst.canvas;
    if (!canvas) return;
    canvas.style.zIndex = String(index);
    if (previewP5.length === 2 && index === 1) {
      const blend = getParams(BLEND_ID);
      const additive = blend.mode === 1;
      canvas.style.mixBlendMode = additive ? 'screen' : 'normal';
      canvas.style.opacity = String(additive ? (blend.add ?? 0.5) : (blend.mix ?? 0.5));
    } else {
      canvas.style.mixBlendMode = 'normal';
      canvas.style.opacity = '1';
    }
  });
}

function attachPreviewCanvas(inst, sketch, layer, generation) {
  const attach = () => {
    if (generation !== previewGeneration || !previewStage || inst._removed) return;
    if (!inst.canvas) {
      requestAnimationFrame(attach);
      return;
    }

    const canvas = inst.canvas;
    if (canvas.parentElement !== previewStage) previewStage.appendChild(canvas);
    canvas.classList.add('preview-canvas');
    canvas.dataset.previewSketch = sketch.id;
    canvas.style.zIndex = String(layer);
    canvas.style.pointerEvents = 'none';
    applyPreviewCompositing();
  };
  attach();
}

function createPreviewInstance(sketch, layer, generation) {
  if (!previewStage) return null;

  const factory = sketch.factory(previewAudio, null, getParams(sketch.id));
  const wrappedSketch = (p) => {
    // Each legacy sketch asks p5 for window-sized canvases on setup and resize.
    // Substitute only those calls, keeping every drawing API and renderer mode
    // (including WEBGL) identical to the output-stage implementation.
    const createCanvas = p.createCanvas.bind(p);
    const resizeCanvas = p.resizeCanvas.bind(p);
    p.createCanvas = (_width, _height, ...rest) => {
      const [width, height] = getPreviewSize();
      return createCanvas(width, height, ...rest);
    };
    p.resizeCanvas = (_width, _height, ...rest) => {
      const [width, height] = getPreviewSize();
      return resizeCanvas(width, height, ...rest);
    };
    factory(p);
  };

  // Passing the stage as p5's parent ensures setup-created canvases start inside
  // the clipped host. attachPreviewCanvas also handles p5 2.x's async canvas.
  const inst = new p5(wrappedSketch, previewStage);
  previewP5.push(inst);
  attachPreviewCanvas(inst, sketch, layer, generation);
  return inst;
}

function clearPreview() {
  previewGeneration += 1;
  previewP5.forEach((inst) => inst.remove());
  previewP5 = [];
  if (previewStage) {
    previewStage.replaceChildren();
    previewStage.style.filter = 'none';
    delete previewStage.dataset.previewSketches;
  }
}

function renderPreview() {
  if (!previewStage) return;
  clearPreview();

  const ids = [...new Set((previewSelection.ids || []).filter(Boolean))];
  const sketches = ids.map((id) => SKETCHES.find((sketch) => sketch.id === id)).filter(Boolean);
  previewStage.dataset.previewSketches = sketches.map((sketch) => sketch.id).join(',');

  if (!sketches.length) {
    previewStage.innerHTML = '<div class="preview-empty">Select a pattern to start the preview.</div>';
    return;
  }

  // A control window must not open a second camera capture (which can steal the
  // selected device from the output screen). Keep the output behavior intact and
  // clearly label this one intentional preview-only exception.
  const cameraSketches = sketches.filter((sketch) => sketch.camera);
  const renderable = sketches.filter((sketch) => !sketch.camera);
  if (!renderable.length) {
    previewStage.innerHTML = '<div class="preview-empty">Camera effect — live video remains on the output screen.</div>';
    return;
  }

  const active = previewSelection.merge ? renderable.slice(0, 2) : renderable.slice(0, 1);
  const generation = previewGeneration;
  active.forEach((sketch, layer) => createPreviewInstance(sketch, layer, generation));

  if (cameraSketches.length) {
    const note = document.createElement('div');
    note.className = 'preview-camera-note';
    note.textContent = 'Camera layer stays on the output screen.';
    previewStage.appendChild(note);
  }
  applyPreviewCompositing();
}

function queuePreviewRender() {
  if (previewRenderRaf) cancelAnimationFrame(previewRenderRaf);
  previewRenderRaf = requestAnimationFrame(() => {
    previewRenderRaf = 0;
    renderPreview();
  });
}

function resizePreview() {
  if (previewResizeRaf) return;
  previewResizeRaf = requestAnimationFrame(() => {
    previewResizeRaf = 0;
    const [width, height] = getPreviewSize();
    previewP5.forEach((inst) => {
      if (inst && !inst._removed && (inst.width !== width || inst.height !== height)) {
        // The instance method is our wrapped resizeCanvas, so it ignores these
        // nominal arguments and always uses the measured preview host size.
        inst.resizeCanvas(width, height);
      }
    });
  });
}

function initPreviewStage(stage) {
  if (previewResizeObserver) previewResizeObserver.disconnect();
  clearPreview();
  previewStage = stage;
  previewResizeObserver = new ResizeObserver(resizePreview);
  previewResizeObserver.observe(stage);
  queuePreviewRender();
}

function setPreviewSelection(selection = {}) {
  previewSelection = {
    ids: Array.isArray(selection.ids) ? selection.ids : [],
    merge: Boolean(selection.merge),
  };
  queuePreviewRender();
}

function loadSketch(index, merge = null) {
  const ordered = getOrderedSketches();
  if (index < 0 || index >= ordered.length) return;

  removeCurrentP5();

  currentIndex = index;
  const canMerge =
    merge && merge.length === 2 &&
    merge[0] >= 0 && merge[0] < ordered.length &&
    merge[1] >= 0 && merge[1] < ordered.length;

  if (canMerge) {
    mergeIndices = [...merge];
    const skA = ordered[merge[0]];
    const skB = ordered[merge[1]];
    mergeIds = [skA.id, skB.id];
    activeSketchId = skA.id;

    // Inject audio, current video device ID, and the LIVE params object so the
    // sketch reads updated param values every frame.
    currentP5 = loadMerged(merge[0], merge[1]);

    console.log(`Loaded merged sketch ${skA.name} + ${skB.name}`);
  } else {
    mergeIndices = null;
    mergeIds = null;
    const sketch = ordered[index];
    activeSketchId = sketch.id;

    // Inject audio, current video device ID, and the LIVE params object so the
    // sketch reads updated param values every frame.
    currentP5 = new p5(sketch.factory(audio, currentVideoDeviceId, getParams(sketch.id)));
    adoptCanvas(currentP5);

    console.log(`Loaded sketch ${index + 1} (${sketch.name})`);
  }
}

// Load a pattern by id — used for library-only patterns that are not assigned
// to any pad slot. The pad index bookkeeping is reset (-1) so the screen knows
// the selection is id-based, not slot-based.
function loadSketchById(id) {
  const sketch = SKETCHES.find((s) => s.id === id);
  if (!sketch) return;

  removeCurrentP5();

  currentIndex = -1;
  mergeIndices = null;
  mergeIds = null;
  activeSketchId = id;

  currentP5 = new p5(sketch.factory(audio, currentVideoDeviceId, getParams(id)));
  adoptCanvas(currentP5);
  console.log(`Loaded sketch ${sketch.name}`);
}

// Keep activeSketchId in sync for ALL windows (the screen sets it in loadSketch;
// control windows derive it from the current ordered list). Pad edits shift
// positions, so the id is what survives an order change.
function updateActiveSketchId() {
  const ordered = getOrderedSketches();
  if (mergeIndices && ordered[mergeIndices[0]]) {
    activeSketchId = ordered[mergeIndices[0]].id;
  } else if (currentIndex >= 0 && ordered[currentIndex]) {
    activeSketchId = ordered[currentIndex].id;
  }
}

function startAudio() {
  const savedAudioId = localStorage.getItem(STORAGE.audio);
  if (savedAudioId && (savedAudioId !== currentAudioDeviceId || !audio.isStarted)) {
    currentAudioDeviceId = savedAudioId;
    audio.startStream(savedAudioId);
  }
}

// Re-read device selection from localStorage and apply it (screen only)
function applyDevices() {
  const savedAudioId = localStorage.getItem(STORAGE.audio);
  const savedVideoId = localStorage.getItem(STORAGE.video);

  if (savedAudioId && (savedAudioId !== currentAudioDeviceId || !audio.isStarted)) {
    currentAudioDeviceId = savedAudioId;
    audio.startStream(savedAudioId);
  }

  if (savedVideoId && savedVideoId !== currentVideoDeviceId) {
    currentVideoDeviceId = savedVideoId;
    // Reload the current sketch only if it's a webcam-dependent one — this
    // covers both pad-based and library-only (id-based) camera effects, and
    // preserves a live merge pair when one is running.
    const sketch = SKETCHES.find((s) => s.id === activeSketchId);
    if (sketch && sketch.camera) {
      if (currentIndex >= 0) loadSketch(currentIndex, mergeIndices);
      else loadSketchById(activeSketchId);
    }
  }
}

// ---------------------------------------------------------------------------
// Role switching
// ---------------------------------------------------------------------------

function becomeControl() {
  if (myRole === 'control') return;
  myRole = 'control';

  document.title = 'Viz Control';
  removeCurrentP5();
  audio.stop();
  stopSpectrumBroadcast();
  currentAudioDeviceId = null;

  document.body.classList.add('is-control');
  document.body.classList.remove('is-screen');

  console.log(`Window ${myId} became a control panel`);
}

// ---------------------------------------------------------------------------
// Broadcast channel
// ---------------------------------------------------------------------------

function broadcast(msg) {
  const full = { ...msg, windowId: myId };
  // BroadcastChannel does NOT deliver messages to the sender, so dispatch
  // locally as well to keep this window's own state consistent.
  channel.postMessage(full);
  handleMessage(full);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'hello':
      if (msg.role === 'screen') {
        screenOnline = true;
        // If two windows booted as screens, the older one demotes so only one
        // screen exists (first-opened window wins).
        if (myRole === 'screen' && msg.windowId !== myId && msg.bootTime < MY_BOOT_TIME) {
          becomeControl();
        }
      }
      if (myRole === 'screen') {
        broadcast({ type: 'state', pattern: currentIndex, merge: mergeIndices, patternId: activeSketchId });
      }
      break;

    case 'state':
      if (typeof msg.pattern === 'number') {
        currentIndex = msg.pattern;
        mergeIndices = Array.isArray(msg.merge) && msg.merge.length === 2 ? [...msg.merge] : null;
        if (msg.pattern < 0 && typeof msg.patternId === 'string') {
          // Library-only playback is id-based; the pad index is -1
          activeSketchId = msg.patternId;
        } else {
          updateActiveSketchId();
        }
      }
      screenOnline = true;
      break;

    case 'pattern':
      currentIndex = msg.index;
      mergeIndices = null;
      updateActiveSketchId();
      if (myRole === 'screen') {
        loadSketch(msg.index);
        broadcast({ type: 'state', pattern: currentIndex, merge: null, patternId: activeSketchId });
      }
      break;

    case 'pattern-id':
      // A library-only pattern (not on the pad) was clicked in some window.
      currentIndex = -1;
      mergeIndices = null;
      mergeIds = null;
      activeSketchId = msg.id;
      if (myRole === 'screen') {
        loadSketchById(msg.id);
        broadcast({ type: 'state', pattern: -1, merge: null, patternId: activeSketchId });
      }
      break;

    case 'merge':
      // Two effects selected at once — run both and blend them on screen.
      if (typeof msg.a === 'number' && typeof msg.b === 'number') {
        currentIndex = msg.a;
        mergeIndices = [msg.a, msg.b];
        updateActiveSketchId();
        if (myRole === 'screen') {
          loadSketch(msg.a, mergeIndices);
          broadcast({ type: 'state', pattern: currentIndex, merge: mergeIndices, patternId: activeSketchId });
        }
      }
      break;

    case 'devices':
      // Devices changed in some window (localStorage is the source of truth)
      if (myRole === 'screen') applyDevices();
      break;

    case 'params':
      // A param slider moved somewhere — merge into the live store (both
      // windows keep the same store, so the running sketch updates in place).
      if (typeof msg.id === 'string' && msg.values) {
        Object.assign(getParams(msg.id), msg.values);
        saveParamValues();
        // Blend sliders drive the overlay canvas styles on the output and
        // the matching mini-stage inside control windows.
        if (msg.id === BLEND_ID) {
          if (myRole === 'screen') applyBlendStyles();
          if (myRole === 'control') applyPreviewCompositing();
        }
        // Band-split crossovers retune the musical feature extractor
        if (msg.id === BANDS_ID) setBandSplit(getParams(BANDS_ID));
        // Post-processing trim restyles the output wrapper and the panel preview.
        if (msg.id === POSTFX_ID) {
          applyPostFx();
          if (myRole === 'control') applyPreviewCompositing();
        }
        if (myRole === 'control' && panel) panel.applyParam(msg.id, msg.values);
      }
      break;

    case 'spectrum':
      // High-frequency log-spectrum feed for the control panel's band-split
      // EQ (broadcast by the screen ~15fps). Forward and return early — the
      // full syncUI() dance is pointless churn at this message rate.
      if (myRole === 'control' && panel) panel.handleSpectrum(msg);
      return;

    case 'analysis-frame':
      // Full-size cleaned frequency + waveform frame for the embedded preview.
      // This deliberately stays separate from the compact EQ spectrum above.
      if (myRole === 'control') previewAudio.setFrame(msg.frame);
      return;

    case 'noise-capture':
      // Capture requests come from control panels; only the screen owns the
      // audio analyser, so only it runs the sampler.
      if (myRole === 'screen') {
        if (msg.action === 'start') {
          if (!audio.isStarted) {
            broadcast({ type: 'noise-floor', status: 'failed', reason: 'no-audio' });
          } else {
            startNoiseCapture(typeof msg.seconds === 'number' ? msg.seconds : NOISE_CAPTURE_DEFAULT_SECONDS);
            noiseCaptureActive = true;
            lastNoiseProgressAt = 0;
            broadcast({ type: 'noise-floor', status: 'capturing', progress: 0, elapsed: 0, seconds: NOISE_CAPTURE_DEFAULT_SECONDS });
          }
        } else if (msg.action === 'cancel') {
          cancelNoiseCapture();
          noiseCaptureActive = false;
          broadcast({ type: 'noise-floor', status: 'cancelled' });
        }
      }
      return;

    case 'noise-floor':
      // The profile itself lives in localStorage (written by the screen);
      // reload it so this window's subtraction / EQ curve stay in sync.
      if (msg.status === 'ready' || msg.status === 'cleared' || msg.status === 'cancelled') {
        loadNoiseFloor();
      }
      if (myRole === 'control' && panel) panel.setNoiseState(msg);
      return;

    case 'reorder':
      // The pad assignment changed in some window. Positions shift, so keep the
      // currently playing pattern selected (by id) and re-render the panel.
      if (Array.isArray(msg.order) && msg.order.length) {
        const idx = msg.order.indexOf(activeSketchId);
        currentIndex = idx >= 0 ? idx : -1;
        // A live merge selection is positional too — remap it by id so the
        // next key event keeps pointing at the same effects.
        if (mergeIndices && mergeIds) {
          const a = msg.order.indexOf(mergeIds[0]);
          const b = msg.order.indexOf(mergeIds[1]);
          if (a >= 0 && b >= 0) mergeIndices = [a, b];
          else {
            // One merged pattern left the pad — end the merge selection
            mergeIndices = null;
            mergeIds = null;
          }
        }
        if (myRole === 'control' && panel) panel.setOrder();
      }
      break;

    case 'screen-closed':
      screenOnline = false;
      break;
  }

  syncUI();
}

channel.onmessage = (e) => handleMessage(e.data || {});

// Announce ourselves so an existing screen can push its state
broadcast({ type: 'hello', role: myRole, bootTime: MY_BOOT_TIME });

// ---------------------------------------------------------------------------
// Band-split EQ spectrum feed (screen -> control panels)
// The screen owns the audio analyser; control panels have none. While this
// window is the screen it resamples the analysis frame into a compact
// log-spaced dB spectrum and broadcasts it (~15fps) so the control panel's
// EQ section can draw the live spectrum.
// ---------------------------------------------------------------------------

let spectrumRaf = 0;
let lastSpectrumAt = 0;
// True while this screen is running a noise-floor capture; the loop watches
// the sampler for completion and streams progress to the control panels.
let noiseCaptureActive = false;
let lastNoiseProgressAt = 0;

function spectrumLoop(now) {
  spectrumRaf = 0;
  if (myRole !== 'screen') return;
  if (now - lastSpectrumAt >= 66) {
    lastSpectrumAt = now;
    const frame = audio.isStarted ? audio.getAnalysisFrame() : null;
    const spec = frame ? computeLogSpectrum(frame) : null;
    if (spec) broadcast({ type: 'spectrum', ...spec });
    // The live preview needs the full resolution analysis frame (including
    // waveforms); the EQ uses only the much smaller log-spectrum above.
    if (frame) broadcast({ type: 'analysis-frame', frame });
  }

  if (noiseCaptureActive) {
    const cap = getNoiseCaptureState();
    if (!cap.capturing) {
      // feedNoiseCapture() finalised the profile inside getAnalysisFrame.
      noiseCaptureActive = false;
      broadcast({ type: 'noise-floor', status: 'ready', meta: getNoiseFloorMeta() });
    } else if (cap.frames === 0 && cap.elapsed > cap.seconds + 2) {
      // No analysis frames arrived (audio died mid-capture) — give up.
      cancelNoiseCapture();
      noiseCaptureActive = false;
      broadcast({ type: 'noise-floor', status: 'failed', reason: 'no-audio' });
    } else if (now - lastNoiseProgressAt > 250) {
      lastNoiseProgressAt = now;
      broadcast({
        type: 'noise-floor',
        status: 'capturing',
        progress: cap.progress,
        elapsed: cap.elapsed,
        seconds: cap.seconds,
      });
    }
  }

  spectrumRaf = requestAnimationFrame(spectrumLoop);
}

function startSpectrumBroadcast() {
  if (!spectrumRaf) spectrumRaf = requestAnimationFrame(spectrumLoop);
}

function stopSpectrumBroadcast() {
  if (spectrumRaf) cancelAnimationFrame(spectrumRaf);
  spectrumRaf = 0;
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (1-0) — active on control panel windows.
// Gesture model (latched): the FIRST key pressed selects that effect; if a
// SECOND key is pressed while the first is still held, both effects merge and
// the blend STAYS (latched) even after the keys are released. A later single
// key press ends the blend; two overlapping presses start a new one. Extra
// held keys (3+) are ignored to keep the blend target stable.
// ---------------------------------------------------------------------------

// Indices of currently held shortcut keys, in press order.
const heldKeys = [];

window.addEventListener('keydown', (e) => {
  if (myRole !== 'control') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const target = e.target;
  // Only bail when the focused element actually consumes typed characters.
  // Range sliders (and buttons/checkboxes) must NOT block the shortcuts, so
  // 1-0 keep switching/blending effects while a param slider has focus.
  const tag = target && target.tagName;
  const type = target && target.type;
  const isTextEntry =
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (tag === 'INPUT' &&
      ['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week'].includes(type)) ||
    !!(target && target.isContentEditable);
  if (isTextEntry) return;

  // Blend shortcuts (merge mode only): + / - nudge the active level slider,
  // Tab switches between Blend and Additive modes.
  if (mergeIndices) {
    const bp = getParams(BLEND_ID);
    if (e.key === '+' || e.key === '=' || e.key === '-') {
      const activeKey = bp.mode === 1 ? 'add' : 'mix';
      const delta = e.key === '-' ? -0.05 : 0.05;
      const cur = typeof bp[activeKey] === 'number' ? bp[activeKey] : 0.5;
      const next = Math.max(0, Math.min(1, Math.round((cur + delta) * 100) / 100));
      broadcast({ type: 'params', id: BLEND_ID, values: { [activeKey]: next } });
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      broadcast({ type: 'params', id: BLEND_ID, values: { mode: bp.mode === 1 ? 0 : 1 } });
      e.preventDefault();
      return;
    }
  }

  const index = indexFromKey(e.key);
  // Only the first 10 positions have shortcuts (1-9, 0)
  if (index < 0 || index >= getOrderedSketches().length) return;
  if (e.repeat || heldKeys.includes(index)) return;

  if (heldKeys.length === 0) {
    // Single selection — replaces any latched blend
    heldKeys.push(index);
    broadcast({ type: 'pattern', index });
  } else if (heldKeys.length === 1) {
    // Second key while the first is still held -> merge the pair (latched)
    heldKeys.push(index);
    const lo = Math.min(heldKeys[0], index);
    const hi = Math.max(heldKeys[0], index);
    broadcast({ type: 'merge', a: lo, b: hi });
  }
  // 2+ keys already held -> ignore extras
});

window.addEventListener('keyup', (e) => {
  if (myRole !== 'control') return;

  const index = indexFromKey(e.key);
  const pos = heldKeys.indexOf(index);
  if (pos >= 0) heldKeys.splice(pos, 1);
  // No broadcast on release: an started blend is latched until the next press
});

// If the control window loses focus mid-hold its keyup events are lost. The
// latched selection is unaffected, but the held-key bookkeeping must reset so
// the next press isn't mistaken for part of a stale gesture.
window.addEventListener('blur', () => {
  if (myRole !== 'control') return;
  heldKeys.length = 0;
});

// Tell everyone when the screen window closes
window.addEventListener('beforeunload', () => {
  if (myRole === 'screen') {
    channel.postMessage({ type: 'screen-closed' });
  }
});

// ---------------------------------------------------------------------------
// Control panel
// ---------------------------------------------------------------------------

function ensurePanel() {
  if (panel) return;
  panel = new ConfigPanel({
    onPatternChange: (index) => {
      currentIndex = index;
      broadcast({ type: 'pattern', index });
    },
    onPatternChangeId: (id) => {
      // Library-only pattern (not on the pad) — play by id
      broadcast({ type: 'pattern-id', id });
    },
    onDevicesChange: () => broadcast({ type: 'devices' }),
    onOpenScreen: () => openScreenWindow(),
    onParamChange: (id, key, value) => {
      // Local dispatch (via broadcast) updates the store + saves + syncs UI
      broadcast({ type: 'params', id, values: { [key]: value } });
    },
    onReorder: (order) => {
      // Persist + sync the new pad assignment to every window
      saveSlotOrder(order);
      broadcast({ type: 'reorder', order });
    },
    onNoiseCapture: (seconds) => broadcast({ type: 'noise-capture', action: 'start', seconds }),
    onNoiseCancel: () => broadcast({ type: 'noise-capture', action: 'cancel' }),
    onNoiseClear: () => {
      clearNoiseFloor();
      broadcast({ type: 'noise-floor', status: 'cleared' });
    },
    onPreviewReady: (stage) => initPreviewStage(stage),
    onPreviewChange: (selection) => setPreviewSelection(selection),
    getParams,
    getPattern: () => currentIndex,
    isScreen: () => myRole === 'screen',
    isScreenOnline: () => screenOnline,
  });
}

function syncUI() {
  if (myRole === 'control') {
    ensurePanel();
    if (panel) {
      if (mergeIndices) panel.setMerge(mergeIndices);
      else if (currentIndex >= 0) panel.setPattern(currentIndex);
      else panel.setPatternById(activeSketchId);
      panel.setScreenOnline(screenOnline);
    }
  }
}

// Open another control-panel window
function openControlWindow() {
  const url = new URL(window.location.href);
  url.searchParams.set('role', 'control');
  const w = window.open(url.toString(), '_blank', 'width=440,height=820');
  if (w) w.focus();
}

// Open a new screen window (fullstage — drop it on another monitor). Opened
// without size features so the browser gives it a normal tab-sized window.
function openScreenWindow() {
  const url = new URL(window.location.href);
  url.searchParams.set('role', 'screen');
  const w = window.open(url.toString(), '_blank');
  if (w) w.focus();
}

// Small floating toolbar shown on the screen window
function renderScreenToolbar() {
  if (document.getElementById('screen-toolbar')) return;

  const toolbar = document.createElement('div');
  toolbar.id = 'screen-toolbar';
  toolbar.innerHTML = `
    <button id="open-control-btn" title="Open a control panel window"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path></svg>Control Panel</button>
  `;
  document.body.appendChild(toolbar);

  toolbar.querySelector('#open-control-btn').onclick = () => openControlWindow();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Apply any saved band-split crossovers so a reload keeps the tuned borders
// on the feature extractor (later changes ride the 'params' message path).
setBandSplit(getParams(BANDS_ID));

// Apply any saved post-processing trim to the stage wrapper (no-op on
// control windows; later changes ride the 'params' message path).
applyPostFx();

// Restore a captured noise floor so cleaned spectra survive reloads.
loadNoiseFloor();

if (myRole === 'screen') {
  document.title = 'Viz Screen';
  document.body.classList.add('is-screen');
  currentVideoDeviceId = localStorage.getItem(STORAGE.video) || null;
  loadSketch(currentIndex);
  startAudio();
  renderScreenToolbar();
  startSpectrumBroadcast();
} else {
  document.title = 'Viz Control';
  document.body.classList.add('is-control');
  updateActiveSketchId();
  ensurePanel();
  syncUI();
}

// Debug/test hook — lets e2e tests read live state (dev builds only)
if (import.meta.env.DEV) {
  window.__viz = {
    get role() { return myRole; },
    get pattern() { return currentIndex; },
    get patternId() { return activeSketchId; },
    // [a, b] effect indices while two effects are merged, null otherwise
    get merge() { return mergeIndices ? [...mergeIndices] : null; },
    get screenOnline() { return screenOnline; },
    get params() { return getParams(activeSketchId || getOrderedSketches()[0].id); },
    // Live blend params (mix/add) — shared via the BLEND_ID store
    get blend() { return getParams(BLEND_ID); },
    get audioFeatures() { return currentP5?.__audioFeatures || null; },
    // Live band-split crossovers (BANDS_ID param store)
    get bands() { return getParams(BANDS_ID); },
    // Live post-processing trim (POSTFX_ID param store)
    get postfx() { return getParams(POSTFX_ID); },
    // Control-panel band-split EQ internals (control windows only)
    get eq() {
      if (!panel) return null;
      return {
        split: { ...panel.eqSplit },
        drawn: panel.eqDrawn,
        spectrumAt: panel.lastSpectrumAt,
        // Last spectrum message received (cleaned by the screen's noise floor)
        lastSpectrum: panel.eqSpectrum,
      };
    },
    // Noise-floor capture state + stored profile (for tests & debugging)
    get noise() {
      return {
        capturing: isNoiseCapturing(),
        capture: getNoiseCaptureState(),
        profile: getNoiseFloorMeta(),
        sampleDb: (hz) => sampleNoiseFloorDb(hz),
      };
    },
    // Exposed only in Vite development mode so integration tests can inject a
    // deterministic spectrum without requiring microphone permissions.
    audio,
    // DEV only: { key -> last read timestamp } of params the sketch accesses
    readLog: () => devReadLog || {},
  };
}
