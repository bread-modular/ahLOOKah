import { FolderControls, useFolderAction } from './FolderControls.jsx';
import { IconControl } from './IconControl.jsx';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';

function ScriptPicker({ scripts, status, onClose, opener }) {
  const dialog = useRef(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => { element.close(); opener.current?.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="script-picker key-map-modal-card" aria-labelledby="script-picker-title"
    aria-describedby="script-picker-trust" onCancel={onClose} onKeyDown={(e) => e.stopPropagation()}>
    <button className="device-setup-modal-close" aria-label="Close script picker" title="Close script picker" onClick={onClose}>×</button>
    <h2 id="script-picker-title">Open Script</h2>
    <p id="script-picker-trust" className="device-setup-modal-desc">Only open JavaScript you trust. Scripts run with app privileges, not in a sandbox. Selecting a file here does not execute it.</p>
    <div className="device-setup-modal-field">
      <label htmlFor="script-file">Script in {status.folder}</label>
      <select className="control-select" id="script-file" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={status.busy} autoFocus>
        <option value="">Select a .viz.js file…</option>
        {status.files.map((file) => <option key={file} value={file} disabled={status.opened?.includes(file)}>{file}{status.opened?.includes(file) ? ' — opened' : ''}</option>)}
      </select>
    </div>
    {!status.files.length && <p>No .viz.js files found. Save a script in this folder using your editor, then reopen this dialog.</p>}
    {error && <p role="alert">{error} Last-good patterns remain active.</p>}
    <div className="device-setup-modal-actions">
      <button className="btn btn--md" onClick={onClose}>Cancel</button>
      <button className="btn btn--md" disabled={!selected || status.busy} onClick={async () => {
        setError('');
        try { await scripts.open(selected); onClose(); } catch (e) { setError(e.message); }
      }}>Open</button>
    </div>
  </dialog>, document.body);
}

export function CustomScriptsPanel() {
  const { runtime, store } = useRuntime();
  const status = useVizStore(store, (s) => s.customScripts) || runtime.customScripts.status;
  const { busy, message, run, setMessage } = useFolderAction();
  const [picker, setPicker] = useState(false);
  const openButton = useRef(null);
  const scripts = runtime.customScripts;
  // Permission prompts must originate directly from the button's user gesture.
  const withAccess = async (action) => {
    if (status.permission !== 'granted') await scripts.reconnect();
    return action();
  };
  return <div className="custom-scripts-panel" onKeyDown={(e) => e.stopPropagation()}>
    <FolderControls label="Custom Scripts" folder={status.folder} permission={status.permission} busy={busy || status.busy} run={run}
      link={() => scripts.choose()} refresh={() => withAccess(() => scripts.reload())} unlink={() => scripts.unlink()}
      note="Only selected .viz.js scripts run. Unlink removes their loaded patterns, not source files.">
      <IconControl icon="add" label="New Script" disabled={busy || status.busy || !status.folder} onClick={() => {
        const name = window.prompt('New script filename', 'new-script.viz.js');
        if (name?.trim()) run(async () => { await scripts.create(name.trim()); setMessage('Script created. Edit it in your editor, then Open Script.'); });
      }} />
      <IconControl ref={openButton} icon="open" label="Open Script" title="Choose a trusted script from the linked folder" disabled={busy || status.busy || !status.folder} onClick={() => run(() => withAccess(async () => { await scripts.browse(); setPicker(true); }))} />
    </FolderControls>
    <a className="script-tutorial" href="/docs/custom-scripts.html" target="_blank" rel="noreferrer">Tutorial &amp; API</a>
    {status.support && <p role="alert">{status.support}</p>}
    {status.busy && <p role="status">Reading / validating selected scripts…</p>}
    {message && <p role="status">{message}</p>}
    {status.errors.length > 0 && <div role="alert">{status.errors.map((error) => <p key={error}>{error}</p>)}<p>Fix the named file and retry. Validation failures keep last-good patterns.</p></div>}
    {picker && status.folder && <ScriptPicker opener={openButton} scripts={scripts} status={status} onClose={() => setPicker(false)} />}
  </div>;
}

export function ScriptFileControls({ file, locked }) {
  const { runtime, store } = useRuntime();
  const scripts = runtime.customScripts;
  const status = useVizStore(store, (s) => s.customScripts) || scripts.status;
  const [error, setError] = useState('');
  const run = async (action) => { setError(''); try { await action(); } catch (e) { setError(e.message); } };
  return <div className="script-file-controls" onKeyDown={(e) => e.stopPropagation()}>
    <p className="script-hint" title={file}>{file}</p>
    <div className="media-manage-row">
      <button className="btn btn--md" disabled={locked || status.busy} title={`Reload only ${file}`} onClick={() => run(async () => {
        if (status.permission !== 'granted') await scripts.reconnect();
        await scripts.reload(file);
      })}>Reload</button>
      <button className="btn btn--md btn--danger" disabled={locked || status.busy} title="Delete loaded script and all its patterns from the library; source file is kept" onClick={() => {
        if (window.confirm(`Delete "${file}" from the library and remove all its patterns? The source file is kept on disk.`)) run(() => scripts.remove(file));
      }}>Delete</button>
    </div>
    <p className="script-hint">Delete removes this script’s loaded patterns, not its source file.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
