// Shared control-panel helpers: active-class computation, slot labels, and
// param value formatting. Pure functions only.
export function slotLabel(i) {
  return i === 9 ? '0' : String(i + 1);
}

export function formatParamValue(v, def) {
  const step = def.step ?? 0.01;
  if (step >= 1) return String(Math.round(v));
  if (step >= 0.1) return v.toFixed(1);
  return v.toFixed(2);
}

export function formatPostFxValue(v) {
  const n = Math.round(Number(v) || 0);
  return n > 0 ? `+${n}` : String(n);
}

// Compute the active/merge/cue classes for a pattern button given the LIVE and
// CUE selections. A pad button (isSlot) is marked when its id is selected; a
// library button is marked only when its id is selected AND not assigned to a
// pad slot.
export function selectionClassesFor({ id, isSlot, liveSelection, cueSelection, slotOrder }) {
  const inPad = slotOrder.indexOf(id) >= 0;
  const markable = isSlot || !inPad;

  const liveMarked = Boolean(liveSelection?.ids?.length) && liveSelection.ids.includes(id) && markable;
  const cueMarked = Boolean(cueSelection?.ids?.length) && cueSelection.ids.includes(id) && markable;

  const classes = [];
  if (liveMarked) {
    if (liveSelection.merge) {
      classes.push('live-merge-active', 'merge-active');
    } else {
      classes.push('live-active', 'active');
    }
  }
  if (cueMarked) {
    classes.push(cueSelection.merge ? 'cue-merge-active' : 'cue-active');
  }
  if (liveMarked && cueMarked) classes.push('live-cue-active');
  return classes;
}
