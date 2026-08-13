// Open control/screen windows. The control window gets a compact size; the
// screen window opens fullstage (normal tab-sized) so it can be dropped on
// another monitor.
export function openControlWindow() {
  const url = new URL(window.location.href);
  url.searchParams.set('role', 'control');
  const w = window.open(url.toString(), '_blank', 'width=440,height=820');
  if (w) w.focus();
}

export function openScreenWindow() {
  const url = new URL(window.location.href);
  url.searchParams.set('role', 'screen');
  const w = window.open(url.toString(), '_blank');
  if (w) w.focus();
}
