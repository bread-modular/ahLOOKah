// Module-level HTML5 drag state (transient; must not trigger React re-renders).
let dragSource = null;

export function getDragSource() { return dragSource; }
export function setDragSource(src) { dragSource = src; }

export function clearDropTargets(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('.pattern-btn.drop-target').forEach((b) => b.classList.remove('drop-target'));
}

function buttonOf(e) { return e.currentTarget; }

export function onDragStart(e) {
  const btn = buttonOf(e);
  const isSlot = btn.dataset.index !== undefined;
  setDragSource({
    type: isSlot ? 'slot' : 'library',
    id: btn.dataset.id,
    index: isSlot ? parseInt(btn.dataset.index, 10) : null,
  });
  btn.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', btn.dataset.id);
  }
}

export function onDragEnd(e) {
  const btn = buttonOf(e);
  setDragSource(null);
  btn.classList.remove('dragging');
  clearDropTargets(btn.closest('#config-panel'));
}

export function onDragOver(e) {
  const btn = buttonOf(e);
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  clearDropTargets(btn.closest('#config-panel'));
  if (getDragSource() && btn.dataset.id !== getDragSource().id) {
    btn.classList.add('drop-target');
  }
}

export function onDragLeave(e) {
  buttonOf(e).classList.remove('drop-target');
}
