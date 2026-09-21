// Bounded audio-input catalog transport (plan section 8). The capture owner is
// the only catalog producer; editors consume validated snapshots. This module is
// DOM-free: it validates and stores, it never probes devices.

export const CATALOG_LIMITS = Object.freeze({
  maxInputs: 128,
  maxLabelLength: 160,
  maxIdLength: 512,
});

export const CATALOG_AUDIO_INPUTS_TYPE = 'audio-inputs';
export const CATALOG_AUDIO_INPUTS_REQUEST_TYPE = 'audio-inputs-request';

const CATALOG_PERMISSION_STATES = Object.freeze(['unknown', 'prompt', 'granted', 'denied']);

function boundedText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

// Validate one owner `audio-inputs` broadcast. Returns a normalized snapshot or
// null. Raw device ids are opaque; labels are display-only and bounded.
export function validateAudioInputsMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (message.type !== CATALOG_AUDIO_INPUTS_TYPE) return null;
  const ownerId = boundedText(message.audioOwnerId, 160);
  if (!ownerId) return null;
  if (message.ownerStatus !== 'active' && message.ownerStatus !== 'stopping') return null;
  const catalogRevision = message.catalogRevision;
  if (!Number.isInteger(catalogRevision) || catalogRevision < 0) return null;
  if (message.complete !== true) return null;
  if (!CATALOG_PERMISSION_STATES.includes(message.permissionState)) return null;
  let globalRequestedId = null;
  if (message.globalRequestedId != null) {
    globalRequestedId = boundedText(message.globalRequestedId, CATALOG_LIMITS.maxIdLength);
    if (!globalRequestedId) return null;
  }
  let globalActiveId = null;
  if (message.globalActiveId != null) {
    globalActiveId = boundedText(message.globalActiveId, CATALOG_LIMITS.maxIdLength);
    if (!globalActiveId) return null;
  }
  if (!Array.isArray(message.inputs) || message.inputs.length > CATALOG_LIMITS.maxInputs) return null;
  const inputs = [];
  const seen = new Set();
  for (const entry of message.inputs) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const deviceId = boundedText(entry.deviceId, CATALOG_LIMITS.maxIdLength);
    if (!deviceId || seen.has(deviceId)) return null;
    seen.add(deviceId);
    const label = boundedText(entry.label, CATALOG_LIMITS.maxLabelLength);
    inputs.push({ deviceId, ...(label ? { label } : {}) });
  }
  return {
    type: CATALOG_AUDIO_INPUTS_TYPE,
    audioOwnerId: ownerId,
    ownerStatus: message.ownerStatus,
    catalogRevision,
    complete: true,
    permissionState: message.permissionState,
    globalRequestedId,
    globalActiveId,
    globalStatus: typeof message.globalStatus === 'string' ? message.globalStatus.slice(0, 32) : null,
    fallback: Boolean(message.fallback),
    inputs,
  };
}

// A validated `audio-inputs-request`: discovery/capabilities only. It can never
// cause a permission prompt or a capture by itself.
export function validateAudioInputsRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (message.type !== CATALOG_AUDIO_INPUTS_REQUEST_TYPE) return null;
  const requesterId = boundedText(message.requesterId, 160);
  if (!requesterId) return null;
  return { type: CATALOG_AUDIO_INPUTS_REQUEST_TYPE, requesterId };
}

// Consumer-side catalog state shared by both editor providers. Keeps the last
// snapshot per owner epoch; `ownerStatus: 'stopping'` or a changed owner id
// flips the stored snapshot to stale without ever inventing device entries.
export function createAudioInputsCatalog() {
  let snapshot = null;
  let stale = true;
  const listeners = new Set();
  const emit = () => { for (const listener of [...listeners]) { try { listener(exported()); } catch { /* noop */ } } };

  function exported() {
    return { ...snapshot, stale };
  }

  return {
    accept(message) {
      const clean = validateAudioInputsMessage(message);
      if (!clean) return false;
      const ownerChanged = snapshot && snapshot.audioOwnerId !== clean.audioOwnerId;
      snapshot = clean;
      stale = clean.ownerStatus === 'stopping' || Boolean(ownerChanged);
      emit();
      return true;
    },
    markStale() {
      if (!stale) {
        stale = true;
        emit();
      }
    },
    getSnapshot: exported,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      listener(exported());
      return () => listeners.delete(listener);
    },
    reset() {
      snapshot = null;
      stale = true;
      emit();
    },
  };
}
