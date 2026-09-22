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
} from './definitions.js';
import { normalizeAudioRoute } from '../audio-routing.js';
import { MAX_EXPRESSION, MAX_BODY, LANGUAGES } from './script.js';

export const VERSION = 1;
// Graph size is not budgeted here. Node count, Pattern source count and wire
// counts are limited only by the machine that edits and renders them, because a
// fixed node/source cap cannot know the hardware. What stays enforced is
// structural and safety validation: ports, references, uniqueness, cycles,
// finite numbers, the restricted script source (MAX_EXPRESSION for the legacy
// expression language, MAX_BODY for the body language) and the JSON payload size
// (MAX_BYTES) that keeps one pattern file loadable.
export const MAX_BYTES = 200000;
export const MODES = { Normal: 'source-over', Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay', Difference: 'difference', Add: 'lighter' };
export { inputs };
const idOK = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const reserved = (key) => ['__proto__', 'constructor', 'prototype'].includes(key);
const number = (value) => Number.isFinite(value) && Math.abs(value) <= 1000000;
const fail = (message) => { throw new Error(message); };
export function validateGraph(raw, { complete = false } = {}) {
  if (!raw || raw.version !== VERSION) fail('Unsupported graph version');
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
      Object.assign(node, { patternId: n.patternId, params: { ...n.params } });
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
    if (!from || !to || !['pattern', 'blend', 'color'].includes(from.type) || !['blend', 'color', 'output'].includes(to.type) || !inputs(to).includes(e.port) || occupied.has(key)) fail('Invalid reference, port, or duplicate input wire');
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
  const mapped = new Set(), links = new Set();
  const modulations = (raw.modulations || []).map(m => {
    const from = ids.get(m?.from), to = ids.get(m?.to);
    if (!isSignalSource(from) || !isModulationTarget(to)) fail('Invalid modulation reference or target');
    const param = m.param ?? null;
    if (param !== null && (!idOK(param) || reserved(param) || (to.type === 'blend' && param !== 'opacity'))) fail('Invalid modulation parameter');
    const key = `${m.to}:${param}`, link = `${m.from}:${key}`;
    if (links.has(link) || (param && mapped.has(key))) fail('Duplicate modulation; explicitly replace the existing mapping');
    links.add(link); if (param) mapped.add(key);
    if (param && (!number(m.min) || !number(m.max))) fail('Invalid modulation range');
    // Signal-range conversion. Omitted fields keep the legacy 0…1 behavior, so
    // existing version-1 graphs and their saved mappings are unchanged.
    const ranged = m.inputMin !== undefined || m.inputMax !== undefined;
    if (ranged && (!number(m.inputMin) || !number(m.inputMax) || m.inputMax <= m.inputMin)) fail('Invalid modulation input range');
    return { from: m.from, to: m.to, param, ...(param ? { min: m.min, max: m.max } : {}), ...(param && ranged ? { inputMin: m.inputMin, inputMax: m.inputMax } : {}) };
  });
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('Connection would create a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    edges.filter(e => e.to === id).forEach(e => visit(e.from));
    signalEdges.filter(e => e.to === id).forEach(e => visit(e.from));
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
    for (const id of required) for (const port of inputs(ids.get(id))) if (!occupied.has(`${id}:${port}`)) fail(`Connect ${id} ${port} before saving`);
  }
  return { version: VERSION, name: raw.name.trim(), nodes, edges,
    ...(signalEdges.length ? { signalEdges } : {}), ...(modulations.length ? { modulations } : {}) };
}
export function newGraph() {
  return { version: VERSION, name: 'Untitled graph', nodes: [{ id: 'output', type: 'output', x: 650, y: 220 }], edges: [] };
}
export function connect(graph, from, to, port) {
  return validateGraph({ ...graph, edges: [...graph.edges.filter(e => e.to !== to || e.port !== port), { from, to, port }] });
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
  return { ...graph, nodes: graph.nodes.filter(n => !removed.has(n.id)), edges: graph.edges.filter(keepLink),
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
  if (ref.kind === 'image') next.edges = graph.edges.filter(keep);
  else if (ref.kind === 'signal') next.signalEdges = (graph.signalEdges || []).filter(keep);
  else next.modulations = (graph.modulations || []).filter(keep);
  return validateGraph(next);
}
export const DRAG_TYPE = 'application/x-viz-pattern+json';
// Every palette drag shares this one versioned payload type: either a structural
// node kind from the fixed create allowlist (never math/output) or a validated
// non-recursive Pattern source id.
const CREATE_TYPES = Object.freeze(['blend', 'color', 'script', 'audio']);
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
