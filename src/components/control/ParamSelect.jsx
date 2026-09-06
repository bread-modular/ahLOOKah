import { Select } from './Select.jsx';

// Dropdown control for discrete parameters. A sketch opts in by giving its
// param def an `options` array: [{ value, label }, ...]. Values stay numeric
// (matching slider-based params) so persistence and the CUE/TAKE param
// protocol need no special handling.
function labelFor(def, value) {
  const match = (def.options || []).find((opt) => Number(opt.value) === Number(value));
  return match ? match.label : String(value);
}

export function ParamSelect({ scope, id, def, value, onChange, disabled = false }) {
  const controlId = `param-${scope || 'live'}-${id || 'unknown'}-${def.key}`;
  return (
    <div className="param-row">
      <div className="param-head">
        <label htmlFor={controlId}>{def.label}</label>
        <span className="param-value" data-value={def.key}>{labelFor(def, value)}</span>
      </div>
      <Select
        id={controlId}
        data-key={def.key}
        className="param-select"
        value={String(value)}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {(def.options || []).map((opt) => (
          <option key={opt.value} value={String(opt.value)}>{opt.label}</option>
        ))}
      </Select>
    </div>
  );
}
