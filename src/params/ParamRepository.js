// Canonical mutable parameter bank. The same object handed to a sketch factory
// is mutated in place on accepted changes so running sketches pick up slider
// updates immediately. In DEV builds each bank object is wrapped in a Proxy that
// records per-frame reads so `window.__viz.readLog()` can prove realtime updates.
import {
  SKETCHES,
  BLEND_ID,
  BANDS_ID,
  BAND_SPLIT_DEFAULTS,
  POSTFX_ID,
  BLEND_PARAMS,
  POSTFX_PARAMS,
  defaultParamValues,
} from '../sketch-registry.js';
import { MAX_PROJECTION_PARAMS, validProjectionPatch } from '../projection/projection-registry.js';
import { STORAGE } from '../platform/constants.js';

export function createParamRepository({ dev = false } = {}) {
  let paramValues = {};
  let paramRawValues = {};
  let devReadLog = dev ? {} : null;

  // Merge one accepted bank entry into an existing object in place so live
  // sketch factories (which captured the object by reference) keep following
  // it. Returns true when anything changed.
  function mergeBankEntryInPlace(current, next) {
    let touched = false;
    for (const key of Object.keys(current)) {
      if (key.startsWith('__')) continue;
      if (!(key in next)) {
        delete current[key];
        touched = true;
      }
    }
    for (const [key, value] of Object.entries(next)) {
      if (current[key] !== value) {
        current[key] = value;
        touched = true;
      }
    }
    return touched;
  }

  // Reconcile an accepted canonical bank while preserving the identity of
  // every entry object that renderers may already hold. Added ids are created
  // through getParams() so both maps stay in sync; removed ids are reset to
  // their defaults in place (never left stale in either map). BANDS_ID is
  // system-scoped and never part of the visual bank.
  function adoptCanonicalBank(bank) {
    const incoming = {};
    for (const [id, values] of Object.entries(copyVisualBank(bank))) {
      if (id === BANDS_ID || !values || typeof values !== 'object') continue;
      incoming[id] = values;
    }
    const known = new Set([...Object.keys(paramRawValues), ...Object.keys(incoming)]);
    let touched = false;
    for (const id of known) {
      if (id === BANDS_ID) continue;
      const next = incoming[id];
      if (next && typeof next === 'object') {
        const current = getParams(id);
        if (mergeBankEntryInPlace(current, next)) touched = true;
        paramRawValues[id] = current;
      } else {
        const current = paramValues[id];
        const defaults = defaultParamValues(id);
        if (current && typeof current === 'object') {
          // Reset in place: renderers holding this object see defaults, and
          // no stale keys survive in either map.
          let reset = false;
          for (const key of Object.keys(current)) {
            if (key.startsWith('__')) continue;
            if (!(key in defaults) || current[key] !== defaults[key]) {
              delete current[key];
              reset = true;
            }
          }
          for (const [key, value] of Object.entries(defaults)) {
            if (current[key] !== value) {
              current[key] = value;
              reset = true;
            }
          }
          if (reset) touched = true;
          paramRawValues[id] = current;
        } else if (paramRawValues[id] !== undefined) {
          delete paramRawValues[id];
          touched = true;
        }
      }
    }
    return touched;
  }

  function copyVisualBank(bank = {}) {
    const out = {};
    for (const [id, values] of Object.entries(bank)) {
      if (id !== BANDS_ID && values && typeof values === 'object') out[id] = { ...values };
    }
    return out;
  }

  function sanitizeParamEntry(id, values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
    const keys = Object.keys(values);
    if (keys.length > (SKETCHES.find((s) => s.id === id)?.projection ? MAX_PROJECTION_PARAMS : 16)) return null;
    const defs = id === BLEND_ID ? BLEND_PARAMS : id === POSTFX_ID ? POSTFX_PARAMS : id === BANDS_ID ? [] : (SKETCHES.find((s) => s.id === id)?.params || []);
    const defaults = defaultParamValues(id);
    const out = {};
    for (const k of keys) {
      if (k.startsWith('__')) continue;
      const v = values[k];
      if (!Number.isFinite(v)) continue;
      if (Math.abs(v) > 1e6) continue;
      const def = defs.find((d) => d.key === k);
      let clamped = v;
      if (SKETCHES.find((s) => s.id === id)?.projection && !def) continue;
      if (def) clamped = Math.min(Math.max(v, def.min - 1e-6), def.max + 1e-6);
      out[k] = clamped;
    }
    const merged = { ...defaults, ...out };
    for (const kk of Object.keys(merged)) if (!Number.isFinite(merged[kk])) merged[kk] = defaults[kk] ?? 0;
    if (!validProjectionPatch(SKETCHES.find((s) => s.id === id), {}, merged)) return defaults;
    return merged;
  }

  function loadParamValues() {
    let raw = {};
    try {
      const txt = localStorage.getItem(STORAGE.params);
      if (txt && txt.length > 1000000) throw new Error('oversize');
      raw = JSON.parse(txt) || {};
    } catch {
      raw = {};
    }
    if (typeof raw !== 'object' || raw === null) raw = {};
    const entries = Object.entries(raw);
    if (entries.length > 256) raw = Object.fromEntries(entries.slice(0, 256));
    if (typeof raw !== 'object' || raw === null) raw = {};

    const out = {};
    const knownIds = new Set(SKETCHES.map((s) => s.id));

    for (const [key, value] of Object.entries(raw)) {
      if (typeof key !== 'string' || key.length > 64) continue;
      if (key === BLEND_ID) {
        const sanitized = sanitizeParamEntry(BLEND_ID, value);
        out[key] = sanitized || defaultParamValues(BLEND_ID);
      } else if (key === BANDS_ID) {
        const sanitized = sanitizeParamEntry(BANDS_ID, value);
        if (sanitized) {
          const low = Number.isFinite(sanitized.low) ? Math.min(Math.max(sanitized.low, 40), 15000) : BAND_SPLIT_DEFAULTS.low;
          const high = Number.isFinite(sanitized.high) ? Math.min(Math.max(sanitized.high, 40), 15000) : BAND_SPLIT_DEFAULTS.high;
          out[key] = { low, high };
        } else out[key] = { ...defaultParamValues(BANDS_ID) };
      } else if (key === POSTFX_ID) {
        const sanitized = sanitizeParamEntry(POSTFX_ID, value);
        out[key] = sanitized || defaultParamValues(POSTFX_ID);
      } else if (knownIds.has(key)) {
        const sanitized = sanitizeParamEntry(key, value);
        if (sanitized) out[key] = sanitized;
      }
    }

    // Migrate legacy numeric (position-keyed) entries to sketch ids.
    for (const [key, value] of Object.entries(raw)) {
      if (Object.keys(out).length > 256) break;
      const n = parseInt(key, 10);
      if (!Number.isNaN(n) && SKETCHES[n] && !out[SKETCHES[n].id]) {
        const sanitized = sanitizeParamEntry(SKETCHES[n].id, value);
        if (sanitized) out[SKETCHES[n].id] = sanitized;
      }
    }

    return out;
  }

  function saveParamValues() {
    localStorage.setItem(STORAGE.params, JSON.stringify(paramRawValues));
  }

  function getParams(id) {
    let v = paramValues[id];
    if (!v) {
      v = defaultParamValues(id);
      paramValues[id] = v;
      paramRawValues[id] = v;
    }

    if (dev && !v.__vizProxied) {
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

  function setRawBank(bank) {
    paramValues = bank;
    paramRawValues = bank;
  }

  function getRawBank() {
    return paramRawValues;
  }

  function getReadLog() {
    return devReadLog || {};
  }

  return {
    sanitizeParamEntry,
    loadParamValues,
    saveParamValues,
    getParams,
    adoptCanonicalBank,
    setRawBank,
    getRawBank,
    getReadLog,
    // Exposed so the runtime can initialize the bank at boot.
    initialize() {
      paramValues = loadParamValues();
      paramRawValues = { ...paramValues };
      return paramValues;
    },
  };
}
