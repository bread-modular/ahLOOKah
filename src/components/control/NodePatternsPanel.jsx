import { DirectoryPicker } from './DirectoryPicker.jsx';
import { FolderControls, useFolderAction } from './FolderControls.jsx';
import { useEffect, useRef, useState } from 'react';
import { nodePatterns, watchGraphs } from '../../nodes/repository.js';
import { useNodeEditor } from '../../nodes/EditorHost.jsx';

export function NodePatternEdit({ sketch }) {
  const { open } = useNodeEditor();
  if (!sketch?.nodesGraph) return null;
  return <div className="media-manage-row">
    <button className="btn btn--md" onClick={() => open(sketch.id)}>Edit Pattern</button>
  </div>;
}

export function NodePatternsPanel() {
  const { open } = useNodeEditor();
  const openFile = async name => { const record = await nodePatterns.open(name); open(record.id); return record; };
  const [picker, setPicker] = useState(null);
  const opener = useRef(null);
  const [, update] = useState(0);
  const { busy, message, run } = useFolderAction();
  useEffect(() => watchGraphs(() => update(v => v + 1)), []);
  return <section className="node-patterns-panel" aria-label="Node pattern files" onKeyDown={e => e.stopPropagation()}>
    <FolderControls label="Node Patterns" folder={nodePatterns.state.folder?.handle.name} busy={busy} run={run}
      link={() => nodePatterns.link()} refresh={() => nodePatterns.reconnect()} unlink={() => nodePatterns.unlink()}
      note="Unlink removes folder patterns, not source files.">
      <button className="library-add-btn" aria-label="New Node Pattern" title="Create a node pattern in the editor" onClick={() => open()}>ADD</button>
      <button className="library-add-btn" ref={opener} aria-label="Open Pattern" title="Open a node pattern file" disabled={busy} onClick={() => nodePatterns.state.folder ? setPicker(nodePatterns.browse()) : run(() => openFile())}>OPEN</button>
    </FolderControls>
    {picker && <DirectoryPicker title="Open Pattern" label="Pattern" folder={nodePatterns.state.folder?.handle.name} listing={picker} open={openFile} opener={opener} onClose={() => setPicker(null)} />}
    {busy && <p role="status">Reading node patterns…</p>}
    {message && <p role="status">{message}</p>}
    {nodePatterns.errors.length > 0 && <div role="alert">{nodePatterns.errors.map((error, i) => <p key={i}>{error}</p>)}</div>}
  </section>;
}
