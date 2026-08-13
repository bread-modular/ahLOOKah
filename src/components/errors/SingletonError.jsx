import { useEffect } from 'react';

// Blocked-page overlay. Mounted only after the pre-React singleton check says the
// role is already owned. No app runtime, p5, audio, preview, or panel is started
// for this page. Emits the exact IDs/text/classes the tests expect.
export function SingletonError({ role }) {
  const title = role === 'screen' ? 'Screen Already Open' : 'Control Panel Already Open';
  const desc = role === 'screen'
    ? 'Only one Screen window is allowed per browser. A Screen is already open in another tab or window.'
    : 'Only one Control Panel is allowed per browser. A Control Panel is already open in another tab or window.';

  useEffect(() => {
    document.body.classList.add('singleton-blocked');
    document.body.classList.remove('is-control', 'is-screen');
    document.title = 'Blocked \u2014 ' + title;
    return () => {
      document.body.classList.remove('singleton-blocked');
    };
  }, [title]);

  return (
    <div id="singleton-error" data-role={role} data-testid="singleton-error">
      <div className="singleton-error-card" role="alert" aria-live="assertive">
        <div className="singleton-error-icon">\u26A0</div>
        <h1>{title}</h1>
        <p className="singleton-error-desc">{desc}</p>
        <p className="singleton-error-hint">
          This window was blocked to prevent conflicts. Only one <strong>Control Panel</strong> and one <strong>Screen</strong> can be open at a time — even via direct URL (<code>?role=control</code> / <code>?role=screen</code>). Close the other window and reload, or use the existing window.
        </p>
        <div className="singleton-error-actions">
          <button id="singleton-reload-btn" type="button" onClick={() => window.location.reload()}>Reload</button>
          <button id="singleton-close-btn" type="button" onClick={() => window.close()}>Close This Tab</button>
        </div>
      </div>
    </div>
  );
}
