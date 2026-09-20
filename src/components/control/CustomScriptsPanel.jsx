import { useState } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';

export function CustomScriptsPanel() {
  const { runtime, store } = useRuntime();
  const status = useVizStore(store, (s) => s.customScripts) || runtime.customScripts.status;
  const [message, setMessage] = useState('');
  const scripts = runtime.customScripts;
  const run = async (action) => {
    setMessage('');
    try { await action(); }
    catch (e) { if (e.name !== 'AbortError') setMessage(e.message); }
  };
  return <div className="custom-scripts-panel" onKeyDown={(e) => e.stopPropagation()}>
    <p><strong>Trusted JavaScript — NOT a security sandbox.</strong> Only load code you trust. Reload cancels CUE/TAKE and restarts affected output.</p>
    <p>{status.folder ? `Folder: ${status.folder} · ${status.permission}` : 'Choose a real local folder for your scripts.'}</p>
    {status.support && <p role="alert">{status.support}</p>}
    <div className="custom-scripts-actions">
      <button disabled={status.busy || !!status.support} onClick={() => {
        if (window.confirm('Trust JavaScript in this folder? Scripts run with the application’s privileges, not in a sandbox.')) run(() => scripts.choose());
      }}>Choose folder</button>
      <button disabled={status.busy || !status.folder || !!status.support} onClick={() => run(() => scripts.reconnect())}>Reconnect</button>
      <button disabled={status.busy || !status.folder} onClick={() => {
        const name = window.prompt('New custom pattern name');
        if (name?.trim()) run(() => scripts.create(name.trim()));
      }}>Create script</button>
      <button disabled={status.busy || !status.folder} onClick={() => run(() => scripts.reload())}>Reload</button>
    </div>
    <p>Open this folder in your editor or coding agent, edit <code>*.viz.js</code>, save, then Reload. No file watcher or browser editor. <a href="/docs/custom-scripts.html" target="_blank" rel="noreferrer">Tutorial &amp; API</a></p>
    {status.busy && <p role="status">Reading / validating scripts…</p>}
    {(message || status.errors.length > 0) && <div role="alert">
      {message && <p>{message}</p>}
      {status.errors.map((error) => <p key={error}>{error}</p>)}
      <p>Fix the named file and Reload. Syntax/definition failures retain the entire last-good registry.</p>
    </div>}
    <ul>{status.files.map((file) => <li key={file}>
      <code>{file}</code>
      <div className="custom-scripts-actions">
        <button disabled={status.busy} onClick={() => setMessage(`Edit ${status.folder}/${file} in your external editor or coding agent. Save, then click Reload. Chrome does not expose its absolute path.`)}>Edit guidance</button>
        <button disabled={status.busy || !scripts.active.sources.some((s) => s.name === file)} onClick={() => run(() => scripts.remove(file))}>Remove registrations</button>
        <button disabled={status.busy} onClick={() => {
          if (window.confirm(`Permanently delete ${status.folder}/${file} from disk and remove ALL its patterns? This cannot be undone. External edits will also be deleted.`)) run(() => scripts.deleteFile(file, true));
        }}>Delete file…</button>
      </div>
    </li>)}</ul>
  </div>;
}
