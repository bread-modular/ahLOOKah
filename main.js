import p5 from 'p5';
import './style.css';
import { SKETCHES, defaultParamValues, indexFromKey } from './sketch-registry.js';
import { ConfigPanel } from './config-panel.js';
import { AudioManager } from './audio-manager.js';

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
// `paramValues` is a per-index map of { key: value }. The same object that is
// handed to a sketch factory is mutated in place on 'params' messages, so
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
  try {
    return JSON.parse(localStorage.getItem(STORAGE.params)) || {};
  } catch {
    return {};
  }
}

function saveParamValues() {
  localStorage.setItem(STORAGE.params, JSON.stringify(paramRawValues));
}

// Returns the live param object for a sketch index (creating it from defaults).
// In DEV builds the object is wrapped in a Proxy that records property reads,
// so tests can prove the running sketch re-reads params every frame.
function getParams(index) {
  let v = paramValues[index];
  if (!v) {
    v = defaultParamValues(index);
    paramValues[index] = v;
    paramRawValues[index] = v;
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
    paramValues[index] = proxy;
    paramRawValues[index] = v;
  }

  return paramValues[index];
}

// ---------------------------------------------------------------------------
// Screen runtime
// ---------------------------------------------------------------------------

function loadSketch(index) {
  if (index < 0 || index >= SKETCHES.length) return;

  if (currentP5) {
    currentP5.remove();
  }

  currentIndex = index;
  const sketchFactory = SKETCHES[index].factory;

  // Inject audio, current video device ID, and the LIVE params object so the
  // sketch reads updated param values every frame.
  currentP5 = new p5(sketchFactory(audio, currentVideoDeviceId, getParams(index)));

  console.log(`Loaded sketch ${index + 1} (${SKETCHES[index].name})`);
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
    // Reload current sketch if it's a webcam-dependent one (slots 6-10)
    if (currentIndex >= 5 && currentIndex <= 9) {
      loadSketch(currentIndex);
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
  loadSketch(currentIndex);
  startAudio();
  renderScreenToolbar();

  broadcast({ type: 'state', pattern: currentIndex });
  console.log(`Window ${myId} became the screen`);
}

function becomeControl() {
  if (myRole === 'control') return;
  myRole = 'control';

  if (currentP5) {
    currentP5.remove();
    currentP5 = null;
  }
  audio.stop();
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
      if (myRole === 'screen') broadcast({ type: 'state', pattern: currentIndex });
      break;

    case 'state':
      if (typeof msg.pattern === 'number') currentIndex = msg.pattern;
      screenOnline = true;
      break;

    case 'pattern':
      currentIndex = msg.index;
      if (myRole === 'screen') {
        loadSketch(msg.index);
        broadcast({ type: 'state', pattern: currentIndex });
      }
      break;

    case 'devices':
      // Devices changed in some window (localStorage is the source of truth)
      if (myRole === 'screen') applyDevices();
      break;

    case 'params':
      // A param slider moved somewhere — merge into the live store (both
      // windows keep the same store, so the running sketch updates in place).
      if (typeof msg.index === 'number' && msg.values) {
        Object.assign(getParams(msg.index), msg.values);
        saveParamValues();
        if (myRole === 'control' && panel) panel.applyParam(msg.index, msg.values);
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
// Keyboard shortcuts (1-0) — active on control panel windows
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (myRole !== 'control') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const target = e.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
    return;
  }

  const index = indexFromKey(e.key);
  if (index >= 0) {
    broadcast({ type: 'pattern', index });
  }
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
    onDevicesChange: () => broadcast({ type: 'devices' }),
    onTakeover: () => broadcast({ type: 'role', role: 'screen' }),
    onOpenControl: () => openControlWindow(),
    onParamChange: (index, key, value) => {
      // Local dispatch (via broadcast) updates the store + saves + syncs UI
      broadcast({ type: 'params', index, values: { [key]: value } });
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
      panel.setPattern(currentIndex);
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

if (myRole === 'screen') {
  document.body.classList.add('is-screen');
  currentVideoDeviceId = localStorage.getItem(STORAGE.video) || null;
  loadSketch(currentIndex);
  startAudio();
  renderScreenToolbar();
} else {
  document.body.classList.add('is-control');
  ensurePanel();
  syncUI();
}

// Debug/test hook — lets e2e tests read live state (dev builds only)
if (import.meta.env.DEV) {
  window.__viz = {
    get role() { return myRole; },
    get pattern() { return currentIndex; },
    get screenOnline() { return screenOnline; },
    get params() { return getParams(currentIndex); },
    // DEV only: { key -> last read timestamp } of params the sketch accesses
    readLog: () => devReadLog || {},
  };
}
