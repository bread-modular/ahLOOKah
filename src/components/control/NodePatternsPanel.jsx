import { useEffect, useState } from 'react';
import { nodePatterns, watchGraphs } from '../../nodes/repository.js';
import { nodeEditorUrl } from '../../nodes/routes.js';

export function NodePatternEdit({ sketch }) {
  if (!sketch?.nodesGraph) return null;
  return <div className="media-manage-row">
    <a className="btn btn--md" href={nodeEditorUrl(sketch.id)} target="_blank" rel="noopener">Edit Pattern ↗</a>
  </div>;
}

export function NodePatternsPanel() {
  const [, update] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => watchGraphs(() => update(v => v + 1)), []);
  const run = async action => {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await action(); }
    catch (e) { setMessage(e.name === 'AbortError' ? 'Canceled. Library unchanged.' : e.message); }
    finally { setBusy(false); }
  };
  return <section className="node-patterns-panel" aria-label="Node pattern files" onKeyDown={e => e.stopPropagation()}>
    <p className="script-hint">{nodePatterns.state.folder?.handle.name || 'No folder linked'} · Disk-authoritative .nodes.json patterns</p>
    <div className="script-folder-row">
      <button className="btn btn--md" disabled={busy} onClick={() => run(async () => { await nodePatterns.link(); setMessage('Linked node patterns folder.'); })}>Link Folder</button>
      <button className="btn btn--md" disabled={busy} onClick={() => run(async () => { const record = await nodePatterns.open(); setMessage(`Opened ${record.fileName}. Select its pattern to edit.`); })}>Open Pattern</button>
      <button className="btn btn--md" disabled={busy} onClick={() => run(async () => { await nodePatterns.reconnect(); setMessage('Library refreshed from disk.'); })}>Refresh folder</button>
    </div>
    <a className="btn btn--md" href={nodeEditorUrl()} target="_blank" rel="noopener">New Node Pattern ↗</a>
    <p className="script-hint">Select a pattern, then Edit Pattern in the sidebar. New graphs save into the linked folder.</p>
    {busy && <p role="status">Reading node patterns…</p>}
    {message && <p role="status">{message}</p>}
    {nodePatterns.errors.length > 0 && <div role="alert">{nodePatterns.errors.map((error, i) => <p key={i}>{error}</p>)}</div>}
  </section>;
}
