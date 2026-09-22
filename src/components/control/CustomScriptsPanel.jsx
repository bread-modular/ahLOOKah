import { folderReference } from '../../platform/folderReferences.js';
import { FolderControls, useFolderAction } from './FolderControls.jsx';
import { DirectoryPicker } from './DirectoryPicker.jsx';
import { useRef, useState } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';

export function CustomScriptsPanel() {
  const { runtime, store } = useRuntime();
  const status = useVizStore(store, (s) => s.customScripts) || runtime.customScripts.status;
  const { busy, message, run } = useFolderAction();
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
      note="Unlink removes loaded scripts, not source files.">
      <button className="library-add-btn" ref={openButton} aria-label="Open Script" title="Choose a trusted script from the linked folder" disabled={busy || status.busy || !status.folder} onClick={() => setPicker(withAccess(async () => { await scripts.browse(); return scripts.status.files.map(name => ({ name, disabled: scripts.status.opened.includes(name) })); }))}>OPEN</button>
    </FolderControls>
    {(folderReference('scripts')?.files || []).filter(file => !status.opened.includes(file.fileName)).map(file => <p className="script-hint" key={file.fileName}>Open trusted script: {file.fileName}</p>)}
    {status.support && <p role="alert">{status.support}</p>}
    {status.busy && <p role="status">Reading / validating selected scripts…</p>}
    {message && <p role="status">{message}</p>}
    {status.errors.length > 0 && <div role="alert">{status.errors.map((error) => <p key={error}>{error}</p>)}<p>Fix the named file and retry. Validation failures keep last-good patterns.</p></div>}
    {picker && status.folder && <DirectoryPicker title="Open Script" label="Script" trust folder={status.folder} listing={picker} open={name => scripts.open(name)} opener={openButton} onClose={() => setPicker(false)} />}
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
