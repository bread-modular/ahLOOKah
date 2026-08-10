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
// windows reload the profile when the capture-owning control broadcasts changes.

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
// sampleRate, fftSize, deviceId, channels, noiseRms, capturedAt, seconds, frames } or null.
let profile = null;

// Active capture: { sum: Float32Array | null, rmsSum, rmsCount, frames, seconds, startedAt, sampleRate, fftSize, deviceId, channels }
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
    const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : null;
    const channels = Number.isFinite(raw.channels) ? Math.max(1, Math.round(raw.channels)) : null;
    const noiseRms = Number.isFinite(raw.noiseRms) ? clamp(Number(raw.noiseRms), 0, 1) : null;
    profile = {
      bins,
      binHz: sampleRate / fftSize,
      sampleRate,
      fftSize,
      deviceId,
      channels,
      noiseRms,
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
      deviceId: profile.deviceId || null,
      channels: profile.channels ?? null,
      noiseRms: profile.noiseRms ?? null,
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
    deviceId: profile.deviceId || null,
    channels: profile.channels ?? null,
    noiseRms: profile.noiseRms ?? null,
    capturedAt: profile.capturedAt,
    seconds: profile.seconds,
    frames: profile.frames,
  };
}

export function getNoiseRms() {
  return profile?.noiseRms ?? null;
}

export function isNoiseProfileCompatible(frame) {
  if (!profile) return false;
  if (!frame) return true;
  const liveDeviceId = frame.deviceId || frame.ownerId || null;
  const liveChannels = Number.isFinite(frame.channels) ? frame.channels : (Number.isFinite(frame.channelCount) ? frame.channelCount : null);
  const liveSampleRate = Number(frame.sampleRate) || null;
  const liveFftSize = Number(frame.fftSize) || null;
  // Device mismatch is the primary corruption source — reject if both sides have explicit ids and they differ
  if (profile.deviceId && liveDeviceId && profile.deviceId !== liveDeviceId) return false;
  // Channel count mismatch beyond 1 is suspicious but not fatal due to mixing; still allow if within 1
  // SampleRate/FFT size are resampled via Hz, so allow any reasonable values; only reject if wildly out of range
  if (liveSampleRate && profile.sampleRate && Math.abs(Math.log2(liveSampleRate / profile.sampleRate)) > 2) return false;
  if (liveFftSize && profile.fftSize && Math.abs(Math.log2(liveFftSize / profile.fftSize)) > 2) return false;
  if (profile.channels && liveChannels && Math.abs(profile.channels - liveChannels) > 1) {
    // Still allow but note incompatibility — we treat as compatible for now since mixing handles it
  }
  return true;
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
    rmsSum: 0,
    rmsCount: 0,
    frames: 0,
    seconds: clamp(Number(seconds) || NOISE_CAPTURE_DEFAULT_SECONDS,
      NOISE_CAPTURE_MIN_SECONDS, NOISE_CAPTURE_MAX_SECONDS),
    startedAt: performance.now(),
    sampleRate: null,
    fftSize: null,
    deviceId: null,
    channels: null,
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

function computeFrameRms(frame) {
  if (Number.isFinite(frame?.rms)) return clamp(Number(frame.rms), 0, 1);
  const left = frame?.waveformLeft;
  const right = frame?.waveformRight;
  if (!left?.length && !right?.length) return null;
  let sum = 0;
  let samples = 0;
  if (left?.length) {
    for (let i = 0; i < left.length; i++) {
      const v = Number.isFinite(left[i]) ? left[i] : 0;
      sum += v * v;
    }
    samples += left.length;
  }
  if (right?.length) {
    for (let i = 0; i < right.length; i++) {
      const v = Number.isFinite(right[i]) ? right[i] : 0;
      sum += v * v;
    }
    samples += right.length;
  }
  return samples ? Math.sqrt(sum / samples) : null;
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
    capture.rmsSum = 0;
    capture.rmsCount = 0;
  }

  // Capture metadata from first frame
  if (capture.sampleRate == null && Number.isFinite(frame.sampleRate)) capture.sampleRate = Number(frame.sampleRate);
  if (capture.fftSize == null && Number.isFinite(frame.fftSize)) capture.fftSize = Number(frame.fftSize);
  if (capture.deviceId == null && typeof frame.deviceId === 'string') capture.deviceId = frame.deviceId;
  if (capture.channels == null) {
    if (Number.isFinite(frame.channels)) capture.channels = Number(frame.channels);
    else if (Number.isFinite(frame.channelCount)) capture.channels = Number(frame.channelCount);
    else capture.channels = left?.length && right?.length ? 2 : 1;
  }

  const channelCount = left?.length && right?.length ? 2 : 1;
  for (let i = 0; i < binCount; i++) {
    let power = 0;
    if (left?.length) power += dbToPower(left[Math.min(i, left.length - 1)]);
    if (right?.length) power += dbToPower(right[Math.min(i, right.length - 1)]);
    capture.sum[i] += power / channelCount;
  }
  capture.frames += 1;

  // Capture waveform RMS for noise gating
  const rms = computeFrameRms(frame);
  if (rms !== null) {
    capture.rmsSum += rms * rms;
    capture.rmsCount += 1;
  }

  const state = getNoiseCaptureState();
  if (state.elapsed >= capture.seconds && capture.frames > 0) {
    const bins = new Float32Array(binCount);
    for (let i = 0; i < binCount; i++) bins[i] = capture.sum[i] / capture.frames;
    const sampleRate = Math.max(8000, Number(frame.sampleRate) || capture.sampleRate || 48000);
    const fftSize = Math.max(binCount * 2, Number(frame.fftSize) || capture.fftSize || binCount * 2);
    const noiseRms = capture.rmsCount > 0 ? Math.sqrt(capture.rmsSum / capture.rmsCount) : null;
    profile = {
      bins,
      binHz: sampleRate / fftSize,
      sampleRate,
      fftSize,
      deviceId: capture.deviceId || (typeof frame.deviceId === 'string' ? frame.deviceId : null),
      channels: capture.channels ?? (left?.length && right?.length ? 2 : 1),
      noiseRms,
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

function cleanRms(liveRms) {
  const noiseRms = profile?.noiseRms;
  if (noiseRms == null || !Number.isFinite(liveRms)) return liveRms;
  const livePower = liveRms * liveRms;
  const noisePower = noiseRms * noiseRms * OVERSUBTRACTION;
  const cleanPower = Math.max(livePower - noisePower, livePower * FLOOR_RATIO, EPSILON * EPSILON);
  // If live is close to noise floor, gate to near zero
  const gated = Math.sqrt(cleanPower);
  // Additional hard gate: if liveRms is within 3dB of noiseRms, suppress further
  if (liveRms < noiseRms * 1.0) {
    // Scale down proportionally when near floor
    const ratio = clamp((liveRms - noiseRms * 0.5) / (noiseRms * 0.5), 0, 1);
    return gated * ratio;
  }
  return gated;
}

// Subtract the stored noise floor from a frame's dB spectra IN PLACE. Called
// by AudioManager.getAnalysisFrame AFTER the raw frame has been fed to the
// capture, so every consumer (feature extractor, EQ broadcast) sees cleaned
// data while a re-capture always samples the raw signature.
// Supports both legacy (left,right,sampleRate,fftSize) and new frame-object signatures.
export function applyNoiseFloor(leftOrFrame, right, sampleRate, fftSize) {
  if (!profile) return false;

  // New signature: applyNoiseFloor(frame)
  if (leftOrFrame && typeof leftOrFrame === 'object' && !ArrayBuffer.isView(leftOrFrame) && leftOrFrame.left) {
    const frame = leftOrFrame;
    if (!isNoiseProfileCompatible(frame)) return false;
    const liveSampleRate = Number(frame.sampleRate) || profile.sampleRate;
    const liveFftSize = Number(frame.fftSize) || profile.fftSize;
    const liveBinHz = Math.max(8000, liveSampleRate) / Math.max(2, liveFftSize);
    if (frame.left?.length) cleanArray(frame.left, liveBinHz);
    if (frame.right?.length) cleanArray(frame.right, liveBinHz);
    // Clean RMS / waveform gate
    if (profile.noiseRms != null) {
      const liveRms = computeFrameRms(frame);
      if (liveRms !== null) {
        const cleaned = cleanRms(liveRms);
        frame.rms = cleaned;
        // Optionally gate waveform amplitude by scaling waveform arrays toward zero when near floor
        // We scale waveform samples proportionally to rms cleaning to keep consistency
        if (liveRms > 1e-6) {
          const scale = cleaned / liveRms;
          if (scale < 0.99) {
            if (frame.waveformLeft?.length) {
              for (let i = 0; i < frame.waveformLeft.length; i++) frame.waveformLeft[i] *= scale;
            }
            if (frame.waveformRight?.length) {
              for (let i = 0; i < frame.waveformRight.length; i++) frame.waveformRight[i] *= scale;
            }
          }
        } else if (cleaned === 0) {
          if (frame.waveformLeft?.length) frame.waveformLeft.fill(0);
          if (frame.waveformRight?.length) frame.waveformRight.fill(0);
        }
      }
    }
    return true;
  }

  // Legacy signature: applyNoiseFloor(left, right, sampleRate, fftSize)
  const left = leftOrFrame;
  // For legacy, we don't have deviceId to check compatibility; just apply spectral
  const liveBinHz = (Math.max(8000, Number(sampleRate) || 48000)) /
    (Math.max(2, Number(fftSize) || 2048));
  let applied = false;
  if (left?.length) { cleanArray(left, liveBinHz); applied = true; }
  if (right?.length) { cleanArray(right, liveBinHz); applied = true; }
  return applied;
}
