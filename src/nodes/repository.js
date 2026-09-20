import { validateManifest } from './portability.js';
import { validateGraph, MAX_BYTES } from './model.js';
import { createBroadcastBus } from '../platform/BroadcastBus.js';
export const PREFIX = 'viz2_nodes_v1:';
export const CHANNEL = 'viz2-nodes-library';
// One immutable record per save: no lost read/modify/write race between tabs,
// and selection IDs themselves pin revisions in LIVE, CUE, pads and reloads.
export function listGraphs() {
  const records = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.startsWith(PREFIX)) continue;
      try {
        const text = localStorage.getItem(key);
        if (text.length > MAX_BYTES) continue;
        const record = JSON.parse(text);
        if (!/^nodes-[a-f0-9-]{36}$/.test(record.id) || key !== PREFIX + record.id) continue;
        records.push({ ...record, dependencies: validateManifest(record.dependencies), graph: validateGraph(record.graph, { complete: true }) });
      } catch { /* Isolate corrupt records. */ }
    }
  } catch { /* Storage disabled: editor still works, Save reports the error. */ }
  return records.slice(0, 64).sort((a, b) => a.id.localeCompare(b.id));
}
export function saveGraph(graph, dependencies) {
  const clean = validateGraph(graph, { complete: true });
  if (listGraphs().length >= 64) throw new Error('Library is full (64 immutable revisions). Export and remove old revisions first.');
  dependencies = validateManifest(dependencies);
  const record = { id: `nodes-${crypto.randomUUID()}`, graph: clean, dependencies };
  const text = JSON.stringify(record);
  if (text.length > MAX_BYTES) throw new Error('Graph and dependency manifest exceed 200 KB');
  localStorage.setItem(PREFIX + record.id, text);
  const bus = createBroadcastBus(CHANNEL, { windowId: crypto.randomUUID(), handleMessage() {} });
  bus.post({ type: 'changed' }); bus.close();
  window.dispatchEvent(new Event('nodes-library-changed'));
  return record;
}
export function watchGraphs(listener) {
  const bus = createBroadcastBus(CHANNEL, { windowId: crypto.randomUUID(), handleMessage: m => { if (m.type === 'changed') listener(); } });
  const onStorage = e => { if (e.key === null || e.key?.startsWith(PREFIX)) listener(); };
  window.addEventListener('storage', onStorage);
  window.addEventListener('nodes-library-changed', listener);
  return () => { bus.close(); window.removeEventListener('storage', onStorage); window.removeEventListener('nodes-library-changed', listener); };
}
