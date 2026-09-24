import { useEffect, useRef, useState } from 'react';
import { formatParamValue } from './panelHelpers.js';
import { scaleOf, trackMin, trackMax, trackValue, valueAtTrack, quantize } from '../../param-scale.js';

// A live-adjustable slider for one parameter. Uses an UNCONTROLLED input plus a
// native `input` listener (matching the legacy ConfigPanel) so Playwright's
// `el.value = x; dispatchEvent(new Event('input'))` probes drive it exactly as
// they did before. The native node is never replaced mid-gesture; external
// values sync back only while the operator is not dragging.
//
// A `scale: 'log'` parameter keeps the SAME contract — the node's value is still
// the parameter's real value — but the input's own min/max/step live in track
// space (base-10 logarithms), so the track is genuinely logarithmic while every
// value crossing this component stays in the parameter's units.
export function ParamSlider({ scope, id, def, getValue, onChange, valueFormat = formatParamValue, disabled = false, mappingOverlay = null, labelExtra = null }) {
  const inputRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const draggingRef = useRef(false);
  const [label, setLabel] = useState(() => valueFormat(getValue(), def));
  const controlId = `param-${scope || 'live'}-${id || 'unknown'}-${def.key}`;
  const logarithmic = scaleOf(def) === 'log';
  const readValue = element => logarithmic ? quantize(valueAtTrack(parseFloat(element.value), def), def) : parseFloat(element.value);
  const writeValue = value => logarithmic ? trackValue(value, def) : value;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onInput = () => {
      const v = readValue(el);
      setLabel(valueFormat(v, def));
      onChangeRef.current(v);
    };
    const onPointerDown = () => { draggingRef.current = true; };
    const onEnd = () => { draggingRef.current = false; };
    el.addEventListener('input', onInput);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onEnd);
    el.addEventListener('pointercancel', onEnd);
    return () => {
      el.removeEventListener('input', onInput);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onEnd);
      el.removeEventListener('pointercancel', onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const externalValue = getValue();
  useEffect(() => {
    const el = inputRef.current;
    if (!el || draggingRef.current) return;
    el.value = String(writeValue(externalValue));
    setLabel(valueFormat(externalValue, def));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalValue]);

  return (
    <div className="param-row">
      <div className="param-head">
        <label htmlFor={controlId}>{def.label}</label>
        {labelExtra}
        <span className="param-value" data-value={def.key}>{label}</span>
      </div>
      <div className="param-slider-track" style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        type="range"
        className="control-range"
        title={def.label}
        id={controlId}
        data-key={def.key}
        min={String(trackMin(def))}
        max={String(trackMax(def))}
        step={String(def.step)}
        defaultValue={String(writeValue(getValue()))}
        disabled={disabled}
      />
      {mappingOverlay}
      </div>
    </div>
  );
}
