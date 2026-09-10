import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { ICON_MENU } from '../common/icons.jsx';

export function AppMenu() {
  const { runtime, store } = useRuntime();
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const importInputRef = useRef(null);

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
          id="app-menu-export-settings"
          className="app-menu-item"
          type="button"
          role="menuitem"
          title="Download all saved settings (and media file references) as a JSON file"
          onClick={() => { close(); runtime.commands.exportSettings(); }}
        >Export Settings</button>
        <button
          id="app-menu-import-settings"
          className="app-menu-item"
          type="button"
          role="menuitem"
          title="Restore settings from an ahLOOKah settings file"
          onClick={() => { close(); importInputRef.current?.click(); }}
        >Import Settings</button>
        {/* Hidden file input: the import picker is a plain <input type="file">
            so it works in every browser (the FS Access picker is only used for
            media files). */}
        <input
          id="settings-import-input"
          ref={importInputRef}
          className="settings-import-input"
          type="file"
          accept=".json,application/json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) await runtime.commands.importSettings(file);
          }}
        />
      </div>
    </div>
  );
}
