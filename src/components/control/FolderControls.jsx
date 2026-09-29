import { folderSupportInfo } from '../../platform/folderAccess.js';
import { folderReference } from '../../platform/folderReferences.js';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The one place the Brave flag URL can be offered. A web page cannot navigate
// Chromium to a `brave://` URL, so the URL is shown as selectable text and "Copy link"
// is the only action offered for it: no Try-to-open control exists, because it could
// only fail. Nothing here is opened automatically — the modal exists only behind a
// click on "How to fix" or on Link Folder, both of which a user has to make.
export function FolderSupportModal({ label, support, opener, onClose }) {
  const dialog = useRef(null);
  const id = useId();
  const [copy, setCopy] = useState('idle');
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => { element.close(); opener.current?.focus(); };
  }, []);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(support.flagUrl);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  // One action row for every cause: the copyable flag (Brave only) sits beside the
  // single Close button, so the modal never offers an action the browser cannot
  // honour and Close is never a second, duplicated row.
  return createPortal(<dialog ref={dialog} className="folder-support key-map-modal-card" aria-labelledby={`${id}-title`} onCancel={onClose} onKeyDown={e => e.stopPropagation()}>
    <button className="device-setup-modal-close" aria-label="Close folder support" onClick={onClose}>×</button>
    <h2 id={`${id}-title`}>{label} unavailable</h2>
    <p className="device-setup-modal-desc">{support.message}</p>
    {support.flagUrl && <p className="device-setup-modal-desc">{support.flagUrl}</p>}
    <div className="device-setup-modal-actions">
      {support.flagUrl && <button className="btn btn--md" disabled={copy === 'copied'} onClick={copyLink}>{copy === 'copied' ? 'Copied' : 'Copy link'}</button>}
      <button className="btn btn--md" onClick={onClose}>Close</button>
    </div>
    {support.flagUrl && copy === 'failed' && <p role="status">Copy failed — select the link above and copy it manually.</p>}
  </dialog>, document.body);
}

// One shared support notice for every folder category. Capability is a pure function
// of the browser, so it is known on load and belongs beside the controls — never only
// in the message a doomed Link Folder click produces. One short actionable sentence
// plus a compact "How to fix" affordance: the guidance (and the Brave flag link) is
// one click away instead of being a paragraph in the header.
export function FolderSupportNotice({ label }) {
  const support = folderSupportInfo(label);
  const [open, setOpen] = useState(false);
  const opener = useRef(null);
  if (!support) return null;
  return <>
    <div className="folder-support-notice" role="alert">
      <span className="script-hint">{support.message}</span>
      <button ref={opener} className="library-add-btn" aria-haspopup="dialog" onClick={() => setOpen(true)}>How to fix</button>
    </div>
    {open && <FolderSupportModal label={label} support={support} opener={opener} onClose={() => setOpen(false)} />}
  </>;
}

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
  const [support, setSupport] = useState(null);
  const opener = useRef(null);
  useEffect(() => { if (!folder) setDetails(false); }, [folder]);
  return <>
    {folder && <button ref={opener} className="btn folder-linked" aria-label={`${label}: Linked`} aria-haspopup="dialog" onClick={() => setDetails(true)}>Linked</button>}
    <span className="folder-actions">
      {!folder && <button ref={opener} className="btn folder-link" disabled={busy} onClick={() => {
        // A missing picker is a capability, not a failed pick, so the click checks at
        // click time (the browser can change under a rendered panel) and answers with
        // the same instructions the notice offers instead of running a doomed link().
        const missing = folderSupportInfo(label);
        if (missing) setSupport(missing); else run(link);
      }}>{expected ? 'Relink Folder' : 'Link Folder'}</button>}
      {children}
    </span>
    {support && <FolderSupportModal label={label} support={support} opener={opener} onClose={() => setSupport(null)} />}
    {details && folder && <FolderDetails {...{ label, folder, permission, note, busy, run, link, refresh, unlink, opener }} onClose={() => setDetails(false)} />}
  </>;
}
