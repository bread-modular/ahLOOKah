import { useEffect, useRef } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { PreviewPane } from './PreviewPane.jsx';
import { PatternPad } from './PatternPad.jsx';
import { PatternLibrary } from './PatternLibrary.jsx';
import { ParameterPanel } from './ParameterPanel.jsx';
import { PostFxPanel } from './PostFxPanel.jsx';
import { BandEqPanel } from './BandEqPanel.jsx';
import { StatusLine } from './StatusLine.jsx';
import { AppMenu } from './AppMenu.jsx';
import { DeviceSetupModal } from './DeviceSetupModal.jsx';
import { KeyMapModal } from './KeyMapModal.jsx';

// Uncontrolled <details> section with native toggle persistence (mirrors the
// legacy persistSectionOpen behaviour and avoids React's controlled-<details>
// `open` attribute quirks).
function CollapsibleSection({ id, storageKey, title, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.open = localStorage.getItem(storageKey) !== '0';
    const summary = el.querySelector('summary');
    if (!summary) return;
    // Persist synchronously on click (not the async `toggle` event) so a reload
    // racing the click can never preempt the persisted state.
    const onClick = (e) => {
      if (!e.isTrusted) return;
      localStorage.setItem(storageKey, el.open ? '0' : '1');
    };
    summary.addEventListener('click', onClick);
    return () => summary.removeEventListener('click', onClick);
  }, [storageKey]);

  return (
    <details id={id} className="config-section" ref={ref}>
      <summary className="config-section-header">{title}</summary>
      {children}
    </details>
  );
}

export function ControlPanel() {
  const { store } = useRuntime();
  const cue = useVizStore(store, (s) => s.cue);
  const setupModalOpen = useVizStore(store, (s) => s.setupModalOpen);
  const keyMapOpen = useVizStore(store, (s) => s.keyMapOpen);

  return (
    <div id="config-container">
      <div id="config-panel" className={`${cue ? 'cue-active' : ''}${cue?.phase === 'take-pending' ? ' cue-pending' : ''}`}>
        <div id="preview-pane">
          <PreviewPane />
          <section className="pad-section" aria-labelledby="pad-title">
            <h3 id="pad-title">Pattern Pad <span className="pad-hint">1–0</span></h3>
            <PatternPad />
          </section>
        </div>

        <div id="library-pane">
          <h3>Pattern Library</h3>
          <PatternLibrary />
        </div>

        <div id="controls-pane">
          <div className="viz-control-header">
            <h3 className="panel-title">ahLOOKah</h3>
            <StatusLine />
            <AppMenu />
          </div>

          <ParameterPanel />

          <CollapsibleSection id="post-fx" storageKey="viz2_post_fx_open" title="Post Processing">
            <PostFxPanel />
          </CollapsibleSection>

          <CollapsibleSection id="band-eq" storageKey="viz2_band_eq_open" title="Band Split EQ">
            <BandEqPanel />
          </CollapsibleSection>
        </div>
      </div>

      {setupModalOpen && <DeviceSetupModal />}
      {keyMapOpen && <KeyMapModal />}
    </div>
  );
}
