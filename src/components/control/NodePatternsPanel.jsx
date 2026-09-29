import { DirectoryPicker } from './DirectoryPicker.jsx';
import { FolderControls, FolderSupportNotice, useFolderAction } from './FolderControls.jsx';
import { useEffect, useRef, useState } from 'react';
import { nodePatterns, watchGraphs } from '../../nodes/repository.js';
import { useNodeEditor } from '../../nodes/EditorHost.jsx';

export function NodePatternEdit({ sketch, locked }) {
  const { open } = useNodeEditor();
  const { busy, message, run } = useFolderAction();
  if (!sketch?.nodesGraph) return null;
  const name = sketch.name || sketch.id;
  return <div className="node-pattern-controls" onKeyDown={e => e.stopPropagation()}>
    <div className="media-manage-row">
      <button className="btn btn--md" disabled={busy || locked} title="Open this pattern in the node editor" onClick={() => open(sketch.id)}>Edit Pattern</button>
      <button className="btn btn--md btn--danger" disabled={busy || locked} title="Delete this pattern from the library; the source file is kept" aria-label="Delete Pattern" onClick={() => {
        // Same contract as script Delete: forget the library item, never the file.
        if (window.confirm(`Delete “${name}” from the library? The source file is kept on disk; use Open Pattern to restore it.`)) run(() => nodePatterns.remove(sketch.id));
      }}>Delete</button>
    </div>
    <p className="script-hint">Delete removes this pattern from the library here, not its source file.</p>
    {message && <p role="alert">{message}</p>}
  </div>;
}

export function NodePatternsPanel() {
  const { open } = useNodeEditor();
  // OPEN adds one file to the library, and that is all it does: the pattern
  // joins this category like any other and the main view stays exactly where it
  // was. The node editor is entered explicitly — ADD for a new graph, or the
  // sidebar's Edit Pattern (NodePatternEdit) for a listed one — so picking a
  // file can never take the operator off the control panel.
  const openFile = async name => {
    // The only names this panel ever passes are the linked folder's own: without
    // that link there is nothing the repository could read, save or refresh, and
    // its own no-folder fallback (the native file picker) must not be reachable
    // from here — not even when another tab unlinked the folder a moment ago.
    if (!nodePatterns.state.folder) throw new Error('Link Folder before opening a node pattern.');
    return nodePatterns.open(name);
  };
  const [picker, setPicker] = useState(null);
  const opener = useRef(null);
  const [, update] = useState(0);
  const { busy, message, run } = useFolderAction();
  useEffect(() => watchGraphs(() => update(v => v + 1)), []);
  // Both header actions are folder gestures. A new pattern only ever exists as a
  // file in the linked folder, and the repository refuses to save without one, so
  // ADD is gated on that link instead of letting a draft be drawn that has nowhere
  // to go. OPEN lists that same folder: a node pattern this library cannot save,
  // reopen or refresh — and that a project can only restore by re-linking — is
  // not a pattern it should hold, so OPEN is gated exactly like ADD. Linking never
  // lists anything; ADD and OPEN are what bring files in.
  const folderId = nodePatterns.state.folder?.id || null;
  const linked = Boolean(folderId);
  // Another tab can Unlink or Relink while this picker is open. The list it shows
  // belongs to the folder that was linked when it opened, so a folder change
  // closes it instead of letting a stale selection reach the repository.
  useEffect(() => { setPicker(null); }, [folderId]);
  return <section className="node-patterns-panel" aria-label="Node pattern files" onKeyDown={e => e.stopPropagation()}>
    <FolderControls label="Node Patterns" folder={nodePatterns.state.folder?.handle.name} busy={busy} run={run}
      link={() => nodePatterns.link()} refresh={() => nodePatterns.reconnect()} unlink={() => nodePatterns.unlink()}
      note="Unlink removes folder patterns, not source files.">
      <button className="library-add-btn" aria-label="New Node Pattern" disabled={busy || !linked}
        title={linked ? 'Create a node pattern in the editor' : 'Link Folder before creating a node pattern'} onClick={() => open()}>ADD</button>
      <button className="library-add-btn" ref={opener} aria-label="Open Pattern" disabled={busy || !linked}
        title={linked ? 'Add a node pattern file from the linked folder (does not open the editor)' : 'Link Folder before opening a node pattern'} onClick={() => setPicker(nodePatterns.browse())}>OPEN</button>
    </FolderControls>
    {picker && <DirectoryPicker title="Open Pattern" label="Pattern" folder={nodePatterns.state.folder?.handle.name} listing={picker} open={openFile} opener={opener} onClose={() => setPicker(null)} />}
    <FolderSupportNotice label="Node Patterns" />
    {!linked && <p className="script-hint">Link Folder before creating or opening a node pattern.</p>}
    {busy && <p role="status">Reading node patterns…</p>}
    {message && <p role="status">{message}</p>}
    {nodePatterns.errors.length > 0 && <div role="alert">{nodePatterns.errors.map((error, i) => <p key={i}>{error}</p>)}</div>}
  </section>;
}
