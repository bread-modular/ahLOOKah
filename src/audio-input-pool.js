import { AudioManager } from './audio-manager.js';
import { buildChannelFrame, getNoiseFloorMeta } from './noise-floor.js';
import {
  DEFAULT_AUDIO_INPUT,
  audioRouteKey,
  effectiveAudioChannel,
  isDefaultAudioRoute,
} from './audio-routing.js';

// Owner-side input pool (plan section 3). Invariant: ONE capture-owning window,
// ONE shared AudioContext, ONE retained capture per resolved input endpoint, and
// no capture in consumers. The primary (global Settings) input keeps its
// existing manager lifecycle; this pool acquires and releases the extra
// pinned-device sources against an explicit safety budget.
//
// The primary reserves capacity first; extra demands are admitted in the order
// they arrive (already-admitted sources are never evicted by new requests). A
// pin that resolves to the primary's actual device shares the primary capture;
// a pin to the global selector's requested id during a fallback stays missing.

export const AUDIO_INPUT_POOL_MAX_SOURCES = 4; // incl. primary: up to 3 extra devices
export const AUDIO_INPUT_RELEASE_GRACE_MS = 250; // absorbs graph-runtime reconstruction

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function mapAcquisitionError(name) {
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  return 'unavailable';
}

export class AudioInputPool {
  constructor({
    primaryManager = null,
    readPrimary = null,
    createManager = null,
    contextProvider = null,
    maxSources = AUDIO_INPUT_POOL_MAX_SOURCES,
    releaseGraceMs = AUDIO_INPUT_RELEASE_GRACE_MS,
    now = defaultNow,
  } = {}) {
    this.primaryManager = primaryManager;
    this.readPrimary = typeof readPrimary === 'function'
      ? readPrimary
      : () => this.primaryManager?.getAnalysisFrame?.() || null;
    this.createManager = typeof createManager === 'function'
      ? createManager
      : (deviceId) => new AudioManager({
          contextProvider: contextProvider || (() => this.ensureContext()),
          allowFallback: false, // exact pins never substitute another input
          feedNoise: false, // only the primary feeds the calibration accumulator
        });
    this.contextProvider = typeof contextProvider === 'function' ? contextProvider : null;
    this.maxSources = Math.max(1, Number(maxSources) || AUDIO_INPUT_POOL_MAX_SOURCES);
    this.releaseGraceMs = Math.max(0, Number(releaseGraceMs) || 0);
    this.now = typeof now === 'function' ? now : defaultNow;

    this.globalDeviceId = null;
    this.primaryGeneration = 0;
    this.sources = new Map(); // requested device id -> entry
    this.desired = new Map(); // requested device id -> route keys (live demand)
    this.denied = new Map(); // requested device id -> 'resource-limit'
    this.sharedContext = null;
    this.revision = 0;
    this.listeners = new Set();
    this.tickCache = new Map();
    this.tickPrimary = null;
    this.disposed = false;
  }

  // -------------------------------------------------------------------------
  // Shared context ownership: only the pool closes it.
  // -------------------------------------------------------------------------
  ensureContext() {
    const AudioContextClass = (typeof window !== 'undefined')
      ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AudioContextClass) throw new Error('Web Audio is not supported by this browser.');
    if (!this.sharedContext || this.sharedContext.state === 'closed') {
      this.sharedContext = new AudioContextClass({ latencyHint: 'interactive' });
    }
    return this.sharedContext;
  }

  resume(force = false) {
    const work = [];
    if (this.sharedContext && (this.sharedContext.state === 'suspended' || this.sharedContext.state === 'interrupted' || force)) {
      work.push(this.sharedContext.resume().catch(() => {}));
    }
    if (force && this.primaryManager?.resume) work.push(this.primaryManager.resume(true));
    return Promise.all(work);
  }

  // -------------------------------------------------------------------------
  // Global selector + primary identity
  // -------------------------------------------------------------------------
  setGlobalDeviceId(idOrNull) {
    this.globalDeviceId = typeof idOrNull === 'string' && idOrNull ? idOrNull : null;
    this._notify();
  }

  notePrimaryRestart() {
    this.primaryGeneration += 1;
    this._notify();
  }

  primarySourceInfo() {
    const manager = this.primaryManager;
    const status = manager?.lastStatus || {};
    let state = 'unselected';
    if (this.globalDeviceId) {
      if (status.status === 'running') state = 'running';
      else if (status.status === 'starting') state = 'starting';
      else if (status.status === 'suspended') state = 'suspended';
      else if (status.status === 'error') state = mapAcquisitionError(status.error?.name);
      else state = 'unavailable';
    }
    return {
      id: 'primary',
      generation: this.primaryGeneration,
      requestedDeviceId: this.globalDeviceId,
      activeDeviceId: manager?.activeDeviceId ?? null,
      channels: manager?.lastRawFrame?.channels ?? null,
      status: state,
      fallback: Boolean(manager?.usedFallback),
      calibration: this._primaryCalibration(),
    };
  }

  _primaryCalibration() {
    const meta = getNoiseFloorMeta();
    if (!meta) return 'none';
    const active = this.primaryManager?.activeDeviceId ?? null;
    if (meta.deviceId && active && meta.deviceId !== active) return 'uncalibrated-device';
    return 'mixed-profile';
  }

  // -------------------------------------------------------------------------
  // Demand reconciliation (declarative: heartbeats replace, never accumulate)
  // -------------------------------------------------------------------------
  reconcileDemands(demands = []) {
    if (this.disposed) return;
    const wanted = new Map();
    for (const demand of demands) {
      const deviceId = demand?.deviceId;
      if (typeof deviceId !== 'string' || !deviceId) continue;
      const key = audioRouteKey({ deviceId, channel: demand.channel || 'mono' });
      if (!wanted.has(deviceId)) wanted.set(deviceId, new Set());
      wanted.get(deviceId).add(key);
    }

    for (const [deviceId, routes] of wanted) {
      this.desired.set(deviceId, routes);
      const entry = this.sources.get(deviceId);
      if (entry) entry.releaseAt = null;
      else if (!this.denied.has(deviceId)) this._acquire(deviceId);
    }
    for (const [deviceId, entry] of this.sources) {
      if (wanted.has(deviceId)) continue;
      if (entry.releaseAt == null) entry.releaseAt = this.now() + this.releaseGraceMs;
      this.desired.delete(deviceId);
    }
    for (const deviceId of [...this.denied.keys()]) {
      if (!wanted.has(deviceId)) this.denied.delete(deviceId);
    }
    this._releaseExpired();
    this._notify();
  }

  _activeSourceCount() {
    return 1 + this.sources.size; // primary reserves capacity first
  }

  _acquire(deviceId) {
    if (this._activeSourceCount() >= this.maxSources) {
      this.denied.set(deviceId, 'resource-limit');
      this._notify();
      return;
    }
    const entry = {
      deviceId,
      manager: null,
      status: 'starting',
      generation: 1,
      actualDeviceId: null,
      channels: null,
      lastError: null,
      releaseAt: null,
      token: 1,
    };
    this.sources.set(deviceId, entry);
    this._startEntry(entry);
    this._notify();
  }

  _startEntry(entry) {
    const token = ++entry.token;
    entry.status = 'starting';
    entry.lastError = null;
    let manager;
    try {
      manager = this.createManager(entry.deviceId);
    } catch (error) {
      entry.status = 'unavailable';
      entry.lastError = error;
      this._notify();
      return;
    }
    entry.manager = manager;
    manager.setStatusListener?.((status) => {
      if (token !== entry.token) return;
      this._absorbStatus(entry, status);
    });
    Promise.resolve(manager.startStream(entry.deviceId)).then((started) => {
      if (token !== entry.token || this.disposed) {
        if (!this.desired.has(entry.deviceId) || token !== entry.token) {
          try { manager.stop?.(); } catch {}
        }
        return;
      }
      if (started) {
        entry.status = 'running';
        entry.actualDeviceId = manager.activeDeviceId ?? null;
        entry.channels = manager.lastRawFrame?.channels ?? null;
        // A completed acquisition that duplicates the primary's actual device
        // is stopped immediately; the pin shares the primary source instead.
        const primary = this.primarySourceInfo();
        if (primary.status === 'running' && primary.activeDeviceId && entry.actualDeviceId
          && primary.activeDeviceId === entry.actualDeviceId && !primary.fallback) {
          try { manager.stop?.(); } catch {}
          this.sources.delete(entry.deviceId);
        }
      } else {
        entry.status = mapAcquisitionError(manager.lastError?.name);
        entry.lastError = manager.lastError || null;
      }
      this._notify();
    }).catch((error) => {
      if (token !== entry.token) return;
      entry.status = mapAcquisitionError(error?.name);
      entry.lastError = error;
      this._notify();
    });
  }

  _absorbStatus(entry, status) {
    const previous = entry.status;
    if (status?.status === 'running') {
      entry.status = 'running';
      entry.actualDeviceId = status.activeDeviceId ?? entry.manager?.activeDeviceId ?? null;
      entry.channels = entry.manager?.lastRawFrame?.channels ?? null;
      entry.generation += previous === 'running' ? 0 : 0; // health transitions keep generation
    } else if (status?.status === 'suspended') {
      entry.status = 'suspended';
    } else if (status?.status === 'error') {
      entry.generation += 1; // failure/recovery increments the source generation
      entry.status = mapAcquisitionError(status.error?.name);
      entry.lastError = status.error || null;
    }
    if (previous !== entry.status) this._notify();
  }

  _releaseExpired() {
    const now = this.now();
    for (const [deviceId, entry] of this.sources) {
      if (entry.releaseAt == null || entry.releaseAt > now) continue;
      try { entry.manager?.stop?.(); } catch {}
      this.sources.delete(deviceId);
      this._notify();
    }
  }

  // Explicit recovery: re-admit a failed/denied source once. Never duplicates an
  // in-flight acquisition and never makes consumers capture.
  retryInput(deviceId) {
    if (this.disposed || typeof deviceId !== 'string') return;
    this.denied.delete(deviceId);
    const entry = this.sources.get(deviceId);
    if (!entry) {
      if (this.desired.has(deviceId)) this._acquire(deviceId);
      this._notify();
      return;
    }
    if (entry.status === 'starting' || entry.status === 'running') return;
    try { entry.manager?.stop?.(); } catch {}
    this.sources.delete(deviceId);
    if (this.desired.has(deviceId)) this._acquire(deviceId);
    this._notify();
  }

  // Confirmed hotplug/devicechange: failed "missing" pins may reappear.
  noteDeviceChange() {
    for (const [deviceId, entry] of this.sources) {
      if (entry.status === 'missing' || entry.status === 'unavailable') {
        this.retryInput(deviceId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Resolution + per-tick sampling
  // -------------------------------------------------------------------------
  resolveInput(audioInput) {
    const route = audioInput || DEFAULT_AUDIO_INPUT;
    if (isDefaultAudioRoute(route) || !route.deviceId) return this.primarySourceInfo();
    const deviceId = route.deviceId;
    const primary = this.primarySourceInfo();
    // Share the primary when the pin resolves to its actual device, or to the
    // requested global id while it is genuinely running on it (no fallback).
    const sharesPrimary = primary.status === 'running'
      && ((primary.activeDeviceId && primary.activeDeviceId === deviceId)
        || (primary.requestedDeviceId === deviceId && !primary.fallback));
    if (sharesPrimary) {
      return { ...primary, id: 'primary', requestedDeviceId: deviceId };
    }
    const entry = this.sources.get(deviceId);
    if (entry) {
      return {
        id: `extra:${deviceId}`,
        generation: entry.generation,
        requestedDeviceId: deviceId,
        activeDeviceId: entry.actualDeviceId,
        channels: entry.channels,
        status: entry.status,
        fallback: false,
        calibration: this._extraCalibration(entry),
      };
    }
    if (this.denied.has(deviceId)) {
      return { id: null, generation: 0, requestedDeviceId: deviceId, activeDeviceId: null, channels: null, status: 'resource-limit', fallback: false, calibration: 'none' };
    }
    if (this.desired.has(deviceId)) {
      return { id: null, generation: 0, requestedDeviceId: deviceId, activeDeviceId: null, channels: null, status: 'starting', fallback: false, calibration: 'none' };
    }
    return { id: null, generation: 0, requestedDeviceId: deviceId, activeDeviceId: null, channels: null, status: 'missing', fallback: false, calibration: 'none' };
  }

  _extraCalibration(entry) {
    const meta = getNoiseFloorMeta();
    if (!meta) return 'none';
    const active = entry.actualDeviceId ?? null;
    if (meta.deviceId && active && meta.deviceId !== active) return 'uncalibrated-device';
    return 'mixed-profile';
  }

  // Synchronously read each running source at most once per owner tick.
  sample() {
    this.tickCache = new Map();
    const primaryFrame = this.readPrimary();
    const primaryRaw = this.primaryManager?.getRawAnalysisFrame?.() || null;
    this.tickPrimary = { frame: primaryFrame, raw: primaryRaw };
    for (const entry of this.sources.values()) {
      if (entry.status !== 'running' || !entry.manager) continue;
      let frame = null;
      let raw = null;
      try {
        frame = entry.manager.getAnalysisFrame() || null;
        raw = entry.manager.getRawAnalysisFrame?.() || frame;
      } catch {
        frame = null;
        raw = null;
      }
      this.tickCache.set(entry.deviceId, { frame, raw, entry });
    }
    return { primary: this.tickPrimary, extras: this.tickCache };
  }

  // Engine routing seam: (audioInput) => { frame, source }.
  resolveRouteInput(audioInput) {
    const route = audioInput || DEFAULT_AUDIO_INPUT;
    if (isDefaultAudioRoute(route)) {
      const primary = this.primarySourceInfo();
      const frame = this.tickPrimary?.frame || this.readPrimary();
      return { frame, source: primary };
    }
    const info = this.resolveInput(route);
    if (info.status !== 'running') return { frame: null, source: info };
    if (info.id === 'primary') {
      // A pin sharing the primary capture gets a mixed-pipeline copy of the raw
      // frame (the primary's own cleaned frame stays exclusive to global slots).
      const raw = this.tickPrimary?.raw || this.primaryManager?.getRawAnalysisFrame?.();
      const cleaned = this.tickPrimary?.frame || null;
      const { frame, calibration } = buildChannelFrame(raw, 'mono');
      return { frame: cleaned || frame, source: { ...info, calibration } };
    }
    let cached = this.tickCache.get(route.deviceId);
    if (!cached) {
      // Lazily sample once if the tick loop has not reached this source yet.
      const entry = this.sources.get(route.deviceId);
      if (entry?.manager && entry.status === 'running') {
        let frame = null;
        try { frame = entry.manager.getAnalysisFrame() || null; } catch {}
        cached = { frame, raw: entry.manager.getRawAnalysisFrame?.() || frame, entry };
        this.tickCache.set(route.deviceId, cached);
      }
    }
    if (!cached?.frame) return { frame: null, source: info };
    const effective = effectiveAudioChannel(route.channel, cached.raw?.channels ?? info.channels);
    if (effective === 'mono') {
      const { frame, calibration } = buildChannelFrame(cached.raw, 'mono');
      return { frame, source: { ...info, calibration } };
    }
    const { frame, calibration } = buildChannelFrame(cached.raw, effective);
    return { frame, source: { ...info, calibration } };
  }

  // -------------------------------------------------------------------------
  // Snapshot / subscription / teardown
  // -------------------------------------------------------------------------
  getSnapshot() {
    return {
      revision: this.revision,
      maxSources: this.maxSources,
      globalDeviceId: this.globalDeviceId,
      primary: this.primarySourceInfo(),
      sources: [...this.sources.values()].map((entry) => ({
        deviceId: entry.deviceId,
        status: entry.status,
        actualDeviceId: entry.actualDeviceId,
        channels: entry.channels,
        releaseAt: entry.releaseAt,
        generation: entry.generation,
        lastError: entry.lastError ? { name: entry.lastError.name, message: entry.lastError.message } : null,
      })),
      denied: [...this.denied.keys()],
    };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  _notify() {
    if (this.disposed) return;
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      try { listener(snapshot); } catch { /* listener errors never break the pool */ }
    }
  }

  // Owner loss (recoverable): stop every extra source and release the shared
  // context. The pool can be re-used when ownership is taken again.
  reset() {
    this.disposed = false;
    for (const entry of this.sources.values()) {
      try { entry.manager?.stop?.(); } catch {}
    }
    this.sources.clear();
    this.desired.clear();
    this.denied.clear();
    this.tickCache = new Map();
    if (this.sharedContext) {
      const context = this.sharedContext;
      this.sharedContext = null;
      context.close().catch(() => {});
    }
    this._notify();
  }

  // Permanent teardown (page disposal).
  dispose() {
    this.reset();
    this.disposed = true;
  }
}
