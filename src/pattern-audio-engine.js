import { NODE_AUDIO_SOURCE } from './nodes/audio-source.js';
// Capture-owner engine for pattern-specific audio controls. It consumes one
// cleaned primary analysis frame per tick, resolves each slot's requested audio
// input route through the supplied routing seam, keeps one canonical feature
// extractor per effective route, updates per-runtime controllers, and emits
// compact packets for each consumer (v1 for default-only legacy plans, v2 with
// routing echoes and per-slot source status otherwise).

import { makeAudioFeatures } from './sketches/audio-features.js';
import {
  DEFAULT_AUDIO_INPUT,
  PATTERN_AUDIO_CONTROLS_TYPE,
  PATTERN_AUDIO_EXPECTED_CONSUMER_MS,
  PATTERN_AUDIO_PLAN_LEASE_MS,
  PATTERN_AUDIO_PLAN_MAX_BYTES,
  PATTERN_AUDIO_PLAN_TYPE,
  estimateTransportBytes,
  audioRouteKey,
  isDefaultAudioRoute,
  neutralControlsForSchema,
  validateControlsForSlot,
  validatePatternAudioPlan,
} from './pattern-audio-protocol.js';

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const dbToByte = (db) => Math.round(clamp(((Number.isFinite(db) ? db : -100) + 100) / 70, 0, 1) * 255);
const waveToByte = (sample) => Math.round(clamp((Number.isFinite(sample) ? sample : 0) * 128 + 128, 0, 255));

function byteChannel(source, converter) {
  if (!source?.length) return new Uint8Array(0);
  // AudioManager frames are float dB / float waveform data. Keeping the source
  // check supports deterministic unit frames that already use byte arrays.
  if (source instanceof Uint8Array) return new Uint8Array(source);
  const output = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) output[i] = converter(source[i]);
  return output;
}

function silentFeatures() {
  return {
    sub: 0, mid: 0, high: 0, energy: 0,
    kick: 0, snare: 0, hat: 0, beat: 0, impact: 0, inputLevel: 0,
  };
}

export class SharedAudioAnalysisView {
  constructor(frame, deltaSeconds = 1 / 30, featureProvider = null) {
    this.frame = frame || null;
    this.deltaSeconds = deltaSeconds;
    if (typeof featureProvider === 'function') {
      this.featureProvider = featureProvider;
    } else {
      const analyser = makeAudioFeatures();
      this.featureProvider = (analysisFrame, seconds) => analyser(analysisFrame, {}, seconds);
    }
    this._frequencies = null;
    this._waveforms = null;
    this._features = null;
    this.diagnostics = { byteFrequencyBuilds: 0, byteWaveformBuilds: 0, featureBuilds: 0 };
  }

  getByteFrequencies() {
    if (!this._frequencies) {
      this._frequencies = {
        left: byteChannel(this.frame?.left, dbToByte),
        right: byteChannel(this.frame?.right || this.frame?.left, dbToByte),
      };
      this.diagnostics.byteFrequencyBuilds += 1;
    }
    return this._frequencies;
  }

  getByteWaveforms() {
    if (!this._waveforms) {
      this._waveforms = {
        left: byteChannel(this.frame?.waveformLeft, waveToByte),
        right: byteChannel(this.frame?.waveformRight || this.frame?.waveformLeft, waveToByte),
      };
      this.diagnostics.byteWaveformBuilds += 1;
    }
    return this._waveforms;
  }

  getFeatures() {
    // Canonical feature extraction intentionally has no pattern parameters.
    // Controllers map their own accepted params afterward, so a complete frame
    // scan/transient update executes no more than once per capture tick.
    if (!this._features) {
      this._features = this.featureProvider?.(this.frame, this.deltaSeconds) || silentFeatures();
      this.diagnostics.featureBuilds += 1;
    }
    return { ...this._features };
  }
}

function controllerKey(consumerSessionId, runtimeId) {
  return `${consumerSessionId}\u0000${runtimeId}`;
}

function makeNeutralSlot(descriptor) {
  const neutral = neutralControlsForSchema(descriptor.audioControlSchema || {});
  return {
    runtimeId: descriptor.runtimeId,
    paramsRevision: descriptor.paramsRevision,
    continuous: neutral.continuous,
    arrays: neutral.arrays,
    events: [],
  };
}

// Neutral source metadata before/while a route has no usable frame. It keeps
// the v2 slot schema complete without claiming hardware health.
function unknownSource() {
  return { id: null, generation: 0, activeDeviceId: null, channels: null, status: 'unavailable', fallback: false, calibration: 'none' };
}

// The wire carries exactly the seven bounded source fields; richer pool
// diagnostics (e.g. requestedDeviceId) stay owner-internal.
function wireSource(source) {
  if (!source) return unknownSource();
  return {
    id: source.id ?? null,
    generation: Number.isInteger(source.generation) && source.generation >= 0 ? source.generation : 0,
    activeDeviceId: typeof source.activeDeviceId === 'string' ? source.activeDeviceId : null,
    channels: Number.isInteger(source.channels) && source.channels >= 1 ? source.channels : null,
    status: source.status ?? 'unavailable',
    fallback: Boolean(source.fallback),
    calibration: source.calibration ?? 'none',
  };
}

export class PatternAudioControlEngine {
  constructor({
    ownerId,
    getSketchById,
    now = defaultNow,
    planLeaseMs = PATTERN_AUDIO_PLAN_LEASE_MS,
    expectedConsumerMs = PATTERN_AUDIO_EXPECTED_CONSUMER_MS,
    createRng = null,
    resolveRouteInput = null,
  } = {}) {
    this.ownerId = String(ownerId || 'audio-owner');
    this.getSketchById = id => id === NODE_AUDIO_SOURCE.id ? NODE_AUDIO_SOURCE : (typeof getSketchById === 'function' ? getSketchById(id) : null);
    this.now = typeof now === 'function' ? now : defaultNow;
    this.planLeaseMs = Math.max(250, Number(planLeaseMs) || PATTERN_AUDIO_PLAN_LEASE_MS);
    this.expectedConsumerMs = Math.max(this.planLeaseMs, Number(expectedConsumerMs) || PATTERN_AUDIO_EXPECTED_CONSUMER_MS);
    this.createRng = typeof createRng === 'function' ? createRng : null;
    // Owner-injected routing seam: (audioInput) => ({ frame, source }). The
    // default route keeps the primary frame passed to update(); other routes
    // resolve through the pool. Without a seam every routed slot is neutral.
    this.resolveRouteInput = typeof resolveRouteInput === 'function' ? resolveRouteInput : null;
    this.featureAnalyser = makeAudioFeatures();

    this.plans = new Map();
    this.expectedConsumers = new Map();
    this.controllers = new Map();
    // One persistent canonical extractor per requested route; rebuilt when the
    // resolved source tuple (id/generation/layout) changes.
    this.routeStates = new Map();
    this.streamNumber = 0;
    this.streamGeneration = this._nextStreamGeneration();
    this.lastTickAt = 0;
    this.diagnostics = {
      acceptedPlans: 0,
      droppedPlans: 0,
      expiredPlans: 0,
      controllersCreated: 0,
      controllersDisposed: 0,
      controllerErrors: 0,
      controlPackets: 0,
      controlBytes: 0,
      lastControllerMs: 0,
      controllerMsByPattern: {},
      lastShared: null,
      routedSlots: 0,
    };
  }

  _nextStreamGeneration() {
    this.streamNumber += 1;
    return `${this.ownerId}-${this.streamNumber}-${Math.round(this.now()).toString(36)}`;
  }

  beginStream() {
    this.streamGeneration = this._nextStreamGeneration();
    this.featureAnalyser = makeAudioFeatures();
    this.routeStates.clear();
    this.disposeControllers();
    return this.streamGeneration;
  }

  expectConsumer(consumerSessionId) {
    if (typeof consumerSessionId !== 'string' || !consumerSessionId) return;
    this.expectedConsumers.set(consumerSessionId, this.now() + this.expectedConsumerMs);
  }

  forgetConsumer(consumerSessionId) {
    this.expectedConsumers.delete(consumerSessionId);
    this.plans.delete(consumerSessionId);
    this._reconcileControllers();
  }

  receivePlan(message) {
    const plan = validatePatternAudioPlan(message, { getSketchById: this.getSketchById });
    if (!plan || plan.type !== PATTERN_AUDIO_PLAN_TYPE) {
      this.diagnostics.droppedPlans += 1;
      return { accepted: false, reason: 'malformed' };
    }
    // Aggregate transport ceiling on an already shape-validated plan, before
    // any controller/schema work.
    if (estimateTransportBytes(plan) > PATTERN_AUDIO_PLAN_MAX_BYTES) {
      this.diagnostics.droppedPlans += 1;
      return { accepted: false, reason: 'capacity' };
    }
    const now = this.now();
    const previous = this.plans.get(plan.consumerSessionId);
    if (previous && plan.planRevision < previous.plan.planRevision) {
      this.diagnostics.droppedPlans += 1;
      return { accepted: false, reason: 'revision' };
    }
    // Same topology revision is intentionally valid: parameter revisions update
    // in place without recreating controller state. But at an unchanged slot
    // revision neither the selector nor the accepted params may change, and a
    // slot's parameter revision can never regress.
    if (previous && plan.planRevision === previous.plan.planRevision) {
      const previousSlots = new Map(previous.plan.slots.map(slot => [slot.runtimeId, slot]));
      for (const slot of plan.slots) {
        const before = previousSlots.get(slot.runtimeId);
        if (!before) continue;
        if (slot.paramsRevision < before.paramsRevision
          || (slot.paramsRevision === before.paramsRevision
            && (JSON.stringify(slot.params) !== JSON.stringify(before.params)
              || JSON.stringify(slot.audioInput || null) !== JSON.stringify(before.audioInput || null)))) {
          this.diagnostics.droppedPlans += 1;
          return { accepted: false, reason: 'revision' };
        }
      }
    }
    this.plans.set(plan.consumerSessionId, { plan, receivedAt: now, expiresAt: now + this.planLeaseMs });
    this.expectedConsumers.set(plan.consumerSessionId, now + this.expectedConsumerMs);
    this.diagnostics.acceptedPlans += 1;
    this._reconcileControllers();
    return { accepted: true, planRevision: plan.planRevision, version: plan.version };
  }

  expirePlans(now = this.now()) {
    let changed = false;
    for (const [consumerSessionId, entry] of this.plans) {
      if (entry.expiresAt > now) continue;
      this.plans.delete(consumerSessionId);
      this.diagnostics.expiredPlans += 1;
      changed = true;
    }
    for (const [consumerSessionId, expiresAt] of this.expectedConsumers) {
      if (expiresAt <= now) this.expectedConsumers.delete(consumerSessionId);
    }
    if (changed) this._reconcileControllers();
  }

  _activeSlots() {
    const slots = [];
    for (const [consumerSessionId, entry] of this.plans) {
      for (const slot of entry.plan.slots) slots.push({ consumerSessionId, slot, plan: entry.plan });
    }
    return slots;
  }

  // Distinct nondefault capture demands (one per requested device) implied by
  // the currently leased plans. Channels never need a second capture.
  getRouteDemands() {
    const demands = new Map();
    for (const { slot } of this._activeSlots()) {
      const route = slot.audioInput;
      if (!route || isDefaultAudioRoute(route) || !route.deviceId) continue;
      if (!demands.has(route.deviceId)) demands.set(route.deviceId, { ...route });
    }
    return [...demands.values()];
  }

  _reconcileControllers() {
    const active = new Map();
    for (const { consumerSessionId, slot } of this._activeSlots()) {
      active.set(controllerKey(consumerSessionId, slot.runtimeId), { consumerSessionId, slot });
    }

    for (const [key, state] of this.controllers) {
      const desired = active.get(key);
      if (desired && desired.slot.patternId === state.patternId) continue;
      try { state.controller?.dispose?.(); } catch {}
      this.controllers.delete(key);
      this.diagnostics.controllersDisposed += 1;
    }

    for (const [key, desired] of active) {
      if (this.controllers.has(key)) continue;
      const sketch = this.getSketchById(desired.slot.patternId);
      if (!sketch?.createAudioController) continue;
      try {
        const rng = this.createRng ? this.createRng({ ...desired.slot }) : undefined;
        const controller = sketch.createAudioController({ rng });
        if (!controller || typeof controller.update !== 'function') throw new Error('Pattern audio controller has no update() method.');
        this.controllers.set(key, { controller, patternId: desired.slot.patternId, routeSignature: '' });
        this.diagnostics.controllersCreated += 1;
      } catch (error) {
        console.error(`Unable to create audio controller for ${desired.slot.patternId}:`, error);
        this.diagnostics.controllerErrors += 1;
      }
    }
  }

  _resetController(key) {
    const state = this.controllers.get(key);
    if (!state) return null;
    try { state.controller?.dispose?.(); } catch {}
    const sketch = this.getSketchById(state.patternId);
    let controller = null;
    try {
      controller = sketch?.createAudioController ? sketch.createAudioController({}) : null;
    } catch (error) {
      this.diagnostics.controllerErrors += 1;
    }
    if (!controller) {
      this.controllers.delete(key);
      this.diagnostics.controllersDisposed += 1;
      return null;
    }
    state.controller = controller;
    state.routeSignature = '';
    this.diagnostics.controllersCreated += 1;
    return state;
  }

  disposeControllers() {
    for (const state of this.controllers.values()) {
      try { state.controller?.dispose?.(); } catch {}
      this.diagnostics.controllersDisposed += 1;
    }
    this.controllers.clear();
  }

  // One canonical analysis view per effective (source, generation, channel)
  // route. A source/layout change rebuilds the extractor so no resumed spectrum
  // is ever compared against arbitrarily old flux/AGC state.
  _viewFor(route, frame, source, deltaSeconds) {
    const key = audioRouteKey(route);
    let state = this.routeStates.get(key);
    if (!state) {
      state = { analyser: null, signature: '', builds: 0 };
      this.routeStates.set(key, state);
    }
    const signature = `${source.id ?? ''}:${source.generation}:${source.channels ?? ''}`;
    if (state.signature !== signature) {
      state.analyser = makeAudioFeatures();
      state.signature = signature;
    }
    state.builds += 1;
    const analyser = state.analyser;
    return new SharedAudioAnalysisView(frame, deltaSeconds, (analysisFrame, seconds) => analyser(analysisFrame, {}, seconds));
  }

  update({ frame, deltaSeconds, captureTime, sequence, now = this.now() } = {}) {
    this.expirePlans(now);
    this._reconcileControllers();
    const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 30, 1 / 240, 0.1);
    const shared = new SharedAudioAnalysisView(
      frame,
      dt,
      (analysisFrame, seconds) => this.featureAnalyser(analysisFrame, {}, seconds),
    );
    const packets = [];
    const tickStarted = this.now();
    const perPattern = {};
    let routedSlots = 0;

    for (const [consumerSessionId, entry] of this.plans) {
      const planVersion = entry.plan.version >= 2 ? 2 : 1;
      const outputSlots = [];
      let anyUsable = false;
      for (const slot of entry.plan.slots) {
        const sketch = this.getSketchById(slot.patternId);
        const descriptor = {
          ...slot,
          audioControlSchema: sketch?.audioControlSchema || {},
        };
        const state = this.controllers.get(controllerKey(consumerSessionId, slot.runtimeId));
        let output = makeNeutralSlot(descriptor);
        // Route selection happens BEFORE extraction: default/default-mono slots
        // share the primary full-stereo view; every other requested route gets
        // its own projected frame and canonical extractor.
        const route = slot.audioInput || DEFAULT_AUDIO_INPUT;
        let routeFrame = frame;
        let routeView = shared;
        let source;
        if (isDefaultAudioRoute(route)) {
          source = this.resolveRouteInput?.(route)?.source
            || { id: 'primary', generation: 0, activeDeviceId: frame?.deviceId ?? null,
              channels: Number.isFinite(frame?.channels) ? frame.channels : null,
              status: frame ? 'running' : 'unavailable', fallback: false, calibration: 'none' };
        } else {
          routedSlots += 1;
          const resolution = this.resolveRouteInput ? this.resolveRouteInput(route) : null;
          routeFrame = resolution?.frame || null;
          source = resolution?.source || unknownSource();
          routeView = routeFrame ? this._viewFor(route, routeFrame, source, dt) : null;
        }
        // A changed resolved source/generation restarts the controller from a
        // fresh history even when patternId and runtimeId did not change.
        const signature = `${audioRouteKey(route)}:${source.id ?? ''}:${source.generation}`;
        let controllerState = state;
        if (controllerState && controllerState.routeSignature && controllerState.routeSignature !== signature) {
          controllerState = this._resetController(controllerKey(consumerSessionId, slot.runtimeId));
        }
        if (controllerState) controllerState.routeSignature = signature;
        if (controllerState?.controller) {
          const started = this.now();
          try {
            const candidate = controllerState.controller.update({
              frame: routeFrame,
              shared: routeView,
              params: { ...slot.params },
              deltaSeconds: dt,
              captureTime,
              sequence,
            });
            const validated = validateControlsForSlot({
              runtimeId: slot.runtimeId,
              paramsRevision: slot.paramsRevision,
              continuous: candidate?.continuous || {},
              arrays: candidate?.arrays || {},
              events: candidate?.events || [],
            }, descriptor);
            if (validated) output = validated;
            else this.diagnostics.controllerErrors += 1;
          } catch (error) {
            this.diagnostics.controllerErrors += 1;
            console.error(`Pattern audio controller failed for ${slot.patternId}:`, error);
          }
          const elapsed = Math.max(0, this.now() - started);
          perPattern[slot.patternId] = (perPattern[slot.patternId] || 0) + elapsed;
        }
        if (routeFrame) anyUsable = true;
        // v2 slots echo their requested selector and carry bounded source
        // availability metadata; v1 packets stay byte-compatible with the old
        // consumer build.
        if (planVersion >= 2) {
          output.audioInput = { ...route };
          output.source = wireSource(source);
        }
        outputSlots.push(output);
      }

      const packet = {
        type: PATTERN_AUDIO_CONTROLS_TYPE,
        version: planVersion,
        consumerSessionId,
        planRevision: entry.plan.planRevision,
        audioOwnerId: this.ownerId,
        streamGeneration: this.streamGeneration,
        sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : 0,
        captureTime: Number.isFinite(captureTime) ? captureTime : now,
        // v1 semantics: the primary frame existed. v2: at least one slot in this
        // packet has usable input — a healthy pinned input keeps the packet
        // active even while the global input is unselected, and a slot's own
        // source status stays authoritative.
        audioActive: planVersion >= 2 ? anyUsable : Boolean(frame),
        slots: outputSlots,
      };
      packets.push(packet);
      this.diagnostics.controlPackets += 1;
      this.diagnostics.controlBytes += estimateTransportBytes(packet);
    }

    this.lastTickAt = now;
    this.diagnostics.lastControllerMs = Math.max(0, this.now() - tickStarted);
    this.diagnostics.controllerMsByPattern = perPattern;
    this.diagnostics.lastShared = { ...shared.diagnostics };
    this.diagnostics.routedSlots = routedSlots;
    return { packets, shared };
  }

  getDiagnostics() {
    const plans = {};
    for (const [consumerSessionId, entry] of this.plans) {
      plans[consumerSessionId] = {
        planRevision: entry.plan.planRevision,
        slots: entry.plan.slots.map((slot) => ({
          runtimeId: slot.runtimeId,
          patternId: slot.patternId,
          paramsRevision: slot.paramsRevision,
          audioTransport: slot.audioTransport,
          audioInput: slot.audioInput ? { ...slot.audioInput } : null,
        })),
        age: Math.max(0, this.now() - entry.receivedAt),
      };
    }
    return {
      ownerId: this.ownerId,
      streamGeneration: this.streamGeneration,
      activeControllers: [...this.controllers.entries()].map(([key, state]) => ({ key, patternId: state.patternId })),
      routeStates: [...this.routeStates.entries()].map(([key, state]) => ({ route: key, builds: state.builds })),
      plans,
      expectedConsumers: [...this.expectedConsumers.keys()],
      routeDemands: this.getRouteDemands(),
      ...this.diagnostics,
    };
  }
}
