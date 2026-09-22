import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { ICON_MENU } from '../common/icons.jsx';

export function AppMenu() {
  const { runtime, store } = useRuntime();
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const openInputRef = useRef(null);

  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (!listRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.code === 'Escape') close();
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="app-menu">
      <button
        id="app-menu-btn"
        ref={btnRef}
        className="app-menu-btn"
        type="button"
        aria-label="Menu"
        aria-haspopup="true"
        aria-expanded={String(open)}
        title="Menu"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        {ICON_MENU}
      </button>
      <div id="app-menu-list" ref={listRef} className="app-menu-list" role="menu" hidden={!open}>
        <a id="app-menu-docs" className="app-menu-item" role="menuitem" href="/docs" target="_blank" rel="noopener" onClick={close}>Docs</a>
        <button id="app-menu-keymap" className="app-menu-item" type="button" role="menuitem" onClick={() => { close(); store.setState({ keyMapOpen: true }); }}>Key Map</button>
        <button id="app-menu-setup" className="app-menu-item" type="button" role="menuitem" onClick={() => { close(); store.setState({ setupModalOpen: true }); }}>Setup</button>
        <button
          id="app-menu-save-project"
          className="app-menu-item"
          type="button"
          role="menuitem"
          title="Write this project to a file — every saved setting plus the identities of its linked Scripts, Node Patterns and Media directories"
          onClick={() => { close(); runtime.commands.saveProject(); }}
        >Save Project</button>
        <button
          id="app-menu-open-project"
          className="app-menu-item"
          type="button"
          role="menuitem"
          title="Open a saved project file in this browser; already-linked directories resume without relinking"
          onClick={() => { close(); openInputRef.current?.click(); }}
        >Open Project</button>
        <button
          id="app-menu-new-project"
          className="app-menu-item"
          type="button"
          role="menuitem"
          title="Clear every saved setting, media pattern and linked directory in this browser and start fresh"
          onClick={() => { close(); runtime.commands.newProject(); }}
        >New Project</button>
        {/* Hidden file input: the project picker is a plain <input type="file">
            so it works in every browser (the FS Access picker is only used for
            media files and for Save Project). */}
        <input
          id="project-open-input"
          ref={openInputRef}
          className="project-open-input"
          type="file"
          accept=".json,application/json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) await runtime.commands.openProject(file);
          }}
        />
      </div>
    </div>
  );
}
