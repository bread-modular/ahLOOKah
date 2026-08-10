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
import { ProgramRuntime, copyProgramSelection, selectionsEqual } from './program-runtime.js';
import { SharedCameraSource } from './shared-camera-source.js';
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
// Exactly one control window owns the physical microphone and Web Audio graph.
// Output screens consume its cleaned analysis snapshots through screenAudio.
const audio = new AudioManager();
const screenAudio = new PreviewAudio({ idleSignal: false, staleAfterMs: 750 });
// Control previews use those same snapshots, with a musical idle signal before
// an input is selected or while no capture-owning panel is available.
const previewAudio = new PreviewAudio();

// Legacy selection fields remain as a compatibility projection for the panel,
// existing messages and DEV probes. Rendering itself is owned by ProgramRuntime
// instances below, never by these globals.
let currentP5 = null;
let currentIndex = 0;
let activeSketchId = null;
let mergeIndices = null;
let mergeIds = null;
let mergeP5 = [];

// Screen-side program slots. The output always has at most one LIVE runtime and
// one prepared CUE/incoming runtime, so a merge-to-merge switch caps at four p5
// instances. Controls mirror the screen-authored cue transaction but create no
// full-resolution program runtimes.
let liveRuntime = null;
let cueRuntime = null;
let incomingRuntime = null;
let retiringRuntime = null;
let liveProgram = null;
let cueSession = null;
let screenStage = null;
let stageLiveLayer = null;
let stageCueLayer = null;
let cueStageRaf = 0;
// Control-originated cue mutations are serialized against the screen's
// revision. Slider input can outpace BroadcastChannel acknowledgements, so a
// local queue batches the latest values instead of dropping stale revisions.
let cueMutationRaf = 0;
let cueMutationInFlight = null;
let queuedCueSelection = null;
let queuedCueParams = new Map();
let queuedCueTake = false;
// A Shift + pattern gesture starts CUE with the selected stable id in the same
// request. Until the screen acknowledges it, keep later input out of LIVE.
let cueEntryPending = null;
const canceledCueEntryRequests = new Set();
// The initiating control locks edits as soon as the operator presses TAKE,
// including while its last slider/selection mutation is still in flight. The
// screen echoes the request id when it accepts, rejects, or completes TAKE.
let cueTakeIntent = null;
let runtimeGeneration = 0;
let directGeneration = 0;
let lastCueTimings = [];
const cameraSource = new SharedCameraSource();
const CUE_WARM_TIMEOUT_MS = 12_000;
let currentVideoDeviceId = null;
let currentAudioDeviceId = null;
let screenOnline = myRole === 'screen';
let panel = null;
let lastAudioStatus = audio.getStatus();
let audioRestartTimer = 0;
let isAudioOwner = false;
let wantsAudioOwnership = false;
let audioOwnershipTask = null;
let audioOwnershipAbort = null;
let releaseAudioOwnershipLock = null;
let audioLockHeld = false;
let fallbackLeaseTimer = 0;

const AUDIO_LOCK_NAME = 'viz2_audio_capture_owner';
const AUDIO_LEASE_KEY = 'viz2_audio_capture_lease';
const AUDIO_LEASE_MS = 3_000;

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
let paramRawValues = { ...paramValues };

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

// CUE owns a separate, plain-object parameter bank. Do not clone DEV Proxy
// wrappers: the output runtime needs real object references that can later be
// adopted as the canonical LIVE bank without a second renderer construction.
function visualParamId(id) {
  return id !== BANDS_ID;
}

function cloneCueBank(selection) {
  const bank = {};
  for (const [id, values] of Object.entries(paramRawValues)) {
    if (visualParamId(id) && values && typeof values === 'object') bank[id] = { ...values };
  }
  const ids = Array.isArray(selection?.ids) ? selection.ids : [];
  ids.forEach((id) => {
    if (!bank[id]) bank[id] = { ...defaultParamValues(id) };
  });
  if (!bank[BLEND_ID]) bank[BLEND_ID] = { ...defaultParamValues(BLEND_ID) };
  if (!bank[POSTFX_ID]) bank[POSTFX_ID] = { ...defaultParamValues(POSTFX_ID) };
  return bank;
}

function getCueParams(id) {
  if (!cueSession) return getParams(id);
  if (id === BANDS_ID) return getParams(BANDS_ID);
  if (!cueSession.params[id]) cueSession.params[id] = { ...defaultParamValues(id) };
  return cueSession.params[id];
}

function getEditingParams(id) {
  return cueSession ? getCueParams(id) : getParams(id);
}

function copyVisualParamBank(bank = {}) {
  const copy = {};
  for (const [id, values] of Object.entries(bank)) {
    if (visualParamId(id) && values && typeof values === 'object') copy[id] = { ...values };
  }
  return copy;
}

function adoptVisualParamBank(bank, { preserveReferences = false } = {}) {
  if (!bank) return;
  // Band split remains a system/global setting and never becomes cue-scoped.
  const bands = getParams(BANDS_ID);
  const adopted = preserveReferences ? bank : copyVisualParamBank(bank);
  adopted[BANDS_ID] = bands;
  paramValues = adopted;
  paramRawValues = adopted;
  saveParamValues();
}

function adoptCueBank(session) {
  if (!session?.params) return;
  // The promoted runtime already reads these exact objects, so preserve them in
  // the screen process. Remote controls receive a cloned committed bank.
  adoptVisualParamBank(session.params, { preserveReferences: true });
}

function canonicalLiveParamBank() {
  return copyVisualParamBank(paramRawValues);
}

function canonicalBandValues() {
  return { ...(paramRawValues[BANDS_ID] || defaultParamValues(BANDS_ID)) };
}

function applyCanonicalBandValues(values) {
  if (myRole === 'screen' || !values || typeof values !== 'object') return false;
  const current = getParams(BANDS_ID);
  if (paramObjectsEqual(current, values)) return false;
  Object.assign(current, values);
  saveParamValues();
  setBandSplit(current);
  if (myRole === 'control' && panel) panel.applyParam(BANDS_ID, current);
  return true;
}

function visualParamBanksEqual(left, right) {
  const lhs = copyVisualParamBank(left);
  const rhs = copyVisualParamBank(right);
  const ids = new Set([...Object.keys(lhs), ...Object.keys(rhs)]);
  return [...ids].every((id) => paramObjectsEqual(lhs[id] || {}, rhs[id] || {}));
}

// The screen owns canonical LIVE values. Controls only adopt this snapshot when
// it differs, so ordinary CUE state broadcasts do not rewrite localStorage just
// by reserializing unchanged values. A rejected legacy live-param message can
// therefore be rolled back deterministically in every control window.
function applyCanonicalLiveParamBank(bank) {
  if (myRole === 'screen' || !bank || typeof bank !== 'object') return false;
  if (visualParamBanksEqual(paramRawValues, bank)) return false;
  adoptVisualParamBank(bank);
  if (myRole === 'control' && panel && !cueSession) {
    panel.applyParam(POSTFX_ID, getParams(POSTFX_ID));
    if (panel.currentPatternId) panel.applyParam(panel.currentPatternId, getParams(panel.currentPatternId));
  }
  return true;
}

function isKnownLiveParamId(id) {
  return id === BLEND_ID
    || id === BANDS_ID
    || id === POSTFX_ID
    || SKETCHES.some((sketch) => sketch.id === id);
}

function applyAcceptedLiveParamValues(id, values) {
  Object.assign(getParams(id), values);
  saveParamValues();
  const editingCue = Boolean(cueSession);
  // Blend sliders drive the overlay canvas styles on the output and the
  // matching mini-stage inside control windows. A CUE preview must keep its
  // isolated values if an earlier accepted LIVE message arrives late.
  if (id === BLEND_ID) {
    if (myRole === 'screen') applyBlendStyles();
    if (myRole === 'control' && !editingCue) applyPreviewCompositing();
  }
  // Band-split crossovers are the one system-scoped param group that remains
  // editable while CUE is active.
  if (id === BANDS_ID) setBandSplit(getParams(BANDS_ID));
  // Post-processing is a visual program value, so raw legacy messages for it
  // are screened out during CUE; accepted LIVE updates style the right surface.
  if (id === POSTFX_ID) {
    applyPostFx();
    if (myRole === 'control' && !editingCue) applyPreviewCompositing();
  }
  if (myRole === 'control' && panel && (!editingCue || id === BANDS_ID)) {
    panel.applyParam(id, values);
  }
}

function recordCueTiming(name, detail = {}) {
  const entry = { name, at: performance.now(), ...detail };
  lastCueTimings.push(entry);
  if (lastCueTimings.length > 30) lastCueTimings.shift();
}

// ---------------------------------------------------------------------------
// Screen runtime
// ---------------------------------------------------------------------------

function singleSelection(id) {
  return { ids: id ? [id] : [], merge: false };
}

function mergeSelection(ids) {
  return { ids: Array.isArray(ids) ? ids.filter(Boolean).slice(0, 2) : [], merge: true };
}

function selectionFromIndices(index, merge = null) {
  const ordered = getOrderedSketches();
  if (Array.isArray(merge) && merge.length === 2) {
    const ids = merge.map((position) => ordered[position]?.id);
    return ids.every(Boolean) ? mergeSelection(ids) : null;
  }
  return ordered[index] ? singleSelection(ordered[index].id) : null;
}

function selectionFromId(id) {
  return SKETCHES.some((sketch) => sketch.id === id) ? singleSelection(id) : null;
}

// Validate a selection sent with the atomic CUE-entry request. Canonical sketch
// ids keep the request stable if a control's pad order changes in transit.
function validCueSelection(selection) {
  const candidate = copyProgramSelection(selection);
  const ids = candidate.ids || [];
  if (!ids.length || !ids.every((id) => SKETCHES.some((sketch) => sketch.id === id))) return null;
  if (candidate.merge ? ids.length !== 2 : ids.length !== 1) return null;
  return candidate;
}

function selectionIndices(selection) {
  const ordered = getOrderedSketches();
  return selection?.ids?.map((id) => ordered.findIndex((sketch) => sketch.id === id)) || [];
}

function selectionName(selection) {
  const names = (selection?.ids || [])
    .map((id) => SKETCHES.find((sketch) => sketch.id === id)?.name || id)
    .filter(Boolean);
  return names.join(selection?.merge ? ' + ' : '') || 'No program';
}

function paramObjectsEqual(left = {}, right = {}) {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  return [...keys].every((key) => key.startsWith('__') || left[key] === right[key]);
}

// A selection matching LIVE can still need a staged runtime when its selected
// effect params, merge mix, or post-processing bank differ from the program.
function cueRequiresRuntime(session) {
  if (!session?.selection) return false;
  if (!selectionsEqual(session.selection, currentLiveSelection())) return true;
  for (const id of session.selection.ids || []) {
    if (!paramObjectsEqual(session.params?.[id], getParams(id))) return true;
  }
  if (session.selection.merge && !paramObjectsEqual(session.params?.[BLEND_ID], getParams(BLEND_ID))) return true;
  return !paramObjectsEqual(session.params?.[POSTFX_ID], getParams(POSTFX_ID));
}

function syncLegacyLiveProjection() {
  const selection = liveProgram;
  if (!selection?.ids?.length) return;
  const indices = selectionIndices(selection);
  activeSketchId = selection.ids[0] || null;
  if (selection.merge && indices.length === 2 && indices.every((index) => index >= 0)) {
    currentIndex = indices[0];
    mergeIndices = indices;
    mergeIds = [...selection.ids];
  } else {
    currentIndex = indices[0] ?? -1;
    mergeIndices = null;
    mergeIds = null;
  }
  currentP5 = liveRuntime?.primary || null;
  mergeP5 = liveRuntime?.merge ? [...liveRuntime.instances] : [];
}

function currentLiveSelection() {
  if (liveProgram?.ids?.length) return copyProgramSelection(liveProgram);
  return selectionFromIndices(currentIndex, mergeIndices) || singleSelection(activeSketchId || getOrderedSketches()[0]?.id);
}

function ensureScreenStage() {
  if (screenStage && stageLiveLayer && stageCueLayer) return screenStage;
  let wrap = document.getElementById('screen-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'screen-wrap';
    document.body.appendChild(wrap);
  }
  wrap.classList.add('program-stage');

  let liveLayer = wrap.querySelector('[data-program-slot="live"]');
  let cueLayer = wrap.querySelector('[data-program-slot="cue"]');
  if (!liveLayer) {
    liveLayer = document.createElement('div');
    liveLayer.dataset.programSlot = 'live';
    wrap.appendChild(liveLayer);
  }
  if (!cueLayer) {
    cueLayer = document.createElement('div');
    cueLayer.dataset.programSlot = 'cue';
    wrap.appendChild(cueLayer);
  }
  liveLayer.className = 'program-layer program-layer-live';
  cueLayer.className = 'program-layer program-layer-cue';
  screenStage = wrap;
  stageLiveLayer = liveLayer;
  stageCueLayer = cueLayer;
  return wrap;
}

function setLayerRoles(liveLayer, cueLayer) {
  if (liveLayer) {
    liveLayer.classList.remove('program-layer-cue', 'program-layer-retiring');
    liveLayer.classList.add('program-layer-live');
    liveLayer.dataset.programRole = 'live';
  }
  if (cueLayer) {
    cueLayer.classList.remove('program-layer-live', 'program-layer-retiring');
    cueLayer.classList.add('program-layer-cue');
    cueLayer.dataset.programRole = 'cue';
  }
}

function createRuntime(selection, getBankParams, layer, reason = 'cue') {
  return new ProgramRuntime({
    p5Constructor: p5,
    selection,
    sketches: SKETCHES,
    audio: screenAudio,
    videoDeviceId: currentVideoDeviceId,
    getParams: getBankParams,
    layer,
    cameraSource,
    generation: ++runtimeGeneration,
    warmTimeoutMs: CUE_WARM_TIMEOUT_MS,
    onTiming: (name, detail) => recordCueTiming(name, { reason, ...detail }),
  });
}

function disposeRuntime(runtime) {
  if (!runtime) return;
  runtime.dispose();
}

// Retained for the role-switch lifecycle. It deliberately tears down all slots
// only when this window stops being a screen; normal program changes prepare
// their replacement first and never call this path.
function removeCurrentP5() {
  if (cueStageRaf) cancelAnimationFrame(cueStageRaf);
  cueStageRaf = 0;
  disposeRuntime(incomingRuntime);
  disposeRuntime(cueRuntime);
  disposeRuntime(retiringRuntime);
  disposeRuntime(liveRuntime);
  incomingRuntime = null;
  cueRuntime = null;
  retiringRuntime = null;
  liveRuntime = null;
  currentP5 = null;
  mergeP5 = [];
  cameraSource.dispose();
}

// Push blend values onto a supplied program layer. The old no-argument shape is
// intentionally preserved for existing callers and DEV/manual checks.
function applyBlendStyles(runtime = liveRuntime) {
  runtime?.applyBlendStyles();
}

// ---------------------------------------------------------------------------
// Post-processing (brightness / contrast / saturation)
// ---------------------------------------------------------------------------

function postFxFilterString(resolve = getParams) {
  const p = resolve(POSTFX_ID) || {};
  const b = Number(p.brightness) || 0;
  const c = Number(p.contrast) || 0;
  const s = Number(p.saturation) || 0;
  if (!b && !c && !s) return 'none';
  return `brightness(${(100 + b) / 100}) contrast(${(100 + c) / 100}) saturate(${(100 + s) / 100})`;
}

function applyPostFx() {
  if (myRole !== 'screen') return;
  const wrap = ensureScreenStage();
  if (cueSession) {
    // Separate filters are what make post-processing a cue-scoped visual value.
    wrap.style.filter = 'none';
    liveRuntime?.setFilter(postFxFilterString(getParams));
    cueRuntime?.setFilter(postFxFilterString(getCueParams));
    incomingRuntime?.setFilter(postFxFilterString(getParams));
  } else {
    // Keep the legacy wrapper filter in normal LIVE mode for the existing stage
    // contract, while every runtime layer itself remains unfiltered.
    wrap.style.filter = postFxFilterString(getParams);
    liveRuntime?.setFilter('none');
    incomingRuntime?.setFilter('none');
  }
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

  // The embedded preview follows the current editing scope: LIVE normally and
  // the isolated CUE bank while a cue transaction is active.
  previewStage.style.filter = postFxFilterString(getEditingParams);

  previewP5.forEach((inst, index) => {
    const canvas = inst && inst.canvas;
    if (!canvas) return;
    canvas.style.zIndex = String(index);
    if (previewP5.length === 2 && index === 1) {
      const blend = getEditingParams(BLEND_ID);
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

  const factory = sketch.factory(previewAudio, null, getEditingParams(sketch.id));
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
    previewStage.innerHTML = `<div class="preview-empty">${cueSession ? 'CAMERA CUE STAGED ON OUTPUT' : 'Camera effect — live video remains on the output screen.'}</div>`;
    return;
  }

  const active = previewSelection.merge ? renderable.slice(0, 2) : renderable.slice(0, 1);
  const generation = previewGeneration;
  active.forEach((sketch, layer) => createPreviewInstance(sketch, layer, generation));

  if (cameraSketches.length) {
    const note = document.createElement('div');
    note.className = 'preview-camera-note';
    note.textContent = cueSession ? 'CAMERA CUE STAGED ON OUTPUT' : 'Camera layer stays on the output screen.';
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

function initialLiveRuntime(selection) {
  ensureScreenStage();
  liveProgram = copyProgramSelection(selection);
  setLayerRoles(stageLiveLayer, stageCueLayer);
  const runtime = createRuntime(selection, getParams, stageLiveLayer, 'initial-live');
  liveRuntime = runtime;
  syncLegacyLiveProjection();
  applyPostFx();
  runtime.prepare()
    .then(() => {
      if (runtime !== liveRuntime) return;
      applyPostFx();
      broadcastLiveState();
    })
    .catch((error) => {
      console.error('Unable to start live program:', error);
    });
}

async function promotePreparedRuntime(runtime, { directToken = null, cue = null, onPromoted = null } = {}) {
  try {
    await runtime.requestFreshFrame();
  } catch (error) {
    throw error;
  }

  return new Promise((resolve, reject) => {
    requestAnimationFrame(() => {
      if (runtime.disposed) {
        reject(new Error('Prepared program was disposed before promotion.'));
        return;
      }
      if (directToken !== null && directToken !== directGeneration) {
        reject(new Error('Prepared program was superseded.'));
        return;
      }
      if (cue && (cueSession !== cue
        || cueRuntime !== runtime
        || cue.revision !== cue.pendingRevision
        || cue.renderedRevision !== cue.pendingRevision
        || cue.selectionGeneration !== cue.pendingSelectionGeneration
        || !selectionsEqual(cue.selection, runtime.selection))) {
        reject(new Error('Cue promotion was superseded.'));
        return;
      }

      const oldLive = liveRuntime;
      const oldLiveLayer = stageLiveLayer;
      const promotedLayer = runtime.layer;
      liveRuntime = runtime;
      incomingRuntime = incomingRuntime === runtime ? null : incomingRuntime;
      cueRuntime = cueRuntime === runtime ? null : cueRuntime;
      stageLiveLayer = promotedLayer;
      stageCueLayer = oldLiveLayer;
      setLayerRoles(stageLiveLayer, stageCueLayer);
      liveProgram = copyProgramSelection(runtime.selection);
      syncLegacyLiveProjection();
      recordCueTiming('role-visibility-swap', { ids: runtime.selection.ids });
      // A cue bank becomes canonical only after the role swap is committed.
      // Doing this before styling prevents one frame of old LIVE post-FX.
      onPromoted?.();
      applyPostFx();

      // The promoted canvas is visible before its predecessor is removed. The
      // next frame keeps normal switches from ever exposing an empty stage.
      retiringRuntime = oldLive && oldLive !== runtime ? oldLive : null;
      requestAnimationFrame(() => {
        if (retiringRuntime === oldLive) {
          disposeRuntime(oldLive);
          retiringRuntime = null;
        }
      });
      resolve(runtime);
    });
  });
}

function prepareThenPromoteLive(selection, { force = false } = {}) {
  if (myRole !== 'screen' || !selection?.ids?.length) return;
  if (!liveRuntime) {
    initialLiveRuntime(selection);
    return;
  }
  if (!force && selectionsEqual(selection, liveProgram) && !incomingRuntime) return;

  ensureScreenStage();
  const token = ++directGeneration;
  disposeRuntime(incomingRuntime);
  disposeRuntime(retiringRuntime);
  retiringRuntime = null;
  incomingRuntime = createRuntime(selection, getParams, stageCueLayer, 'direct-live');
  applyPostFx();
  const runtime = incomingRuntime;
  runtime.prepare()
    .then(() => promotePreparedRuntime(runtime, { directToken: token }))
    .then(() => {
      if (token !== directGeneration) return;
      broadcastLiveState();
    })
    .catch((error) => {
      if (runtime.disposed || token !== directGeneration) return;
      console.error('Unable to prepare requested live program:', error);
      disposeRuntime(runtime);
      if (incomingRuntime === runtime) incomingRuntime = null;
      applyPostFx();
      broadcastLiveState();
    });
}

function loadSketch(index, merge = null) {
  const selection = selectionFromIndices(index, merge);
  if (!selection) return;
  prepareThenPromoteLive(selection);
}

function loadSketchById(id) {
  const selection = selectionFromId(id);
  if (!selection) return;
  prepareThenPromoteLive(selection);
}

function updateActiveSketchId() {
  const selection = selectionFromIndices(currentIndex, mergeIndices);
  if (!selection) return;
  activeSketchId = selection.ids[0] || null;
  mergeIds = selection.merge ? [...selection.ids] : null;
}

function cueStatePayload() {
  if (!cueSession) return null;
  const params = {};
  for (const [id, values] of Object.entries(cueSession.params || {})) {
    if (id !== BANDS_ID) params[id] = { ...values };
  }
  return {
    sessionId: cueSession.sessionId,
    entryRequestId: cueSession.entryRequestId || null,
    revision: cueSession.revision,
    selection: copyProgramSelection(cueSession.selection),
    phase: cueSession.phase,
    takePending: Boolean(cueSession.takePending),
    takeRequestId: cueSession.takeRequestId || null,
    renderedRevision: cueSession.renderedRevision ?? null,
    pendingRevision: cueSession.pendingRevision ?? null,
    selectionGeneration: cueSession.selectionGeneration || 0,
    pendingSelectionGeneration: cueSession.pendingSelectionGeneration ?? null,
    error: cueSession.error || null,
    params,
  };
}

function broadcastLiveState() {
  const selection = currentLiveSelection();
  const indices = selectionIndices(selection);
  broadcast({
    type: 'state',
    pattern: selection.merge ? indices[0] : (indices[0] ?? -1),
    merge: selection.merge ? indices : null,
    patternId: selection.ids[0] || null,
    live: copyProgramSelection(selection),
    // Snapshot is screen-authored: it repairs a control that received a stale
    // unscoped LIVE parameter message after CUE began.
    liveParams: canonicalLiveParamBank(),
    bands: canonicalBandValues(),
    cue: cueStatePayload(),
  });
}

function broadcastCueState(notice = '', committedParams = null, acknowledgement = {}) {
  broadcast({
    type: 'cue-state',
    cue: cueStatePayload(),
    notice,
    live: currentLiveSelection(),
    liveParams: canonicalLiveParamBank(),
    bands: canonicalBandValues(),
    committedParams: committedParams ? copyVisualParamBank(committedParams) : null,
    takeRequestId: acknowledgement.takeRequestId || cueSession?.takeRequestId || null,
    rejectedTakeRequestId: acknowledgement.rejectedTakeRequestId || null,
  });
}

function mergeCueParamsInPlace(target, source) {
  const incoming = source || {};
  Object.keys(target).forEach((id) => {
    if (id !== BANDS_ID && !(id in incoming)) delete target[id];
  });
  for (const [id, values] of Object.entries(incoming)) {
    if (id === BANDS_ID) continue;
    if (!target[id]) target[id] = {};
    for (const key of Object.keys(target[id])) {
      if (!(key in values)) delete target[id][key];
    }
    Object.assign(target[id], values);
  }
}

function cueEditsLocked() {
  return Boolean(
    cueSession?.takePending
    || (myRole === 'control'
      && cueTakeIntent
      && cueTakeIntent.sessionId === cueSession?.sessionId),
  );
}

function panelCueState() {
  const payload = cueStatePayload();
  if (!payload || !cueTakeIntent || cueTakeIntent.sessionId !== payload.sessionId || payload.takePending) return payload;
  // The initiating panel has committed to TAKE even before the screen's
  // acknowledgement crosses the BroadcastChannel. Render the same locked UI
  // immediately, while retaining CANCEL as the one available escape hatch.
  return {
    ...payload,
    takePending: true,
    phase: 'take-pending',
  };
}

function settleCueTakeIntent(payload, acknowledgement = {}) {
  if (myRole !== 'control' || !cueTakeIntent) return;
  const requestId = cueTakeIntent.requestId;
  if (!payload || payload.sessionId !== cueTakeIntent.sessionId) {
    cueTakeIntent = null;
    return;
  }
  if (payload.takeRequestId === requestId
    || acknowledgement.takeRequestId === requestId
    || acknowledgement.rejectedTakeRequestId === requestId
    || payload.phase === 'error') {
    cueTakeIntent = null;
  }
}

function applyReceivedCueState(payload, notice = '', acknowledgement = {}) {
  if (!payload) {
    cueSession = null;
    clearCueMutationQueue();
    if (myRole === 'control') {
      queuePreviewRender();
      syncUI(notice);
    }
    applyPostFx();
    return;
  }

  if (cueSession?.sessionId === payload.sessionId) {
    cueSession.entryRequestId = payload.entryRequestId || cueSession.entryRequestId || null;
    cueSession.revision = payload.revision;
    cueSession.selection = copyProgramSelection(payload.selection);
    cueSession.phase = payload.phase;
    cueSession.takePending = Boolean(payload.takePending);
    cueSession.takeRequestId = payload.takeRequestId || null;
    cueSession.renderedRevision = payload.renderedRevision ?? cueSession.renderedRevision ?? null;
    cueSession.pendingRevision = payload.pendingRevision;
    cueSession.selectionGeneration = payload.selectionGeneration ?? cueSession.selectionGeneration ?? 0;
    cueSession.pendingSelectionGeneration = payload.pendingSelectionGeneration ?? null;
    cueSession.error = payload.error || null;
    mergeCueParamsInPlace(cueSession.params, payload.params);
  } else {
    cueSession = {
      sessionId: payload.sessionId,
      entryRequestId: payload.entryRequestId || null,
      revision: payload.revision,
      selection: copyProgramSelection(payload.selection),
      params: cloneCueBank(payload.selection),
      phase: payload.phase,
      takePending: Boolean(payload.takePending),
      takeRequestId: payload.takeRequestId || null,
      renderedRevision: payload.renderedRevision ?? null,
      pendingRevision: payload.pendingRevision,
      selectionGeneration: payload.selectionGeneration || 0,
      pendingSelectionGeneration: payload.pendingSelectionGeneration ?? null,
      error: payload.error || null,
      runtimeRequired: !selectionsEqual(payload.selection, currentLiveSelection()),
    };
    mergeCueParamsInPlace(cueSession.params, payload.params);
  }

  // A Shift gesture may be followed by another pattern input before the screen
  // has created the session. Keep that latest target cue-scoped and flush it
  // only after the matching entry acknowledgement arrives.
  if (myRole === 'control' && cueEntryPending) {
    const pending = cueEntryPending;
    if (payload.entryRequestId === pending.requestId) {
      cueEntryPending = null;
      if (!selectionsEqual(payload.selection, pending.selection)) {
        queueCueSelectionChange(pending.selection);
      }
    } else if (payload.entryRequestId) {
      // Another control owns the accepted CUE transaction; never let this
      // panel's pre-ack gesture fall through to an unintended LIVE switch.
      cueEntryPending = null;
    }
  }

  settleCueTakeIntent(payload, acknowledgement);
  acknowledgeCueMutation(payload);
  applyPostFx();
  if (myRole === 'control') {
    queuePreviewRender();
    syncUI(notice);
  }
}

function enterCueSession(initiatorId, requestedSelection = null, entryRequestId = null) {
  if (myRole !== 'screen' || cueSession || !liveRuntime) return;
  if (entryRequestId && canceledCueEntryRequests.delete(entryRequestId)) return;

  // Manual CUE takes ownership of the only hidden slot. Abort an in-flight
  // automatic/direct replacement before creating the session to preserve the
  // strict LIVE + one CUE context cap.
  directGeneration += 1;
  disposeRuntime(incomingRuntime);
  disposeRuntime(retiringRuntime);
  incomingRuntime = null;
  retiringRuntime = null;
  // Shift + selection supplies a stable-id candidate up front, avoiding an
  // intermediate same-as-live session and any opportunity to mutate LIVE.
  const selection = validCueSelection(requestedSelection) || currentLiveSelection();
  cueSession = {
    sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    entryRequestId,
    revision: 0,
    initiatorId,
    selection,
    params: cloneCueBank(selection),
    phase: 'same',
    takePending: false,
    takeRequestId: null,
    // The revision known to have a complete output frame. It gates READY and
    // TAKE after parameter edits without rebuilding the existing runtime.
    renderedRevision: 0,
    pendingRevision: null,
    selectionGeneration: 0,
    pendingSelectionGeneration: null,
    error: null,
    runtimeRequired: false,
  };
  cueSession.runtimeRequired = cueRequiresRuntime(cueSession);
  if (cueSession.runtimeRequired) {
    cueSession.phase = 'warming';
    cueSession.renderedRevision = null;
  }
  recordCueTiming('cue-entered', { sessionId: cueSession.sessionId, ids: selection.ids });
  applyPostFx();
  broadcastCueState();
  if (cueSession.runtimeRequired) queueCueRuntime();
}

function isAcceptedCueRequest(msg) {
  return myRole === 'screen'
    && cueSession
    && msg.sessionId === cueSession.sessionId
    && (msg.baseRevision === undefined || msg.baseRevision === cueSession.revision)
    && !cueSession.takePending;
}

function isCueVisualParamId(session, id) {
  if (!session || typeof id !== 'string' || id === BANDS_ID) return false;
  if (id === POSTFX_ID) return true;
  if (id === BLEND_ID) return Boolean(session.selection?.merge);
  return Boolean(session.selection?.ids?.includes(id));
}

function queueCueRuntime() {
  if (myRole !== 'screen' || !cueSession) return;
  if (cueStageRaf) cancelAnimationFrame(cueStageRaf);
  cueStageRaf = requestAnimationFrame(() => {
    cueStageRaf = 0;
    stageCueRuntime();
  });
}

function isCurrentCueRuntime(session, runtime, selectionGeneration, revision = null) {
  return cueSession === session
    && cueRuntime === runtime
    && !runtime.disposed
    && session.selectionGeneration === selectionGeneration
    && selectionsEqual(session.selection, runtime.selection)
    && (revision === null || session.revision === revision);
}

function failCueRuntime(session, runtime, selectionGeneration, revision, error) {
  if (!isCurrentCueRuntime(session, runtime, selectionGeneration, revision)) return;
  disposeRuntime(runtime);
  if (cueRuntime === runtime) cueRuntime = null;
  session.takePending = false;
  session.takeRequestId = null;
  session.pendingRevision = null;
  session.pendingSelectionGeneration = null;
  session.promoting = false;
  session.phase = 'error';
  session.error = error?.message || 'Cue warm-up failed.';
  recordCueTiming('cue-error', { sessionId: session.sessionId, revision: session.revision, message: session.error });
  applyPostFx();
  broadcastCueState('CUE ERROR');
}

function settleCueRuntimeRevision(session, runtime, selectionGeneration) {
  if (!isCurrentCueRuntime(session, runtime, selectionGeneration)) return;
  // A runtime's initial READY is insufficient after a later parameter edit:
  // `renderedRevision` must identify the exact candidate revision that drew.
  if (!runtime.ready || session.renderedRevision !== session.revision) {
    session.phase = session.takePending ? 'take-pending' : 'warming';
    broadcastCueState();
    return;
  }

  // The hidden program may only be parked once its readiness contract is true,
  // including camera media-ready followed by a drawing pass. A queued fresh
  // frame takes precedence over noLoop so an old edit cannot pause a newer one.
  if (!runtime.hasPendingFreshFrame) runtime.pause();

  if (session.takePending) {
    session.phase = 'take-pending';
    broadcastCueState('TAKE PENDING — WARMING');
    if (session.pendingRevision === session.revision
      && session.pendingSelectionGeneration === selectionGeneration) {
      takeCueSession(session, session.takeRequestId);
    }
    return;
  }

  session.phase = 'ready';
  recordCueTiming('cue-ready', { sessionId: session.sessionId, revision: session.revision });
  broadcastCueState('CUE READY');
}

function requestCueRevisionFrame(session, runtime, selectionGeneration, revision) {
  runtime.applyBlendStyles();
  applyPostFx();
  // ProgramRuntime refuses to park until its own readiness contract is met.
  // This keeps a warming camera looping until a current media frame has been
  // observed and subsequently drawn.
  runtime.requestFreshFrame(4_000, { parkAfter: true })
    .then(() => {
      // Completion belongs to the exact accepted revision. An older coalesced
      // frame must never turn a newer slider value READY or trigger its TAKE.
      if (!isCurrentCueRuntime(session, runtime, selectionGeneration, revision)) return;
      session.renderedRevision = revision;
      settleCueRuntimeRevision(session, runtime, selectionGeneration);
    })
    .catch((error) => failCueRuntime(session, runtime, selectionGeneration, revision, error));
}

function stageCueRuntime() {
  if (myRole !== 'screen' || !cueSession) return;
  const session = cueSession;
  const revision = session.revision;
  const selectionGeneration = session.selectionGeneration || 0;
  const sameAsLive = selectionsEqual(session.selection, currentLiveSelection()) && !session.runtimeRequired;

  disposeRuntime(cueRuntime);
  cueRuntime = null;
  if (sameAsLive) {
    session.phase = 'same';
    session.renderedRevision = session.revision;
    session.error = null;
    applyPostFx();
    broadcastCueState();
    return;
  }

  ensureScreenStage();
  session.phase = session.takePending ? 'take-pending' : 'warming';
  session.renderedRevision = null;
  session.error = null;
  const runtime = createRuntime(session.selection, getCueParams, stageCueLayer, 'cue');
  cueRuntime = runtime;
  applyPostFx();
  broadcastCueState();
  recordCueTiming('cue-runtime-requested', { sessionId: session.sessionId, revision });

  runtime.prepare()
    .then(() => {
      // Parameter edits may advance the revision while this same selection is
      // warming. The initial readiness draw only proves the construction
      // revision; later edits install their own fresh-frame gate below.
      if (!isCurrentCueRuntime(session, runtime, selectionGeneration)) return;
      if (session.revision === revision) session.renderedRevision = revision;
      settleCueRuntimeRevision(session, runtime, selectionGeneration);
    })
    .catch((error) => failCueRuntime(session, runtime, selectionGeneration, revision, error));
}

function resyncRejectedCueRequest(msg) {
  if (myRole === 'screen' && cueSession && msg.sessionId === cueSession.sessionId) broadcastCueState();
}

function updateCueSelection(msg) {
  if (!isAcceptedCueRequest(msg)) {
    resyncRejectedCueRequest(msg);
    return;
  }
  const nextSelection = validCueSelection(msg.selection);
  if (!nextSelection) {
    broadcastCueState();
    return;
  }
  if (selectionsEqual(nextSelection, cueSession.selection)) {
    // Acknowledge duplicate/coalesced controls with a new monotonic revision
    // without rebuilding the renderer. If a prior edit was still freshening,
    // bind a new frame to this revision rather than letting that old callback
    // mark this later acknowledgement READY.
    cueSession.revision += 1;
    const session = cueSession;
    const revision = session.revision;
    const selectionGeneration = session.selectionGeneration || 0;
    if (session.runtimeRequired && cueRuntime) {
      session.renderedRevision = null;
      session.phase = 'warming';
      requestCueRevisionFrame(session, cueRuntime, selectionGeneration, revision);
    } else {
      session.renderedRevision = revision;
    }
    broadcastCueState();
    return;
  }
  // Invalidate immediately, not on the next rAF: an old asynchronous ready
  // callback must never be eligible for promotion after a new selection.
  if (cueStageRaf) cancelAnimationFrame(cueStageRaf);
  cueStageRaf = 0;
  disposeRuntime(cueRuntime);
  cueRuntime = null;
  cueSession.selection = nextSelection;
  cueSession.selectionGeneration = (cueSession.selectionGeneration || 0) + 1;
  cueSession.revision += 1;
  cueSession.renderedRevision = null;
  cueSession.error = null;
  cueSession.runtimeRequired = cueRequiresRuntime(cueSession);
  cueSession.phase = cueSession.runtimeRequired ? 'warming' : 'same';
  queueCueRuntime();
  broadcastCueState();
}

function updateCueParams(msg) {
  if (!isAcceptedCueRequest(msg)) {
    resyncRejectedCueRequest(msg);
    return;
  }
  const changes = Array.isArray(msg.changes)
    ? msg.changes
    : [{ id: msg.id, values: msg.values }];
  const valid = changes.filter((change) =>
    typeof change?.id === 'string'
      && isCueVisualParamId(cueSession, change.id)
      && change.values
      && typeof change.values === 'object',
  );
  if (!valid.length) {
    broadcastCueState();
    return;
  }

  for (const { id, values } of valid) {
    const target = getCueParams(id);
    for (const [key, value] of Object.entries(values)) {
      if (target[key] !== value) target[key] = value;
    }
  }
  // A single accepted message is one canonical revision even when it batches
  // a reset's three post-FX values. A no-op re-emission still gets a fresh-frame
  // gate: it may have arrived while a prior accepted revision was still drawing.
  cueSession.revision += 1;
  const session = cueSession;
  const revision = session.revision;
  const selectionGeneration = session.selectionGeneration || 0;
  session.error = null;
  session.runtimeRequired = cueRequiresRuntime(session);
  if (!session.runtimeRequired) {
    if (cueStageRaf) cancelAnimationFrame(cueStageRaf);
    cueStageRaf = 0;
    disposeRuntime(cueRuntime);
    cueRuntime = null;
    session.renderedRevision = revision;
    session.phase = 'same';
    applyPostFx();
    broadcastCueState();
    return;
  }

  // Parameter-only changes mutate the same runtime objects, but READY must not
  // be advertised until a frame for this exact revision has made it through the
  // output compositor. This is deliberately WARMING even when construction was
  // already READY.
  session.renderedRevision = null;
  session.phase = 'warming';
  if (cueRuntime) {
    requestCueRevisionFrame(session, cueRuntime, selectionGeneration, revision);
  } else {
    queueCueRuntime();
  }
  broadcastCueState();
}

function cancelCueSession(notice = 'CUE CANCELED') {
  if (myRole !== 'screen' || !cueSession) return;
  if (cueStageRaf) cancelAnimationFrame(cueStageRaf);
  cueStageRaf = 0;
  disposeRuntime(cueRuntime);
  cueRuntime = null;
  cueSession = null;
  applyPostFx();
  recordCueTiming('cue-canceled');
  broadcastCueState(notice);
  broadcastLiveState();
}

function cancelCueEntryRequest(entryRequestId) {
  if (myRole !== 'screen' || !entryRequestId) return;
  if (cueSession?.entryRequestId === entryRequestId) {
    cancelCueSession();
    return;
  }
  // BroadcastChannel ordering normally makes this unnecessary, but retain a
  // short bounded tombstone so an Escape that races an entry never creates CUE.
  canceledCueEntryRequests.add(entryRequestId);
  while (canceledCueEntryRequests.size > 32) {
    canceledCueEntryRequests.delete(canceledCueEntryRequests.values().next().value);
  }
}

async function takeCueSession(session = cueSession, takeRequestId = null) {
  if (myRole !== 'screen' || !session || session !== cueSession || session.promoting) return;
  if (session.phase === 'error') {
    // RETRY CUE is intentionally not a TAKE lock: the failed renderer is gone
    // and the operator may edit/cancel the new warm-up normally.
    session.takePending = false;
    session.takeRequestId = null;
    session.pendingRevision = null;
    session.pendingSelectionGeneration = null;
    session.renderedRevision = null;
    session.phase = 'warming';
    session.error = null;
    queueCueRuntime();
    broadcastCueState();
    return;
  }

  const wasPending = session.takePending;
  const requestId = wasPending
    ? (session.takeRequestId || takeRequestId || null)
    : (takeRequestId || session.takeRequestId || null);
  if (session.phase === 'same' && !cueRuntime) {
    // A same-as-live cue is already the live program; there is no replacement
    // renderer to promote. It still ends as an acknowledged TAKE transaction.
    cueSession = null;
    applyPostFx();
    broadcastCueState('CUE TAKEN LIVE', null, { takeRequestId: requestId });
    broadcastLiveState();
    return;
  }

  session.takePending = true;
  session.takeRequestId = requestId;
  session.pendingRevision = session.revision;
  session.pendingSelectionGeneration = session.selectionGeneration || 0;
  session.phase = 'take-pending';
  if (!wasPending) {
    recordCueTiming('take-requested', { sessionId: session.sessionId, revision: session.revision });
  }
  broadcastCueState('TAKE PENDING — WARMING');

  // `runtime.ready` only proves construction. Parameter edits after that point
  // must also complete their revision-bound fresh-frame gate before promotion.
  if (!cueRuntime
    || !cueRuntime.ready
    || session.renderedRevision !== session.pendingRevision
    || cueRuntime.hasPendingFreshFrame) return;

  const runtime = cueRuntime;
  session.promoting = true;
  try {
    await promotePreparedRuntime(runtime, { cue: session, onPromoted: () => adoptCueBank(session) });
  } catch (error) {
    if (cueSession !== session || runtime.disposed) return;
    session.promoting = false;
    session.takePending = false;
    session.pendingRevision = null;
    session.pendingSelectionGeneration = null;
    session.phase = 'error';
    session.error = error?.message || 'Unable to take cue live.';
    broadcastCueState('CUE ERROR', null, { takeRequestId: requestId });
    return;
  }

  if (cueSession !== session) return;
  const committedParams = session.params;
  cueSession = null;
  applyPostFx();
  recordCueTiming('cue-taken-live', { ids: liveProgram?.ids || [] });
  // Every control receives the exact committed visual bank before it drops its
  // local cue state, so previews/sliders cannot revert to stale LIVE objects.
  broadcastCueState('CUE TAKEN LIVE', committedParams, { takeRequestId: requestId });
  broadcastLiveState();
}

function clearCueMutationQueue() {
  if (cueMutationRaf) cancelAnimationFrame(cueMutationRaf);
  cueMutationRaf = 0;
  cueMutationInFlight = null;
  queuedCueSelection = null;
  queuedCueParams.clear();
  queuedCueTake = false;
  cueTakeIntent = null;
}

function scheduleCueMutationFlush() {
  if (cueMutationRaf || cueMutationInFlight || !cueSession || cueSession.takePending) return;
  cueMutationRaf = requestAnimationFrame(() => {
    cueMutationRaf = 0;
    flushCueMutationQueue();
  });
}

function flushCueMutationQueue() {
  if (!cueSession || cueSession.takePending || cueMutationInFlight) return;
  const sessionId = cueSession.sessionId;
  const baseRevision = cueSession.revision;

  if (queuedCueSelection) {
    const selection = queuedCueSelection;
    queuedCueSelection = null;
    cueMutationInFlight = { sessionId, baseRevision, type: 'selection' };
    broadcast({ type: 'cue-selection', sessionId, baseRevision, selection });
    return;
  }

  if (queuedCueParams.size) {
    const changes = [...queuedCueParams.entries()].map(([id, values]) => ({ id, values }));
    queuedCueParams.clear();
    cueMutationInFlight = { sessionId, baseRevision, type: 'params' };
    broadcast({ type: 'cue-params', sessionId, baseRevision, changes });
    return;
  }

  if (queuedCueTake) {
    queuedCueTake = false;
    sendCueTakeRequest(sessionId, baseRevision);
  }
}

function acknowledgeCueMutation(payload) {
  if (!cueMutationInFlight) return;
  if (!payload || payload.sessionId !== cueMutationInFlight.sessionId) {
    clearCueMutationQueue();
    return;
  }
  // An advanced revision either acknowledges our transaction or gives us the
  // authoritative revision after a stale request. In both cases, send the next
  // coalesced mutation against that revision.
  if (payload.revision > cueMutationInFlight.baseRevision) {
    cueMutationInFlight = null;
    scheduleCueMutationFlush();
  }
}

function beginCueTakeIntent() {
  if (myRole !== 'control' || !cueSession || cueSession.phase === 'error') return null;
  if (cueTakeIntent?.sessionId === cueSession.sessionId) return cueTakeIntent;
  cueTakeIntent = {
    sessionId: cueSession.sessionId,
    requestId: `${myId}-take-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    sent: false,
    baseRevision: null,
  };
  // Lock this panel before the channel round-trip, but leave CANCEL enabled.
  syncUI('TAKE PENDING — WARMING');
  return cueTakeIntent;
}

function sendCueTakeRequest(sessionId, baseRevision) {
  const intent = cueTakeIntent?.sessionId === sessionId ? cueTakeIntent : null;
  if (intent) {
    intent.sent = true;
    intent.baseRevision = baseRevision;
  }
  broadcast({
    type: 'cue-take',
    sessionId,
    baseRevision,
    takeRequestId: intent?.requestId || null,
  });
}

function queueCueSelectionChange(selection) {
  if (!cueSession || cueEditsLocked()) return;
  queuedCueSelection = copyProgramSelection(selection);
  scheduleCueMutationFlush();
}

function queueCueParamChange(id, values) {
  if (!cueSession || cueEditsLocked()) return;
  const existing = queuedCueParams.get(id) || {};
  queuedCueParams.set(id, { ...existing, ...values });
  scheduleCueMutationFlush();
}

// Start CUE with the requested stable-id selection in one screen-authoritative
// transaction. This avoids a transient LIVE change between entering CUE and
// selecting its first candidate.
function requestCueSelection(selection) {
  const candidate = validCueSelection(selection);
  if (!candidate || cueEditsLocked()) return;
  if (cueSession) {
    queueCueSelectionChange(candidate);
    return;
  }
  if (!screenOnline) return;

  // A fast follow-up pattern action stays in this pending transaction instead
  // of falling through to requestSelection() and unexpectedly replacing LIVE.
  if (cueEntryPending) {
    cueEntryPending.selection = candidate;
    return;
  }

  heldKeys.length = 0;
  cueEntryPending = {
    requestId: `${myId}-cue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    selection: candidate,
  };
  broadcast({
    type: 'cue-enter',
    initiatorId: myId,
    entryRequestId: cueEntryPending.requestId,
    selection: candidate,
  });
}

function requestCuePrimary() {
  // There is intentionally no standalone CUE action. Shift + a pattern enters
  // CUE; this overlay action only takes (or retries) an existing candidate.
  if (!cueSession || cueEditsLocked()) return;

  // RETRY CUE rebuilds a failed candidate; it is not a TAKE intent and should
  // not lock out the operator's next corrective edit.
  const isRetry = cueSession.phase === 'error';
  if (!isRetry) beginCueTakeIntent();
  if (cueMutationInFlight || queuedCueSelection || queuedCueParams.size) {
    // Bind TAKE to the exact screen-accepted revision after all slider/selection
    // deltas in this control's queue have been acknowledged. The local intent
    // already locks further edits so the final queued value cannot be displaced.
    queuedCueTake = true;
    scheduleCueMutationFlush();
    return;
  }
  sendCueTakeRequest(cueSession.sessionId, cueSession.revision);
}

function requestCueCancel() {
  // A cancel ends the current Shift gesture; drop held-key bookkeeping so a
  // later pattern input can't be read as part of the abandoned entry.
  heldCueKeys.length = 0;
  if (!cueSession) {
    if (!cueEntryPending) return;
    const entryRequestId = cueEntryPending.requestId;
    cueEntryPending = null;
    broadcast({ type: 'cue-cancel-entry', entryRequestId });
    return;
  }
  clearCueMutationQueue();
  broadcast({ type: 'cue-cancel', sessionId: cueSession.sessionId });
}

function requestSelection(selection) {
  if (!selection?.ids?.length) return;
  if (cueSession) {
    queueCueSelectionChange(selection);
    return;
  }
  if (cueEntryPending) {
    cueEntryPending.selection = copyProgramSelection(selection);
    return;
  }

  // Preserve legacy messages for external controllers and all existing tests.
  const indices = selectionIndices(selection);
  if (selection.merge) broadcast({ type: 'merge', a: indices[0], b: indices[1] });
  else if (indices[0] >= 0) broadcast({ type: 'pattern', index: indices[0] });
  else broadcast({ type: 'pattern-id', id: selection.ids[0] });
}

function requestParamChange(id, values) {
  // Band split is deliberately system-scoped, never part of a visual cue.
  if (id === BANDS_ID) {
    broadcast({ type: 'params', id, values });
    return;
  }
  if (cueSession) {
    queueCueParamChange(id, values);
    return;
  }
  // Do not let a slider gesture made while Shift-entry is still crossing the
  // channel mutate LIVE. Its first CUE frame will inherit the current bank.
  if (cueEntryPending) return;
  broadcast({ type: 'params', id, values });
}

function handleAudioManagerStatus(status) {
  lastAudioStatus = { ...status };
  if (isAudioOwner) broadcast({ type: 'audio-status', ...lastAudioStatus });

  // An unplugged interface normally raises both track "ended" and
  // mediaDevices "devicechange". Keep the ended path as a fallback for
  // browsers that only send one of them.
  if (isAudioOwner && status?.error?.name === 'DeviceEndedError') {
    scheduleAudioRecovery();
  }
}

audio.setStatusListener(handleAudioManagerStatus);

function startAudio(deviceId = localStorage.getItem(STORAGE.audio)) {
  if (!isAudioOwner) return Promise.resolve(false);
  if (!deviceId) {
    currentAudioDeviceId = null;
    audio.reportStatus('unselected');
    return Promise.resolve(false);
  }

  currentAudioDeviceId = deviceId;
  return audio.startStream(deviceId);
}

// Apply explicit selections from any panel. Audio is acted on only by the one
// capture-owning control window; video remains owned by the output screen.
function applyDevices(selection = {}) {
  const explicitAudioId = typeof selection.audioDeviceId === 'string' ? selection.audioDeviceId : null;
  const explicitVideoId = typeof selection.videoDeviceId === 'string' ? selection.videoDeviceId : null;
  const videoLocked = Boolean(cueSession && explicitVideoId);
  if (explicitAudioId) localStorage.setItem(STORAGE.audio, explicitAudioId);
  // Reject device changes at the transaction boundary as well as in the UI so
  // a stale/malicious BroadcastChannel message cannot invalidate the cue.
  if (explicitVideoId && !videoLocked) localStorage.setItem(STORAGE.video, explicitVideoId);

  const savedAudioId = explicitAudioId || localStorage.getItem(STORAGE.audio);
  const savedVideoId = videoLocked ? localStorage.getItem(STORAGE.video) : (explicitVideoId || localStorage.getItem(STORAGE.video));
  currentAudioDeviceId = savedAudioId || null;

  if (isAudioOwner) {
    if (savedAudioId && (savedAudioId !== audio.requestedDeviceId || !audio.isStarted)) {
      startAudio(savedAudioId);
    } else if (!savedAudioId) {
      audio.reportStatus('unselected');
    }
  }

  if (myRole === 'screen' && savedVideoId && savedVideoId !== currentVideoDeviceId) {
    // Camera selection is global and could invalidate both program slots. The
    // panel disables it while cueing; this guard also protects stale messages.
    if (cueSession) return;
    currentVideoDeviceId = savedVideoId;
    const selection = currentLiveSelection();
    const usesCamera = selection.ids.some((id) => SKETCHES.find((sketch) => sketch.id === id)?.camera);
    if (usesCamera) prepareThenPromoteLive(selection, { force: true });
  }
}

function scheduleAudioRecovery() {
  if (audioRestartTimer || !isAudioOwner || !currentAudioDeviceId) return;
  audioRestartTimer = window.setTimeout(async () => {
    audioRestartTimer = 0;
    if (!isAudioOwner || !currentAudioDeviceId) return;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === 'audioinput');
      const preferredAvailable = inputs.some((device) => device.deviceId === currentAudioDeviceId);
      const activeTrack = audio.stream?.getAudioTracks?.()[0];
      const shouldRestorePreferred = preferredAvailable
        && audio.usedFallback
        && audio.activeDeviceId !== currentAudioDeviceId;
      if (!preferredAvailable || !activeTrack || activeTrack.readyState === 'ended' || shouldRestorePreferred) {
        // AudioManager retries without deviceId.exact if the preferred interface
        // disappeared, while keeping the preference ready for a later reconnect.
        startAudio(currentAudioDeviceId);
      }
    } catch (err) {
      console.error('Unable to refresh audio devices:', err);
    }
  }, 250);
}

navigator.mediaDevices?.addEventListener?.('devicechange', scheduleAudioRecovery);

function takeAudioOwnership() {
  if (isAudioOwner || !wantsAudioOwnership || myRole !== 'control') return;
  isAudioOwner = true;
  currentAudioDeviceId = localStorage.getItem(STORAGE.audio) || null;
  startAudioBroadcast();
  startAudio(currentAudioDeviceId);
  // Ensure newly opened peers receive a status even if AudioManager's state did
  // not change enough to trigger its de-duplicated listener.
  broadcast({ type: 'audio-status', ...audio.getStatus() });
}

function relinquishAudioOwnership() {
  if (!isAudioOwner) return;
  isAudioOwner = false;
  if (audioRestartTimer) clearTimeout(audioRestartTimer);
  audioRestartTimer = 0;
  stopAudioBroadcast();
  if (noiseCaptureActive) {
    cancelNoiseCapture();
    noiseCaptureActive = false;
    broadcast({ type: 'noise-floor', status: 'cancelled' });
  }
  audio.stop();
}

// Web Locks provide an atomic, browser-managed owner election across same-origin
// windows. A queued panel takes over automatically when the current owner closes.
function beginAudioOwnership() {
  wantsAudioOwnership = true;
  if (myRole !== 'control' || audioOwnershipTask || fallbackLeaseTimer) return;

  if (navigator.locks?.request) {
    audioOwnershipAbort = new AbortController();
    audioOwnershipTask = navigator.locks.request(
      AUDIO_LOCK_NAME,
      { mode: 'exclusive', signal: audioOwnershipAbort.signal },
      async () => {
        audioLockHeld = true;
        if (!wantsAudioOwnership || myRole !== 'control') {
          audioLockHeld = false;
          return;
        }
        takeAudioOwnership();
        await new Promise((resolve) => { releaseAudioOwnershipLock = resolve; });
        releaseAudioOwnershipLock = null;
        relinquishAudioOwnership();
        audioLockHeld = false;
      },
    ).catch((err) => {
      if (err?.name !== 'AbortError') console.error('Audio ownership lock failed:', err);
    }).finally(() => {
      audioOwnershipTask = null;
      audioOwnershipAbort = null;
      audioLockHeld = false;
      if (wantsAudioOwnership && myRole === 'control') beginAudioOwnership();
    });
    return;
  }

  // Fallback for browsers without Web Locks: a short localStorage lease. The
  // verify-after-write step resolves simultaneous claims; the lease heartbeat
  // also lets another panel recover after a crash.
  refreshFallbackAudioLease();
}

function readFallbackAudioLease() {
  try {
    const lease = JSON.parse(localStorage.getItem(AUDIO_LEASE_KEY) || 'null');
    return lease && typeof lease.id === 'string' && Number.isFinite(lease.expires) ? lease : null;
  } catch {
    return null;
  }
}

function refreshFallbackAudioLease() {
  if (fallbackLeaseTimer) clearTimeout(fallbackLeaseTimer);
  fallbackLeaseTimer = 0;
  if (!wantsAudioOwnership || myRole !== 'control' || navigator.locks?.request) return;

  const now = Date.now();
  const lease = readFallbackAudioLease();
  if (!lease || lease.id === myId || lease.expires <= now) {
    localStorage.setItem(AUDIO_LEASE_KEY, JSON.stringify({ id: myId, expires: now + AUDIO_LEASE_MS }));
  }

  const confirmed = readFallbackAudioLease();
  if (confirmed?.id === myId) takeAudioOwnership();
  else relinquishAudioOwnership();
  fallbackLeaseTimer = window.setTimeout(refreshFallbackAudioLease, AUDIO_LEASE_MS / 3);
}

function endAudioOwnership() {
  wantsAudioOwnership = false;
  if (fallbackLeaseTimer) clearTimeout(fallbackLeaseTimer);
  fallbackLeaseTimer = 0;

  const lease = readFallbackAudioLease();
  if (lease?.id === myId) localStorage.removeItem(AUDIO_LEASE_KEY);

  if (audioLockHeld && releaseAudioOwnershipLock) releaseAudioOwnershipLock();
  else if (audioOwnershipAbort) audioOwnershipAbort.abort();
  relinquishAudioOwnership();
}

window.addEventListener('storage', (event) => {
  if (event.key === AUDIO_LEASE_KEY && wantsAudioOwnership && !navigator.locks?.request) {
    refreshFallbackAudioLease();
  }
});

// ---------------------------------------------------------------------------
// Role switching
// ---------------------------------------------------------------------------

function becomeControl() {
  if (myRole === 'control') return;
  myRole = 'control';

  document.title = 'Viz Control';
  removeCurrentP5();
  screenAudio.clearFrame();
  currentAudioDeviceId = localStorage.getItem(STORAGE.audio) || null;

  document.body.classList.add('is-control');
  document.body.classList.remove('is-screen');
  beginAudioOwnership();

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
      if (myRole === 'screen') broadcastLiveState();
      // A window opened after capture startup would otherwise miss the one-time
      // starting/running/suspended event. The capture owner answers every hello.
      if (isAudioOwner && msg.windowId !== myId) {
        broadcast({ type: 'audio-status', ...lastAudioStatus });
      }
      break;

    case 'state': {
      const selection = msg.live
        || (typeof msg.patternId === 'string' && msg.pattern < 0
          ? selectionFromId(msg.patternId)
          : selectionFromIndices(msg.pattern, msg.merge));
      if (selection?.ids?.length) {
        liveProgram = copyProgramSelection(selection);
        syncLegacyLiveProjection();
      } else if (typeof msg.pattern === 'number') {
        currentIndex = msg.pattern;
        mergeIndices = Array.isArray(msg.merge) && msg.merge.length === 2 ? [...msg.merge] : null;
        if (msg.pattern < 0 && typeof msg.patternId === 'string') activeSketchId = msg.patternId;
        else updateActiveSketchId();
      }
      screenOnline = true;
      // Adopt screen-authored global and visual values before constructing a
      // received CUE bank; a late-open panel must clone the same canonical
      // values the screen uses.
      if (msg.bands) applyCanonicalBandValues(msg.bands);
      if (msg.liveParams) applyCanonicalLiveParamBank(msg.liveParams);
      if ('cue' in msg) applyReceivedCueState(msg.cue);
      break;
    }

    case 'pattern': {
      // Legacy live-scoped messages are intentionally ignored during a cue;
      // only explicit cue-* protocol messages may mutate the candidate.
      if (cueSession) break;
      const selection = selectionFromIndices(msg.index);
      if (!selection) break;
      if (myRole === 'screen') {
        if (!cueSession) prepareThenPromoteLive(selection);
      } else {
        // Standalone controls retain their local preview behaviour even without
        // an output window; the screen remains authoritative once present.
        liveProgram = copyProgramSelection(selection);
        syncLegacyLiveProjection();
      }
      break;
    }

    case 'pattern-id': {
      if (cueSession) break;
      const selection = selectionFromId(msg.id);
      if (!selection) break;
      if (myRole === 'screen') {
        if (!cueSession) prepareThenPromoteLive(selection);
      } else {
        liveProgram = copyProgramSelection(selection);
        syncLegacyLiveProjection();
      }
      break;
    }

    case 'merge': {
      if (cueSession) break;
      const selection = selectionFromIndices(msg.a, [msg.a, msg.b]);
      if (!selection) break;
      if (myRole === 'screen') {
        if (!cueSession) prepareThenPromoteLive(selection);
      } else {
        liveProgram = copyProgramSelection(selection);
        syncLegacyLiveProjection();
      }
      break;
    }

    case 'cue-enter':
      if (myRole === 'screen') {
        enterCueSession(
          msg.initiatorId || msg.windowId,
          msg.selection,
          msg.entryRequestId || null,
        );
      }
      return;

    case 'cue-cancel-entry':
      if (myRole === 'screen') cancelCueEntryRequest(msg.entryRequestId || null);
      return;

    case 'cue-selection':
      updateCueSelection(msg);
      return;

    case 'cue-params':
      updateCueParams(msg);
      return;

    case 'cue-take':
      if (myRole === 'screen' && cueSession && msg.sessionId === cueSession.sessionId) {
        if (msg.baseRevision !== undefined && msg.baseRevision !== cueSession.revision) {
          // A control that optimistically locked itself must be told that this
          // particular TAKE lost a revision race, rather than staying disabled.
          broadcastCueState('', null, { rejectedTakeRequestId: msg.takeRequestId || null });
        } else if (cueSession.takePending
          && msg.takeRequestId
          && cueSession.takeRequestId
          && msg.takeRequestId !== cueSession.takeRequestId) {
          // The first accepted TAKE owns the committed revision. A racing
          // second control may cancel it, but cannot replace its request id.
          broadcastCueState('', null, { rejectedTakeRequestId: msg.takeRequestId });
        } else {
          takeCueSession(cueSession, msg.takeRequestId || null);
        }
      }
      return;

    case 'cue-cancel':
      if (myRole === 'screen' && cueSession && msg.sessionId === cueSession.sessionId) cancelCueSession();
      return;

    case 'cue-state':
      if (msg.live?.ids?.length) {
        liveProgram = copyProgramSelection(msg.live);
        syncLegacyLiveProjection();
      }
      if (msg.bands) applyCanonicalBandValues(msg.bands);
      if (msg.liveParams) applyCanonicalLiveParamBank(msg.liveParams);
      if (msg.committedParams && !(myRole === 'screen' && msg.windowId === myId)) {
        adoptVisualParamBank(msg.committedParams);
      }
      applyReceivedCueState(msg.cue, msg.notice || '', {
        takeRequestId: msg.takeRequestId || null,
        rejectedTakeRequestId: msg.rejectedTakeRequestId || null,
      });
      return;

    case 'devices':
      // Device ids are included explicitly; localStorage remains persistence,
      // not an inter-window delivery mechanism. Every window stores the choice,
      // but only the audio-owner control and the output screen act on it.
      applyDevices(msg);
      break;

    case 'audio-status':
      lastAudioStatus = {
        status: msg.status,
        state: msg.state,
        deviceId: msg.deviceId,
        activeDeviceId: msg.activeDeviceId,
        fallback: Boolean(msg.fallback),
        error: msg.error || null,
      };
      if (msg.status !== 'running') {
        if (myRole === 'screen') screenAudio.clearFrame();
        else previewAudio.clearFrame();
      }
      if (myRole === 'control' && panel) panel.setAudioStatus(lastAudioStatus);
      return;

    case 'params':
      // Legacy unscoped LIVE parameter requests are now screen-authoritative.
      // Controls deliberately do not mutate/persist on this raw message: a
      // CUE could have been accepted in the gap between a slider event and its
      // BroadcastChannel delivery. The screen answers accepted requests with
      // `live-params`, or rebroadcasts its canonical bank when it rejects one.
      if (myRole !== 'screen' || !isKnownLiveParamId(msg.id) || !msg.values) return;
      if (cueSession && msg.id !== BANDS_ID) {
        broadcastCueState('LIVE PARAMETER IGNORED — CUE ACTIVE');
        return;
      }
      applyAcceptedLiveParamValues(msg.id, msg.values);
      broadcast({ type: 'live-params', id: msg.id, values: msg.values });
      return;

    case 'live-params':
      // Only the output screen emits accepted LIVE values. Screen windows have
      // already applied their source request and therefore ignore the echo.
      if (myRole !== 'screen' && isKnownLiveParamId(msg.id) && msg.values) {
        applyAcceptedLiveParamValues(msg.id, msg.values);
      }
      break;

    case 'spectrum':
      // Compact EQ feed from the capture-owning control (~15fps). Forward and
      // return early — the full syncUI() dance is pointless churn at this rate.
      if (myRole === 'control' && panel) panel.handleSpectrum(msg);
      return;

    case 'analysis-frame':
      // Cleaned frequency + waveform snapshots flow control -> screen. Other
      // panels consume them too so every embedded preview follows the same mic.
      if (myRole === 'screen') screenAudio.setFrame(msg.frame);
      else previewAudio.setFrame(msg.frame);
      return;

    case 'noise-capture':
      // Requests may originate in any panel; only the elected microphone owner
      // has the analyser buffers needed to run the sampler.
      if (isAudioOwner) {
        if (msg.action === 'start') {
          if (!audio.isStarted) {
            broadcast({ type: 'noise-floor', status: 'failed', reason: 'no-audio' });
          } else {
            const seconds = typeof msg.seconds === 'number' ? msg.seconds : NOISE_CAPTURE_DEFAULT_SECONDS;
            startNoiseCapture(seconds);
            noiseCaptureActive = true;
            lastNoiseProgressAt = 0;
            broadcast({ type: 'noise-floor', status: 'capturing', progress: 0, elapsed: 0, seconds });
          }
        } else if (msg.action === 'cancel') {
          cancelNoiseCapture();
          noiseCaptureActive = false;
          broadcast({ type: 'noise-floor', status: 'cancelled' });
        }
      }
      return;

    case 'noise-floor':
      // The profile itself lives in localStorage (written by the audio owner);
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
        if (liveProgram?.ids?.length) syncLegacyLiveProjection();
        if (myRole === 'control' && panel) panel.setOrder();
      }
      break;

    case 'screen-closed':
      screenOnline = false;
      // A cue is unsafe without its screen-side warmed runtime. Controls discard
      // it rather than retaining a stale TAKE action after screen loss.
      if (myRole === 'control') cueEntryPending = null;
      if (myRole === 'control' && cueSession) applyReceivedCueState(null, 'CUE CANCELED — OUTPUT OFFLINE');
      if (myRole === 'control' && panel) panel.setScreenOnline(false);
      break;
  }

  syncUI();
}

channel.onmessage = (e) => handleMessage(e.data || {});

// Announce ourselves so an existing screen can push its state
broadcast({ type: 'hello', role: myRole, bootTime: MY_BOOT_TIME });

// ---------------------------------------------------------------------------
// Audio analysis feed (capture-owning control -> screens and other controls)
// Full cleaned snapshots run at ~30fps for responsive visuals. The EQ receives
// a compact log-spaced spectrum at ~15fps. Only the latest snapshot is retained
// by each consumer, so there is no application-level frame queue.
// ---------------------------------------------------------------------------

let audioBroadcastRaf = 0;
let lastAnalysisAt = 0;
let lastSpectrumAt = 0;
let audioFrameSequence = 0;
// True while the capture owner is running a noise-floor sample; this same loop
// watches the sampler for completion and broadcasts progress to every panel.
let noiseCaptureActive = false;
let lastNoiseProgressAt = 0;

function audioBroadcastLoop(now) {
  audioBroadcastRaf = 0;
  if (!isAudioOwner) return;

  if (now - lastAnalysisAt >= 33) {
    lastAnalysisAt = now;
    const frame = audio.isStarted ? audio.getAnalysisFrame() : null;
    if (frame) {
      audioFrameSequence += 1;
      broadcast({ type: 'analysis-frame', sequence: audioFrameSequence, frame });
      if (now - lastSpectrumAt >= 66) {
        lastSpectrumAt = now;
        const spec = computeLogSpectrum(frame);
        if (spec) broadcast({ type: 'spectrum', ...spec });
      }
    }
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

  audioBroadcastRaf = requestAnimationFrame(audioBroadcastLoop);
}

function startAudioBroadcast() {
  if (!audioBroadcastRaf) audioBroadcastRaf = requestAnimationFrame(audioBroadcastLoop);
}

function stopAudioBroadcast() {
  if (audioBroadcastRaf) cancelAnimationFrame(audioBroadcastRaf);
  audioBroadcastRaf = 0;
  lastAnalysisAt = 0;
  lastSpectrumAt = 0;
}

// Web Audio autoplay permission belongs to the capture-owning control window.
// Resume from any trusted interaction in that panel, regardless of the target.
function resumeAudioFromControlGesture() {
  if (myRole === 'control' && isAudioOwner && audio.isStarted) audio.resume(true);
}
window.addEventListener('pointerdown', resumeAudioFromControlGesture, { capture: true, passive: true });
window.addEventListener('keydown', resumeAudioFromControlGesture, { capture: true });

// ---------------------------------------------------------------------------
// Keyboard shortcuts (1-0) — active on control panel windows.
// Shift + a number starts/updates CUE with that one stable pad selection.
// Unmodified number keys retain the latched merge gesture: the FIRST key
// selects an effect; if a SECOND key is pressed while the first is still held,
// both effects merge and the blend stays until a later single-key selection.
// ---------------------------------------------------------------------------

// Held keys are tracked by physical code, not character, so a Shift-modified
// digit (whose `key` is punctuation on most layouts) can never corrupt a merge.
const heldKeys = [];
// CUE's Shift + number gesture tracks its own held keys so a LIVE merge hold
// can never be mistaken for (or corrupted by) a CUE entry, and vice versa.
const heldCueKeys = [];

function shortcutIndexFromEvent(event) {
  const digit = /^Digit([0-9])$/.exec(event.code || '');
  if (digit) return digit[1] === '0' ? 9 : Number(digit[1]) - 1;
  return indexFromKey(event.key);
}

window.addEventListener('keydown', (e) => {
  if (myRole !== 'control') return;

  // Transport keys intentionally run before text-entry guards. Enter queues a
  // safe TAKE while warming; Escape remains the abort path even during entry.
  if (e.code === 'Enter' && cueSession) {
    e.preventDefault();
    if (!e.repeat) requestCuePrimary();
    return;
  }
  if (e.code === 'Escape' && (cueSession || cueEntryPending)) {
    e.preventDefault();
    requestCueCancel();
    return;
  }

  if (e.metaKey || e.ctrlKey || e.altKey || cueEditsLocked()) return;

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

  const editingSelection = cueSession?.selection || currentLiveSelection();
  // Blend shortcuts target CUE values while cueing, otherwise the LIVE bank.
  if (editingSelection.merge) {
    const bp = getEditingParams(BLEND_ID);
    if (e.key === '+' || e.key === '=' || e.key === '-') {
      const activeKey = bp.mode === 1 ? 'add' : 'mix';
      const delta = e.key === '-' ? -0.05 : 0.05;
      const cur = typeof bp[activeKey] === 'number' ? bp[activeKey] : 0.5;
      const next = Math.max(0, Math.min(1, Math.round((cur + delta) * 100) / 100));
      requestParamChange(BLEND_ID, { [activeKey]: next });
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      requestParamChange(BLEND_ID, { mode: bp.mode === 1 ? 0 : 1 });
      e.preventDefault();
      return;
    }
  }

  const index = shortcutIndexFromEvent(e);
  // Only the first 10 positions have shortcuts (1-9, 0).
  if (index < 0 || index >= getOrderedSketches().length) return;

  if (e.shiftKey) {
    if (e.repeat) return;
    // Reset LIVE merge bookkeeping so a stale hold can't leak into CUE. The
    // CUE gesture tracks its own held keys below.
    heldKeys.length = 0;
    // Shift + a number stages that one pattern; holding Shift and pressing a
    // SECOND number while the first is still down stages a two-pattern blend,
    // mirroring the unmodified hold-two-keys merge used for LIVE. The blend
    // stays latched after release until the next pattern input.
    if (heldCueKeys.some((held) => held.code === e.code)) return;
    if (heldCueKeys.length === 0) {
      heldCueKeys.push({ code: e.code, index });
      requestCueSelection(selectionFromIndices(index));
    } else if (heldCueKeys.length === 1) {
      heldCueKeys.push({ code: e.code, index });
      const lo = Math.min(heldCueKeys[0].index, index);
      const hi = Math.max(heldCueKeys[0].index, index);
      requestCueSelection(selectionFromIndices(lo, [lo, hi]));
    }
    // 2+ keys already held while Shift is down -> ignore extras
    e.preventDefault();
    return;
  }

  if (e.repeat || heldKeys.some((held) => held.code === e.code)) return;

  if (heldKeys.length === 0) {
    // An unmodified gesture supersedes any in-flight Shift hold tracking.
    heldCueKeys.length = 0;
    heldKeys.push({ code: e.code, index });
    requestSelection(selectionFromIndices(index));
  } else if (heldKeys.length === 1) {
    heldKeys.push({ code: e.code, index });
    const lo = Math.min(heldKeys[0].index, index);
    const hi = Math.max(heldKeys[0].index, index);
    requestSelection(selectionFromIndices(lo, [lo, hi]));
  }
  // 2+ keys already held -> ignore extras
});

window.addEventListener('keyup', (e) => {
  if (myRole !== 'control') return;

  const pos = heldKeys.findIndex((held) => held.code === e.code);
  if (pos >= 0) heldKeys.splice(pos, 1);
  const cuePos = heldCueKeys.findIndex((held) => held.code === e.code);
  if (cuePos >= 0) heldCueKeys.splice(cuePos, 1);
  // No broadcast on release: a started blend is latched until the next press.
});

// If the control window loses focus mid-hold its keyup events are lost. The
// latched selection is unaffected, but the held-key bookkeeping must reset so
// the next press isn't mistaken for part of a stale gesture.
window.addEventListener('blur', () => {
  if (myRole !== 'control') return;
  heldKeys.length = 0;
  heldCueKeys.length = 0;
});

// Tell panels when the screen closes; capture ownership is released separately
// so a queued control window can take over the microphone immediately.
window.addEventListener('beforeunload', () => {
  if (myRole === 'screen') channel.postMessage({ type: 'screen-closed' });
  if (myRole === 'control') endAudioOwnership();
});

// ---------------------------------------------------------------------------
// Control panel
// ---------------------------------------------------------------------------

function ensurePanel() {
  if (panel) return;
  panel = new ConfigPanel({
    onPatternChange: (index) => requestSelection(selectionFromIndices(index)),
    onPatternChangeId: (id) => requestSelection(selectionFromId(id)),
    onCuePatternChange: (index) => requestCueSelection(selectionFromIndices(index)),
    onCuePatternChangeId: (id) => requestCueSelection(selectionFromId(id)),
    onDevicesChange: (selection) => broadcast({ type: 'devices', ...(selection || {}) }),
    onOpenScreen: () => openScreenWindow(),
    onCuePrimary: () => requestCuePrimary(),
    onCueCancel: () => requestCueCancel(),
    onParamChange: (id, key, value) => requestParamChange(id, { [key]: value }),
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
    getParams: getEditingParams,
    getPattern: () => currentIndex,
    isScreen: () => myRole === 'screen',
    isScreenOnline: () => screenOnline,
  });
  panel.setAudioStatus(lastAudioStatus);
}

function syncUI(notice = '') {
  if (myRole === 'control') {
    ensurePanel();
    if (panel) {
      panel.setTransportState({
        live: currentLiveSelection(),
        cue: panelCueState(),
        screenOnline,
        notice,
      });
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
currentAudioDeviceId = localStorage.getItem(STORAGE.audio) || null;

if (myRole === 'screen') {
  document.title = 'Viz Screen';
  document.body.classList.add('is-screen');
  currentVideoDeviceId = localStorage.getItem(STORAGE.video) || null;
  loadSketch(currentIndex);
  renderScreenToolbar();
} else {
  document.title = 'Viz Control';
  document.body.classList.add('is-control');
  updateActiveSketchId();
  ensurePanel();
  syncUI();
  beginAudioOwnership();
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
    // Screen-authored CUE transaction diagnostics for deterministic e2e checks.
    get cue() { return cueStatePayload(); },
    get cueParams() { return cueSession ? cueSession.params : null; },
    get cueRuntime() {
      return cueRuntime ? {
        ids: [...cueRuntime.selection.ids],
        count: cueRuntime.count,
        ready: cueRuntime.ready,
        generation: cueRuntime.generation,
      } : null;
    },
    get runtimeCounts() {
      return {
        live: liveRuntime?.count || 0,
        cue: cueRuntime?.count || 0,
        incoming: incomingRuntime?.count || 0,
        retiring: retiringRuntime?.count || 0,
        total: (liveRuntime?.count || 0) + (cueRuntime?.count || 0) + (incomingRuntime?.count || 0) + (retiringRuntime?.count || 0),
        camera: cameraSource.diagnostics(),
      };
    },
    get cueTimings() { return lastCueTimings.map((entry) => ({ ...entry })); },
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
        // Last spectrum received from the capture owner after noise subtraction
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
    // Role-facing provider: local AudioManager in controls, received-frame
    // facade on screens. captureAudio always exposes the physical-input manager.
    get audio() { return myRole === 'screen' ? screenAudio : audio; },
    captureAudio: audio,
    get audioOwner() { return isAudioOwner; },
    get audioStatus() { return { ...lastAudioStatus }; },
    get audioDeviceId() { return currentAudioDeviceId; },
    // DEV only: { key -> last read timestamp } of params the sketch accesses
    readLog: () => devReadLog || {},
  };
}
