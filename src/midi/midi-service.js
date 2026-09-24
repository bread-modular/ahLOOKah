// One Web MIDI session per browser window, shared by every consumer that needs it:
// the node editor (in the control window or at `?role=nodes`), the in-place editor
// inside the main view, and the LIVE output screen. Web MIDI access is granted per
// origin and profile, so a graph that reads a controller behaves identically in the
// editor preview and on the screen — and the screen never depends on the editor
// being open, because `GraphRuntime` itself asks this module for a node's value.
//
// The module owns no clock of its own: messages only update session state, and a
// node reads that state once per rendered frame (exactly how an Audio node reads its
// routed band). Nothing here notifies per message, so the graph keeps one clock and
// no listener is ever attached or disposed per edit.
//
// State is kept per input device as well as per channel, so two MIDI nodes can
// listen to two different controllers (or to "any device") at the same time. Every
// message also lands in the shared "any" bucket.
// Timestamps are seconds from the same monotonic clock the environment uses, so the
// envelope times below are the same units the Attack/Decay controls store (the LFO
// treats Cycle time as seconds for the same reason).
export const PULSE_FLOOR_S = .08;
export const LEARN_TIMEOUT_MS = 60_000;
export const ANY_DEVICE = 'any';
export const MIN_CHANNEL = 1, MAX_CHANNEL = 16, MAX_CC = 127;
const NOTE_OFF = 0x80, NOTE_ON = 0x90, CONTROL_CHANGE = 0xb0;

export const clamp01 = value => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
export const normalizeChannel = value => Number.isInteger(value) && value >= MIN_CHANNEL && value <= MAX_CHANNEL ? value : MIN_CHANNEL;
// The bucket a node reads: its pinned input, or the merged "any device" one.
export const deviceKeyOf = value => typeof value === 'string' && value ? value : ANY_DEVICE;
// A swept selector (a CC number) sits between two discrete values, so reading blends
// them by the fractional part. An unmapped parameter is a whole number and reads
// exactly its own choice.
export const blendChoices = (value, low, high, read) => {
  const at = Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
  const floor = Math.floor(at);
  const a = read(floor);
  const ceil = Math.min(high, floor + 1);
  if (ceil === floor || at <= floor) return a;
  return a + (read(ceil) - a) * (at - floor);
};

// One channel's musical state. `notes` is what actually holds the gate: held notes
// are tracked per input as well as per channel, so one controller releasing a key
// can never cut a note another controller is still holding, and a controller that is
// unplugged releases only its own notes. `onAt` is when the gate opened (what
// Sustain's attack runs from) and `trigAt` the last note-on (what Pulse fires from,
// so every note gets its own envelope). A single-stream caller may omit the input
// key (the pure reducer below defaults to one shared stream).
export const newChannelState = () => ({ gateOn: false, onAt: NaN, offAt: NaN, trigAt: NaN, velocity: 0, cc: new Map(), notes: new Map() });

const heldNotes = (state, key) => {
  if (!state.notes.has(key)) state.notes.set(key, new Set());
  return state.notes.get(key);
};
// Only the *last* held note across every input closes the merged gate.
const releaseNote = (state, key, note, at) => {
  const held = state.notes.get(key);
  if (held) { held.delete(note); if (!held.size) state.notes.delete(key); }
  if (!state.notes.size && state.gateOn) { state.gateOn = false; state.offAt = at; }
};

// Pure reducer for one MIDI message (one input stream unless `key` names the input).
// Note-on with velocity 0 is a note-off, the form most controllers send. Anything
// else (aftertouch, pitch bend, program change) is intentionally ignored rather than
// guessed at.
export function applyMidiMessage(state, data, at = 0, key = null) {
  if (!state || !data || data.length < 2) return state;
  const status = data[0] & 0xf0;
  if (status === NOTE_ON) {
    const note = data[1] & 0x7f;
    const velocity = data.length > 2 ? data[2] & 0x7f : 0;
    if (velocity > 0) {
      heldNotes(state, key).add(note);
      // Every note-on is a trigger (what Pulse fires from), but only the note that
      // opens the gate sets its timing, so a second held note joins the envelope
      // instead of restarting it.
      if (!state.gateOn) { state.gateOn = true; state.onAt = at; }
      state.trigAt = at;
      state.velocity = clamp01(velocity / 127);
    } else releaseNote(state, key, note, at);
  } else if (status === NOTE_OFF) {
    releaseNote(state, key, data[1] & 0x7f, at);
  } else if (status === CONTROL_CHANGE && data.length > 2) {
    state.cc.set(data[1] & 0x7f, clamp01((data[2] & 0x7f) / 127));
  }
  return state;
}

// Gate envelope, always 0…1.
//   pulse   — one envelope per note: every note-on re-fires the attack ramp and then
//             the decay ramp, so a note played while another is still held still gets
//             its own pulse, and how long any key is held is ignored. A floor keeps a
//             1 ms/1 ms pulse (the defaults) visible instead of collapsing it to a
//             single frame.
//   sustain — the attack ramp while the gate is open (the note that opened it owns
//             that timing, so a second note joins without restarting the ramp), then
//             the decay ramp after the last note-off, starting from the level the
//             gate actually reached.
export function gateLevel(params, state, at) {
  if (!state || !Number.isFinite(state.onAt)) return 0;
  const attack = Math.max(0, Number.isFinite(params?.attack) ? params.attack : 0);
  const decay = Math.max(0, Number.isFinite(params?.decay) ? params.decay : 0);
  const pulse = params?.gateMode === 'pulse';
  const start = pulse && Number.isFinite(state.trigAt) ? state.trigAt : state.onAt;
  const up = time => attack > 0 ? clamp01((time - start) / attack) : 1;
  if (pulse) {
    const peakAt = start + attack;
    if (at < peakAt) return up(at);
    const fall = Math.max(decay, PULSE_FLOOR_S);
    return clamp01(up(peakAt) * (1 - (at - peakAt) / fall));
  }
  if (state.gateOn) return up(at);
  const offAt = Number.isFinite(state.offAt) ? state.offAt : state.onAt;
  if (decay <= 0 || at <= offAt) return 0;
  return clamp01(up(offAt) * (1 - (at - offAt) / decay));
}

// The value of one control change, normalized 0…1. A swept CC number (a mapped
// signal moving the CC it reads) blends its two neighbours, so the output glides.
export const ccLevel = (state, cc) => clamp01(blendChoices(cc, 0, MAX_CC, index => state?.cc?.get(index) ?? 0));

// Apply Velocity blends the envelope toward the note's own velocity as the slider
// rises: 0 ignores velocity entirely, 1 multiplies by it fully.
export function midiLevel(params, state, at) {
  if (params?.mode === 'cc') return ccLevel(state, params.cc);
  const level = gateLevel(params, state, at);
  const amount = clamp01(params?.velocity);
  if (amount <= 0) return level;
  return clamp01(level * ((1 - amount) + amount * clamp01(state?.velocity)));
}

export function createMidiService({ requestAccess = null, now = null } = {}) {
  // deviceKey → (channel → state). Every message updates its own input's bucket and
  // the shared ANY_DEVICE one, so a node pinned to a device and a node listening to
  // everything each read what they asked for.
  const devices = new Map();
  const statusListeners = new Set();
  const learners = new Set();
  let access = null, attached = new Set(), state = 'idle', error = '', disposed = false, pending = null, onStateChange = null;

  const clock = now || (() => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() / 1000 : Date.now() / 1000));
  const hasAccess = () => typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  const callAccess = () => navigator.requestMIDIAccess({ sysex: false });
  const supported = () => typeof requestAccess === 'function' || hasAccess();
  const channelFor = (deviceKey, channel) => {
    if (!devices.has(deviceKey)) devices.set(deviceKey, new Map());
    const channels = devices.get(deviceKey);
    const key = normalizeChannel(channel);
    if (!channels.has(key)) channels.set(key, newChannelState());
    return channels.get(key);
  };
  const inputs = () => access ? [...(access.inputs?.values?.() || [])].map(port => ({ id: port.id, name: port.name || 'MIDI input', manufacturer: port.manufacturer || '' })) : [];
  const describe = () => ({ supported: supported(), state, error, inputs: inputs(), attached: attached.size });
  const notify = () => {
    const snapshot = describe();
    for (const listener of [...statusListeners]) { try { listener(snapshot); } catch { /* a subscriber never breaks the session */ } }
  };
  const settleLearners = message => { for (const learner of [...learners]) finishLearn(learner, message); };
  const finishLearn = (learner, message) => {
    clearTimeout(learner.timer);
    learners.delete(learner);
    learner.resolve(message);
  };
  const attach = port => {
    if (!port || attached.has(port)) return;
    attached.add(port);
    port.onmidimessage = event => receive(event?.data, port);
  };
  // A controller that is unplugged while a note is held must not leave the gate stuck
  // on: the notes that input was holding are released the moment that device
  // disappears, so the node runs its own decay ramp instead of holding 1 forever.
  // Only that input's notes go — another controller still connected keeps holding its
  // own, and the gate stays open while any note is still held. CC values keep their
  // last position, exactly like a fader whose controller went away.
  const releasePortNotes = gone => {
    const at = clock();
    for (const channels of devices.values()) {
      for (const channel of channels.values()) {
        if (gone) for (const port of gone) channel.notes.delete(port);
        else channel.notes.clear();
        if (!channel.notes.size && channel.gateOn) { channel.gateOn = false; channel.offAt = at; }
      }
    }
  };
  const syncPorts = () => {
    const present = new Set(access?.inputs?.values?.() || []);
    const removed = new Set();
    for (const port of [...attached]) {
      if (present.has(port)) continue;
      port.onmidimessage = null;
      attached.delete(port);
      removed.add(port);
    }
    for (const port of present) attach(port);
    if (removed.size) releasePortNotes(removed);
    return removed.size > 0;
  };
  const receive = (data, port) => {
    if (disposed || !data || data.length < 2) return;
    const channel = (data[0] & 0x0f) + 1;
    const at = clock();
    // The input port is the note key, so each controller's held notes stay its own —
    // in the device's own bucket and in the merged one.
    applyMidiMessage(channelFor(deviceKeyOf(port?.id), channel), data, at, port);
    if (port?.id !== ANY_DEVICE) applyMidiMessage(channelFor(ANY_DEVICE, channel), data, at, port);
    if ((data[0] & 0xf0) === CONTROL_CHANGE && data.length > 2) settleLearners({ channel, cc: data[1] & 0x7f });
  };
  const bind = next => {
    access = next;
    attached = new Set();
    onStateChange = () => { if (!disposed) { syncPorts(); notify(); } };
    next?.addEventListener?.('statechange', onStateChange);
    syncPorts();
  };
  // A failed request is a reported state, never a throw: the node simply outputs 0
  // until the operator retries.
  const failRequest = cause => {
    const denial = cause?.name === 'SecurityError' || cause?.name === 'NotAllowedError' || cause?.name === 'InvalidStateError';
    state = denial ? 'denied' : 'error';
    error = cause?.message || 'MIDI access failed.';
    notify();
    return describe();
  };
  // Explicit request: the "Enable MIDI" button, and the automatic first attempt when
  // a graph actually contains a MIDI node. Both share one in-flight promise, so no
  // prompt is ever doubled. The browser call is made synchronously, inside the
  // operator's own click when there is one (some browsers only grant access with
  // user activation).
  const request = () => {
    if (disposed) return Promise.resolve(describe());
    if (state === 'requesting' || state === 'ready') return pending || Promise.resolve(describe());
    if (!supported()) { state = 'unsupported'; error = ''; notify(); return Promise.resolve(describe()); }
    state = 'requesting'; error = ''; notify();
    let granted;
    try { granted = requestAccess ? requestAccess() : (hasAccess() ? callAccess() : null); }
    catch (cause) { return Promise.resolve(failRequest(cause)); }
    pending = Promise.resolve(granted)
      .then(next => {
        if (disposed) return describe();
        // A browser without the API (or a stub without an access object) is a
        // capability gap, not a working session with zero devices.
        if (!next) { state = 'unsupported'; error = ''; notify(); return describe(); }
        bind(next); state = 'ready'; notify(); return describe();
      })
      .catch(failRequest)
      .finally(() => { pending = null; });
    return pending;
  };

  return {
    status: describe,
    // A graph that contains a MIDI node is what makes this window need MIDI: ask
    // once, silently when the origin already allows it, and leave the button for a
    // denial or a retry.
    ensure: () => state === 'idle' ? request() : Promise.resolve(describe()),
    request,
    subscribe(listener) {
      if (disposed) return () => {};
      statusListeners.add(listener);
      listener(describe());
      return () => statusListeners.delete(listener);
    },
    // The node's own value, normalized 0…1. `params.deviceId` picks the bucket, so a
    // pinned node ignores every other controller.
    level(params) {
      if (disposed) return 0;
      return midiLevel(params, devices.get(deviceKeyOf(params?.deviceId))?.get(normalizeChannel(params?.channel)), clock());
    },
    // Learn reads raw CC traffic from every device (the operator plays the control
    // they want), and resolves null when it is cancelled.
    learnCc({ timeoutMs = LEARN_TIMEOUT_MS } = {}) {
      return new Promise((resolve, reject) => {
        if (disposed) { reject(new Error('MIDI session is closed.')); return; }
        const learner = { resolve, timer: 0 };
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          learner.timer = setTimeout(() => {
            learners.delete(learner);
            reject(new Error('No MIDI CC message arrived — check the device and try again.'));
          }, timeoutMs);
        }
        learners.add(learner);
      });
    },
    cancelLearn: () => settleLearners(null),
    dispose() {
      if (disposed) return;
      disposed = true;
      settleLearners(null);
      for (const port of attached) port.onmidimessage = null;
      access?.removeEventListener?.('statechange', onStateChange);
      onStateChange = null;
      attached = new Set();
      statusListeners.clear();
      devices.clear();
      pending = null; access = null; state = 'idle'; error = '';
    },
  };
}

// The window's session. Both the editor preview and the LIVE output screen read it,
// so the same controller drives the graph wherever it runs.
export const MIDI = createMidiService();
