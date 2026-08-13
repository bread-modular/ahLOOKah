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
import { STORAGE } from '../platform/constants.js';

export function createParamRepository({ dev = false } = {}) {
  let paramValues = {};
  let paramRawValues = {};
  let devReadLog = dev ? {} : null;

  function sanitizeParamEntry(id, values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
    const keys = Object.keys(values);
    if (keys.length > 16) return null;
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
      if (def) clamped = Math.min(Math.max(v, def.min - 1e-6), def.max + 1e-6);
      out[k] = clamped;
    }
    const merged = { ...defaults, ...out };
    for (const kk of Object.keys(merged)) if (!Number.isFinite(merged[kk])) merged[kk] = defaults[kk] ?? 0;
    return merged;
  }

  function loadParamValues() {
    let raw = {};
    try {
      const txt = localStorage.getItem(STORAGE.params);
      if (txt && txt.length > 50000) throw new Error('oversize');
      raw = JSON.parse(txt) || {};
    } catch {
      raw = {};
    }
    if (typeof raw !== 'object' || raw === null) raw = {};
    const entries = Object.entries(raw);
    if (entries.length > 80) raw = Object.fromEntries(entries.slice(0, 80));
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
      if (Object.keys(out).length > 80) break;
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
