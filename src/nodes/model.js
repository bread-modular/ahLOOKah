// Versioned, JSON-only graph contract. Missing sources are diagnostics, not
// structurally invalid graphs: imported files must remain editable/repairable.
//
// Three independent link kinds (never conflated):
//   edges       — image pixels between visual nodes
//   signalEdges — scalar values into Math/Script input ports
//   modulations — terminal scalar mappings onto a numeric parameter
import {
  TYPES, COLOR_PARAMS, MATH_OPS, MATH_LITERALS, SCRIPT_LITERALS,
  inputs, isSignalSource, isScalarConsumer, isModulationTarget, inactiveMathPort,
  isVisualSource, canAcceptImageFx, imageInputConnected,
} from './definitions.js';
import { normalizeAudioRoute, isValidAudioDeviceId } from '../audio-routing.js';
import { MAX_EXPRESSION, MAX_BODY, LANGUAGES } from './script.js';
import { TRANSFORM_PARAMS, transformDefaults } from './transform.js';
import { LFO_PATTERNS, LFO_RANGES, LFO_PARAMS, LFO_MIN_POINTS, LFO_MAX_POINTS, LFO_MAX_SEED, lfoDefaults, lfoCycleFromLegacySpeed } from './lfo.js';
import { MIDI_MODES, MIDI_GATE_MODES, MIDI_CHANNELS, MIDI_STORED_PARAMS, MIDI_GATE_KEYS, midiDefaults, midiParameters } from './midi.js';
import { MODES } from './blend-modes.js';
// Blend modes are defined in blend-modes.js (canvas-native operations plus the
// shader-only TouchDesigner modes); a graph stores only the mode name. Re-exported
// here because this module is the public contract for saved graphs.
export { MODES };

export const VERSION = 2;
export const LEGACY_VERSION = 1;
// Graph size is not budgeted here. Node count, Pattern source count and wire
// counts are limited only by the machine that edits and renders them, because a
// fixed node/source cap cannot know the hardware. What stays enforced is
// structural and safety validation: ports, references, uniqueness, cycles,
// finite numbers, the restricted script source (MAX_EXPRESSION for the legacy
// expression language, MAX_BODY for the body language) and the JSON payload size
// (MAX_BYTES) that keeps one pattern file loadable.
export const MAX_BYTES = 200000;
export { inputs };
const idOK = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const reserved = (key) => ['__proto__', 'constructor', 'prototype'].includes(key);
const number = (value) => Number.isFinite(value) && Math.abs(value) <= 1000000;
const fail = (message) => { throw new Error(message); };
export function validateGraph(raw, { complete = false } = {}) {
  if (!raw || ![LEGACY_VERSION, VERSION].includes(raw.version)) fail('Unsupported graph version');
  if (JSON.stringify(raw).length > MAX_BYTES) fail('Graph exceeds 200 KB');
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 80) fail('Name must contain 1–80 characters');
  if (!Array.isArray(raw.nodes) || !raw.nodes.length) fail('Graph needs at least one node');
  if (!Array.isArray(raw.edges)) fail('Invalid image wires');
  const ids = new Map();
  const nodes = raw.nodes.map(n => {
    if (!n || !idOK(n.id) || ids.has(n.id) || !TYPES.includes(n.type)) fail('Invalid or duplicate node');
    // Signed graph coordinates are independent of the visible pan/zoom viewport.
    if (![n.x, n.y].every(Number.isFinite)) fail('Invalid node position');
    const node = { id: n.id, type: n.type, x: n.x, y: n.y };
    if (n.type === 'pattern') {
      if (!idOK(n.patternId) || n.patternId.startsWith('nodes-')) fail('Graph sources cannot recursively reference graphs; use ordinary patterns');
      if (!n.params || typeof n.params !== 'object' || Array.isArray(n.params) || Object.keys(n.params).length > 256) fail('Invalid pattern parameters');
      for (const [k, v] of Object.entries(n.params)) if (k.length > 80 || reserved(k) || !number(v)) fail('Invalid parameter value');
      if (n.inputMode !== undefined) {
        if (!['source', 'fx'].includes(n.inputMode)) fail('Invalid pattern input mode');
        if (n.inputMode === 'fx' && raw.version !== VERSION) fail('FX pattern requires graph version 2');
        // Explicit source survives a round trip, but omission retains v1 identity.
        node.inputMode = n.inputMode;
      }
      Object.assign(node, { patternId: n.patternId, params: { ...n.params } });
    }
    if (n.type === 'camera') {
      if (raw.version !== VERSION) fail('Camera node requires graph version 2');
      // Opaque browser device ids follow Audio's 512-char/control-character
      // guard. null follows Settings/videoDeviceId at runtime, never at save.
      if (n.deviceId !== undefined && n.deviceId !== null && !isValidAudioDeviceId(n.deviceId)) fail('Invalid camera input device');
      node.deviceId = n.deviceId ?? null;
    }
    if (n.type === 'color') {
      if (!n.params || typeof n.params !== 'object' || Array.isArray(n.params)) fail('Invalid color parameters');
      // Only the documented Color controls exist, inside their own ranges;
      // omitted fields fall back to the documented identity defaults.
      const params = Object.fromEntries(COLOR_PARAMS.map(p => [p.key, p.default]));
      for (const [k, v] of Object.entries(n.params)) {
        const def = COLOR_PARAMS.find(p => p.key === k);
        if (!def || !number(v) || v < def.min || v > def.max) fail(`Invalid color parameter: ${k}`);
        params[k] = v;
      }
      node.params = params;
    }
    if (n.type === 'transform') {
      // Same contract as Color: only the documented controls exist, inside their
      // own ranges, and omitted fields fall back to the identity defaults.
      if (!n.params || typeof n.params !== 'object' || Array.isArray(n.params)) fail('Invalid transform parameters');
      const params = transformDefaults();
      for (const [k, v] of Object.entries(n.params)) {
        const def = TRANSFORM_PARAMS.find(p => p.key === k);
        if (!def || !number(v) || v < def.min || v > def.max) fail(`Invalid transform parameter: ${k}`);
        params[k] = v;
      }
      node.params = params;
    }
    if (n.type === 'lfo') {
      // Same contract as Color/Transform for the numeric controls, plus the two
      // enumerations and the drawn table. The pattern/range names are stored as
      // names (one place in lfo.js owns the tables), and an absent field falls
      // back to the node's documented default instead of failing the load.
      if (!LFO_PATTERNS.includes(n.pattern === undefined ? 'linear' : n.pattern)) fail('Invalid LFO pattern');
      if (n.range !== undefined && !LFO_RANGES.includes(n.range)) fail('Invalid LFO range');
      const seed = n.seed === undefined ? 0 : n.seed;
      if (!Number.isInteger(seed) || seed < 0 || seed > LFO_MAX_SEED) fail('Invalid LFO seed');
      if (!n.params || typeof n.params !== 'object' || Array.isArray(n.params)) fail('Invalid LFO parameters');
      const params = lfoDefaults();
      let legacySpeed = null;
      for (const [k, v] of Object.entries(n.params)) {
        // `speed` is the pre-release name for Cycle time (cycles per second, 0 =
        // frozen). A file written while the control had that name keeps its rate;
        // an explicit `cycle` in the same file wins.
        if (k === 'speed') {
          if (!number(v) || v < 0) fail('Invalid LFO parameter: speed');
          legacySpeed = v;
          continue;
        }
        const def = LFO_PARAMS.find(p => p.key === k);
        if (!def || !number(v) || v < def.min || v > def.max) fail(`Invalid LFO parameter: ${k}`);
        params[k] = v;
      }
      if (legacySpeed !== null && n.params.cycle === undefined) params.cycle = lfoCycleFromLegacySpeed(legacySpeed);
      Object.assign(node, { pattern: n.pattern === undefined ? 'linear' : n.pattern,
        range: n.range === undefined ? 'unipolar' : n.range, seed, params });
      // The drawn table is only stored when the file declared one: a node that
      // never used Custom stays small, and the shared ramp is its fallback shape.
      if (n.points !== undefined) {
        if (!Array.isArray(n.points) || n.points.length < LFO_MIN_POINTS || n.points.length > LFO_MAX_POINTS) fail('Invalid LFO points');
        for (const v of n.points) if (!number(v) || v < 0 || v > 1) fail('Invalid LFO points');
        node.points = n.points.slice();
      }
    }
    if (n.type === 'midi') {
      // Same contract as the LFO — the two are the signal nodes whose own controls are
      // automated: the enumerations are validated against the tables in midi.js, an
      // absent field falls back to the node's documented default instead of failing the
      // load, and the numeric parameters keep the Color/Transform rule: only the
      // documented controls exist, inside their own ranges. Both modes' values are
      // retained, so switching Gate ⇄ CC never loses what the operator set.
      if (!MIDI_MODES.includes(n.mode === undefined ? 'gate' : n.mode)) fail('Invalid MIDI mode');
      if (n.gateMode !== undefined && !MIDI_GATE_MODES.includes(n.gateMode)) fail('Invalid MIDI gate mode');
      const channel = n.channel === undefined ? MIDI_CHANNELS[0] : n.channel;
      if (!Number.isInteger(channel) || channel < MIDI_CHANNELS[0] || channel > MIDI_CHANNELS[MIDI_CHANNELS.length - 1]) fail('Invalid MIDI channel');
      // Opaque input ids follow Audio/Camera's 512-char/control-character guard; null
      // means "any device", which is what a fresh node listens to.
      if (n.deviceId !== undefined && n.deviceId !== null && !isValidAudioDeviceId(n.deviceId)) fail('Invalid MIDI input device');
      if (!n.params || typeof n.params !== 'object' || Array.isArray(n.params)) fail('Invalid MIDI parameters');
      const params = midiDefaults();
      for (const [k, v] of Object.entries(n.params)) {
        const def = MIDI_STORED_PARAMS.find(p => p.key === k);
        if (!def || !number(v) || v < def.min || v > def.max) fail(`Invalid MIDI parameter: ${k}`);
        // The CC number is a whole number of the 128 controllers, never a fraction.
        if (def.step >= 1 && !Number.isInteger(v)) fail(`Invalid MIDI parameter: ${k}`);
        params[k] = v;
      }
      Object.assign(node, { mode: n.mode === undefined ? 'gate' : n.mode,
        gateMode: n.gateMode === undefined ? MIDI_GATE_MODES[0] : n.gateMode,
        channel, deviceId: n.deviceId ?? null, params });
    }
    if (n.type === 'audio') {
      if (!['bass', 'mid', 'high'].includes(n.band)) fail('Invalid audio band');
      node.band = n.band;
      // Per-node input route (plan section 6). Missing fields in existing
      // graphs normalize to Global input + Mono; explicit values must be exact.
      // Device availability is a runtime condition, never a file-load error.
      const route = normalizeAudioRoute(n.deviceId, n.channel);
      if (!route) fail('Invalid audio input route');
      Object.assign(node, route);
    }
    if (n.type === 'math') {
      if (!MATH_OPS.includes(n.op)) fail('Invalid math operation');
      for (const key of ['a', 'b', 'c']) {
        const value = n[key] === undefined ? MATH_LITERALS[key] : n[key];
        if (!number(value)) fail('Invalid math literal');
        node[key] = value;
      }
      node.op = n.op;
    }
    if (n.type === 'script') {
      // A missing language is the legacy expression language; an explicit value
      // must be known, so a typo can never silently downgrade a saved script.
      const language = n.language === undefined ? 'expression' : n.language;
      if (!LANGUAGES.includes(language)) fail('Invalid script language');
      const limit = language === 'body' ? MAX_BODY : MAX_EXPRESSION;
      if (typeof n.source !== 'string' || n.source.length > limit) fail(`Script source must be text of at most ${limit} characters`);
      for (const key of ['inputX', 'inputY']) {
        const value = n[key] === undefined ? SCRIPT_LITERALS[key] : n[key];
        if (!number(value)) fail('Invalid script literal');
        node[key] = value;
      }
      node.source = n.source;
      // Written only when the file declared it, so legacy graphs round-trip exactly.
      if (n.language !== undefined) node.language = language;
    }
    if (n.type === 'blend') {
      if (!Object.hasOwn(MODES, n.mode) || !Number.isFinite(n.opacity) || n.opacity < 0 || n.opacity > 1) fail('Invalid blend mode or opacity');
      Object.assign(node, { mode: n.mode, opacity: n.opacity });
    }
    ids.set(node.id, node);
    return node;
  });
  if (nodes.filter(n => n.type === 'output').length !== 1) fail('Exactly one Output is required');
  const occupied = new Set();
  const edges = raw.edges.map(e => {
    const from = ids.get(e?.from), to = ids.get(e?.to);
    const key = `${e?.to}:${e?.port}`;
    // Image wires only ever reach image ports of visual nodes; scalar inputs
    // (Math/Script) are wired exclusively by signalEdges.
    if (!isVisualSource(from) || !to || !['pattern', 'blend', 'color', 'transform', 'output'].includes(to.type) || !inputs(to).includes(e.port) || occupied.has(key)) fail('Invalid reference, port, or duplicate input wire');
    if (to.type === 'pattern' && raw.version !== VERSION) fail('Pattern image input requires graph version 2');
    occupied.add(key);
    return { from: e.from, to: e.to, port: e.port };
  });
  if (raw.signalEdges !== undefined && !Array.isArray(raw.signalEdges)) fail('Invalid signal wires');
  // A Math input that the selected operation does not consume can never be read:
  // files saved by builds that always showed C still open, but the inactive wire
  // is dropped instead of being rejected (which would make the graph unloadable)
  // or kept (which would leave an invisible, unreachable link behind). Unknown
  // ports still fail below.
  const reachableSignalEdges = (raw.signalEdges || []).filter(e => !inactiveMathPort(ids.get(e?.to), e?.port));
  const signalOccupied = new Set();
  const signalEdges = reachableSignalEdges.map(e => {
    const from = ids.get(e?.from), to = ids.get(e?.to);
    const key = `${e?.to}:${e?.port}`;
    if (!from || !to || !isSignalSource(from) || !isScalarConsumer(to) || !inputs(to).includes(e.port) || signalOccupied.has(key)) fail('Invalid signal reference, port, or duplicate input wire');
    signalOccupied.add(key);
    return { from: e.from, to: e.to, port: e.port };
  });
  if (raw.modulations !== undefined && !Array.isArray(raw.modulations)) fail('Invalid modulation links');
  // Pass 1 — every stored mapping is validated, including one the selected mode is
  // about to drop: a ghost source, an unknown parameter or a broken range must never
  // be discarded silently just because the slider it targets is hidden.
  const storedLinks = (raw.modulations || []).map(m => {
    const from = ids.get(m?.from), to = ids.get(m?.to);
    if (!isSignalSource(from) || !isModulationTarget(to)) fail('Invalid modulation reference or target');
    // An LFO mapping saved while that control was still called `speed` keeps its
    // automation: the endpoints described the sweep in cycles per second, and are
    // converted to the same sweep in seconds per cycle, so the input that selected
    // the fast end still selects the fast end. A `speed` parameter on any other
    // target (a sketch may have one) is left exactly as it is.
    const legacySpeed = m.param === 'speed' && to.type === 'lfo';
    const param = legacySpeed ? 'cycle' : m.param ?? null;
    if (param !== null && (!idOK(param) || reserved(param) || (to.type === 'blend' && param !== 'opacity'))) fail('Invalid modulation parameter');
    if (param && (!number(m.min) || !number(m.max))) fail('Invalid modulation range');
    // Signal-range conversion. Omitted fields keep the legacy 0…1 behavior, so
    // existing version-1 graphs and their saved mappings are unchanged.
    const ranged = m.inputMin !== undefined || m.inputMax !== undefined;
    if (ranged && (!number(m.inputMin) || !number(m.inputMax) || m.inputMax <= m.inputMin)) fail('Invalid modulation input range');
    return { from: m.from, to: m.to, param,
      ...(param ? { min: legacySpeed ? lfoCycleFromLegacySpeed(m.min) : m.min, max: legacySpeed ? lfoCycleFromLegacySpeed(m.max) : m.max } : {}),
      ...(param && ranged ? { inputMin: m.inputMin, inputMax: m.inputMax } : {}) };
  });
  // Pass 2 — a Gate slider (Attack, Decay, Apply Velocity) that the selected mode
  // does not show can never be edited or removed from the inspector, so its mapping
  // is dropped exactly like a wire to an inactive Math port: never rejected (that
  // would make the file unloadable) and never kept invisibly (that would block Save
  // with no control to fix it). The drop is final — switching the mode back does not
  // restore the mapping, and the inspector says so when the switch happens. A mapping
  // to `cc` is *not* dropped here: `cc` is a stored value that is never a slider in
  // any mode, so it stays visible to the diagnostics below, which name the node.
  const reachableLinks = storedLinks.filter(link => !(ids.get(link.to)?.type === 'midi' && link.param
    && MIDI_GATE_KEYS.includes(link.param)
    && !midiParameters(ids.get(link.to)).some(def => def.key === link.param)));
  // Pass 3 — duplicates and cycles are judged on what the graph will actually read.
  const mapped = new Set(), links = new Set();
  const modulations = reachableLinks.map(m => {
    const key = `${m.to}:${m.param}`, link = `${m.from}:${key}`;
    if (links.has(link) || (m.param && mapped.has(key))) fail('Duplicate modulation; explicitly replace the existing mapping');
    links.add(link); if (m.param) mapped.add(key);
    return m;
  });
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('Connection would create a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    edges.filter(e => e.to === id).forEach(e => visit(e.from));
    signalEdges.filter(e => e.to === id).forEach(e => visit(e.from));
    // A mapped parameter is a data dependency too: the target reads its source
    // every frame, so a loop through modulations recurses exactly like a wire.
    // Only a signal node can be a modulation target *and* a source (an LFO's own
    // Cycle time), which is what makes this walk reachable — and fatal — without it.
    modulations.filter(m => m.to === id).forEach(m => visit(m.from));
    visiting.delete(id); visited.add(id);
  }
  nodes.forEach(n => visit(n.id));
  // Completeness is opt-in and never a save gate: a pattern may be saved (and
  // re-read from disk) while its Output is still unconnected, so a half-wired
  // graph stays editable instead of being refused silently. Callers that want
  // the "every reachable input is wired" rule must ask for it explicitly.
  if (complete) {
    const required = new Set();
    const walk = id => { if (required.has(id)) return; required.add(id); edges.filter(e => e.to === id).forEach(e => walk(e.from)); };
    walk(nodes.find(n => n.type === 'output').id);
    for (const id of required) for (const port of inputs(ids.get(id))) {
      // Pattern image inputs are optional even with complete=true; an explicit
      // legacy FX hint with no wire falls back to its ordinary source path.
      if (ids.get(id).type !== 'pattern' && !occupied.has(`${id}:${port}`)) fail(`Connect ${id} ${port} before saving`);
    }
  }
  return { version: raw.version, name: raw.name.trim(), nodes, edges,
    ...(signalEdges.length ? { signalEdges } : {}), ...(modulations.length ? { modulations } : {}) };
}
export function newGraph() {
  return { version: LEGACY_VERSION, name: 'Untitled graph', nodes: [{ id: 'output', type: 'output', x: 650, y: 220 }], edges: [] };
}
// A new Pattern image wire needs a capable *live* descriptor, while validation
// of imported graphs deliberately doesn't: missing definitions and saved wires
// must remain editable/repairable. A v1 graph upgrades atomically when wired.
export function connect(graph, from, to, port, { sketches } = {}) {
  const target = graph.nodes.find(n => n.id === to);
  if (target?.type === 'pattern' && (!sketches || !canAcceptImageFx(sketches.find(s => s.id === target.patternId))))
    fail('Connect an image only to a known FX-capable pattern');
  return validateGraph({ ...graph, version: target?.type === 'pattern' ? VERSION : graph.version,
    edges: [...graph.edges.filter(e => e.to !== to || e.port !== port), { from, to, port }] });
}
// Only explicit legacy `fx` hints on sockets *just disconnected* are removed.
// Existing imported no-wire FX nodes survive validation and can be repaired.
function resetDisconnectedFx(nodes, edges, affectedIds) {
  return nodes.map(node => {
    if (!affectedIds.has(node.id) || node.type !== 'pattern' || node.inputMode !== 'fx' || imageInputConnected({ edges }, node.id)) return node;
    const { inputMode: _old, ...source } = node;
    return source;
  });
}
// Scalar input port wiring (Math/Script). One wire per input; new wires replace.
export function connectSignalEdge(graph, from, to, port) {
  return validateGraph({ ...graph, signalEdges: [...(graph.signalEdges || []).filter(e => e.to !== to || e.port !== port), { from, to, port }] });
}
// Output is structural: selecting it never removes it, but does not veto
// deletion of other selected nodes. Remove all incident links atomically.
export function deleteNodes(graph, ids) {
  const selected = new Set(ids);
  const removed = new Set(graph.nodes.filter(n => n.type !== 'output' && selected.has(n.id)).map(n => n.id));
  if (!removed.size) return graph;
  const keepLink = e => !removed.has(e.from) && !removed.has(e.to);
  const edges = graph.edges.filter(keepLink);
  const affected = new Set(graph.edges.filter(e => removed.has(e.from)).map(e => e.to));
  return { ...graph, nodes: resetDisconnectedFx(graph.nodes.filter(n => !removed.has(n.id)), edges, affected), edges,
    ...(graph.signalEdges ? { signalEdges: graph.signalEdges.filter(keepLink) } : {}),
    ...(graph.modulations ? { modulations: graph.modulations.filter(keepLink) } : {}) };
}
export function deleteNode(graph, id) { return deleteNodes(graph, [id]); }

// The three link kinds are independent, so a selected connection is addressed by
// both its kind and a key that is unique inside that kind. Selection is transient
// editor state; these helpers turn it back into an exact graph edit, which is what
// lets Delete remove one wire without touching either endpoint node.
export const WIRE_KINDS = Object.freeze(['image', 'signal', 'modulation']);
export function connectionRef(kind, link) {
  return { kind, key: kind === 'modulation' ? `${link.from}:${link.to}:${link.param ?? ''}` : `${link.to}:${link.port}` };
}
export function findConnection(graph, ref) {
  if (!ref || !WIRE_KINDS.includes(ref.kind)) return null;
  const links = ref.kind === 'image' ? graph.edges : ref.kind === 'signal' ? graph.signalEdges : graph.modulations;
  return (links || []).find(link => connectionRef(ref.kind, link).key === ref.key) || null;
}
export function removeConnection(graph, ref) {
  if (!findConnection(graph, ref)) return graph;
  const keep = link => connectionRef(ref.kind, link).key !== ref.key;
  const next = { ...graph };
  if (ref.kind === 'image') {
    const removed = findConnection(graph, ref);
    next.edges = graph.edges.filter(keep);
    next.nodes = resetDisconnectedFx(graph.nodes, next.edges, new Set([removed.to]));
  } else if (ref.kind === 'signal') next.signalEdges = (graph.signalEdges || []).filter(keep);
  else next.modulations = (graph.modulations || []).filter(keep);
  return validateGraph(next);
}
export const DRAG_TYPE = 'application/x-viz-pattern+json';
// Every palette drag shares this one versioned payload type: either a structural
// node kind from the fixed create allowlist (never math/output) or a validated
// non-recursive Pattern source id.
const CREATE_TYPES = Object.freeze(['blend', 'color', 'transform', 'script', 'audio', 'camera', 'lfo', 'midi']);
export function readPaletteDrag(transfer, sketches) {
  try {
    const text = transfer.getData(DRAG_TYPE);
    if (!text || text.length > 512) return null;
    const data = JSON.parse(text);
    if (data.version !== 1) return null;
    if (CREATE_TYPES.includes(data.nodeType)) return { nodeType: data.nodeType };
    return sketches.some(s => s.id === data.patternId && !s.nodesGraph) ? { patternId: data.patternId } : null;
  } catch { return null; }
}

export function connectSignal(graph, from, to) {
  if ((graph.modulations || []).some(m => m.from === from && m.to === to)) return graph;
  return validateGraph({ ...graph, modulations: [...(graph.modulations || []), { from, to, param: null }] });
}
export function mapSignal(graph, from, to, param, min, max, replace = false, range = null) {
  const existing = (graph.modulations || []).find(m => m.to === to && m.param === param);
  if (existing && existing.from !== from && !replace) throw new Error('Parameter already mapped; explicitly replace it');
  // Preserve an existing signal input range when only the output range moves.
  const previous = existing || (graph.modulations || []).find(m => m.from === from && m.to === to && m.param === null);
  const bounds = range ? { inputMin: range.inputMin, inputMax: range.inputMax }
    : previous && number(previous.inputMin) && number(previous.inputMax) ? { inputMin: previous.inputMin, inputMax: previous.inputMax } : null;
  return validateGraph({ ...graph, modulations: [...(graph.modulations || []).filter(m => !(m.to === to && (m.param === param || (m.from === from && m.param === null)))), { from, to, param, min, max, ...(bounds || {}) }] });
}
export function mapSignalInput(graph, from, to, param, inputMin, inputMax) {
  const existing = (graph.modulations || []).find(m => m.to === to && m.param === param);
  if (!existing) throw new Error('Map this parameter before setting its signal input range');
  return mapSignal(graph, from, to, param, existing.min, existing.max, true, { inputMin, inputMax });
}
