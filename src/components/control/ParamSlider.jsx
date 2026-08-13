import { useEffect, useRef, useState } from 'react';
import { formatParamValue } from './panelHelpers.js';

// A live-adjustable slider for one parameter. Uses an UNCONTROLLED input plus a
// native `input` listener (matching the legacy ConfigPanel) so Playwright's
// `el.value = x; dispatchEvent(new Event('input'))` probes drive it exactly as
// they did before. The native node is never replaced mid-gesture; external
// values sync back only while the operator is not dragging.
export function ParamSlider({ scope, id, def, getValue, onChange, valueFormat = formatParamValue, disabled = false }) {
  const inputRef = useRef(null);
  const draggingRef = useRef(false);
  const [label, setLabel] = useState(() => valueFormat(getValue(), def));

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onInput = () => {
      const v = parseFloat(el.value);
      setLabel(valueFormat(v, def));
      onChange(v);
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
    el.value = String(externalValue);
    setLabel(valueFormat(externalValue, def));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalValue]);

  return (
    <div className="param-row">
      <div className="param-head">
        <label htmlFor={`param-${def.key}`}>{def.label}</label>
        <span className="param-value" data-value={def.key}>{label}</span>
      </div>
      <input
        ref={inputRef}
        type="range"
        id={`param-${def.key}`}
        data-key={def.key}
        min={String(def.min)}
        max={String(def.max)}
        step={String(def.step)}
        defaultValue={String(getValue())}
        disabled={disabled}
      />
    </div>
  );
}
