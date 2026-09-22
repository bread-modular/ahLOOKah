import { createContext, useContext, useState } from 'react';
import { useRuntime } from '../app/RuntimeContext.jsx';
import { NodesEditor } from './NodesEditor.jsx';
import { confirmDiscard } from './leave-guard.js';
import './editor-host.css';

// One editor, one session: the main view and a single node-graph editor share
// this window. There is no tab rail and no draft list to manage — New/Edit/Open
// fill the session, Back to Main clears it (NodesEditor confirms dirty drafts).
const NodeEditorContext = createContext(null);
export const useNodeEditor = () => useContext(NodeEditorContext);

const IDLE = { name: '', dirty: false, busy: false };

export function EditorHost({ children }) {
  const { runtime } = useRuntime();
  const [session, setSession] = useState(null);
  const [editor, setEditor] = useState(IDLE);
  const open = id => {
    const next = id ?? null;
    // Replacing an unsaved graph is the only silent-loss path left; the guard
    // stays defensive because main-view actions are inert behind the editor.
    if (session && session.id === next) return;
    if (session && (editor.busy || !(editor.dirty ? confirmDiscard() : true))) return;
    setEditor(IDLE);
    setSession({ id: next, key: crypto.randomUUID() });
  };
  // NodesEditor already confirmed any dirty draft before calling back.
  const back = () => { setEditor(IDLE); setSession(null); };
  return <NodeEditorContext.Provider value={{ open }}>
    <div className="app-editor-shell">
      <div className="app-editor-content">
        {/* Keep main mounted and at its original dimensions: hiding must not
            resize/reparent program canvases or transfer audio ownership. */}
        <section id="panel-main" className={`app-main-panel ${session ? 'is-inactive' : ''}`} inert={!!session} aria-hidden={!!session}>{children}</section>
        {session && <section className="app-editor-panel" aria-label="Node pattern editor">
          <NodesEditor key={session.key} graphId={session.id} sharedRuntime={runtime} onState={setEditor} onBack={back}
            onSaved={id => setSession(current => (current ? { ...current, id } : current))} />
        </section>}
      </div>
    </div>
  </NodeEditorContext.Provider>;
}
