// Capture-owner engine for pattern-specific audio controls. It consumes one
// cleaned AudioManager analysis frame per tick, exposes lazy shared conversions,
// updates per-runtime controllers, and emits compact packets for each consumer.

import { makeAudioFeatures } from './sketches/audio-features.js';
import {
  LEGACY_AUDIO_TRANSPORT,
  PATTERN_AUDIO_CONTROLS_TYPE,
  PATTERN_AUDIO_EXPECTED_CONSUMER_MS,
  PATTERN_AUDIO_PLAN_LEASE_MS,
  PATTERN_AUDIO_PLAN_TYPE,
  PATTERN_AUDIO_PROTOCOL_VERSION,
  PATTERN_CONTROLS_TRANSPORT,
  estimateTransportBytes,
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

export class PatternAudioControlEngine {
  constructor({
    ownerId,
    getSketchById,
    now = defaultNow,
    planLeaseMs = PATTERN_AUDIO_PLAN_LEASE_MS,
    expectedConsumerMs = PATTERN_AUDIO_EXPECTED_CONSUMER_MS,
    createRng = null,
  } = {}) {
    this.ownerId = String(ownerId || 'audio-owner');
    this.getSketchById = typeof getSketchById === 'function' ? getSketchById : () => null;
    this.now = typeof now === 'function' ? now : defaultNow;
    this.planLeaseMs = Math.max(250, Number(planLeaseMs) || PATTERN_AUDIO_PLAN_LEASE_MS);
    this.expectedConsumerMs = Math.max(this.planLeaseMs, Number(expectedConsumerMs) || PATTERN_AUDIO_EXPECTED_CONSUMER_MS);
    this.createRng = typeof createRng === 'function' ? createRng : null;
    this.featureAnalyser = makeAudioFeatures();

    this.plans = new Map();
    this.expectedConsumers = new Map();
    this.controllers = new Map();
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
      rawFramesSent: 0,
      rawFramesSkipped: 0,
      rawBytes: 0,
      lastControllerMs: 0,
      controllerMsByPattern: {},
      lastShared: null,
    };
  }

  _nextStreamGeneration() {
    this.streamNumber += 1;
    return `${this.ownerId}-${this.streamNumber}-${Math.round(this.now()).toString(36)}`;
  }

  beginStream() {
    this.streamGeneration = this._nextStreamGeneration();
    this.featureAnalyser = makeAudioFeatures();
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
    const now = this.now();
    const previous = this.plans.get(plan.consumerSessionId);
    if (previous && plan.planRevision < previous.plan.planRevision) {
      this.diagnostics.droppedPlans += 1;
      return { accepted: false, reason: 'revision' };
    }
    // Same topology revision is intentionally valid: parameter revisions update
    // in place without recreating controller state.
    this.plans.set(plan.consumerSessionId, { plan, receivedAt: now, expiresAt: now + this.planLeaseMs });
    this.expectedConsumers.set(plan.consumerSessionId, now + this.expectedConsumerMs);
    this.diagnostics.acceptedPlans += 1;
    this._reconcileControllers();
    return { accepted: true, planRevision: plan.planRevision };
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

  _reconcileControllers() {
    const active = new Map();
    for (const { consumerSessionId, slot } of this._activeSlots()) {
      if (slot.audioTransport !== PATTERN_CONTROLS_TRANSPORT) continue;
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
        this.controllers.set(key, { controller, patternId: desired.slot.patternId });
        this.diagnostics.controllersCreated += 1;
      } catch (error) {
        console.error(`Unable to create audio controller for ${desired.slot.patternId}:`, error);
        this.diagnostics.controllerErrors += 1;
      }
    }
  }

  disposeControllers() {
    for (const state of this.controllers.values()) {
      try { state.controller?.dispose?.(); } catch {}
      this.diagnostics.controllersDisposed += 1;
    }
    this.controllers.clear();
  }

  rawRequired(now = this.now()) {
    this.expirePlans(now);
    // Conservative startup / uncertainty path: do not suppress legacy frames
    // until every known consumer has a fresh, complete topology declaration.
    if (!this.plans.size) return true;
    for (const consumerSessionId of this.expectedConsumers.keys()) {
      if (!this.plans.has(consumerSessionId)) return true;
    }
    for (const entry of this.plans.values()) {
      if (!entry.plan.complete) return true;
      if (entry.plan.slots.some((slot) => slot.audioTransport === LEGACY_AUDIO_TRANSPORT)) return true;
    }
    return false;
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

    for (const [consumerSessionId, entry] of this.plans) {
      const outputSlots = [];
      for (const slot of entry.plan.slots) {
        if (slot.audioTransport !== PATTERN_CONTROLS_TRANSPORT) continue;
        const sketch = this.getSketchById(slot.patternId);
        const descriptor = {
          ...slot,
          audioControlSchema: sketch?.audioControlSchema || {},
        };
        const state = this.controllers.get(controllerKey(consumerSessionId, slot.runtimeId));
        let output = makeNeutralSlot(descriptor);
        if (state?.controller) {
          const started = this.now();
          try {
            const candidate = state.controller.update({
              frame,
              shared,
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
        outputSlots.push(output);
      }

      const packet = {
        type: PATTERN_AUDIO_CONTROLS_TYPE,
        version: PATTERN_AUDIO_PROTOCOL_VERSION,
        consumerSessionId,
        planRevision: entry.plan.planRevision,
        audioOwnerId: this.ownerId,
        streamGeneration: this.streamGeneration,
        sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : 0,
        captureTime: Number.isFinite(captureTime) ? captureTime : now,
        audioActive: Boolean(frame),
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
    return { packets, rawRequired: this.rawRequired(now), shared };
  }

  recordRawFrame(frame, sent) {
    if (sent) {
      this.diagnostics.rawFramesSent += 1;
      this.diagnostics.rawBytes += estimateTransportBytes(frame);
    } else {
      this.diagnostics.rawFramesSkipped += 1;
    }
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
        })),
        age: Math.max(0, this.now() - entry.receivedAt),
      };
    }
    return {
      ownerId: this.ownerId,
      streamGeneration: this.streamGeneration,
      activeControllers: [...this.controllers.entries()].map(([key, state]) => ({ key, patternId: state.patternId })),
      plans,
      expectedConsumers: [...this.expectedConsumers.keys()],
      ...this.diagnostics,
    };
  }
}
