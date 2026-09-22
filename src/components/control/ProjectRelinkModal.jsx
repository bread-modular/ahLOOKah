import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';

const REASONS = {
  missing: 'Not linked on this computer yet.',
  changed: 'This computer remembers that identity, but it now points at a different folder.',
  denied: 'Browser access was denied or has expired.',
};

// Blocking dialog for a project whose linked directories are not available on this
// computer (typically the project was saved elsewhere). There is deliberately no
// close button, no Escape and no backdrop dismissal: the project is only usable
// once every directory it names exists here, so the save completes — success
// notice, peer reload — on the last successful link. Missing *files* inside a
// linked directory never block; they are marked in the library instead.
export function ProjectRelinkModal() {
  const { runtime, store } = useRuntime();
  const state = useVizStore(store, (s) => s.projectRelink);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  if (!state) return null;

  const pending = Array.isArray(state.pending) ? state.pending : [];
  const run = async (section, reconnect) => {
    if (busy) return;
    setBusy(section);
    setError('');
    try {
      await (reconnect
        ? runtime.commands.reconnectProjectFolder(section)
        : runtime.commands.linkProjectFolder(section));
    } catch (e) {
      setError(e?.name === 'AbortError'
        ? 'Canceled — the project still needs that directory.'
        : (e?.message || 'That folder could not be linked.'));
    } finally {
      setBusy('');
    }
  };

  return createPortal(
    <div
      id="project-relink-modal"
      className="notice-modal notice-modal--error"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="project-relink-title"
    >
      <div className="notice-modal-card">
        <div className="notice-modal-head">
          <span className="notice-modal-icon" aria-hidden="true">!</span>
          <h2 id="project-relink-title">Link this project’s directories</h2>
        </div>
        <p className="notice-modal-message">
          {state.fileName} was loaded into this browser, but these linked directories are not
          available on this computer. Link each one to finish opening the project.
        </p>
        <ul className="project-relink-list">
          {pending.map((item) => (
            <li key={item.section} className="project-relink-item" data-section={item.section}>
              <div className="project-relink-info">
                <strong>{item.label}</strong>
                <span className="project-relink-folder">Expected folder: {item.folderName}</span>
                <span className="project-relink-reason">{REASONS[item.reason] || REASONS.missing}</span>
              </div>
              <div className="project-relink-actions">
                {item.reason === 'denied' && (
                  <button
                    id={`project-relink-reconnect-${item.section}`}
                    className="btn btn--md"
                    type="button"
                    disabled={Boolean(busy)}
                    title={`Renew browser access to “${item.folderName}” without re-picking it`}
                    onClick={() => run(item.section, true)}
                  >Reconnect</button>
                )}
                <button
                  id={`project-relink-link-${item.section}`}
                  className="btn btn--md btn--solid"
                  type="button"
                  disabled={Boolean(busy)}
                  title={`Select “${item.folderName}” on this computer`}
                  onClick={() => run(item.section, false)}
                >Link Folder</button>
              </div>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="project-relink-error">{error}</p>}
        <p className="notice-modal-note">
          Opening a project completes when every directory above is linked. Missing files inside a
          linked folder never block it — those patterns are marked red in the library.
        </p>
      </div>
    </div>,
    document.body,
  );
}
