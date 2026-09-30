import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SKETCHES, getGroups, getSketchesByGroup } from '../../sketch-registry.js';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { IDENTITY_QUAD, cloneQuad, parseMappingQuad, quadToPointsString, SCREEN_MAPPING_CORNER_LABELS, SCREEN_MAPPING_EDGE_BLUR_MAX } from '../../screen-mapping.js';
import { PROJECTION_GROUP, surfaceQuad, surfaceEdgeBlur } from '../../projection/projection-registry.js';

import { Select } from './Select.jsx';
import { ParamSlider } from './ParamSlider.jsx';
import { useProjectionAutosave } from './useProjectionAutosave.js';

// Child controls stay in the sidebar; mapping edits are applied as you work.
export function ProjectionMappingEditor({ sketch, surface, isNew, scope, locked, structuralLock, onClose }) {
  const { runtime, store } = useRuntime();
  const resolution = useVizStore(store, (s) => s.screenResolution);
  useVizStore(store, (s) => s.paramRevision);
  useVizStore(store, (s) => s.projectionRevision);
  useVizStore(store, (s) => s.mediaRevision);
  const cue = useVizStore(store, (s) => s.cue);
  const screenOnline = useVizStore(store, (s) => s.screenOnline);
  const failure = useVizStore(store, (s) => s.projectionFailure);
  const dialogRef = useRef(null);
  const titleId = useId();
  const hintId = useId();
  const lockNoteId = useId();
  const [name, setName] = useState(surface.name);
  const [patternId, setPatternId] = useState(surface.patternId);
  const [quad, setQuad] = useState(() => isNew ? cloneQuad(IDENTITY_QUAD) : surfaceQuad(surface, runtime.getEditingParams(sketch.id)));
  const [edgeBlur, setEdgeBlur] = useState(() => isNew ? 0 : surfaceEdgeBlur(surface, runtime.getEditingParams(sketch.id)));
  const [geometryEdited, setGeometryEdited] = useState(false);
  const autosave = useProjectionAutosave({ runtime, store, sketch, surface, name, setName, patternId, quad, edgeBlur,
    geometryEdited, locked, structuralLock, onClose });
  const child = SKETCHES.find((s) => s.id === patternId && !s.projection);
  const currentSurface = sketch.surfaces.find((s) => s.id === surface.id);
  const disabled = locked || autosave.stale || autosave.closing;
  // A new mapping only exists once it has a name. Until then every other control
  // stays locked — and visibly muted — because any edit made before the name
  // would be staged on a mapping that is never created.
  const namingRequired = !currentSurface && !name.trim();
  // Corners and smoothing remain editable during CUE; source and metadata do not.
  const settingsLocked = disabled || structuralLock || namingRequired;
  const geometryLocked = disabled || namingRequired;
  const currentValues = runtime.getEditingParams(sketch.id);
  const changeQuad = (next) => { setQuad(next); setGeometryEdited(true); };

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    runtime.commands.clearPatternKeys();
    dialog.showModal();
    (dialog.querySelector('input:not(:disabled)') || dialog.querySelector('button'))?.focus();
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  return createPortal(<dialog ref={dialogRef} className={`projection-editor${namingRequired ? ' is-awaiting-name' : ''}`}
    aria-modal="true" aria-labelledby={titleId} aria-describedby={namingRequired ? `${hintId} ${lockNoteId}` : hintId}
    onCancel={(event) => { event.preventDefault(); autosave.close(); }}>
    <form onSubmit={(event) => event.preventDefault()}>
      <header className="projection-editor-header">
        <div><p className="projection-editor-eyebrow">{sketch.name} · {scope === 'cue' ? 'CUE' : 'LIVE'}</p>
          <h2 id={titleId}>{!currentSurface ? 'Add mapping' : `Edit mapping — ${currentSurface.name}`}</h2></div>
        <button type="button" className="btn btn--icon" aria-label="Close mapping editor" onClick={autosave.close}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className="projection-editor-body">
        <aside className="projection-editor-settings">
          <label className="projection-source-label">Mapping name
            <input type="text" maxLength={80} required placeholder="e.g. Left wall" value={name} disabled={disabled || structuralLock} onChange={(event) => setName(event.target.value)} />
          </label>
          {namingRequired && <p id={lockNoteId} role="status" className="projection-lock-note">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
            </svg>
            <span>Name this mapping to unlock its source, smoothing and mapping box. Nothing is created before it has a name.</span>
          </p>}
          <label className="projection-source-label">Source pattern
            <Select className="projection-source" value={patternId} disabled={settingsLocked} onChange={(event) => setPatternId(event.target.value)}>
              {!child && <option value={patternId}>Missing pattern — choose a replacement</option>}
              {getGroups().filter((group) => group !== PROJECTION_GROUP).map((group) => <optgroup key={group} label={group}>
                {getSketchesByGroup(group).filter((s) => !s.projection).map((s) => <option key={s.id} value={s.id}>{s.name}{s.media ? ` (${s.kind})` : ''}</option>)}
              </optgroup>)}
            </Select>
          </label>
          <p className="projection-hint projection-source-help">Patterns, images and videos. Source controls stay in the sidebar.</p>
          <div className="projection-edge-control">
            <ParamSlider scope={scope} id={surface.id}
              def={{ key: 'mappingEdgeBlur', label: 'Edge smoothing', min: 0, max: SCREEN_MAPPING_EDGE_BLUR_MAX, step: 0.5 }}
              getValue={() => edgeBlur} onChange={(value) => { setEdgeBlur(value); setGeometryEdited(true); }}
              valueFormat={(value) => value === 0 ? 'Off' : `${value}%`} disabled={geometryLocked} />
            <p className="projection-hint">Soften all four edges for a smoother blend. Keeps the picture sharp.</p>
          </div>
          {cue && <p className="projection-warning">Corners and smoothing are staged in CUE. TAKE applies them to LIVE. Name and source are locked.</p>}
          {!child && <p className="projection-warning">This source is unavailable. The mapping will remain black until a replacement is selected.</p>}
          {child?.camera && <p className="projection-hint">Camera input renders on the output only.</p>}
        </aside>
        <main className="projection-editor-workspace">
          <div className="projection-editor-canvas-heading"><strong>Output mapping</strong><span>{resolution ? `${resolution.width} × ${resolution.height}` : '16:9 output'}</span></div>
          <p id={hintId} className="projection-hint projection-canvas-help">{namingRequired
            ? 'Name this mapping to place it on the output. Faint outlines show other mappings.'
            : 'Drag corners to fit the output. Faint outlines show other mappings.'}</p>
          <ProjectionQuadEditor quad={quad} name={name.trim() || 'New mapping'} locked={disabled} pending={namingRequired} resolution={resolution}
            others={sketch.surfaces.filter((s) => s.id !== surface.id).map((s) => surfaceQuad(s, currentValues))} onChange={changeQuad} />
        </main>
      </div>
      <footer className="projection-editor-footer">
        <div aria-live="polite">
          {autosave.error ? <p role="alert" className="projection-warning">{autosave.error}</p>
            : <p className="projection-hint">{!name.trim() ? (currentSurface ? 'Enter a name. The last saved name is kept while this is empty.' : 'Enter a name to unlock these settings and create this mapping.')
              : autosave.saving ? 'Saving changes…'
                : cue ? 'Changes staged · TAKE to apply'
                  : screenOnline ? 'All changes saved' : 'Saved locally · Output is offline.'}</p>}
          {failure?.selection?.ids.includes(sketch.id) && <p role="alert" className="projection-warning">
            Output kept the previous layout: {failure.error}
          </p>}
        </div>
        <div className="projection-editor-actions">
          {autosave.error && !autosave.stale && <button type="button" className="btn" onClick={autosave.retry}>Retry autosave</button>}
          {failure?.selection?.ids.includes(sketch.id) && <button type="button" className="btn" disabled={structuralLock || !screenOnline} onClick={() => runtime.commands.retryProjection()}>Retry output</button>}
          <button type="button" className="btn btn--solid" onClick={autosave.close}>Close</button>
        </div>
      </footer>
    </form>
  </dialog>, document.body);
}

function ProjectionQuadEditor({ quad, others, name, resolution, onChange, locked, pending }) {
  const svg = useRef(null);
  const gridId = useId();
  const drag = useRef(null);
  const [draft, setDraft] = useState(null);
  const shown = draft || quad;
  const invalid = !parseMappingQuad(shown).valid;
  const commit = (next) => { if (parseMappingQuad(next).valid) onChange(next); };
  const move = (event) => {
    if (!drag.current || locked) return;
    const rect = svg.current.getBoundingClientRect();
    const next = cloneQuad(drag.current.quad);
    next[drag.current.index] = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
    drag.current.quad = next;
    setDraft(next);
    commit(next);
  };
  const finish = () => {
    if (drag.current) commit(drag.current.quad);
    drag.current = null;
    setDraft(null);
  };
  return <div className="projection-geometry">
    <div className={`projection-canvas${pending ? ' projection-canvas--pending' : ''}`}>
    <svg ref={svg} className={`projection-quad-editor${invalid ? ' is-invalid' : ''}${pending ? ' is-pending' : ''}`} viewBox="0 0 100 100" preserveAspectRatio="none"
      style={{ aspectRatio: resolution ? `${resolution.width} / ${resolution.height}` : '16 / 9', '--projection-aspect': resolution ? resolution.width / resolution.height : 16 / 9 }} aria-label={`${name} corner editor`}>
      <defs><pattern id={gridId} width="10" height="10" patternUnits="userSpaceOnUse"><path d="M 10 0 L 0 0 0 10" fill="none" stroke="#ffffff12" strokeWidth="0.15" /></pattern></defs>
      <rect width="100" height="100" fill={`url(#${gridId})`} />
      {others.map((other, i) => <polygon key={i} className="projection-other" points={quadToPointsString(other)} />)}
      {!pending && <>
        <polygon className="sm-quad" points={quadToPointsString(shown)} />
        {shown.map((point, i) => <g key={i}>
          <circle cx={point.x * 100} cy={point.y * 100} r="0.9" className="sm-handle" />
          <circle cx={point.x * 100} cy={point.y * 100} r="2.5" className="sm-handle-hit" role="button" tabIndex={locked ? -1 : 0}
            aria-label={`${name} ${SCREEN_MAPPING_CORNER_LABELS[i]} corner`} aria-disabled={locked} data-corner-index={i}
            onPointerDown={(event) => {
              if (locked || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { index: i, quad: cloneQuad(quad) };
            }} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
            onKeyDown={(event) => {
              if (locked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
              event.preventDefault();
              const next = cloneQuad(quad);
              const axis = ['ArrowLeft', 'ArrowRight'].includes(event.key) ? 'x' : 'y';
              const delta = (event.shiftKey ? 0.01 : 0.001) * (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1);
              next[i][axis] = Math.max(0, Math.min(1, next[i][axis] + delta));
              commit(next);
            }} />
        </g>)}
      </>}
    </svg>
    </div>
    {pending ? <p className="projection-hint projection-pending-help" role="status">The mapping box, its corners and its smoothing stay locked until this mapping has a name.</p>
      : <>
        <p className="projection-hint projection-keyboard-help">Arrow keys to fine-tune · Shift for larger steps</p>
        <details><summary>Corner positions (%)</summary><div className="projection-coordinates">
          {quad.map((point, i) => <div key={i}><span>{SCREEN_MAPPING_CORNER_LABELS[i]}</span>
            {['x', 'y'].map((axis) => <label key={axis}>{axis.toUpperCase()}
              <input type="number" min="0" max="100" step="any" aria-label={`${name} ${SCREEN_MAPPING_CORNER_LABELS[i]} ${axis.toUpperCase()}`} disabled={locked}
                value={Number((point[axis] * 100).toFixed(2))} onChange={(event) => {
                  if (event.target.value === '') return;
                  const next = cloneQuad(quad);
                  next[i][axis] = Number(event.target.value) / 100;
                  commit(next);
                }} />
            </label>)}
          </div>)}
        </div></details>
        <button type="button" className="btn" disabled={locked} onClick={() => onChange(cloneQuad(IDENTITY_QUAD))}>Reset mapping to full frame</button>
        {invalid && <p role="status" className="projection-warning">Corners cannot cross. Keeping the last valid mapping.</p>}
      </>}
  </div>;
}
