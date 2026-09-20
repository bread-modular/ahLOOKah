import { IconControl } from './IconControl.jsx';
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
    <div className="script-folder-row">
      {nodePatterns.state.folder ? <>
        <span className="script-folder-name" title={nodePatterns.state.folder.handle.name}>{nodePatterns.state.folder.handle.name}</span>
        <IconControl icon="unlink" label="Unlink node patterns folder" title="Unlink node patterns folder; source files are kept" disabled={busy} onClick={() => run(() => nodePatterns.unlink())} />
      </> : <button className="btn btn--md" title="Link a local node patterns folder" disabled={busy} onClick={() => run(() => nodePatterns.link())}>Link Folder</button>}
      <IconControl icon="add" label="New Node Pattern" title="Create a node pattern in a new editor tab" href={nodeEditorUrl()} target="_blank" rel="noopener" />
      <IconControl icon="open" label="Open Pattern" title="Open a node pattern file" disabled={busy} onClick={() => run(() => nodePatterns.open())} />
      <IconControl icon="reload" label="Refresh folder" title="Reload node patterns from disk and renew folder access" disabled={busy} onClick={() => run(() => nodePatterns.reconnect())} />
    </div>
    {busy && <p role="status">Reading node patterns…</p>}
    {message && <p role="status">{message}</p>}
    {nodePatterns.errors.length > 0 && <div role="alert">{nodePatterns.errors.map((error, i) => <p key={i}>{error}</p>)}</div>}
  </section>;
}
