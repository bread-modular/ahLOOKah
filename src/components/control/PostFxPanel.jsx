import { POSTFX_ID, POSTFX_PARAMS, defaultParamValues } from '../../sketch-registry.js';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { formatPostFxValue } from './panelHelpers.js';
import { ParamSlider } from './ParamSlider.jsx';
import { ICON_RESET } from '../common/icons.jsx';

export function PostFxPanel() {
  const { runtime, store } = useRuntime();
  useVizStore(store, (s) => s.postFxRevision);
  const cue = useVizStore(store, (s) => s.cue);
  const locked = Boolean(cue?.takePending);

  const getValue = (key) => {
    const p = runtime.getEditingParams(POSTFX_ID);
    return Number(p?.[key]);
  };

  return (
    <div className="config-section-body">
      <div id="post-fx-list" className="params-list">
        {POSTFX_PARAMS.map((def) => (
          <ParamSlider
            key={`postfx:${def.key}`}
            scope="postfx"
            id={POSTFX_ID}
            def={def}
            getValue={() => getValue(def.key)}
            onChange={(v) => runtime.commands.changeParam(POSTFX_ID, def.key, v)}
            valueFormat={formatPostFxValue}
            disabled={locked}
          />
        ))}
      </div>
      <div className="config-group actions">
        <button
          id="post-fx-reset-btn"
          type="button"
          onClick={() => {
            const defs = defaultParamValues(POSTFX_ID);
            runtime.commands.changeParams(POSTFX_ID, defs);
          }}
        >
          {ICON_RESET}Reset to Natural
        </button>
      </div>
      <p>Global output trim — applied on top of every effect, including blends. 0 is the natural level; negative values reduce, positive values boost.</p>
    </div>
  );
}
