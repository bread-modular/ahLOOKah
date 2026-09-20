import { listGraphs } from './repository.js';
import { graphFactory } from './runtime.js';
export function registerNodeSketches(sketches) {
  for (const record of listGraphs()) {
    // A revision's ID is never reused. Keep already-selected revisions alive
    // even if local storage is cleared in a different tab.
    if (sketches.some(s => s.id === record.id)) continue;
    sketches.push({ id: record.id, name: `${record.graph.name} · ${record.id.slice(-6)}`, group: 'Node Graphs',
      nodesGraph: true, params: [], factory: graphFactory(record, sketches), graphRecord: record });
  }
}
