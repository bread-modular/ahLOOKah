const paths = {
  open: 'M3 7h6l2 2h10l-3 11H3V7Zm0 5h17',
  add: 'M12 5v14M5 12h14',
  unlink: 'm6 6 12 12M18 6 6 18',
  reload: 'M20 7v5h-5M20 12a8 8 0 1 0-2 5',
  zoomIn: 'M10 6v8M6 10h8M16 16l5 5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  zoomOut: 'M6 10h8M16 16l5 5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
};

export function IconControl({ icon, label, title = label, href, className = '', ...props }) {
  const Tag = href ? 'a' : 'button';
  return <Tag className={`btn script-icon ${className}`} aria-label={label} title={title} href={href} {...props}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[icon]} /></svg>
  </Tag>;
}
