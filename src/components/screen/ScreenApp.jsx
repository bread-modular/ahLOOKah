import { useEffect } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { ICON_EXPAND } from '../common/icons.jsx';

export function ScreenApp() {
  const { runtime } = useRuntime();

  useEffect(() => {
    runtime.bootScreen();
  }, [runtime]);

  return (
    <>
      <div id="screen-wrap" className="program-stage">
        <div className="program-layer program-layer-live" data-program-slot="live" />
        <div className="program-layer program-layer-cue" data-program-slot="cue" />
      </div>
      <div id="screen-toolbar">
        <button
          id="open-control-btn"
          type="button"
          className="btn"
          title="Open a control panel window"
          onClick={() => runtime.commands.openControl()}
        >
          {ICON_EXPAND}
          <span className="btn-label">Control Panel</span>
        </button>
      </div>
    </>
  );
}
