import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { ICON_MENU } from '../common/icons.jsx';

export function AppMenu() {
  const { store } = useRuntime();
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const listRef = useRef(null);

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
        <button id="app-menu-docs" className="app-menu-item" type="button" role="menuitem" onClick={() => { close(); window.open('/docs', '_blank'); }}>Docs</button>
        <button id="app-menu-keymap" className="app-menu-item" type="button" role="menuitem" onClick={() => { close(); store.setState({ keyMapOpen: true }); }}>Key Map</button>
        <button id="app-menu-setup" className="app-menu-item" type="button" role="menuitem" onClick={() => { close(); store.setState({ setupModalOpen: true }); }}>Setup</button>
      </div>
    </div>
  );
}
