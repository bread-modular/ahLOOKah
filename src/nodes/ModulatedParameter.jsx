import { useRef } from 'react';
import { ParameterControl } from '../components/control/ParameterControl.jsx';
import { numeric, clampStep, SIGNAL_DRAG } from './modulation.js';

export function ModulatedParameter({ node, def, value, onChange, mapping, onMap, onRange, onRemove }) {
  const gesture = useRef(null);
  const eligible = numeric(def);
  const percent = v => 100 * (v - def.min) / (def.max - def.min);
  const min = mapping ? clampStep(mapping.min, def) : 0, max = mapping ? clampStep(mapping.max, def) : 0;
  const begin = (e, part) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const track = e.currentTarget.closest('.nodes-mapping-overlay').getBoundingClientRect();
    gesture.current = { x: e.clientX, width: track.width, min, max, part };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = e => {
    const g = gesture.current; if (!g) return;
    let delta = (e.clientX - g.x) / g.width * (def.max - def.min);
    if (g.part === 'box') delta = Math.min(def.max - Math.max(g.min, g.max), Math.max(def.min - Math.min(g.min, g.max), delta));
    onRange(clampStep(g.min + (g.part !== 'max' ? delta : 0), def), clampStep(g.max + (g.part !== 'min' ? delta : 0), def));
  };
  const pointer = part => ({ onPointerDown: e => begin(e, part), onPointerMove: move, onPointerUp: () => { gesture.current = null; }, onPointerCancel: () => { gesture.current = null; } });
  const overlay = mapping && eligible && <div className="nodes-mapping-overlay">
    <div className="nodes-mapping-box" data-testid={`mapping-box-${def.key}`} title="Drag mapping range; use fields below for keyboard editing" style={{ left: `${Math.min(percent(min), percent(max))}%`, width: `${Math.abs(percent(max) - percent(min))}%` }} {...pointer('box')} />
    <span className="nodes-mapping-handle" title="Drag signal 0 endpoint" style={{ left: `${percent(min)}%` }} {...pointer('min')} />
    <span className="nodes-mapping-handle" title="Drag signal 1 endpoint" style={{ left: `${percent(max)}%` }} {...pointer('max')} />
  </div>;
  return <div className="nodes-modulated-param" data-param-target={def.key} onDragOver={e => { if (e.dataTransfer.types.includes(SIGNAL_DRAG)) e.preventDefault(); }} onDrop={e => {
    e.preventDefault(); e.stopPropagation(); const source = e.dataTransfer.getData(SIGNAL_DRAG); if (source.length <= 80) onMap(source, def);
  }}>
    <ParameterControl scope="nodes" id={node.id} def={def} value={value} onChange={onChange} mappingOverlay={overlay} />
    {!eligible && <small>Audio mapping unsupported: enum, bool and text are not numeric sliders.</small>}
    {mapping && eligible && <div className="nodes-mapping-fields">
      <small>Base: {value} · signal 0 → {min}; 1 → {max}{min > max ? ' (reversed)' : ''}</small>
      <div>{[['min', 'Mapping min (signal 0)', min], ['max', 'Mapping max (signal 1)', max]].map(([key, label, v]) => <label key={key}>{label}<input className="control-input" type="number" aria-label={`${def.label} ${label}`} min={def.min} max={def.max} step={def.step} value={v} onChange={e => { const next = e.target.valueAsNumber; if (Number.isFinite(next)) onRange(key === 'min' ? clampStep(next, def) : min, key === 'max' ? clampStep(next, def) : max); }} /></label>)}</div>
      <button className="btn btn--sm" onClick={() => onRange(max, min)}>Reverse range</button>
      <button className="btn btn--sm" onClick={() => onRange(clampStep(value, def), max)}>Start at base</button>
      <button className="btn btn--sm" onClick={onRemove}>Remove mapping</button>
    </div>}
  </div>;
}
