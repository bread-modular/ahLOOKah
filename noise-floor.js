// Noise-floor capture & spectral subtraction.
//
// Every input chain (mic preamp, DJ interface, room hum) adds a stationary
// spectral signature that is visible even with no music playing. This module
// records that signature for a few seconds — averaging per-bin power with both
// channels mixed, exactly like the feature extractor — and afterwards
// subtracts it from every analysis frame so the effects and the band-split EQ
// only react to what sits above the captured floor.
//
// The profile persists in localStorage, so a calibrated setup survives
// reloads. The screen window owns the capture (it owns the audio); other
// windows reload the profile when the screen broadcasts the change.

const STORAGE_KEY = 'viz2_noise_floor';
const MIN_DB = -120;
const EPSILON = 1e-8;

export const NOISE_CAPTURE_DEFAULT_SECONDS = 4;
export const NOISE_CAPTURE_MIN_SECONDS = 0.2; // small floor so tests can run fast
export const NOISE_CAPTURE_MAX_SECONDS = 10;

// Subtraction tuning. A slight oversubtraction absorbs analyser flutter so
// the stationary signature stays suppressed; the spectral floor caps how far
// a bin may drop below its incoming value (prevents -Inf holes and keeps
// transient music content intact).
const OVERSUBTRACTION = 1.3; // ~+1.1 dB safety margin on the profile
const FLOOR_RATIO = 0.001; // at most ~30 dB of suppression per bin

// Active profile: { bins: Float32Array of noise power per bin, binHz,
// sampleRate, fftSize, capturedAt, seconds, frames } or null.
let profile = null;

// Active capture: { sum: Float32Array | null, frames, seconds, startedAt }
let capture = null;

const finiteDb = (value) => (Number.isFinite(value) ? Math.max(value, MIN_DB) : MIN_DB);
const dbToPower = (db) => Math.pow(10, finiteDb(db) / 10);
const powerToDb = (power) => 10 * Math.log10(Math.max(power, EPSILON * EPSILON));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// Load the stored profile (called at boot on every window, and again whenever
// another window finishes/clears a capture).
export function loadNoiseFloor() {
  profile = null;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!raw || raw.v !== 1) return null;
    const dbs = Array.isArray(raw.dbs) ? raw.dbs : null;
    const sampleRate = Number(raw.sampleRate);
    const fftSize = Number(raw.fftSize);
    if (!dbs || dbs.length < 2 || !Number.isFinite(sampleRate) || !Number.isFinite(fftSize)) {
      return null;
    }
    const bins = new Float32Array(dbs.length);
    for (let i = 0; i < dbs.length; i++) bins[i] = dbToPower(Number(dbs[i]));
    profile = {
      bins,
      binHz: sampleRate / fftSize,
      sampleRate,
      fftSize,
      capturedAt: Number(raw.capturedAt) || Date.now(),
      seconds: Number(raw.seconds) || 0,
      frames: Number(raw.frames) || 0,
    };
  } catch {
    profile = null;
  }
  return profile ? getNoiseFloorMeta() : null;
}

export function clearNoiseFloor() {
  profile = null;
  capture = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage full/blocked — the in-memory clear still applies
  }
}

function persistProfile() {
  if (!profile) return;
  const dbs = new Array(profile.bins.length);
  for (let i = 0; i < profile.bins.length; i++) {
    dbs[i] = Math.round(powerToDb(profile.bins[i]) * 10) / 10;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 1,
      sampleRate: profile.sampleRate,
      fftSize: profile.fftSize,
      capturedAt: profile.capturedAt,
      seconds: profile.seconds,
      frames: profile.frames,
      dbs,
    }));
  } catch {
    // Non-fatal: the profile still works for this session.
  }
}

export function hasNoiseFloor() {
  return !!profile;
}

export function getNoiseFloorMeta() {
  if (!profile) return null;
  return {
    sampleRate: profile.sampleRate,
    fftSize: profile.fftSize,
    binCount: profile.bins.length,
    capturedAt: profile.capturedAt,
    seconds: profile.seconds,
    frames: profile.frames,
  };
}

// Noise level (dB) at an arbitrary frequency — used by the control panel to
// draw the captured signature as a dashed curve on the log-frequency EQ.
export function sampleNoiseFloorDb(hz) {
  if (!profile) return null;
  const pos = clamp(hz / profile.binHz, 0, profile.bins.length - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, profile.bins.length - 1);
  const frac = pos - i0;
  return powerToDb(profile.bins[i0] * (1 - frac) + profile.bins[i1] * frac);
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export function startNoiseCapture(seconds = NOISE_CAPTURE_DEFAULT_SECONDS) {
  capture = {
    sum: null,
    frames: 0,
    seconds: clamp(Number(seconds) || NOISE_CAPTURE_DEFAULT_SECONDS,
      NOISE_CAPTURE_MIN_SECONDS, NOISE_CAPTURE_MAX_SECONDS),
    startedAt: performance.now(),
  };
  return getNoiseCaptureState();
}

export function cancelNoiseCapture() {
  capture = null;
}

export function isNoiseCapturing() {
  return !!capture;
}

export function getNoiseCaptureState() {
  if (!capture) return { capturing: false, progress: 0, elapsed: 0, seconds: 0, frames: 0 };
  const elapsed = (performance.now() - capture.startedAt) / 1000;
  return {
    capturing: true,
    elapsed,
    seconds: capture.seconds,
    frames: capture.frames,
    progress: clamp(elapsed / capture.seconds, 0, 1),
  };
}

// Feed one raw analysis frame into the capture. Channels are mixed in the
// power domain like everywhere else in the app. Returns the capture state;
// once the requested duration has elapsed the profile is finalised right here
// (this runs on the screen, inside getAnalysisFrame) and `done` flips true.
export function feedNoiseCapture(frame) {
  if (!capture) return null;

  const left = frame?.left;
  const right = frame?.right;
  if (!left?.length && !right?.length) return getNoiseCaptureState();

  const binCount = Math.max(left?.length || 0, right?.length || 0);
  if (!capture.sum || capture.sum.length !== binCount) {
    capture.sum = new Float32Array(binCount);
    capture.frames = 0;
  }

  const channelCount = left?.length && right?.length ? 2 : 1;
  for (let i = 0; i < binCount; i++) {
    let power = 0;
    if (left?.length) power += dbToPower(left[Math.min(i, left.length - 1)]);
    if (right?.length) power += dbToPower(right[Math.min(i, right.length - 1)]);
    capture.sum[i] += power / channelCount;
  }
  capture.frames += 1;

  const state = getNoiseCaptureState();
  if (state.elapsed >= capture.seconds && capture.frames > 0) {
    const bins = new Float32Array(binCount);
    for (let i = 0; i < binCount; i++) bins[i] = capture.sum[i] / capture.frames;
    profile = {
      bins,
      binHz: (Math.max(8000, Number(frame.sampleRate) || 48000)) /
        (Math.max(binCount * 2, Number(frame.fftSize) || binCount * 2)),
      sampleRate: Math.max(8000, Number(frame.sampleRate) || 48000),
      fftSize: Math.max(binCount * 2, Number(frame.fftSize) || binCount * 2),
      capturedAt: Date.now(),
      seconds: capture.seconds,
      frames: capture.frames,
    };
    capture = null;
    persistProfile();
    return { ...state, capturing: false, done: true, progress: 1 };
  }
  return state;
}

// ---------------------------------------------------------------------------
// Subtraction
// ---------------------------------------------------------------------------

// Noise power at a live bin frequency, resampling the stored profile by Hz so
// a profile captured at another sample rate / FFT size still lines up.
function noisePowerAtHz(hz) {
  const pos = clamp(hz / profile.binHz, 0, profile.bins.length - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, profile.bins.length - 1);
  const frac = pos - i0;
  return profile.bins[i0] * (1 - frac) + profile.bins[i1] * frac;
}

function cleanArray(arr, binHz) {
  for (let i = 0; i < arr.length; i++) {
    const power = dbToPower(arr[i]);
    const noise = noisePowerAtHz(i * binHz) * OVERSUBTRACTION;
    // Spectral subtraction with a proportional floor: bins at the captured
    // level drop ~30 dB, bins far above it are barely touched.
    const clean = Math.max(power - noise, power * FLOOR_RATIO, EPSILON * EPSILON);
    arr[i] = Math.max(powerToDb(clean), MIN_DB);
  }
}

// Subtract the stored noise floor from a frame's dB spectra IN PLACE. Called
// by AudioManager.getAnalysisFrame AFTER the raw frame has been fed to the
// capture, so every consumer (feature extractor, EQ broadcast) sees cleaned
// data while a re-capture always samples the raw signature.
export function applyNoiseFloor(left, right, sampleRate, fftSize) {
  if (!profile) return false;
  const liveBinHz = (Math.max(8000, Number(sampleRate) || 48000)) /
    (Math.max(2, Number(fftSize) || 2048));
  if (left?.length) cleanArray(left, liveBinHz);
  if (right?.length) cleanArray(right, liveBinHz);
  return true;
}
