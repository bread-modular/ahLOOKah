import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useRuntime } from '../app/RuntimeContext.jsx';
import { NodesEditor } from './NodesEditor.jsx';
import { nodePatterns } from './repository.js';
import './editor-tabs.css';

const EditorTabsContext = createContext(null);
export const useEditorTabs = () => useContext(EditorTabsContext);

function EditorPanel({ tab, active, runtime, update, saved, beforeSave }) {
  const onState = useCallback(state => update(tab.key, state), [tab.key, update]);
  const onSaved = useCallback(id => saved(tab.key, id), [tab.key, saved]);
  return <section id={`panel-${tab.key}`} role="tabpanel" aria-labelledby={`tab-${tab.key}`}
    className="app-tab-panel" hidden={!active} onKeyDown={e => e.stopPropagation()}>
    <NodesEditor graphId={tab.initialId} sharedRuntime={runtime} active={active}
      onState={onState} onSaved={onSaved} beforeSave={beforeSave} />
  </section>;
}

export function EditorTabs({ children }) {
  const { runtime } = useRuntime();
  const [tabs, setTabs] = useState([]);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const [active, setActive] = useState('main');
  const update = useCallback((key, patch) => {
    setTabs(tabs => tabs.map(tab => tab.key === key ? { ...tab, ...patch } : tab));
  }, []);
  const saved = useCallback((key, id) => update(key, { graphId: id, dirty: false }), [update]);
  const open = (id = null) => {
    const existing = id && tabsRef.current.find(tab => tab.graphId === id);
    if (existing) { setActive(existing.key); return; }
    const key = crypto.randomUUID();
    const tab = { key, initialId: id, graphId: id, name: 'New graph', dirty: false, busy: false };
    tabsRef.current = [...tabsRef.current, tab];
    setTabs(tabsRef.current); setActive(key);
  };
  const close = tab => {
    if (tab.busy || (tab.dirty && !window.confirm(`Discard unsaved changes to “${tab.name}”?`))) return;
    setTabs(tabs => tabs.filter(t => t.key !== tab.key));
    if (active === tab.key) setActive('main');
  };
  // Do not let a new draft overwrite a graph with a different open draft.
  // The repository still performs its own disk conflict/permission checks.
  const beforeSave = (graph, current) => {
    const fileName = current?.folderId === nodePatterns.state.folder?.id ? current.fileName
      : (graph.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'pattern') + '.nodes.json';
    const destination = nodePatterns.records.find(r => r.folderId === nodePatterns.state.folder?.id && r.fileName === fileName);
    if (destination && tabsRef.current.some(t => t.key !== active && t.graphId === destination.id)) {
      throw new Error('This destination already has an open editor. Close that editor or choose a different name; both drafts are retained.');
    }
  };
  const keyNav = e => {
    const buttons = [...e.currentTarget.querySelectorAll('[role="tab"]')];
    const index = buttons.indexOf(e.target);
    if (index < 0) return;
    let next;
    if (e.key === 'ArrowDown') next = (index + 1) % buttons.length;
    if (e.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = buttons.length - 1;
    if (next !== undefined) { e.preventDefault(); buttons[next].focus(); buttons[next].click(); }
  };
  return <EditorTabsContext.Provider value={{ open }}>
    <div className="app-tabs-shell">
      <div className="app-tabs-content">
        {/* Keep main mounted and at its original dimensions: hiding must not
            resize/reparent program canvases or transfer audio ownership. */}
        <section id="panel-main" role="tabpanel" aria-labelledby="tab-main" className={`app-main-panel ${active !== 'main' ? 'is-inactive' : ''}`} inert={active !== 'main'} aria-hidden={active !== 'main'}>{children}</section>
        {tabs.map(tab => <EditorPanel key={tab.key} tab={tab} active={active === tab.key} runtime={runtime} update={update} saved={saved} beforeSave={beforeSave} />)}
      </div>
      <aside className="app-tabs-rail" aria-label="Workspace tabs" onKeyDown={e => e.stopPropagation()}>
        <div role="tablist" aria-label="App views" aria-orientation="vertical" onKeyDown={keyNav}>
          <button id="tab-main" role="tab" className="btn" aria-controls="panel-main" aria-selected={active === 'main'} tabIndex={active === 'main' ? 0 : -1} onClick={() => setActive('main')}>Main</button>
          {tabs.map(tab => <div className="app-tab-row" key={tab.key}>
            <button id={`tab-${tab.key}`} role="tab" className="btn" aria-controls={`panel-${tab.key}`} aria-selected={active === tab.key} tabIndex={active === tab.key ? 0 : -1} title={tab.name} onClick={() => setActive(tab.key)}>{tab.name}{tab.dirty ? ' •' : ''}</button>
            <button className="btn app-tab-close" aria-label={`Close ${tab.name}`} disabled={tab.busy} onClick={() => close(tab)}>×</button>
          </div>)}
        </div>
        <button className="btn" onClick={() => open()}>+ New graph</button>
      </aside>
    </div>
  </EditorTabsContext.Provider>;
}
