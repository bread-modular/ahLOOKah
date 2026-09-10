import { useEffect, useRef, useState } from 'react';
import { PerformanceBudget } from './PerformanceBudget.jsx';
import { getOrderedSketches, SKETCHES, BLEND_ID, BLEND_PARAMS } from '../../sketch-registry.js';
import { selectionName } from '../../program/selection.js';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { canUseFileSystemPicker, isMediaLinked } from '../../media/media-store.js';
import { formatParamValue, formatPostFxValue } from './panelHelpers.js';
import { ProjectionMappingPanel } from './ProjectionMappingPanel.jsx';
import { ParamSlider } from './ParamSlider.jsx';
import { ParamSelect } from './ParamSelect.jsx';

function blendName(index, id, ordered) {
  return ordered[index]?.name || SKETCHES.find((s) => s.id === id)?.name || 'Effect';
}

export function ParameterPanel() {
  const { runtime, store } = useRuntime();
  const editingSelection = useVizStore(store, (s) => s.editingSelection);
  const editingScope = useVizStore(store, (s) => s.editingScope);
  const cue = useVizStore(store, (s) => s.cue);
  // Re-reads the mutable param bank whenever the accepted values change.
  useVizStore(store, (s) => s.paramRevision);
  // Refreshes names shown here (blend pair, cue heading, media rename row)
  // after a media rename in either window.
  const mediaRevision = useVizStore(store, (s) => s.mediaRevision);
  useVizStore(store, (s) => s.projectionRevision);

  const ordered = getOrderedSketches();
  const ids = editingSelection.ids || [];
  const indices = ids.map((id) => ordered.findIndex((s) => s.id === id));
  const currentPattern = indices[0] ?? -1;
  const currentPatternId = editingSelection.merge ? BLEND_ID : (ids[0] || null);

  const getValue = (id, key) => {
    const p = runtime.getEditingParams(id);
    return Number(p?.[key]);
  };

  const changeParam = (id, key, value) => runtime.commands.changeParam(id, key, value);
  const locked = Boolean(cue?.takePending);

  return (
    <>
      <h3 id="params-heading">
        {cue ? `CUE Parameters — ${selectionName(cue.selection)}` : 'Parameters'}
      </h3>
      <div id="params-list" className="params-list">
        {editingSelection.merge ? (
          <BlendControls
            getValue={getValue}
            changeParam={changeParam}
            scope={editingScope}
            locked={locked}
            ids={ids}
            indices={indices}
            ordered={ordered}
            nameA={blendName(indices[0], ids[0], ordered)}
            nameB={blendName(indices[1], ids[1], ordered)}
          />
        ) : (
          <EffectParams
            currentPattern={currentPattern}
            currentPatternId={currentPatternId}
            getValue={getValue}
            changeParam={changeParam}
            scope={editingScope}
            locked={locked}
            onRenameMedia={(id, name) => runtime.commands.renameMedia(id, name)}
            onRemoveMedia={(id) => runtime.commands.removeMedia(id)}
            onRelinkMedia={(id, files) => runtime.commands.relinkMedia(id, files)}
            mediaRevision={mediaRevision}
          />
        )}
      </div>
    </>
  );
}

function EffectParams({ currentPattern, currentPatternId, getValue, changeParam, scope, locked, onRenameMedia, onRemoveMedia, onRelinkMedia, mediaRevision }) {
  const ordered = getOrderedSketches();
  const relinkInputRef = useRef(null);
  const pickerAvailable = canUseFileSystemPicker();
  const sketch = currentPattern >= 0
    ? ordered[currentPattern]
    : SKETCHES.find((s) => s.id === currentPatternId);
  const mediaId = sketch?.media ? sketch.mediaId : null;
  // Relink is only offered when the pattern can no longer reach its file in
  // this browser (imported settings, file removed). Start hidden so a healthy
  // pattern never flashes the button while the check runs.
  const [mediaLinked, setMediaLinked] = useState(true);
  useEffect(() => {
    if (!mediaId) return undefined;
    let cancelled = false;
    isMediaLinked(mediaId)
      .then((linked) => { if (!cancelled) setMediaLinked(linked); })
      .catch(() => { if (!cancelled) setMediaLinked(false); });
    return () => { cancelled = true; };
  }, [mediaId, mediaRevision]);
  if (sketch?.projection) return <ProjectionMappingPanel key={`${scope}:${sketch.id}`} sketch={sketch} scope={scope} locked={locked} />;
  const defs = (sketch && sketch.params) || [];

  const rows = defs.length === 0
    ? [<p key="empty" className="param-empty">No parameters for this effect.</p>]
    : defs.map((def) => (def.options ? (
    <ParamSelect
      key={`${scope}:${currentPatternId}:${def.key}`}
      scope={scope}
      id={currentPatternId}
      def={def}
      value={getValue(currentPatternId, def.key)}
      onChange={(v) => changeParam(currentPatternId, def.key, v)}
      disabled={locked}
    />
  ) : (
    <ParamSlider
      key={`${scope}:${currentPatternId}:${def.key}`}
      scope={scope}
      id={currentPatternId}
      def={def}
      getValue={() => getValue(currentPatternId, def.key)}
      onChange={(v) => changeParam(currentPatternId, def.key, v)}
      disabled={locked}
    />
  )));

  return (
    <>
      <PerformanceBudget patternId={currentPatternId} scope={scope} />
      {rows}
      {sketch?.media && (
        <div className="media-manage-row">
          <button
            type="button"
            className="btn btn--md"
            disabled={locked}
            onClick={() => {
              const next = window.prompt('Rename media pattern', sketch.name);
              if (next === null) return;
              const clean = next.trim().slice(0, 80);
              if (!clean || clean === sketch.name) return;
              onRenameMedia(sketch.id, clean);
            }}
          >Rename</button>
          <button
            type="button"
            className="btn btn--md btn--danger"
            disabled={locked}
            onClick={() => {
              const ok = window.confirm(`Remove "${sketch.name}" from the library?`);
              if (!ok) return;
              onRemoveMedia(sketch.id);
            }}
          >Remove</button>
        </div>
      )}
      {sketch?.media && !mediaLinked && (
        <div className="media-relink-row">
          <button
            id="media-relink-btn"
            type="button"
            className="btn btn--md"
            disabled={locked}
            title={`Point "${sketch.name}" at a file on this computer`}
            onClick={() => {
              if (pickerAvailable) onRelinkMedia(sketch.id);
              else relinkInputRef.current?.click();
            }}
          >Relink File</button>
          {!pickerAvailable && (
            <input
              ref={relinkInputRef}
              type="file"
              accept="image/*,video/*"
              className="media-file-input"
              onChange={(event) => {
                const files = event.target.files;
                if (files?.length) onRelinkMedia(sketch.id, files);
                event.target.value = '';
              }}
            />
          )}
        </div>
      )}
    </>
  );
}

function BlendControls({ getValue, changeParam, scope, ids, indices, ordered, nameA, nameB, locked }) {
  const additive = getValue(BLEND_ID, 'mode') === 1;
  const activeDef = BLEND_PARAMS.find((d) => d.key === (additive ? 'add' : 'mix'));

  return (
    <>
      <div className="blend-header">
        <span>Blend</span>
        <span className="blend-names">{nameA} + {nameB}</span>
      </div>
      <div className="blend-mode-toggle">
        <button type="button" className={`blend-mode-btn${additive ? '' : ' active'}`} data-mode="blend" disabled={locked}
          onClick={() => { changeParam(BLEND_ID, 'mode', 0); }}>Blend</button>
        <button type="button" className={`blend-mode-btn${additive ? ' active' : ''}`} data-mode="additive" disabled={locked}
          onClick={() => { changeParam(BLEND_ID, 'mode', 1); }}>Additive</button>
      </div>
      <ParamSlider
        key={`${scope}:${BLEND_ID}:${activeDef.key}`}
        scope={scope}
        id={BLEND_ID}
        def={activeDef}
        getValue={() => getValue(BLEND_ID, activeDef.key)}
        onChange={(v) => changeParam(BLEND_ID, activeDef.key, v)}
        disabled={locked}
      />
      {(ids || []).slice(0, 2).map((patternId, slot) => (
        <MergePatternParams
          key={`${scope}:merge:${patternId}`}
          patternId={patternId}
          slotLabel={slot === 0 ? 'A' : 'B'}
          name={slot === 0 ? nameA : nameB}
          getValue={getValue}
          changeParam={changeParam}
          scope={scope}
          locked={locked}
        />
      ))}
    </>
  );
}

function MergePatternParams({ patternId, slotLabel, name, getValue, changeParam, scope, locked }) {
  const sketch = SKETCHES.find((s) => s.id === patternId);
  if (sketch?.projection) return <ProjectionMappingPanel key={`${scope}:${sketch.id}`} sketch={sketch} scope={scope} locked={locked} />;
  const defs = (sketch && sketch.params) || [];

  return (
    <section className="merge-pattern-params" data-pattern-id={patternId} aria-label={`${name} parameters`}>
      <div className="merge-pattern-header">
        <span className="merge-pattern-slot">{slotLabel}</span>
        <span className="merge-pattern-name">{name}</span>
      </div>
      <PerformanceBudget patternId={patternId} scope={scope} />
      {defs.length === 0 ? (
        <p className="param-empty">No parameters for this effect.</p>
      ) : defs.map((def) => (def.options ? (
        <ParamSelect
          key={`${scope}:${patternId}:${def.key}`}
          scope={scope}
          id={patternId}
          def={def}
          value={getValue(patternId, def.key)}
          onChange={(v) => changeParam(patternId, def.key, v)}
          disabled={locked}
        />
      ) : (
        <ParamSlider
          key={`${scope}:${patternId}:${def.key}`}
          scope={scope}
          id={patternId}
          def={def}
          getValue={() => getValue(patternId, def.key)}
          onChange={(v) => changeParam(patternId, def.key, v)}
          disabled={locked}
        />
      )))}
    </section>
  );
}
