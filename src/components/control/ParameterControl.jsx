import { ParamSelect } from './ParamSelect.jsx';
import { ParamSlider } from './ParamSlider.jsx';

// All supported parameter definitions: numeric ranges and numeric option enums.
// Storage/runtime values remain numeric; presentation is shared by every editor.
export function ParameterControl({ value, ...props }) {
  return props.def.options
    ? <ParamSelect {...props} value={value} />
    : <ParamSlider {...props} getValue={() => value} />;
}
