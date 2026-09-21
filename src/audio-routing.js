// Per-node audio input routing contract: device/channel selectors, validation,
// tuple keys and channel-frame projection. This module is the shared vocabulary
// for the graph model (model.js), the compact transport (pattern-audio-protocol)
// and the capture routing (pool/engine), so a route can never mean one thing in
// a saved file and another on the wire. Deliberately dependency-free and
// DOM-free: definitions.js imports it, and it must never import back.

// Reserved internal pattern id for Audio-node signal slots (mirrored by
// nodes/audio-source.js, which is the only place allowed to register it).
export const NODE_AUDIO_SIGNAL_PATTERN_ID = '__node_audio_signal';

// deviceId: null means "Global input (Settings)" — a live reference resolved
// only by the capture owner, never a snapshot of the current device id. A
// nonempty string pins the node to that exact browser input.
export const DEFAULT_AUDIO_INPUT = Object.freeze({ deviceId: null, channel: 'mono' });
export const AUDIO_CHANNELS = Object.freeze(['left', 'right', 'mono']);
export const AUDIO_CHANNEL_LABELS = Object.freeze({ left: 'Left', right: 'Right', mono: 'Mono' });
// Opaque browser device ids are preserved exactly (case and punctuation); the
// bound only keeps hostile files from stuffing arbitrary payloads into a node.
export const MAX_AUDIO_DEVICE_ID_LENGTH = 512;

// Per-source availability states reported on v2 control slots and diagnostics.
export const AUDIO_SOURCE_STATUSES = Object.freeze([
  'running', 'starting', 'unselected', 'permission-required', 'permission-denied',
  'suspended', 'muted', 'missing', 'unavailable', 'resource-limit', 'identity-unknown',
]);
// Calibration provenance of a routed frame (noise-floor coordination).
export const AUDIO_CALIBRATION_STATES = Object.freeze([
  'none', 'mixed-profile', 'channel-profile', 'uncalibrated-device', 'uncalibrated-channel',
]);

const hasControlChars = (value) => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

// Opaque device id: nonempty string within the bound, case/punctuation
// preserved, no graph-id rules, no trimming, no coercion of numbers/objects.
export function isValidAudioDeviceId(value) {
  return typeof value === 'string' && value.length > 0
    && value.length <= MAX_AUDIO_DEVICE_ID_LENGTH && !hasControlChars(value);
}

// Normalize one stored/transported route. `undefined` means "field missing" and
// falls back to the documented defaults; anything invalid returns null so the
// caller decides how to report it (graph files fail validation, transport
// rejects the message). Explicit null deviceId is the Global selector; explicit
// null/misspelled channel is invalid, never silently repaired.
export function normalizeAudioRoute(deviceId, channel) {
  const resolvedDevice = deviceId === undefined ? null : deviceId;
  if (resolvedDevice !== null && !isValidAudioDeviceId(resolvedDevice)) return null;
  const resolvedChannel = channel === undefined ? 'mono' : channel;
  if (!AUDIO_CHANNELS.includes(resolvedChannel)) return null;
  return { deviceId: resolvedDevice, channel: resolvedChannel };
}

export const sameAudioRoute = (a, b) => !!a && !!b
  && a.deviceId === b.deviceId && a.channel === b.channel;

export const isDefaultAudioRoute = (route) => !!route && route.deviceId === null && route.channel === 'mono';

// Structured tuple key for Maps. JSON encoding keeps the key unambiguous even
// for device ids containing any delimiter (JSON escapes control characters), and
// the key is never parsed back apart.
export const audioRouteKey = (route) => JSON.stringify([route?.deviceId ?? null, route?.channel ?? 'mono']);

const channelRms = (wave) => {
  if (!wave?.length) return undefined;
  let sum = 0;
  let samples = 0;
  for (let i = 0; i < wave.length; i++) {
    const value = wave[i];
    if (!Number.isFinite(value)) continue;
    sum += value * value;
    samples += 1;
  }
  return samples ? Math.sqrt(sum / samples) : undefined;
};

// Select-before-extraction projection (plan section 4.3). Mono is the identity:
// it keeps today's combined two-channel frame (power-mix semantics live in the
// feature/support math, not here). Left/Right expose ONLY their channel as a
// single-channel analysis frame: `right`/`waveformRight` are omitted, and RMS is
// recomputed from that channel's own waveform so a stereo-derived combined RMS
// override can never leak into gating/AGC. The source arrays are shared by
// reference — projections are read-only views; noise processing runs on copies.
export function projectChannelFrame(frame, channel) {
  if (!frame || channel === 'mono') return frame;
  const spectrum = channel === 'left' ? frame.left : frame.right;
  const wave = channel === 'left' ? frame.waveformLeft : frame.waveformRight;
  return {
    left: spectrum || undefined,
    waveformLeft: wave || undefined,
    sampleRate: frame.sampleRate,
    fftSize: frame.fftSize,
    time: frame.time,
    deviceId: frame.deviceId,
    channels: frame.channels,
    ...(channelRms(wave) !== undefined ? { rms: channelRms(wave) } : {}),
  };
}

// Physical mono (or unknown-count) sources mirror channel 0 into both logical
// channels, so every requested selection analyses the same effective route
// without halving or doubling level. The stored requested selection is kept so
// it takes effect if the device later supplies stereo.
export function effectiveAudioChannel(channel, sourceChannels) {
  if (channel === 'mono') return 'mono';
  // A missing channel-count setting keeps the existing conservative
  // one-channel/mirror assumption: every selection reads the same signal.
  if (!Number.isFinite(sourceChannels) || sourceChannels <= 1) return 'mono';
  return channel;
}
