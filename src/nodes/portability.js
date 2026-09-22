import { mappingDiagnostics } from './modulation.js';
import { validateGraph, MAX_BYTES } from './model.js';
import { validateScript } from './script.js';
import { scriptLanguageOf } from './scalar.js';
// Manifests deliberately do NOT execute imported scripts or claim that local
// file handles are portable. Dynamic dependencies must already match locally.
function fingerprint(text = '') {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}
export function dependencySignature(sketch) {
  return JSON.stringify({ id: sketch.id, kind: sketch.kind || null, mediaId: sketch.mediaId || null,
    surfaces: sketch.surfaces || null, source: sketch.customScript ? fingerprint(sketch.nodesSourceText) : null,
    params: sketch.params || [] });
}
export function entryFor(id, sketches) {
  const s = sketches.find(x => x.id === id);
  if (!s) return { id, kind: 'missing', signature: null };
  return { id, name: s.name, kind: s.media ? 'local-media' : s.projection ? 'projection' : s.customScript ? 'custom-script' : 'built-in', signature: dependencySignature(s) };
}
export function manifestFor(graph, sketches) {
  const found = new Map();
  function add(id) {
    if (found.has(id)) return;
    const s = sketches.find(x => x.id === id);
    if (s && (s.nodesGraph || id.startsWith('nodes-'))) throw new Error('Recursive graph dependency is not supported');
    found.set(id, entryFor(id, sketches));
    s?.surfaces?.forEach(surface => add(surface.patternId));
  }
  graph.nodes.filter(n => n.type === 'pattern').forEach(n => add(n.patternId));
  return [...found.values()];
}
// Every id a Pattern source consumes: its own id plus the projection surfaces it
// is built from (those are Pattern sources too). Deleting the last node that used
// a source removes it from this set, which is what lets a dependency manifest
// follow the graph instead of pinning a source the graph no longer contains.
function consumedIds(sketches, patternId, into = new Set()) {
  if (!patternId || into.has(patternId)) return into;
  into.add(patternId);
  sketches.find(s => s.id === patternId)?.surfaces?.forEach(surface => consumedIds(sketches, surface.patternId, into));
  return into;
}
export function referencedIds(graph, sketches) {
  const ids = new Set();
  graph.nodes.filter(n => n.type === 'pattern').forEach(n => consumedIds(sketches, n.patternId, ids));
  return ids;
}
// Keep the manifest in step with the graph. Unreferenced entries are dropped —
// a stale entry (a removed or changed custom script, say) blocks Save forever,
// even after the node that used it is gone — while the stored fingerprints of
// surviving entries are preserved: "changed dependency" detection must stay
// until an explicit Refresh dependencies, so a signature is only ever derived
// fresh for an id the manifest does not know yet.
export function pruneManifest(graph, sketches, manifest = []) {
  const required = referencedIds(graph, sketches);
  const kept = manifest.filter(d => required.has(d.id)).map(d => ({ ...d }));
  for (const id of required) if (!kept.some(d => d.id === id)) kept.push(entryFor(id, sketches));
  return kept;
}
// One pass over the graph produces both shapes the editor needs: the flat message
// list that blocks Save, and the same messages attributed to the node that owns
// them, so the offending node can be outlined instead of only refusing the write.
export function graphDiagnostics(graph, sketches, manifest = []) {
  const messages = mappingDiagnostics(graph, sketches);
  const byNode = new Map();
  const report = (nodeId, message) => { messages.push(message); byNode.set(nodeId, [...(byNode.get(nodeId) || []), message]); };
  const patternNodes = graph.nodes.filter(n => n.type === 'pattern');
  for (const n of patternNodes) {
    const s = sketches.find(s => s.id === n.patternId);
    if (!s) { report(n.id, `Missing pattern: ${n.patternId}`); continue; }
    for (const surface of s.surfaces || []) {
      const child = sketches.find(x => x.id === surface.patternId);
      if (!child) report(n.id, `Missing projection source: ${surface.patternId}`);
      else if (child.projection || child.nodesGraph) report(n.id, 'Nested composite sources are not supported');
    }
    if (s.nodesGraph || s.surfaces?.some(x => x.patternId.startsWith('nodes-'))) report(n.id, 'Recursive graph dependency is not supported');
    for (const [key, value] of Object.entries(n.params)) {
      const def = s.params?.find(d => d.key === key);
      if (!def || value < def.min || value > def.max) report(n.id, `Invalid ${s.name} parameter: ${key}`);
    }
  }
  // No leaf-renderer budget: the number of Pattern sources is a hardware
  // question, not a validation rule. Structural and dependency checks stay.
  // A broken script (either language) is repairable in the editor but must never
  // be saved.
  for (const n of graph.nodes.filter(n => n.type === 'script')) {
    // Validate the stored text itself (an empty source is repairable but not
    // savable), not the runtime's default fallback.
    const result = validateScript(n.source, scriptLanguageOf(n));
    if (!result.ok) report(n.id, `Invalid script on ${n.id}: ${result.error}`);
  }
  for (const dep of manifest) {
    const s = sketches.find(s => s.id === dep.id);
    const message = !s ? `Missing dependency: ${dep.name || dep.id}`
      : dep.signature && dep.signature !== dependencySignature(s) ? `Changed dependency: ${dep.name || dep.id}; restore it or explicitly refresh dependencies` : null;
    if (!message) continue;
    // Attribute the message to every node that still consumes this source; a
    // manifest entry no node references has no owner and stays a graph-level note.
    const owners = patternNodes.filter(n => consumedIds(sketches, n.patternId).has(dep.id));
    if (owners.length) owners.forEach(n => report(n.id, message));
    else messages.push(message);
  }
  const unique = map => [...new Set(map)];
  return { messages: unique(messages), byNode: new Map([...byNode].map(([id, list]) => [id, unique(list)])) };
}
export function sourceDiagnostics(graph, sketches, manifest = []) {
  return graphDiagnostics(graph, sketches, manifest).messages;
}
export function serializeGraph(graph, dependencies) {
  return JSON.stringify({ format: 'viz2-nodes', version: 1, graph: validateGraph(graph), dependencies,
    portability: 'Local media files/permissions and matching custom scripts/projection definitions are required on the destination. No files or executable code are embedded. Audio nodes pinned to a specific input device keep that browser device id, which is origin/profile-specific and may need reselection on another machine or after clearing site data; Global input (the default) always follows the destination Settings.' }, null, 2);
}
export function validateManifest(value) {
  if (!Array.isArray(value) || value.length > 80 || value.some(d => !d || typeof d.id !== 'string' || d.id.length > 80 || (d.signature !== null && typeof d.signature !== 'string'))) throw new Error('Invalid dependency manifest');
  return value.map(d => ({ id: d.id, name: typeof d.name === 'string' ? d.name.slice(0, 80) : d.id, kind: typeof d.kind === 'string' ? d.kind.slice(0, 40) : 'missing', signature: d.signature }));
}
export function parseGraph(text) {
  if (text.length > MAX_BYTES) throw new Error('Pattern exceeds 200 KB');
  const raw = JSON.parse(text);
  if (raw.format !== 'viz2-nodes' || raw.version !== 1) throw new Error('Unsupported graph file');
  raw.dependencies = validateManifest(raw.dependencies);
  const graph = validateGraph(raw.graph);
  if (graph.nodes.some(n => n.type === 'pattern' && !raw.dependencies.some(d => d.id === n.patternId))) throw new Error('Missing required dependency manifest');
  return { graph, dependencies: raw.dependencies };
}
