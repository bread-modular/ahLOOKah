// Shared UI helpers — small, dependency-free factories used by both the control
// panel and the screen window so buttons render consistently everywhere.

// Escapes text for safe interpolation into HTML strings.
export function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text == null ? '' : String(text);
  return d.innerHTML;
}

// Builds a <button> element from a small options object. This is the single
// source of truth for button markup: the `.btn` CSS class (see style.css)
// provides the shared rectangle look, while `variant` / `size` / `iconOnly`
// map to modifier classes for per-place customization.
//
//   id        string  — element id (the CSS/test hook and JS query target)
//   label     string  — visible text (HTML-escaped)
//   icon      string  — raw inline SVG markup (already trusted, e.g. ICON_*)
//   variant   '' | 'solid' | 'amber' | 'danger'  — color/emphasis modifier
//   size      '' | 'sm' | 'md'                   — size modifier
//   iconOnly  boolean — square icon button (no visible label)
//   title     string  — hover tooltip
//   attrs     object  — extra attributes (aria-label, aria-haspopup, etc.)
//   className string  — extra classes to append verbatim
export function button(opts = {}) {
  const {
    id,
    label = '',
    icon = '',
    variant = '',
    size = '',
    iconOnly = false,
    title,
    attrs = {},
    className = '',
    type = 'button',
  } = opts;

  const classes = ['btn'];
  if (variant) classes.push(`btn--${variant}`);
  if (size) classes.push(`btn--${size}`);
  if (iconOnly) classes.push('btn--icon');
  if (className) classes.push(className);

  const attrMap = { type, ...attrs };
  if (id) attrMap.id = id;
  if (title) attrMap.title = title;
  attrMap.class = classes.join(' ');

  const attrStr = Object.entries(attrMap)
    .map(([k, v]) => {
      if (v === true) return k;                 // boolean flag, e.g. disabled
      if (v === false || v == null) return '';  // omit false/null
      return `${k}="${escapeHtml(String(v))}"`;
    })
    .filter(Boolean)
    .join(' ');

  const body = icon + (label ? `<span class="btn-label">${escapeHtml(label)}</span>` : '');
  return `<button ${attrStr}>${body}</button>`;
}
