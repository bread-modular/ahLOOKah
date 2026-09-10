import { createPortal } from 'react-dom';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';

// Small result dialog for one-shot operations that need the operator's
// attention (currently: settings import). Unlike window.alert it is styled like
// the rest of the UI, distinguishes success from failure, can list the media
// files that still need re-linking, and — critically — only reloads the app
// when the operator acknowledges it, so the imported settings are never
// silently applied behind a dismissable native dialog.
export function NoticeModal() {
  const { store } = useRuntime();
  const notice = useVizStore(store, (s) => s.notice);
  if (!notice) return null;

  const details = Array.isArray(notice.details) ? notice.details : [];
  const items = Array.isArray(notice.items) ? notice.items : [];
  const success = notice.tone !== 'error';

  return createPortal(
    <div
      id="notice-modal"
      className={`notice-modal notice-modal--${success ? 'success' : 'error'}`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="notice-modal-title"
    >
      <div className="notice-modal-card">
        <div className="notice-modal-head">
          <span className="notice-modal-icon" aria-hidden="true">{success ? '✓' : '!'}</span>
          <h2 id="notice-modal-title">{notice.title}</h2>
        </div>
        {notice.message && <p className="notice-modal-message">{notice.message}</p>}
        {details.length > 0 && (
          <ul className="notice-modal-details">
            {details.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
          </ul>
        )}
        {items.length > 0 && (
          <div className="notice-modal-warning">
            <p>These media files are not in this browser yet — select each pattern and use <strong>Relink File</strong>:</p>
            <ul className="notice-modal-items">
              {items.map((name, index) => <li key={`${index}-${name}`}>{name}</li>)}
            </ul>
          </div>
        )}
        <div className="notice-modal-actions">
          {notice.reload ? (
            <button
              id="notice-modal-reload"
              className="btn btn--solid"
              type="button"
              onClick={() => window.location.reload()}
            >
              <span className="btn-label">Reload &amp; Apply</span>
            </button>
          ) : (
            <button
              id="notice-modal-dismiss"
              className="btn btn--solid"
              type="button"
              onClick={() => store.setState({ notice: null })}
            >
              <span className="btn-label">Close</span>
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
