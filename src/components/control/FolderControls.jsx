import { folderReference } from '../../platform/folderReferences.js';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Shared async action state; action() runs immediately so native permission and
// picker prompts retain user activation. Cancel never changes the linked state.
export function useFolderAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const running = useRef(false);
  const run = async action => {
    if (running.current) return;
    running.current = true; setBusy(true); setMessage('');
    try { await action(); return true; }
    catch (e) { setMessage(e.name === 'AbortError' ? 'Canceled. Library unchanged.' : e.message); return false; }
    finally { running.current = false; setBusy(false); }
  };
  return { busy, message, run, setMessage };
}

function FolderDetails({ label, folder, permission, note, busy, run, link, refresh, unlink, onClose, opener }) {
  const dialog = useRef(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => { element.close(); opener.current?.focus(); };
  }, []);
  const action = fn => run(async () => {
    setError('');
    try { await fn(); } catch (e) { setError(e.message); throw e; }
  });
  return createPortal(<dialog ref={dialog} className="folder-details key-map-modal-card" aria-label={`${label} folder details`} onCancel={onClose} onKeyDown={e => e.stopPropagation()}>
    <button className="device-setup-modal-close" aria-label="Close folder details" onClick={onClose}>×</button>
    <h2>{label}</h2>
    <p className="folder-details-name">{folder}</p>
    <p className="device-setup-modal-desc">Local folder · {permission || 'Read from disk'}</p>
    <p className="device-setup-modal-desc">{note}</p>
    <p className="device-setup-modal-desc">Full paths are private. Same-name folders must be verified by you.</p>
    {error && <p role="alert">{error}</p>}
    <div className="device-setup-modal-actions">
      <button className="btn btn--md" aria-label="Refresh folder" disabled={busy} onClick={() => action(refresh)}>Refresh</button>
      <button className="btn btn--md" aria-label="Relink Folder" disabled={busy} onClick={() => action(link)}>Relink</button>
      <button className="btn btn--md btn--danger" aria-label="Unlink folder" disabled={busy} onClick={() => action(async () => { await unlink(); onClose(); })}>Unlink</button>
    </div>
  </dialog>, document.body);
}

export function FolderControls({ label, folder, permission, note, busy, run, link, refresh, unlink, children }) {
  const section = { 'Custom Scripts': 'scripts', 'Node Patterns': 'nodes', Media: 'media' }[label];
  const expected = folderReference(section)?.folderName;
  const [details, setDetails] = useState(false);
  const opener = useRef(null);
  useEffect(() => { if (!folder) setDetails(false); }, [folder]);
  return <>
    {folder && <button ref={opener} className="btn folder-linked" aria-label={`${label}: Linked`} aria-haspopup="dialog" onClick={() => setDetails(true)}>Linked</button>}
    <span className="folder-actions">
      {!folder && <button ref={opener} className="btn folder-link" disabled={busy} onClick={() => run(link)}>{expected ? 'Relink Folder' : 'Link Folder'}</button>}
      {children}
    </span>
    {details && folder && <FolderDetails {...{ label, folder, permission, note, busy, run, link, refresh, unlink, opener }} onClose={() => setDetails(false)} />}
  </>;
}
