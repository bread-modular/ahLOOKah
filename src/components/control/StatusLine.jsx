import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { ICON_MONITOR } from '../common/icons.jsx';

export function StatusLine() {
  const { runtime, store } = useRuntime();
  const screenOnline = useVizStore(store, (s) => s.screenOnline);

  return (
    <div id="status-line" className="status-line">
      {screenOnline ? (
        <span className="viz-pill viz-pill--status badge badge-online viz-pill--online">SCREEN ONLINE</span>
      ) : (
        <button
          id="open-screen-btn"
          className="viz-pill viz-pill--action viz-pill--offline badge badge-offline status-btn"
          type="button"
          title="Open a new screen window"
          onClick={() => runtime.commands.openScreen()}
        >
          {ICON_MONITOR}Open Screen
        </button>
      )}
    </div>
  );
}
