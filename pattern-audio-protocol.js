// Pattern-specific audio transport protocol shared by capture owners and render
// consumers. Keep this module DOM-free so validation and sizing can be tested in
// a browser page without booting p5 or microphone capture.

export const PATTERN_AUDIO_PROTOCOL_VERSION = 1;
export const PATTERN_AUDIO_PLAN_TYPE = 'pattern-audio-plan';
export const PATTERN_AUDIO_CONTROLS_TYPE = 'pattern-audio-controls';
export const PATTERN_AUDIO_PLAN_REQUEST_TYPE = 'pattern-audio-plan-request';
export const PATTERN_CONTROLS_TRANSPORT = 'pattern-controls';
export const LEGACY_AUDIO_TRANSPORT = 'analysis-frame';

export const PATTERN_AUDIO_LIMITS = Object.freeze({
  maxSlots: 8,
  maxParamKeys: 16,
  maxControlKeys: 64,
  maxKeyLength: 64,
  maxIdLength: 160,
  maxEventIdLength: 128,
  maxArrayElements: 512,
  maxEventsPerSlot: 16,
  maxRevision: 0x7fffffff,
  maxFiniteMagnitude: 1_000_000,
});

export const PATTERN_AUDIO_PLAN_LEASE_MS = 3_500;
export const PATTERN_AUDIO_EXPECTED_CONSUMER_MS = 8_000;
export const PATTERN_AUDIO_STALE_AFTER_MS = 750;
// One-shot visual events are only meaningful close to their receipt time. They
// must never accumulate in a paused CUE renderer and replay on a later TAKE.
export const PATTERN_AUDIO_EVENT_MAX_AGE_MS = 250;
export const PATTERN_AUDIO_NEUTRAL_DECAY_MS = 350;

const allowedRoles = new Set(['live', 'cue', 'incoming', 'retiring', 'preview']);

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function validString(value, max = PATTERN_AUDIO_LIMITS.maxKeyLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validRevision(value) {
  return Number.isInteger(value) && value >= 0 && value <= PATTERN_AUDIO_LIMITS.maxRevision;
}

function validFinite(value) {
  return isFiniteNumber(value) && Math.abs(value) <= PATTERN_AUDIO_LIMITS.maxFiniteMagnitude;
}

export function cloneTransportValue(value) {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return new value.constructor(value);
  }
  if (Array.isArray(value)) return value.map((entry) => cloneTransportValue(entry));
  if (isPlainObject(value)) {
    const output = {};
    for (const [key, entry] of Object.entries(value)) output[key] = cloneTransportValue(entry);
    return output;
  }
  return value;
}

export function estimateTransportBytes(value, seen = new Set()) {
  if (value == null) return 0;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'string') return value.length * 2;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return value.byteLength;
  if (typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return value.reduce((total, entry) => total + estimateTransportBytes(entry, seen), 0);
  return Object.entries(value).reduce((total, [key, entry]) => total + key.length * 2 + estimateTransportBytes(entry, seen), 0);
}

export function getAudioTransport(sketch) {
  return sketch?.audioTransport === PATTERN_CONTROLS_TRANSPORT
    ? PATTERN_CONTROLS_TRANSPORT
    : LEGACY_AUDIO_TRANSPORT;
}

export function snapshotPatternParams(sketch, values = {}) {
  const snapshot = {};
  const defs = Array.isArray(sketch?.params) ? sketch.params : [];
  for (const def of defs) {
    if (!validString(def?.key)) continue;
    const fallback = Number.isFinite(def.default) ? def.default : 0;
    const source = Number.isFinite(values?.[def.key]) ? values[def.key] : fallback;
    const min = Number.isFinite(def.min) ? def.min : -PATTERN_AUDIO_LIMITS.maxFiniteMagnitude;
    const max = Number.isFinite(def.max) ? def.max : PATTERN_AUDIO_LIMITS.maxFiniteMagnitude;
    snapshot[def.key] = clamp(source, min, max);
  }
  return snapshot;
}

export function paramsFingerprint(params = {}) {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}:${Number(params[key])}`)
    .join('|');
}

function validateParams(sketch, params) {
  if (!isPlainObject(params)) return null;
  const keys = Object.keys(params);
  if (keys.length > PATTERN_AUDIO_LIMITS.maxParamKeys) return null;
  const defs = Array.isArray(sketch?.params) ? sketch.params : [];
  const byKey = new Map(defs.map((def) => [def.key, def]));
  const output = {};

  for (const [key, value] of Object.entries(params)) {
    if (!validString(key) || !byKey.has(key) || !validFinite(value)) return null;
    const def = byKey.get(key);
    const min = Number.isFinite(def.min) ? def.min : -PATTERN_AUDIO_LIMITS.maxFiniteMagnitude;
    const max = Number.isFinite(def.max) ? def.max : PATTERN_AUDIO_LIMITS.maxFiniteMagnitude;
    // The plan contains *accepted* values. Reject, rather than silently repair,
    // an out-of-range remote plan so a malformed sender cannot change authority.
    if (value < min - 1e-6 || value > max + 1e-6) return null;
    output[key] = clamp(value, min, max);
  }

  // A pattern plan always carries a complete accepted parameter object. This
  // makes revisions meaningful and avoids controller defaults drifting from the
  // renderer after a partial or malformed message.
  if (output && Object.keys(output).length !== defs.length) return null;
  return output;
}

function publicSlot(slot) {
  return {
    runtimeId: slot.runtimeId,
    patternId: slot.patternId,
    role: slot.role,
    childIndex: slot.childIndex,
    paramsRevision: slot.paramsRevision,
    params: { ...slot.params },
    audioTransport: slot.audioTransport,
  };
}

export function toPublicPlanSlot(slot) {
  return publicSlot(slot);
}

export function validatePatternAudioPlan(message, { getSketchById } = {}) {
  if (!isPlainObject(message)
    || message.type !== PATTERN_AUDIO_PLAN_TYPE
    || message.version !== PATTERN_AUDIO_PROTOCOL_VERSION
    || !validString(message.consumerSessionId, PATTERN_AUDIO_LIMITS.maxIdLength)
    || !validRevision(message.planRevision)
    || !isFiniteNumber(message.sentAt)
    || message.complete !== true
    || !Array.isArray(message.slots)
    || message.slots.length > PATTERN_AUDIO_LIMITS.maxSlots) return null;

  const slots = [];
  const runtimeIds = new Set();
  for (const slot of message.slots) {
    if (!isPlainObject(slot)
      || !validString(slot.runtimeId, PATTERN_AUDIO_LIMITS.maxIdLength)
      || !validString(slot.patternId)
      || !validString(slot.role, 24)
      || !allowedRoles.has(slot.role)
      || !Number.isInteger(slot.childIndex)
      || slot.childIndex < 0
      || slot.childIndex >= PATTERN_AUDIO_LIMITS.maxSlots
      || !validRevision(slot.paramsRevision)
      || (slot.audioTransport !== PATTERN_CONTROLS_TRANSPORT && slot.audioTransport !== LEGACY_AUDIO_TRANSPORT)
      || runtimeIds.has(slot.runtimeId)) return null;

    const sketch = typeof getSketchById === 'function' ? getSketchById(slot.patternId) : null;
    if (!sketch || getAudioTransport(sketch) !== slot.audioTransport) return null;
    const params = validateParams(sketch, slot.params);
    if (!params) return null;

    runtimeIds.add(slot.runtimeId);
    slots.push({
      runtimeId: slot.runtimeId,
      patternId: slot.patternId,
      role: slot.role,
      childIndex: slot.childIndex,
      paramsRevision: slot.paramsRevision,
      params,
      audioTransport: slot.audioTransport,
    });
  }

  return {
    type: PATTERN_AUDIO_PLAN_TYPE,
    version: PATTERN_AUDIO_PROTOCOL_VERSION,
    consumerSessionId: message.consumerSessionId,
    planRevision: message.planRevision,
    sentAt: message.sentAt,
    complete: true,
    slots,
  };
}

function validateTypedArray(value) {
  if (!ArrayBuffer.isView(value) || value instanceof DataView) return null;
  if (!Number.isInteger(value.length) || value.length > PATTERN_AUDIO_LIMITS.maxArrayElements) return null;
  for (let i = 0; i < value.length; i++) {
    if (!validFinite(value[i])) return null;
  }
  return new value.constructor(value);
}

function validateContinuous(continuous) {
  if (!isPlainObject(continuous) || Object.keys(continuous).length > PATTERN_AUDIO_LIMITS.maxControlKeys) return null;
  const output = {};
  for (const [key, value] of Object.entries(continuous)) {
    if (!validString(key) || !validFinite(value)) return null;
    output[key] = value;
  }
  return output;
}

function validateArrays(arrays) {
  if (!isPlainObject(arrays) || Object.keys(arrays).length > PATTERN_AUDIO_LIMITS.maxControlKeys) return null;
  const output = {};
  for (const [key, value] of Object.entries(arrays)) {
    if (!validString(key)) return null;
    const array = validateTypedArray(value);
    if (!array) return null;
    output[key] = array;
  }
  return output;
}

function validateEvent(event) {
  if (!isPlainObject(event)
    || !validString(event.id, PATTERN_AUDIO_LIMITS.maxEventIdLength)
    || !validString(event.type, PATTERN_AUDIO_LIMITS.maxKeyLength)) return null;
  const output = { id: event.id, type: event.type };
  for (const [key, value] of Object.entries(event)) {
    if (key === 'id' || key === 'type') continue;
    if (!validString(key) || !validFinite(value)) return null;
    output[key] = value;
  }
  return output;
}

export function validatePatternAudioControls(message) {
  if (!isPlainObject(message)
    || message.type !== PATTERN_AUDIO_CONTROLS_TYPE
    || message.version !== PATTERN_AUDIO_PROTOCOL_VERSION
    || !validString(message.consumerSessionId, PATTERN_AUDIO_LIMITS.maxIdLength)
    || !validRevision(message.planRevision)
    || !validString(message.audioOwnerId, PATTERN_AUDIO_LIMITS.maxIdLength)
    || !validString(message.streamGeneration, PATTERN_AUDIO_LIMITS.maxIdLength)
    || !validRevision(message.sequence)
    || !isFiniteNumber(message.captureTime)
    || (message.audioActive !== undefined && typeof message.audioActive !== 'boolean')
    || !Array.isArray(message.slots)
    || message.slots.length > PATTERN_AUDIO_LIMITS.maxSlots) return null;

  const slots = [];
  const runtimeIds = new Set();
  for (const slot of message.slots) {
    if (!isPlainObject(slot)
      || !validString(slot.runtimeId, PATTERN_AUDIO_LIMITS.maxIdLength)
      || runtimeIds.has(slot.runtimeId)
      || !validRevision(slot.paramsRevision)) return null;
    const continuous = validateContinuous(slot.continuous || {});
    const arrays = validateArrays(slot.arrays || {});
    if (!continuous || !arrays || !Array.isArray(slot.events) || slot.events.length > PATTERN_AUDIO_LIMITS.maxEventsPerSlot) return null;
    const events = [];
    const eventIds = new Set();
    for (const event of slot.events) {
      const clean = validateEvent(event);
      if (!clean || eventIds.has(clean.id)) return null;
      eventIds.add(clean.id);
      events.push(clean);
    }
    runtimeIds.add(slot.runtimeId);
    slots.push({ runtimeId: slot.runtimeId, paramsRevision: slot.paramsRevision, continuous, arrays, events });
  }

  return {
    type: PATTERN_AUDIO_CONTROLS_TYPE,
    version: PATTERN_AUDIO_PROTOCOL_VERSION,
    consumerSessionId: message.consumerSessionId,
    planRevision: message.planRevision,
    audioOwnerId: message.audioOwnerId,
    streamGeneration: message.streamGeneration,
    sequence: message.sequence,
    captureTime: message.captureTime,
    audioActive: Boolean(message.audioActive),
    slots,
  };
}

function normalizeRange(def, fallbackMin = -PATTERN_AUDIO_LIMITS.maxFiniteMagnitude, fallbackMax = PATTERN_AUDIO_LIMITS.maxFiniteMagnitude) {
  return {
    min: Number.isFinite(def?.min) ? def.min : fallbackMin,
    max: Number.isFinite(def?.max) ? def.max : fallbackMax,
  };
}

// Validate controller output against the receiving pattern's small, explicit
// schema. It is used both on the capture owner (before broadcast) and by the
// store (before mutating consumer state).
export function validateControlsForSlot(slot, descriptor) {
  if (!slot || !descriptor || slot.runtimeId !== descriptor.runtimeId || slot.paramsRevision !== descriptor.paramsRevision) return null;
  const schema = descriptor.audioControlSchema || {};
  const allowedContinuous = schema.continuous || {};
  const allowedArrays = schema.arrays || {};
  const allowedEvents = schema.events || {};
  const output = { runtimeId: slot.runtimeId, paramsRevision: slot.paramsRevision, continuous: {}, arrays: {}, events: [] };

  for (const [key, value] of Object.entries(slot.continuous || {})) {
    if (!Object.prototype.hasOwnProperty.call(allowedContinuous, key) || !validFinite(value)) return null;
    const range = normalizeRange(allowedContinuous[key]);
    if (value < range.min || value > range.max) return null;
    output.continuous[key] = value;
  }

  for (const [key, value] of Object.entries(slot.arrays || {})) {
    const definition = allowedArrays[key];
    if (!definition) return null;
    const array = validateTypedArray(value);
    if (!array) return null;
    const maxLength = Math.min(PATTERN_AUDIO_LIMITS.maxArrayElements, Number.isInteger(definition.maxLength) ? definition.maxLength : PATTERN_AUDIO_LIMITS.maxArrayElements);
    const minLength = Math.max(0, Number.isInteger(definition.minLength) ? definition.minLength : 0);
    const range = normalizeRange(definition);
    if (array.length < minLength || array.length > maxLength) return null;
    for (let i = 0; i < array.length; i++) {
      if (array[i] < range.min || array[i] > range.max) return null;
    }
    output.arrays[key] = array;
  }

  if (!Array.isArray(slot.events) || slot.events.length > PATTERN_AUDIO_LIMITS.maxEventsPerSlot) return null;
  const eventIds = new Set();
  for (const event of slot.events) {
    const clean = validateEvent(event);
    const definition = clean && allowedEvents[clean.type];
    if (!clean || !definition || eventIds.has(clean.id)) return null;
    const fieldDefs = definition.fields || {};
    const keys = Object.keys(clean).filter((key) => key !== 'id' && key !== 'type');
    if (keys.some((key) => !Object.prototype.hasOwnProperty.call(fieldDefs, key))) return null;
    for (const [field, fieldDef] of Object.entries(fieldDefs)) {
      if (!Object.prototype.hasOwnProperty.call(clean, field)) {
        if (fieldDef.required) return null;
        continue;
      }
      const range = normalizeRange(fieldDef);
      if (clean[field] < range.min || clean[field] > range.max) return null;
      if (fieldDef.integer && !Number.isInteger(clean[field])) return null;
    }
    eventIds.add(clean.id);
    output.events.push(clean);
  }

  return output;
}

export function neutralControlsForSchema(schema = {}) {
  const continuous = {};
  const arrays = {};
  const declared = schema.neutral?.continuous || {};
  for (const [key, definition] of Object.entries(schema.continuous || {})) {
    const fallback = Number.isFinite(definition?.neutral) ? definition.neutral : 0;
    const value = Number.isFinite(declared[key]) ? declared[key] : fallback;
    const range = normalizeRange(definition);
    continuous[key] = clamp(value, range.min, range.max);
  }
  for (const [key, definition] of Object.entries(schema.neutral?.arrays || {})) {
    if (!ArrayBuffer.isView(definition) || definition instanceof DataView) continue;
    arrays[key] = new definition.constructor(definition);
  }
  return { continuous, arrays, events: [] };
}
