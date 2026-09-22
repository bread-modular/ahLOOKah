import { useEffect, useRef, useState } from 'react';
import { ParameterControl } from '../components/control/ParameterControl.jsx';
import { numeric, mappingEndpoint, mappedValue, SIGNAL_DRAG } from './modulation.js';

// One mapping number field. It must accept values the target parameter's own
// domain does not contain (a negative minimum, for example) and must not fight
// the operator while they type a partial "-0." — so it is uncontrolled while
// focused and the stored value is written back into the DOM as soon as it
// changes from anywhere else (handle drag, the other field, a remap). Fewer
// constraints are declared than the domain: `step="any"` keeps any
// finite value valid instead of marking a negative one :invalid.
function MappingNumberField({ ariaLabel, label, value, onCommit }) {
  const ref = useRef(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { const el = ref.current; if (el && !editing) el.value = String(value); }, [value, editing]);
  return <label>{label}<input ref={ref} className="control-input" type="number" step="any" inputMode="decimal"
    aria-label={ariaLabel} defaultValue={String(value)}
    onFocus={() => setEditing(true)} onBlur={() => setEditing(false)}
    onChange={e => { const next = e.target.valueAsNumber; if (Number.isFinite(next)) onCommit(next); }} /></label>;
}

export function ModulatedParameter({ node, def, value, onChange, mapping, readEffective, onMap, onRange, onInputRange, onRemove, sourceLabel = null }) {
  const gesture = useRef(null);
  const eligible = numeric(def);
  const read = useRef(readEffective); read.current = readEffective;
  const [live, setLive] = useState(null);
  // Mapping controls start collapsed and have no separate heading or button: the
  // overlay itself is the disclosure toggle (focusable, Enter/Space, and click on
  // the track). A drag on the box or on a handle only rescales the range and
  // hides the controls, so releasing a resize can never pop the fields open by
  // accident, and cancelling a gesture leaves them closed.
  const [showFields, setShowFields] = useState(false);
  const fieldsId = `${node.id}-${def.key}-mapping-fields`;
  useEffect(() => {
    if (!mapping || !eligible) { setLive(null); return; }
    let frame;
    const update = () => {
      const value = read.current?.();
      setLive(Number.isFinite(value) ? value : mappedValue(mapping, 0, def));
      frame = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [mapping, eligible, def]);
  const effective = live ?? (mapping && eligible ? mappedValue(mapping, 0, def) : value);
  // Stored endpoints are read exactly as saved (they may lie outside the target
  // domain); only their *display* position inside the track is pinned to the
  // track edges, and only the value the target consumes is domain-clamped.
  const min = mapping ? mappingEndpoint(mapping.min, def.min) : 0, max = mapping ? mappingEndpoint(mapping.max, def.max) : 0;
  const span = def.max - def.min;
  const percent = v => Math.min(100, Math.max(0, 100 * (v - def.min) / span));
  // Signal input range: legacy mappings (and new ones) default to 0…1.
  const inputMin = Number.isFinite(mapping?.inputMin) ? mapping.inputMin : 0;
  const inputMax = Number.isFinite(mapping?.inputMax) ? mapping.inputMax : 1;
  const toggle = () => setShowFields(open => !open);
  const begin = (e, part) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const track = e.currentTarget.closest('.nodes-mapping-overlay').getBoundingClientRect();
    gesture.current = { x: e.clientX, width: track.width, min, max, span, part, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  // A gesture only starts counting after a few pixels: the tiny drift inside a
  // click must never rewrite the range, and the disclosure click below still fires.
  const DRAG_THRESHOLD = 3;
  const move = e => {
    const g = gesture.current; if (!g) return;
    // Sub-threshold motion is still a click: the range is left exactly as it was.
    if (!g.moved) {
      if (Math.abs(e.clientX - g.x) <= DRAG_THRESHOLD) return;
      // Any real motion is a range gesture, not a click: the controls collapse and
      // stay collapsed when the pointer is released.
      g.moved = true; setShowFields(false);
    }
    const delta = (e.clientX - g.x) / g.width * g.span;
    // Continuous translation: the whole range follows the pointer and may leave the
    // parameter's domain (an endpoint is never forced back inside it, so an
    // out-of-domain range does not snap to the domain edge on the first pixel).
    onRange(mappingEndpoint(g.min + (g.part !== 'max' ? delta : 0), g.min), mappingEndpoint(g.max + (g.part !== 'min' ? delta : 0), g.max));
  };
  const end = () => {
    const g = gesture.current; gesture.current = null;
    // Only a click that never became a range gesture toggles the controls.
    if (g?.part === 'box' && !g.moved) toggle();
  };
  const pointer = part => ({ onPointerDown: e => begin(e, part), onPointerMove: move, onPointerUp: end, onPointerCancel: () => { gesture.current = null; } });
  const overlay = mapping && eligible && <div className="nodes-mapping-overlay" role="button" tabIndex={0}
    aria-label={`${def.label} mapping settings`} aria-expanded={showFields} aria-controls={showFields ? fieldsId : undefined}
    title={`Mapped from ${sourceLabel || 'a signal'} · drag the box to move the range or its handles to resize it; click or press Enter for the mapping controls`}
    onClick={e => { if (e.target === e.currentTarget) toggle(); }}
    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
    <div className="nodes-mapping-box" data-testid={`mapping-box-${def.key}`} title="Drag to move the mapping range, click to show its controls" style={{ left: `${Math.min(percent(min), percent(max))}%`, width: `${Math.abs(percent(max) - percent(min))}%` }} {...pointer('box')} />
    <span className="nodes-mapping-handle" title="Drag signal 0 endpoint" style={{ left: `${percent(min)}%` }} {...pointer('min')} />
    <span className="nodes-mapping-handle" title="Drag signal 1 endpoint" style={{ left: `${percent(max)}%` }} {...pointer('max')} />
    <span className="nodes-mapping-live" data-testid={`mapping-live-${def.key}`} title={`LIVE ${effective}`} style={{ left: `${percent(effective)}%` }} />
  </div>;
  return <div className={`nodes-modulated-param${mapping && eligible ? ' is-mapped' : ''}`} data-param-target={def.key} onDragOver={e => { if (e.dataTransfer.types.includes(SIGNAL_DRAG)) e.preventDefault(); }} onDrop={e => {
    e.preventDefault(); e.stopPropagation(); const source = e.dataTransfer.getData(SIGNAL_DRAG); if (source.length <= 80) onMap(source, def);
  }}>
    <ParameterControl scope="nodes" id={node.id} def={def} value={value} onChange={onChange} disabled={!!mapping && eligible} mappingOverlay={overlay}
      labelExtra={mapping && eligible && sourceLabel ? <span className="nodes-mapping-source" data-testid={`mapping-source-${def.key}`} title={`Signal source: ${sourceLabel}`}>{sourceLabel}</span> : null} />
    {!eligible && <small>Audio mapping unsupported: enum, bool and text are not numeric sliders.</small>}
    {mapping && eligible && <>
      {showFields && <output className="nodes-mapping-value" aria-label={`${def.label} LIVE mapped value`}>LIVE {effective}</output>}
      {showFields && <div className="nodes-mapping-fields" id={fieldsId}>
      <p className="nodes-mapping-inline"><small>Base: {value} · signal {inputMin} → {min}; {inputMax} → {max}{min > max ? ' (reversed)' : ''}</small></p>
      <div>{[['min', 'Mapping min', min], ['max', 'Mapping max', max]].map(([key, label, v]) => <MappingNumberField key={key} ariaLabel={`${def.label} ${label}`} label={label} value={v}
        onCommit={next => onRange(key === 'min' ? mappingEndpoint(next, v) : min, key === 'max' ? mappingEndpoint(next, v) : max)} />)}</div>
      {onInputRange && <div>{[['inputMin', 'Signal in min', inputMin], ['inputMax', 'Signal in max', inputMax]].map(([key, label, v]) => <MappingNumberField key={key} ariaLabel={`${def.label} ${label}`} label={label} value={v}
        onCommit={next => onInputRange(key === 'inputMin' ? next : inputMin, key === 'inputMax' ? next : inputMax)} />)}</div>}
      <button className="btn btn--sm" onClick={onRemove}>Remove mapping</button>
      </div>}
    </>}
  </div>;
}
