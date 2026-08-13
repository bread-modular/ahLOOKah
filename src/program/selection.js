// Pure selection + param-bank helpers shared by the runtime coordinator, CUE
// authority, and the control-panel UI. No mutable window state lives here.
import {
  SKETCHES,
  getOrderedSketches,
  BLEND_ID,
  BANDS_ID,
  POSTFX_ID,
  defaultParamValues,
} from '../sketch-registry.js';
import { copyProgramSelection, selectionsEqual } from '../program-runtime.js';

export function singleSelection(id) {
  return { ids: id ? [id] : [], merge: false };
}

export function mergeSelection(ids) {
  return { ids: Array.isArray(ids) ? ids.filter(Boolean).slice(0, 2) : [], merge: true };
}

export function selectionFromIndices(index, merge = null) {
  const ordered = getOrderedSketches();
  if (Array.isArray(merge) && merge.length === 2) {
    const ids = merge.map((position) => ordered[position]?.id);
    return ids.every(Boolean) ? mergeSelection(ids) : null;
  }
  return ordered[index] ? singleSelection(ordered[index].id) : null;
}

export function selectionFromId(id) {
  return SKETCHES.some((sketch) => sketch.id === id) ? singleSelection(id) : null;
}

export function validCueSelection(selection) {
  const candidate = copyProgramSelection(selection);
  const ids = candidate.ids || [];
  if (!ids.length || !ids.every((id) => SKETCHES.some((sketch) => sketch.id === id))) return null;
  if (candidate.merge ? ids.length !== 2 : ids.length !== 1) return null;
  return candidate;
}

export function selectionIndices(selection) {
  const ordered = getOrderedSketches();
  return selection?.ids?.map((id) => ordered.findIndex((sketch) => sketch.id === id)) || [];
}

export function selectionName(selection) {
  const names = (selection?.ids || [])
    .map((id) => SKETCHES.find((sketch) => sketch.id === id)?.name || id)
    .filter(Boolean);
  return names.join(selection?.merge ? ' + ' : '') || 'No program';
}

export function paramObjectsEqual(left = {}, right = {}) {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  return [...keys].every((key) => key.startsWith('__') || left[key] === right[key]);
}

// `__bands` is a system-scoped group, not a visual value, so it is excluded from
// the visual bank that CUE clones and TAKE promotes.
export function visualParamId(id) {
  return id !== BANDS_ID;
}

export function copyVisualParamBank(bank = {}) {
  const clonedBank = {};
  for (const [id, values] of Object.entries(bank)) {
    if (visualParamId(id) && values && typeof values === 'object') clonedBank[id] = { ...values };
  }
  return clonedBank;
}

export function visualParamBanksEqual(left, right) {
  const lhs = copyVisualParamBank(left);
  const rhs = copyVisualParamBank(right);
  const ids = new Set([...Object.keys(lhs), ...Object.keys(rhs)]);
  return [...ids].every((id) => paramObjectsEqual(lhs[id] || {}, rhs[id] || {}));
}

export function visualParamBankUsesOnlyDefaults(bank) {
  return Object.entries(copyVisualParamBank(bank)).every(([id, values]) =>
    paramObjectsEqual(values, defaultParamValues(id)),
  );
}

export function isKnownLiveParamId(id) {
  return id === BLEND_ID
    || id === BANDS_ID
    || id === POSTFX_ID
    || SKETCHES.some((sketch) => sketch.id === id);
}

// A selection matching LIVE can still need a staged runtime when its selected
// effect params, merge mix, or post-processing bank differ from the program.
export function cueRequiresRuntime(session, { getParams, currentLiveSelection }) {
  if (!session?.selection) return false;
  if (!selectionsEqual(session.selection, currentLiveSelection())) return true;
  for (const id of session.selection.ids || []) {
    if (!paramObjectsEqual(session.params?.[id], getParams(id))) return true;
  }
  if (session.selection.merge && !paramObjectsEqual(session.params?.[BLEND_ID], getParams(BLEND_ID))) return true;
  return !paramObjectsEqual(session.params?.[POSTFX_ID], getParams(POSTFX_ID));
}
