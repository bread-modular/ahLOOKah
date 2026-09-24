// The graph's MIDI signal node: it reads one channel of the operator's controller
// (note gates, or one control-change value) and always emits a normalized 0…1
// signal, so it wires and maps exactly like an Audio band.
//
// Like the LFO it is a *source* that also accepts modulations on its own numeric
// controls: a signal mapped onto Attack, Decay or Apply Velocity arrives through
// the ordinary modulation endpoint — converted by the mapping's own input range,
// in the control's domain — so automating a control is the same gesture on every
// node. Mode, gate mode, channel and input device are switches, never sliders, so
// they are not automation targets.
//
// A *mapped* control is glided (see MIDI_PARAM_SLEW) rather than written straight
// through: a steppy source — a random LFO, an audio band, a slow Script — eases the
// envelope shape instead of kicking it, with the same response time the runtime uses
// for the LFO's rate. A manual slider edit is used exactly as stored, and a mapping
// that is removed forgets its glide, so re-mapping starts from the slider's value.
//
// This module is dependency-free on purpose: definitions.js imports it (like
// lfo.js and transform.js), so it must never import back into the definition graph.
export const MIDI_MODES = Object.freeze(['gate', 'cc']);
export const MIDI_MODE_LABELS = Object.freeze({ gate: 'Gate (note on/off)', cc: 'CC (control change)' });
export const MIDI_GATE_MODES = Object.freeze(['pulse', 'sustain']);
export const MIDI_GATE_MODE_LABELS = Object.freeze({
  pulse: 'Pulse (one envelope per note)', sustain: 'Sustain (level while held)',
});
export const MIDI_CHANNELS = Object.freeze(Array.from({ length: 16 }, (_, i) => i + 1));
export const MIDI_MAX_CC = 127;
// Attack and Decay are logarithmic, exactly like the LFO's Cycle time: on a linear
// 0…5 s track almost the whole travel would sit in the last second. A logarithmic
// domain is positive by definition, so the floor is the shortest one can express —
// 1 ms, which is instant in practice — instead of 0.
export const MIDI_MIN_TIME = .001;
export const MIDI_MAX_TIME = 5;
// The sliders the shared parameter UI renders (and therefore the only controls a
// signal can automate). Reachable in Gate mode; CC mode reads no envelope.
export const MIDI_PARAMS = Object.freeze([
  { key: 'attack', label: 'Attack', min: MIDI_MIN_TIME, max: MIDI_MAX_TIME, step: .002, scale: 'log', format: 'duration', default: MIDI_MIN_TIME },
  { key: 'decay', label: 'Decay', min: MIDI_MIN_TIME, max: MIDI_MAX_TIME, step: .002, scale: 'log', format: 'duration', default: MIDI_MIN_TIME },
  { key: 'velocity', label: 'Apply Velocity', min: 0, max: 1, step: .01, default: 0 },
]);
// The CC number is a chosen value, not a slider: it is stored with the other
// parameters (so a mode switch never loses it) and edited with a number field plus
// Learn, but it is deliberately not automatable.
export const MIDI_CC_PARAM = Object.freeze({ key: 'cc', label: 'CC Number', min: 0, max: MIDI_MAX_CC, step: 1, default: 1 });
export const midiDefaults = () => Object.fromEntries([...MIDI_PARAMS, MIDI_CC_PARAM].map(p => [p.key, p.default]));
export const midiParamDef = key => MIDI_PARAMS.find(p => p.key === key) || (key === MIDI_CC_PARAM.key ? MIDI_CC_PARAM : null);
// The stored values the layer above validates against: the mode's sliders plus the
// retained CC number (and the other mode's sliders, which survive a mode switch).
export const MIDI_STORED_PARAMS = Object.freeze([...MIDI_PARAMS, MIDI_CC_PARAM]);
export const MIDI_GATE_KEYS = Object.freeze(MIDI_PARAMS.map(def => def.key));
export const midiParameters = (node) => midiModeOf(node?.mode) === 'cc' ? [] : MIDI_PARAMS.slice();

// Stored fields are read through these so an imported or hand-edited file can never
// put the node in a state the UI and runtime disagree about.
export const midiModeOf = value => MIDI_MODES.includes(value) ? value : MIDI_MODES[0];
export const midiGateModeOf = value => MIDI_GATE_MODES.includes(value) ? value : MIDI_GATE_MODES[0];
export const midiChannelOf = value => Number.isInteger(value) && value >= MIDI_CHANNELS[0] && value <= MIDI_CHANNELS[MIDI_CHANNELS.length - 1] ? value : MIDI_CHANNELS[0];
export const midiDeviceOf = value => typeof value === 'string' && value ? value : null;
export const midiCcOf = node => Number.isInteger(node?.params?.cc) && node.params.cc >= 0 && node.params.cc <= MIDI_MAX_CC ? node.params.cc : MIDI_CC_PARAM.default;
// One control's live value: the mapped value when a signal drives it, the stored
// value otherwise, and the documented default when the file omits it.
export function midiParamValue(node, key, view = null) {
  const live = view?.[key];
  if (Number.isFinite(live)) return live;
  const stored = node?.params?.[key];
  return Number.isFinite(stored) ? stored : midiParamDef(key)?.default ?? 0;
}
// The response time of the mapped-control glide: about five frames at 60 fps,
// matching the LFO's rate glide so both nodes react to a mapped signal the same way.
export const MIDI_PARAM_SLEW = .08;
// One glide step for a mapped control. Engaging a mapping hands the control over
// from its *stored* value (so connecting a signal never jumps), the approach is
// exponential — the same wall-clock response at any frame rate, so one 80 ms frame
// and four 20 ms frames arrive in the same place — and a frame with no elapsed time
// never moves.
export function midiGlide(previous, target, dt, base = target) {
  if (previous === undefined) return Number.isFinite(base) ? base : target;
  if (!(dt > 0)) return previous;
  return previous + (target - previous) * (1 - Math.exp(-dt / MIDI_PARAM_SLEW));
}
// Everything the session needs for one node, with the active mode's controls
// glided: the realtime session stays a pure state lookup, so a node never has to
// know how a mapping is stored.
export function midiNodeParams(node, view = null, glide = null) {
  const params = {
    mode: midiModeOf(node?.mode),
    gateMode: midiGateModeOf(node?.gateMode),
    channel: midiChannelOf(node?.channel),
    deviceId: midiDeviceOf(node?.deviceId),
    cc: midiCcOf(node),
    attack: midiParamValue(node, 'attack', view),
    decay: midiParamValue(node, 'decay', view),
    velocity: midiParamValue(node, 'velocity', view),
  };
  if (!glide) return params;
  for (const def of midiParameters(node)) {
    // (target, stored base): the glide starts from what the slider holds, so a new
    // mapping takes the control over gradually instead of jumping to the source.
    params[def.key] = glide(def.key, midiParamValue(node, def.key, view), midiParamValue(node, def.key));
  }
  return params;
}
