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
export function manifestFor(graph, sketches) {
  const found = new Map();
  function add(id) {
    if (found.has(id)) return;
    const s = sketches.find(s => s.id === id);
    if (!s) { found.set(id, { id, kind: 'missing', signature: null }); return; }
    if (s.nodesGraph || id.startsWith('nodes-')) throw new Error('Recursive graph dependency is not supported');
    found.set(id, { id, name: s.name, kind: s.media ? 'local-media' : s.projection ? 'projection' : s.customScript ? 'custom-script' : 'built-in', signature: dependencySignature(s) });
    s.surfaces?.forEach(surface => add(surface.patternId));
  }
  graph.nodes.filter(n => n.type === 'pattern').forEach(n => add(n.patternId));
  return [...found.values()];
}
export function sourceDiagnostics(graph, sketches, manifest = []) {
  const messages = mappingDiagnostics(graph, sketches);
  for (const n of graph.nodes.filter(n => n.type === 'pattern')) {
    const s = sketches.find(s => s.id === n.patternId);
    if (!s) { messages.push(`Missing pattern: ${n.patternId}`); continue; }
    for (const surface of s.surfaces || []) {
      const child = sketches.find(x => x.id === surface.patternId);
      if (!child) messages.push(`Missing projection source: ${surface.patternId}`);
      else if (child.projection || child.nodesGraph) messages.push('Nested composite sources are not supported');
    }
    if (s.nodesGraph || s.surfaces?.some(x => x.patternId.startsWith('nodes-'))) messages.push('Recursive graph dependency is not supported');
    for (const [key, value] of Object.entries(n.params)) {
      const def = s.params?.find(d => d.key === key);
      if (!def || value < def.min || value > def.max) messages.push(`Invalid ${s.name} parameter: ${key}`);
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
    if (!result.ok) messages.push(`Invalid script on ${n.id}: ${result.error}`);
  }
  for (const dep of manifest) {
    const s = sketches.find(s => s.id === dep.id);
    if (!s) messages.push(`Missing dependency: ${dep.name || dep.id}`);
    else if (dep.signature && dep.signature !== dependencySignature(s)) messages.push(`Changed dependency: ${dep.name || dep.id}; restore it or explicitly refresh dependencies`);
  }
  return [...new Set(messages)];
}
export function serializeGraph(graph, dependencies) {
  return JSON.stringify({ format: 'viz2-nodes', version: 1, graph: validateGraph(graph), dependencies,
    portability: 'Local media files/permissions and matching custom scripts/projection definitions are required on the destination. No files or executable code are embedded.' }, null, 2);
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
