// Routes carry only repository IDs, never graph content or filenames. Handles
// are shared through IndexedDB; each editor reads the selected graph from disk.
export const NODE_PATTERNS_GROUP = 'Node Patterns';
export function nodeEditorUrl(id) {
  const query = new URLSearchParams({ role: 'nodes' });
  if (id !== undefined) query.set('graph', id);
  return `/?${query}`;
}
