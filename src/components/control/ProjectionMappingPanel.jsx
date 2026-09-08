import { useState } from 'react';
import { SKETCHES } from '../../sketch-registry.js';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { MAX_SURFACES, newSurfaceId, projectionKey } from '../../projection/projection-registry.js';
import { ProjectionMappingEditor } from './ProjectionMappingEditor.jsx';
import { ParamSlider } from './ParamSlider.jsx';
import { ParamSelect } from './ParamSelect.jsx';
import { clearDropTargets, getDragSource } from './dragDrop.js';

export function ProjectionMappingPanel({ sketch, scope, locked }) {
  const { runtime, store } = useRuntime();
  const cue = useVizStore(store, (s) => s.cue);
  const failure = useVizStore(store, (s) => s.projectionFailure);
  const screenOnline = useVizStore(store, (s) => s.screenOnline);
  const [editor, setEditor] = useState(null);
  const structuralLock = Boolean(cue) || locked;
  const context = `${sketch.id}:${scope}:${cue?.sessionId || ''}`;
  const save = (surfaces) => runtime.commands.saveProjection({ ...sketch, surfaces });
  const openEditor = (surface, isNew = false) => setEditor({ surface, isNew, context });

  return <div className="projection-panel" data-projection-id={sketch.id}>
    {failure?.selection?.ids.includes(sketch.id) && <div role="alert" className="projection-warning">
      Output kept the previous layout: {failure.error} Edits below are pending; retry to apply them.
      <button className="btn" disabled={structuralLock || !screenOnline} onClick={() => runtime.commands.retryProjection()}>Retry projection layout</button>
    </div>}
    <div className="projection-title"><strong>{sketch.name}</strong>
      <button className="btn" disabled={structuralLock} onClick={() => {
        const next = window.prompt('Rename projection pattern', sketch.name);
        if (next?.trim()) runtime.commands.saveProjection({ ...sketch, name: next });
      }}>Rename pattern</button>
    </div>
    <p className="projection-hint">This pattern uses its own mapping, not the global screen mapping. Later mappings cover earlier ones.</p>
    {cue && <p className="projection-hint">CUE: edit corners and pattern parameters. Finish or cancel CUE to change names, sources, or mappings.</p>}
    <div className="projection-add">
      <span className="projection-hint">{sketch.surfaces.length} / {MAX_SURFACES} mappings</span>
      <button className="btn" disabled={structuralLock || sketch.surfaces.length >= MAX_SURFACES}
        onClick={() => openEditor({ id: newSurfaceId(), name: '', patternId: 'solid-color' }, true)}>Add mapping</button>
    </div>
    {!sketch.surfaces.length && <p className="param-empty">Add a mapping to choose its pattern and position it on the output.</p>}
    {sketch.surfaces.map((surface, index) => <MappingRow key={surface.id}
      surface={surface} index={index} sketch={sketch} scope={scope} locked={locked} structuralLock={structuralLock}
      onEdit={() => openEditor(surface)} onRemove={() => {
        if (window.confirm(`Remove mapping "${surface.name}"?`)) save(sketch.surfaces.filter((s) => s.id !== surface.id));
      }} />)}
    <button className="btn btn--danger" disabled={structuralLock} onClick={() => {
      if (window.confirm(`Remove projection pattern "${sketch.name}"?`)) runtime.commands.removeProjection(sketch.id);
    }}>Remove projection pattern</button>
    {editor?.context === context && <ProjectionMappingEditor key={editor.surface.id}
      sketch={sketch} surface={editor.surface} isNew={editor.isNew} scope={scope}
      locked={locked} structuralLock={structuralLock} onClose={() => setEditor(null)} />}
  </div>;
}

function MappingRow({ surface, index, sketch, scope, locked, structuralLock, onEdit, onRemove }) {
  const { runtime } = useRuntime();
  const [expanded, setExpanded] = useState(false);
  const child = SKETCHES.find((entry) => entry.id === surface.patternId && !entry.projection);
  const values = runtime.getEditingParams(sketch.id);
  const regionId = `mapping-params-${scope}-${sketch.id}-${surface.id}`;
  const droppedPattern = () => {
    if (expanded || structuralLock) return null;
    const source = getDragSource();
    return source && SKETCHES.find((entry) => entry.id === source.id && !entry.projection);
  };
  return <section className="projection-surface" data-surface-id={surface.id} aria-label={`${surface.name} mapping`}
    title={!expanded && !structuralLock ? 'Drop a pattern from the library or pad to assign it to this mapping.' : undefined}
    onDragOver={(event) => {
      event.stopPropagation();
      clearDropTargets(event.currentTarget.closest('#config-panel'));
      const pattern = droppedPattern();
      if (event.dataTransfer) event.dataTransfer.dropEffect = pattern ? 'move' : 'none';
      if (!pattern) return;
      event.preventDefault();
      event.currentTarget.classList.add('drop-target');
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('drop-target');
    }}
    onDrop={(event) => {
      event.preventDefault();
      event.stopPropagation();
      clearDropTargets(event.currentTarget.closest('#config-panel'));
      const pattern = droppedPattern();
      if (!pattern || pattern.id === surface.patternId) return;
      // Reuse the source-change path: retain mapping geometry/smoothing and
      // initialize independent controls from the new source's current settings.
      runtime.commands.saveProjection({ ...sketch, surfaces: sketch.surfaces.map((entry) =>
        entry.id === surface.id ? { ...entry, patternId: pattern.id } : entry) }, {}, sketch);
    }}>
    <div className="projection-surface-header">
      <button type="button" className="projection-surface-toggle" aria-expanded={expanded} aria-controls={regionId}
        onClick={() => setExpanded(!expanded)}>
        <span className="projection-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="projection-surface-label"><strong>{index + 1}. {surface.name}</strong><small>{child?.name || 'Unavailable pattern'}</small></span>
      </button>
      <div className="projection-surface-actions">
        <button type="button" className="btn" aria-label={`Edit ${surface.name}`} disabled={locked} onClick={onEdit}>Edit</button>
        <button type="button" className="btn btn--danger" aria-label={`Remove ${surface.name}`} disabled={structuralLock} onClick={onRemove}>Remove</button>
      </div>
    </div>
    {!child && <p className="projection-warning">This pattern was removed. Edit this mapping to choose a replacement.</p>}
    <div id={regionId} className="projection-surface-params" hidden={!expanded}>
      <h4 className="projection-param-heading">{child?.name || 'Unavailable'} parameters</h4>
      {child?.camera && <p className="projection-hint">Camera input renders on the output only, not in the control preview.</p>}
      {child && !child.params?.length && <p className="param-empty">No parameters for this pattern.</p>}
      {(child?.params || []).map((def) => {
        const key = projectionKey(surface.id, def.key);
        const mappedDef = { ...def, key };
        const change = (value) => runtime.commands.changeParam(sketch.id, key, value);
        return def.options
          ? <ParamSelect key={`${scope}:${surface.patternId}:${key}`} scope={scope} id={sketch.id} def={mappedDef} value={values[key] ?? def.default} onChange={change} disabled={locked} />
          : <ParamSlider key={`${scope}:${surface.patternId}:${key}`} scope={scope} id={sketch.id} def={mappedDef} getValue={() => runtime.getEditingParams(sketch.id)[key] ?? def.default} onChange={change} disabled={locked} />;
      })}
    </div>
  </section>;
}
