// Screen-side state for compact pattern-specific audio controls. The store owns
// validation, ordering, interpolation and one-shot consumption; renderers only
// receive a narrow binding through ProgramRuntime's runtimeContext.

import {
  PATTERN_AUDIO_CONTROLS_TYPE,
  PATTERN_AUDIO_EVENT_MAX_AGE_MS,
  PATTERN_AUDIO_NEUTRAL_DECAY_MS,
  PATTERN_AUDIO_STALE_AFTER_MS,
  clamp,
  cloneTransportValue,
  neutralControlsForSchema,
  validateControlsForSlot,
  validatePatternAudioControls,
} from './pattern-audio-protocol.js';

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function lerp(left, right, amount) {
  return left + (right - left) * amount;
}

function cloneContinuous(values = {}) {
  return { ...values };
}

function cloneArrays(values = {}) {
  const output = {};
  for (const [key, value] of Object.entries(values)) output[key] = cloneTransportValue(value);
  return output;
}

function sameDescriptor(left, right) {
  return left
    && right
    && left.patternId === right.patternId
    && left.paramsRevision === right.paramsRevision
    && left.audioTransport === right.audioTransport;
}

function makeSlotState(descriptor, {
  eventDeliveryEnabled = true,
  eventDeliveryEnabledAt = -Infinity,
} = {}) {
  return {
    descriptor: { ...descriptor },
    previous: null,
    current: null,
    events: [],
    seenEventIds: new Set(),
    // A hidden CUE runtime continues receiving continuous controls so it can
    // warm correctly, but it must not bank one-shot effects while parked.
    eventDeliveryEnabled: Boolean(eventDeliveryEnabled),
    eventDeliveryEnabledAt,
    lastReadSequence: null,
    readMarker: 0,
    lastDrawReadMarker: 0,
    renderMarker: 0,
    renderedParamsRevision: null,
    renderedSequence: null,
    forcedStaleAt: null,
  };
}

function copySample(sample) {
  if (!sample) return null;
  return {
    continuous: cloneContinuous(sample.continuous),
    arrays: cloneArrays(sample.arrays),
    receivedAt: sample.receivedAt,
    sequence: sample.sequence,
    captureTime: sample.captureTime,
  };
}

export class PatternAudioControlBinding {
  constructor(store, runtimeId) {
    this.store = store;
    this.runtimeId = runtimeId;
  }

  // Renderers should call read once per draw and use that immutable-ish snapshot
  // for all continuous values and arrays in the frame.
  read() {
    return this.store.read(this.runtimeId);
  }

  consumeEvents() {
    return this.store.consumeEvents(this.runtimeId);
  }

  noteDraw() {
    return this.store.noteDraw(this.runtimeId);
  }

  getState() {
    return this.store.getState(this.runtimeId);
  }

  getRenderMarker() {
    return this.store.getRenderMarker(this.runtimeId);
  }

  setEventDeliveryEnabled(enabled) {
    return this.store.setEventDeliveryEnabled(this.runtimeId, enabled);
  }

  hasRenderedAfter(paramsRevision, marker) {
    return this.store.hasRenderedAfter(this.runtimeId, paramsRevision, marker);
  }
}

export class PatternAudioControlStore {
  constructor({
    consumerSessionId,
    staleAfterMs = PATTERN_AUDIO_STALE_AFTER_MS,
    eventMaxAgeMs = PATTERN_AUDIO_EVENT_MAX_AGE_MS,
    neutralDecayMs = PATTERN_AUDIO_NEUTRAL_DECAY_MS,
    interpolationDelayMs = 33,
    now = defaultNow,
  } = {}) {
    this.consumerSessionId = String(consumerSessionId || 'consumer');
    this.staleAfterMs = Math.max(100, Number(staleAfterMs) || PATTERN_AUDIO_STALE_AFTER_MS);
    this.eventMaxAgeMs = Math.max(1, Math.min(
      this.staleAfterMs,
      Number(eventMaxAgeMs) || PATTERN_AUDIO_EVENT_MAX_AGE_MS,
    ));
    this.neutralDecayMs = Math.max(1, Number(neutralDecayMs) || PATTERN_AUDIO_NEUTRAL_DECAY_MS);
    this.interpolationDelayMs = Math.max(0, Number(interpolationDelayMs) || 0);
    this.now = typeof now === 'function' ? now : defaultNow;

    this.planRevision = -1;
    this.slots = new Map();
    this.audioOwnerId = null;
    this.streamGeneration = null;
    this.lastSequence = -1;
    this.diagnostics = {
      acceptedPackets: 0,
      acceptedSlots: 0,
      droppedMalformed: 0,
      droppedWrongConsumer: 0,
      droppedWrongPlan: 0,
      droppedDuplicate: 0,
      droppedUnknownSlot: 0,
      droppedWrongRevision: 0,
      droppedSchema: 0,
      droppedEvents: 0,
      droppedSuppressedEvents: 0,
      droppedStaleEvents: 0,
      streamResets: 0,
    };
  }

  createBinding(runtimeId) {
    return new PatternAudioControlBinding(this, runtimeId);
  }

  upsertSlot(descriptor) {
    if (!descriptor?.runtimeId) return null;
    const existing = this.slots.get(descriptor.runtimeId);
    if (!existing) {
      const created = makeSlotState(descriptor);
      this.slots.set(descriptor.runtimeId, created);
      return created;
    }
    if (!sameDescriptor(existing.descriptor, descriptor)) {
      // Parameter revisions reset samples, but must not accidentally re-enable
      // events for a CUE runtime that is currently parked.
      const reset = makeSlotState(descriptor, {
        eventDeliveryEnabled: existing.eventDeliveryEnabled,
        eventDeliveryEnabledAt: existing.eventDeliveryEnabledAt,
      });
      this.slots.set(descriptor.runtimeId, reset);
      return reset;
    }
    existing.descriptor = { ...existing.descriptor, ...descriptor };
    return existing;
  }

  retireSlot(runtimeId) {
    this.slots.delete(runtimeId);
  }

  retireSlots(runtimeIds = []) {
    for (const runtimeId of runtimeIds) this.retireSlot(runtimeId);
  }

  // ProgramRuntime toggles this around noLoop()/loop(). Continuous packets still
  // update their current sample while disabled, but one-shot events are discarded
  // until the next real draw after resume. This prevents a hidden CUE's events
  // from bursting into the promoted LIVE frame.
  setEventDeliveryEnabled(runtimeId, enabled) {
    const state = this.slots.get(runtimeId);
    if (!state) return false;
    const next = Boolean(enabled);
    if (state.eventDeliveryEnabled === next) return false;
    state.eventDeliveryEnabled = next;
    state.eventDeliveryEnabledAt = next ? this.now() : Infinity;
    if (state.events.length) {
      this.diagnostics.droppedEvents += state.events.length;
      state.events = [];
    }
    return true;
  }

  setPlan(plan) {
    if (!plan || plan.consumerSessionId !== this.consumerSessionId || !Number.isInteger(plan.planRevision)) return false;
    const revisionChanged = plan.planRevision !== this.planRevision;
    const incoming = new Set((plan.slots || []).map((slot) => slot.runtimeId));

    if (revisionChanged) {
      this.planRevision = plan.planRevision;
      // All controls from the previous plan are authority-stale. Keep descriptor
      // registrations, but reset the samples until a packet for this revision is
      // accepted.
      for (const [runtimeId, state] of this.slots) {
        if (incoming.has(runtimeId)) {
          this.slots.set(runtimeId, makeSlotState(state.descriptor, {
            eventDeliveryEnabled: state.eventDeliveryEnabled,
            eventDeliveryEnabledAt: state.eventDeliveryEnabledAt,
          }));
        }
      }
      this.audioOwnerId = null;
      this.streamGeneration = null;
      this.lastSequence = -1;
    }

    for (const descriptor of plan.slots || []) this.upsertSlot(descriptor);
    for (const runtimeId of [...this.slots.keys()]) {
      if (!incoming.has(runtimeId)) this.slots.delete(runtimeId);
    }
    return true;
  }

  clearForOwnerLoss() {
    const now = this.now();
    for (const state of this.slots.values()) {
      state.events = [];
      state.seenEventIds.clear();
      state.lastReadSequence = null;
      // Make the next renderer read stale immediately: events disappear now and
      // continuous values begin their neutral decay without a one-frame grace.
      state.forcedStaleAt = now - 1;
    }
  }

  resetStream(ownerId, streamGeneration) {
    this.audioOwnerId = ownerId || null;
    this.streamGeneration = streamGeneration || null;
    this.lastSequence = -1;
    for (const [runtimeId, state] of this.slots) {
      this.slots.set(runtimeId, makeSlotState(state.descriptor, {
        eventDeliveryEnabled: state.eventDeliveryEnabled,
        eventDeliveryEnabledAt: state.eventDeliveryEnabledAt,
      }));
    }
    this.diagnostics.streamResets += 1;
  }

  acceptPacket(message) {
    const packet = validatePatternAudioControls(message);
    if (!packet) {
      this.diagnostics.droppedMalformed += 1;
      return { accepted: false, reason: 'malformed' };
    }
    if (packet.type !== PATTERN_AUDIO_CONTROLS_TYPE || packet.consumerSessionId !== this.consumerSessionId) {
      this.diagnostics.droppedWrongConsumer += 1;
      return { accepted: false, reason: 'consumer' };
    }
    if (packet.planRevision !== this.planRevision) {
      this.diagnostics.droppedWrongPlan += 1;
      return { accepted: false, reason: 'plan' };
    }

    const changedStream = packet.audioOwnerId !== this.audioOwnerId || packet.streamGeneration !== this.streamGeneration;
    if (changedStream) this.resetStream(packet.audioOwnerId, packet.streamGeneration);
    if (packet.sequence <= this.lastSequence) {
      this.diagnostics.droppedDuplicate += 1;
      return { accepted: false, reason: 'sequence' };
    }

    const receivedAt = this.now();
    let acceptedSlots = 0;
    for (const rawSlot of packet.slots) {
      const state = this.slots.get(rawSlot.runtimeId);
      if (!state) {
        this.diagnostics.droppedUnknownSlot += 1;
        continue;
      }
      if (rawSlot.paramsRevision !== state.descriptor.paramsRevision) {
        this.diagnostics.droppedWrongRevision += 1;
        continue;
      }
      const slot = validateControlsForSlot(rawSlot, state.descriptor);
      if (!slot) {
        this.diagnostics.droppedSchema += 1;
        continue;
      }

      state.previous = copySample(state.current);
      state.current = {
        continuous: cloneContinuous(slot.continuous),
        arrays: cloneArrays(slot.arrays),
        receivedAt,
        sequence: packet.sequence,
        captureTime: packet.captureTime,
      };
      state.forcedStaleAt = null;
      for (const event of slot.events) {
        const eventKey = `${packet.streamGeneration}:${event.id}`;
        if (state.seenEventIds.has(eventKey)) {
          this.diagnostics.droppedEvents += 1;
          continue;
        }
        state.seenEventIds.add(eventKey);
        // Keep the de-duplication window bounded even on long-running streams.
        while (state.seenEventIds.size > 256) state.seenEventIds.delete(state.seenEventIds.values().next().value);
        if (!state.eventDeliveryEnabled || receivedAt < state.eventDeliveryEnabledAt) {
          this.diagnostics.droppedSuppressedEvents += 1;
          continue;
        }
        // Event lifetime is based on receiver time, not captureTime: source and
        // receiver clocks are unrelated across windows.
        state.events.push({ ...event, sequence: packet.sequence, receivedAt });
      }
      while (state.events.length > 64) {
        state.events.shift();
        this.diagnostics.droppedEvents += 1;
      }
      acceptedSlots += 1;
    }

    this.lastSequence = packet.sequence;
    this.diagnostics.acceptedPackets += 1;
    this.diagnostics.acceptedSlots += acceptedSlots;
    return { accepted: true, slots: acceptedSlots, sequence: packet.sequence };
  }

  _age(state, now) {
    if (!state?.current) return Infinity;
    if (state.forcedStaleAt !== null) return this.staleAfterMs + Math.max(0, now - state.forcedStaleAt);
    return Math.max(0, now - state.current.receivedAt);
  }

  _interpolationAmount(previous, current, now) {
    if (!previous || !current) return 1;
    const duration = Math.max(1, current.receivedAt - previous.receivedAt);
    const targetTime = now - Math.min(this.interpolationDelayMs, duration);
    return clamp((targetTime - previous.receivedAt) / duration, 0, 1);
  }

  _interpolateContinuous(state, now, freshness) {
    const neutral = neutralControlsForSchema(state.descriptor.audioControlSchema).continuous;
    const current = state.current?.continuous || {};
    const previous = state.previous?.continuous || null;
    const amount = this._interpolationAmount(state.previous, state.current, now);
    const keys = new Set([...Object.keys(neutral), ...Object.keys(current), ...Object.keys(previous || {})]);
    const output = {};
    for (const key of keys) {
      const fallback = Number.isFinite(neutral[key]) ? neutral[key] : 0;
      const from = Number.isFinite(previous?.[key]) ? previous[key] : (Number.isFinite(current[key]) ? current[key] : fallback);
      const to = Number.isFinite(current[key]) ? current[key] : fallback;
      let value = lerp(from, to, amount);
      if (!freshness.isFresh) value = lerp(value, fallback, freshness.decay);
      output[key] = value;
    }
    return output;
  }

  _interpolateArrays(state, now, freshness) {
    const neutral = neutralControlsForSchema(state.descriptor.audioControlSchema).arrays;
    const current = state.current?.arrays || {};
    const previous = state.previous?.arrays || null;
    const amount = this._interpolationAmount(state.previous, state.current, now);
    const output = {};
    const keys = new Set([...Object.keys(neutral), ...Object.keys(current), ...Object.keys(previous || {})]);
    for (const key of keys) {
      const to = current[key] || neutral[key];
      const from = previous?.[key] || to;
      if (!to) continue;
      if (!freshness.isFresh || !from || from.length !== to.length) {
        output[key] = cloneTransportValue(to);
        continue;
      }
      const Constructor = to.constructor;
      const values = new Constructor(to.length);
      for (let i = 0; i < to.length; i++) values[i] = lerp(from[i], to[i], amount);
      output[key] = values;
    }
    return output;
  }

  _freshness(state, now) {
    const age = this._age(state, now);
    if (age <= this.staleAfterMs) return { isReady: Boolean(state?.current), isFresh: Boolean(state?.current), age, decay: 0 };
    return {
      isReady: Boolean(state?.current),
      isFresh: false,
      age,
      decay: clamp((age - this.staleAfterMs) / this.neutralDecayMs, 0, 1),
    };
  }

  _discardExpiredEvents(state, now = this.now()) {
    if (!state?.events?.length) return;
    const oldestAllowed = now - this.eventMaxAgeMs;
    const retained = state.events.filter((event) => Number.isFinite(event.receivedAt) && event.receivedAt >= oldestAllowed);
    const dropped = state.events.length - retained.length;
    if (dropped) this.diagnostics.droppedStaleEvents += dropped;
    state.events = retained;
  }

  read(runtimeId, { markRead = true } = {}) {
    const state = this.slots.get(runtimeId);
    if (!state) {
      return {
        continuous: {}, arrays: {}, events: [], isReady: false, isFresh: false,
        packetAge: Infinity, sequence: -1, paramsRevision: null,
      };
    }
    const now = this.now();
    const freshness = this._freshness(state, now);
    if (freshness.isFresh && state.current && markRead) {
      state.lastReadSequence = state.current.sequence;
      state.readMarker += 1;
    }
    if (!freshness.isFresh) {
      if (state.events.length) this.diagnostics.droppedStaleEvents += state.events.length;
      state.events = [];
    } else {
      this._discardExpiredEvents(state, now);
    }
    return {
      continuous: this._interpolateContinuous(state, now, freshness),
      arrays: this._interpolateArrays(state, now, freshness),
      events: [],
      isReady: freshness.isReady,
      isFresh: freshness.isFresh,
      packetAge: freshness.age,
      sequence: state.current?.sequence ?? -1,
      paramsRevision: state.descriptor.paramsRevision,
      planRevision: this.planRevision,
      audioOwnerId: this.audioOwnerId,
      streamGeneration: this.streamGeneration,
    };
  }

  consumeEvents(runtimeId) {
    const state = this.slots.get(runtimeId);
    if (!state) return [];
    const now = this.now();
    const freshness = this._freshness(state, now);
    if (!freshness.isFresh || !state.eventDeliveryEnabled) {
      if (state.events.length) this.diagnostics.droppedStaleEvents += state.events.length;
      state.events = [];
      return [];
    }
    this._discardExpiredEvents(state, now);
    // `receivedAt` is transport bookkeeping rather than a renderer contract.
    return state.events.splice(0).map(({ receivedAt, ...event }) => ({ ...event }));
  }

  noteDraw(runtimeId) {
    const state = this.slots.get(runtimeId);
    if (!state?.current) return false;
    const freshness = this._freshness(state, this.now());
    if (!freshness.isFresh
      || state.lastReadSequence !== state.current.sequence
      || state.readMarker <= state.lastDrawReadMarker) return false;
    state.lastDrawReadMarker = state.readMarker;
    state.renderMarker += 1;
    state.renderedParamsRevision = state.descriptor.paramsRevision;
    state.renderedSequence = state.current.sequence;
    return true;
  }

  getRenderMarker(runtimeId) {
    return this.slots.get(runtimeId)?.renderMarker || 0;
  }

  hasRenderedAfter(runtimeId, paramsRevision, marker) {
    const state = this.slots.get(runtimeId);
    return Boolean(state
      && state.renderMarker > marker
      && state.renderedParamsRevision === paramsRevision
      && state.renderedSequence === state.current?.sequence
      && this._freshness(state, this.now()).isFresh);
  }

  getState(runtimeId) {
    const state = this.slots.get(runtimeId);
    if (!state) return null;
    const snapshot = this.read(runtimeId, { markRead: false });
    return {
      ...snapshot,
      queuedEvents: state.events.length,
      eventDeliveryEnabled: state.eventDeliveryEnabled,
      renderMarker: state.renderMarker,
      renderedParamsRevision: state.renderedParamsRevision,
      renderedSequence: state.renderedSequence,
      descriptor: { ...state.descriptor },
    };
  }

  getDiagnostics() {
    const slots = {};
    for (const [runtimeId, state] of this.slots) {
      const snapshot = this.getState(runtimeId);
      slots[runtimeId] = {
        patternId: state.descriptor.patternId,
        paramsRevision: state.descriptor.paramsRevision,
        sequence: snapshot.sequence,
        age: snapshot.packetAge,
        fresh: snapshot.isFresh,
        events: state.events.length,
        eventDeliveryEnabled: state.eventDeliveryEnabled,
        renderMarker: state.renderMarker,
        renderedParamsRevision: state.renderedParamsRevision,
        renderedSequence: state.renderedSequence,
      };
    }
    return {
      consumerSessionId: this.consumerSessionId,
      planRevision: this.planRevision,
      audioOwnerId: this.audioOwnerId,
      streamGeneration: this.streamGeneration,
      lastSequence: this.lastSequence,
      ...this.diagnostics,
      slots,
    };
  }
}
