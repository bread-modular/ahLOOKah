// Single source of truth for node kinds, ports and numeric definitions. Both the
// JSON contract (model.js) and the editor/runtime read from here so a node type
// can never drift between validation, wiring and controls. One import: the
// dependency-free audio-routing route defaults (which must never import back).
import { DEFAULT_AUDIO_INPUT } from '../audio-routing.js';
import { TRANSFORM_PARAMS, transformDefaults } from './transform.js';
import { LFO_PARAMS, lfoDefaults } from './lfo.js';
import { midiDefaults, midiParameters } from './midi.js';
export const TYPES = Object.freeze(['pattern', 'blend', 'output', 'audio', 'color', 'math', 'script', 'camera', 'transform', 'lfo', 'midi']);
export const VISUAL_TYPES = Object.freeze(['pattern', 'blend', 'color', 'output', 'camera', 'transform']);
export const VISUAL_SOURCES = Object.freeze(['pattern', 'blend', 'color', 'camera', 'transform']);
// `inputMode` is a legacy saved hint, not a switch. The presence of an image
// wire determines a pattern's runtime mode; without one it remains a source.
export const inputModeOf = node => node?.inputMode === 'fx' ? 'fx' : 'source';
export const imageInputConnected = (graph, nodeId) => !!graph?.edges?.some(e => e.to === nodeId && e.port === 'image');
export const patternInputMode = (node, graph) => node?.type === 'pattern' && imageInputConnected(graph, node.id) ? 'fx' : 'source';
export const supportsImageFx = sketch => !!sketch?.fx && sketch.fx.input === 'image'
  && Object.keys(sketch.fx).length === 1;
export const canAcceptImageFx = sketch => supportsImageFx(sketch)
  && !sketch.projection && !sketch.nodesGraph && !sketch.surfaces?.length;
// `lfo` is a signal *source* that also accepts modulations on its own numeric
// controls (Cycle time, Start Position) through the ordinary modulation endpoint.
// It has no scalar input ports, because automating a control is what the mapping
// system does — with a range and a target domain — for every other node.
// `midi` follows the same shape: it emits one normalized 0…1 value and its Attack,
// Decay and Apply Velocity sliders are automation targets, while its mode, gate
// mode, channel and input device stay switches (selects, never mapped).
export const SIGNAL_TYPES = Object.freeze(['audio', 'math', 'script', 'lfo', 'midi']);
export const SCALAR_TYPES = Object.freeze(['math', 'script']);
export const MODULATION_TARGETS = Object.freeze(['pattern', 'blend', 'color', 'transform', 'lfo', 'midi']);

// Identity defaults: an untouched Color node is a pixel-exact copy of its input.
export const COLOR_PARAMS = Object.freeze([
  { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: .01, default: 1 },
  { key: 'brightness', label: 'Brightness', min: 0, max: 2, step: .01, default: 1 },
  { key: 'contrast', label: 'Contrast', min: 0, max: 2, step: .01, default: 1 },
  { key: 'hue', label: 'Hue Shift', min: -180, max: 180, step: 1, default: 0 },
]);

export const MATH_OPS = Object.freeze(['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'clamp', 'abs']);
export const MATH_LABELS = Object.freeze({
  add: 'Add (a + b)', subtract: 'Subtract (a − b)', multiply: 'Multiply (a × b)', divide: 'Divide (a ÷ b)',
  min: 'Minimum (min of a, b)', max: 'Maximum (max of a, b)', clamp: 'Clamp (a between b and c)', abs: 'Absolute (|a|)',
});
export const MATH_INPUTS = Object.freeze(['a', 'b', 'c']);
export const MATH_PORT_LABELS = Object.freeze({ a: 'Value A', b: 'Value B', c: 'Value C' });
export const MATH_LITERALS = Object.freeze({ a: 0, b: 0, c: 1 });
export const SCRIPT_INPUTS = Object.freeze(['x', 'y']);
export const SCRIPT_PORT_LABELS = Object.freeze({ x: 'Input x', y: 'Input y' });
// Node position already owns x/y, so the wire fallback literals use their own
// field names (the ports keep the mathematical x/y naming).
export const SCRIPT_LITERAL_FIELDS = Object.freeze({ x: 'inputX', y: 'inputY' });
export const SCRIPT_LITERALS = Object.freeze({ inputX: 0, inputY: 0 });
export const DEFAULT_EXPRESSION = 'x';
// New Script nodes start in the body language; graphs saved before it existed
// carry no `language` field and keep running as expressions.
export const DEFAULT_LANGUAGE = 'body';
export const DEFAULT_BODY = 'return x;';

const ports = {
  blend: ['base', 'layer'],
  color: ['image'],
  // The Transform (image) node: one picture in, the same picture out, moved,
  // scaled and rotated in X/Y/Z.
  transform: ['image'],
  output: ['image'],
  math: MATH_INPUTS,
  script: SCRIPT_INPUTS,
};
// Stored graph validation cannot consult a live registry (which might be
// missing after import), so every Pattern has a *potential*, optional image
// port. Only the editor's activeInputs and model.connect gate new connections.
export const inputs = (node) => node?.type === 'pattern' ? ['image'] : (ports[node?.type] || []).slice();
// Only clamp consumes c: add/subtract/multiply/divide/min/max/abs read a and b at
// most, and abs ignores b as well but keeps the port so an operation change never
// rewires a saved graph. `inputs()` stays the stored contract (all three Math
// ports) so files saved by builds that always showed C still validate; the editor,
// the wire geometry and the runtime ask this instead, and the model drops a wire
// to a port that is present in the contract but inactive for the current operation.
export const MATH_OP_PORTS = Object.freeze({ clamp: Object.freeze(['a', 'b', 'c']) });
const MATH_DEFAULT_PORTS = Object.freeze(['a', 'b']);
export const mathPorts = (op) => (MATH_OP_PORTS[op] || MATH_DEFAULT_PORTS).slice();
// Editor socket: visible for a capable live descriptor, and retained for a
// legacy FX node or a saved wire whose descriptor went missing/changed. Pass the
// graph as third argument to keep even implicit-mode orphaned wires visible.
export const activeInputs = (node, sketch, graph) => node?.type === 'math' ? mathPorts(node.op)
  : node?.type === 'pattern' ? (canAcceptImageFx(sketch) || inputModeOf(node) === 'fx' || imageInputConnected(graph, node.id) ? ['image'] : [])
    : inputs(node);
export const inactiveMathPort = (node, port) => node?.type === 'math' && inputs(node).includes(port) && !mathPorts(node.op).includes(port);
export const isSignalSource = (node) => !!node && SIGNAL_TYPES.includes(node.type);
export const isScalarConsumer = (node) => !!node && SCALAR_TYPES.includes(node.type);
export const isVisualSource = (node) => !!node && VISUAL_SOURCES.includes(node.type);
export const isModulationTarget = (node) => !!node && MODULATION_TARGETS.includes(node.type);
export const isVisualType = (node) => !!node && VISUAL_TYPES.includes(node.type);
// Numeric controls rendered by the shared parameter UI for a node's own fields.
export const parameters = (node) => node?.type === 'color' ? COLOR_PARAMS.slice()
  : node?.type === 'transform' ? TRANSFORM_PARAMS.slice()
    : node?.type === 'lfo' ? LFO_PARAMS.slice()
      : node?.type === 'midi' ? midiParameters(node) : [];

export function newId() { return `n${crypto.randomUUID().slice(0, 8)}`; }
// Structural defaults for a fresh node. Pattern nodes additionally need a
// non-recursive patternId and a parameter snapshot, so the editor builds those.
export function defaultNode(type, x = 0, y = 0, id = newId()) {
  const base = { id, type, x, y };
  if (type === 'blend') return { ...base, mode: 'Normal', opacity: 1 };
  if (type === 'audio') return { ...base, band: 'bass', ...DEFAULT_AUDIO_INPUT };
  if (type === 'camera') return { ...base, deviceId: null };
  if (type === 'color') return { ...base, params: Object.fromEntries(COLOR_PARAMS.map(p => [p.key, p.default])) };
  if (type === 'transform') return { ...base, params: transformDefaults() };
  // A fresh LFO is a one-cycle-per-second rising saw over 0…1. Its custom table
  // stays absent until the operator draws: the shared ramp is the fallback shape,
  // so a new node never carries 32 numbers it does not use.
  if (type === 'lfo') return { ...base, pattern: 'linear', range: 'unipolar', seed: 0, params: lfoDefaults() };
  // A fresh MIDI node listens to every device on channel 1 in Gate/Pulse mode: the
  // first note plays a short pulse, and the device list starts on "Any device" so a
  // new node works before the operator pins a controller.
  if (type === 'midi') return { ...base, mode: 'gate', gateMode: 'pulse', channel: 1, deviceId: null, params: midiDefaults() };
  if (type === 'math') return { ...base, op: 'add', ...MATH_LITERALS };
  if (type === 'script') return { ...base, language: DEFAULT_LANGUAGE, source: DEFAULT_BODY, ...SCRIPT_LITERALS };
  if (type === 'output') return base;
  throw new Error(`Cannot create a ${type} node without a pattern`);
}
