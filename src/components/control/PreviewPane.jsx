import { useEffect, useRef } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';

function transportFrom(cue, online) {
  let action = 'GO LIVE';
  let phase = 'CUE / WARMING';
  let disabled = !cue || !online;
  if (cue) {
    switch (cue.phase) {
      case 'same': phase = 'CUE / SAME AS LIVE'; break;
      case 'warming': phase = 'CUE / WARMING'; break;
      case 'ready': phase = 'CUE / READY'; break;
      case 'take-pending': action = 'GOING LIVE'; phase = 'GOING LIVE / WARMING'; disabled = true; break;
      case 'error': action = 'RETRY CUE'; phase = `CUE ERROR — ${cue.error || 'LIVE SAFE'}`; break;
      default: phase = 'CUE / WARMING';
    }
  }
  return { action, phase, disabled };
}

export function PreviewPane() {
  const { runtime, store } = useRuntime();
  const cue = useVizStore(store, (s) => s.cue);
  const screenOnline = useVizStore(store, (s) => s.screenOnline);
  const notice = useVizStore(store, (s) => s.transportNotice);
  const stageRef = useRef(null);

  useEffect(() => {
    if (stageRef.current) runtime.registerPreviewHost(stageRef.current);
  }, [runtime]);

  const { action, phase, disabled } = transportFrom(cue, screenOnline);
  const isReady = cue?.phase === 'ready' || cue?.phase === 'same';
  const isError = cue?.phase === 'error';

  return (
    <section className="preview-section" aria-labelledby="preview-title">
      <div className="preview-heading">
        <h3 id="preview-title">{cue ? 'CUE PREVIEW' : 'LIVE PREVIEW'}</h3>
        <span id="preview-renderer" className="preview-renderer">
          {cue ? phase.replace(/^CUE \/ /, '') : 'LIVE RENDER'}
        </span>
      </div>
      <div className="preview-surface">
        <div
          id="preview-stage"
          ref={stageRef}
          className={`preview-stage${cue ? ' cue-preview' : ''}`}
          aria-label={cue ? 'Cue visualization preview' : 'Live visualization preview'}
        />
        <div id="cue-preview-controls" className="cue-preview-controls" aria-label="Cue transport controls" hidden={!cue}>
          <span id="cue-preview-phase" className={`cue-preview-phase${isReady ? ' is-ready' : ''}${isError ? ' is-error' : ''}`}>
            {phase}
          </span>
          <div className="cue-preview-actions">
            <button
              id="cue-primary"
              className="cue-primary"
              type="button"
              disabled={disabled}
              aria-label={`${action}; Enter`}
              title={`${action} with the cued program (Enter)`}
              onClick={() => runtime.commands.cuePrimary()}
            >
              <span className="transport-action">{action}</span><kbd>ENTER</kbd>
            </button>
            <button
              id="cue-cancel"
              className="cue-cancel"
              type="button"
              disabled={!cue}
              aria-label="Cancel cue; Escape"
              title="Cancel cue (Escape)"
              onClick={() => runtime.commands.cueCancel()}
            >
              <span className="transport-action">CANCEL</span><kbd>ESC</kbd>
            </button>
          </div>
        </div>
      </div>
      <div id="cue-live-region" className="sr-only" aria-live="polite" aria-atomic="true">{notice}</div>
    </section>
  );
}
