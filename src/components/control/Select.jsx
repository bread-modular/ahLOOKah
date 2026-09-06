// Shared native dropdown chrome, also usable in portaled dialogs. Callers own
// value conversion: pattern IDs are strings; numeric parameters stay numeric.
export function Select({ className = '', children, ...props }) {
  return <select {...props} className={`control-select ${className}`.trim()}>{children}</select>;
}
