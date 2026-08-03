import p5 from 'p5';
import './style.css';
import {
  getOrderedSketches,
  SKETCHES,
  BLEND_ID,
  BANDS_ID,
  defaultParamValues,
  indexFromKey,
  saveSlotOrder,
} from './sketch-registry.js';
import { ConfigPanel } from './config-panel.js';
import { AudioManager } from './audio-manager.js';
import { setBandSplit, computeLogSpectrum } from './sketches/audio-features.js';

// ---------------------------------------------------------------------------
// Window roles
//   ?screen  -> this window is the visualization screen (default)
//   ?control -> this window is a control panel
// Any window can "take over" as the screen via the control panel button.
// ---------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
let myRole = params.get('role') === 'control' ? 'control' : 'screen';
const myId = Math.random().toString(36).slice(2);
const MY_BOOT_TIME = Date.now();

const channel = new BroadcastChannel('viz2_channel');
const audio = new AudioManager();

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

function becomeScreen() {
  if (myRole === 'screen') return;
  myRole = 'screen';
  screenOnline = true;

  document.body.classList.add('is-screen');
  document.body.classList.remove('is-control');

  currentVideoDeviceId = localStorage.getItem(STORAGE.video) || null;
  currentAudioDeviceId = null;
  if (currentIndex >= 0) loadSketch(currentIndex, mergeIndices);
  else loadSketchById(activeSketchId);
  startAudio();
  renderScreenToolbar();
  startSpectrumBroadcast();

  broadcast({ type: 'state', pattern: currentIndex, merge: mergeIndices, patternId: activeSketchId });
  console.log(`Window ${myId} became the screen`);
}

function becomeControl() {
  if (myRole === 'control') return;
  myRole = 'control';

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
        // screen exists (first-opened window wins; use Take Over to change it).
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
        // Blend sliders drive the overlay canvas styles on the screen
        if (msg.id === BLEND_ID && myRole === 'screen') applyBlendStyles();
        // Band-split crossovers retune the musical feature extractor
        if (msg.id === BANDS_ID) setBandSplit(getParams(BANDS_ID));
        if (myRole === 'control' && panel) panel.applyParam(msg.id, msg.values);
      }
      break;

    case 'spectrum':
      // High-frequency log-spectrum feed for the control panel's band-split
      // EQ (broadcast by the screen ~15fps). Forward and return early — the
      // full syncUI() dance is pointless churn at this message rate.
      if (myRole === 'control' && panel) panel.handleSpectrum(msg);
      return;

    case 'reorder':
      // The pad assignment changed in some window. Positions shift, so keep the
      // currently playing pattern selected (by id) and re-render the panel.
      if (Array.isArray(msg.order) && msg.order.length) {
        const idx = msg.order.indexOf(activeSketchId);
        currentIndex = idx >= 0 ? idx : -1;
        // A live merge selection is positional too — remap it by id so the
        // next key event / takeover keeps pointing at the same effects.
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

    case 'role':
      if (msg.windowId === myId) {
        becomeScreen();
      } else {
        becomeControl();
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

function spectrumLoop(now) {
  spectrumRaf = 0;
  if (myRole !== 'screen') return;
  if (now - lastSpectrumAt >= 66) {
    lastSpectrumAt = now;
    const frame = audio.isStarted ? audio.getAnalysisFrame() : null;
    const spec = frame ? computeLogSpectrum(frame) : null;
    if (spec) broadcast({ type: 'spectrum', ...spec });
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
    onTakeover: () => broadcast({ type: 'role', role: 'screen' }),
    onOpenControl: () => openControlWindow(),
    onParamChange: (id, key, value) => {
      // Local dispatch (via broadcast) updates the store + saves + syncs UI
      broadcast({ type: 'params', id, values: { [key]: value } });
    },
    onReorder: (order) => {
      // Persist + sync the new pad assignment to every window
      saveSlotOrder(order);
      broadcast({ type: 'reorder', order });
    },
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

// Small floating toolbar shown on the screen window
function renderScreenToolbar() {
  if (document.getElementById('screen-toolbar')) return;

  const toolbar = document.createElement('div');
  toolbar.id = 'screen-toolbar';
  toolbar.innerHTML = `
    <button id="open-control-btn" title="Open a control panel window">⛶ Control Panel</button>
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

if (myRole === 'screen') {
  document.body.classList.add('is-screen');
  currentVideoDeviceId = localStorage.getItem(STORAGE.video) || null;
  loadSketch(currentIndex);
  startAudio();
  renderScreenToolbar();
  startSpectrumBroadcast();
} else {
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
    // Control-panel band-split EQ internals (control windows only)
    get eq() {
      if (!panel) return null;
      return {
        split: { ...panel.eqSplit },
        drawn: panel.eqDrawn,
        spectrumAt: panel.lastSpectrumAt,
      };
    },
    // Exposed only in Vite development mode so integration tests can inject a
    // deterministic spectrum without requiring microphone permissions.
    audio,
    // DEV only: { key -> last read timestamp } of params the sketch accesses
    readLog: () => devReadLog || {},
  };
}
