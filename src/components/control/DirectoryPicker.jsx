import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Select } from './Select.jsx';

// All linked libraries share the same lifecycle, dropdown chrome and feedback.
// The caller starts listing directly in the click gesture (permission prompts).
export function DirectoryPicker({ title, label, folder, listing, open, onClose, opener, trust = false }) {
  const dialog = useRef(null);
  const id = useId();
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    let live = true;
    Promise.resolve(listing).then(items => { if (live) setFiles(items); }, e => { if (live) setError(e.message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; element.close(); opener.current?.focus(); };
  }, [listing]);
  return createPortal(<dialog ref={dialog} className="directory-picker key-map-modal-card" aria-labelledby={`${id}-title`} onCancel={onClose} onKeyDown={e => e.stopPropagation()}>
    <button className="device-setup-modal-close" aria-label="Close file picker" onClick={onClose}>×</button>
    <h2 id={`${id}-title`}>{title}</h2>
    <p className="folder-details-name">{folder}</p>
    {trust && <p className="device-setup-modal-desc">Open only trusted JavaScript — scripts run with app privileges, not in a sandbox.</p>}
    <div className="device-setup-modal-field">
      <label htmlFor={`${id}-file`}>{label} in {folder}</label>
      <Select id={`${id}-file`} value={selected} onChange={e => { setSelected(e.target.value); setError(''); }} disabled={busy} autoFocus>
        <option value="">Select a file…</option>
        {files.map(file => <option key={file.name} value={file.name} disabled={file.disabled}>{file.name}{file.disabled ? ' — opened' : ''}</option>)}
      </Select>
    </div>
    {busy && <p role="status">Reading files…</p>}
    {!busy && !error && !files.length && <p role="status">No supported files in this folder. Subfolders are not included.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="device-setup-modal-actions">
      <button className="btn btn--md" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="btn btn--md" disabled={busy || !selected} onClick={async () => {
        setBusy(true); setError('');
        try { await open(selected); onClose(); } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }}>Open</button>
    </div>
  </dialog>, document.body);
}
