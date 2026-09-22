import { NODE_PATTERNS_GROUP } from './routes.js';
import { listGraphs } from './repository.js';
import { graphFactory } from './runtime.js';
export function registerNodeSketches(sketches) {
  const records = listGraphs(), changed = new Set();
  const previous = sketches.filter(s => s.nodesGraph);
  for (const old of previous) if (!records.some(r => r.id === old.id && r.hash === old.graphRecord.hash)) changed.add(old.id);
  const next = records.map(record => {
    const old = previous.find(s => s.id === record.id && s.graphRecord.hash === record.hash);
    if (old) return old;
    changed.add(record.id);
    return { id: record.id, name: record.graph.name, group: NODE_PATTERNS_GROUP,
      nodesGraph: true, params: [], factory: graphFactory(record, sketches), graphRecord: record };
  });
  sketches.splice(0, sketches.length, ...sketches.filter(s => !s.nodesGraph), ...next);
  return changed;
}
