// Versioned, JSON-only graph contract. Missing sources are diagnostics, not
// structurally invalid graphs: imported files must remain editable/repairable.
export const VERSION = 1;
export const MAX_NODES = 24;
export const MAX_SOURCES = 8;
export const MAX_BYTES = 200000;
export const MODES = { Normal: 'source-over', Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay', Difference: 'difference', Add: 'lighter' };
export const inputs = (node) => node.type === 'blend' ? ['base', 'layer'] : node.type === 'output' ? ['image'] : [];
const idOK = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const fail = (message) => { throw new Error(message); };
export function validateGraph(raw, { complete = false } = {}) {
  if (!raw || raw.version !== VERSION) fail('Unsupported graph version');
  if (JSON.stringify(raw).length > MAX_BYTES) fail('Graph exceeds 200 KB');
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 80) fail('Name must contain 1–80 characters');
  if (!Array.isArray(raw.nodes) || !raw.nodes.length || raw.nodes.length > MAX_NODES) fail('Graph needs 1–24 nodes');
  if (!Array.isArray(raw.edges) || raw.edges.length > MAX_NODES * 2) fail('Too many wires');
  const ids = new Map();
  const nodes = raw.nodes.map(n => {
    if (!n || !idOK(n.id) || ids.has(n.id) || !['pattern', 'blend', 'output'].includes(n.type)) fail('Invalid or duplicate node');
    // Signed graph coordinates are independent of the visible pan/zoom viewport.
    if (![n.x, n.y].every(Number.isFinite)) fail('Invalid node position');
    const node = { id: n.id, type: n.type, x: n.x, y: n.y };
    if (n.type === 'pattern') {
      if (!idOK(n.patternId) || n.patternId.startsWith('nodes-')) fail('Graph sources cannot recursively reference graphs; use ordinary patterns');
      if (!n.params || typeof n.params !== 'object' || Array.isArray(n.params) || Object.keys(n.params).length > 256) fail('Invalid pattern parameters');
      for (const [k, v] of Object.entries(n.params)) if (k.length > 80 || ['__proto__', 'constructor', 'prototype'].includes(k) || !Number.isFinite(v) || Math.abs(v) > 1000000) fail('Invalid parameter value');
      Object.assign(node, { patternId: n.patternId, params: { ...n.params } });
    }
    if (n.type === 'blend') {
      if (!Object.hasOwn(MODES, n.mode) || !Number.isFinite(n.opacity) || n.opacity < 0 || n.opacity > 1) fail('Invalid blend mode or opacity');
      Object.assign(node, { mode: n.mode, opacity: n.opacity });
    }
    ids.set(node.id, node);
    return node;
  });
  if (nodes.filter(n => n.type === 'output').length !== 1) fail('Exactly one Output is required');
  if (nodes.filter(n => n.type === 'pattern').length > MAX_SOURCES) fail('At most 8 Pattern sources');
  const occupied = new Set();
  const edges = raw.edges.map(e => {
    const from = ids.get(e?.from), to = ids.get(e?.to);
    const key = `${e?.to}:${e?.port}`;
    if (!from || !to || from.type === 'output' || !inputs(to).includes(e.port) || occupied.has(key)) fail('Invalid reference, port, or duplicate input wire');
    occupied.add(key);
    return { from: e.from, to: e.to, port: e.port };
  });
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('Connection would create a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    edges.filter(e => e.to === id).forEach(e => visit(e.from));
    visiting.delete(id); visited.add(id);
  }
  nodes.forEach(n => visit(n.id));
  if (complete) {
    const required = new Set();
    const walk = id => { if (required.has(id)) return; required.add(id); edges.filter(e => e.to === id).forEach(e => walk(e.from)); };
    walk(nodes.find(n => n.type === 'output').id);
    for (const id of required) for (const port of inputs(ids.get(id))) if (!occupied.has(`${id}:${port}`)) fail(`Connect ${id} ${port} before saving`);
  }
  return { version: VERSION, name: raw.name.trim(), nodes, edges };
}
export function newGraph() {
  return { version: VERSION, name: 'Untitled graph', nodes: [{ id: 'output', type: 'output', x: 650, y: 220 }], edges: [] };
}
export function connect(graph, from, to, port) {
  return validateGraph({ ...graph, edges: [...graph.edges.filter(e => e.to !== to || e.port !== port), { from, to, port }] });
}
export function deleteNode(graph, id) {
  if (graph.nodes.find(n => n.id === id)?.type === 'output') return graph;
  return { ...graph, nodes: graph.nodes.filter(n => n.id !== id), edges: graph.edges.filter(e => e.from !== id && e.to !== id) };
}
export const DRAG_TYPE = 'application/x-viz-pattern+json';
export function readPatternDrag(transfer, sketches) {
  try {
    const text = transfer.getData(DRAG_TYPE);
    if (!text || text.length > 512) return null;
    const data = JSON.parse(text);
    return data.version === 1 && sketches.some(s => s.id === data.patternId && !s.nodesGraph) ? data.patternId : null;
  } catch { return null; }
}
