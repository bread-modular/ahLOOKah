// Control-window keyboard gestures (1-0, Shift+CUE, +/-, Tab, Enter, Escape).
// Held keys are tracked by physical code, not character, so a Shift-modified
// digit can never corrupt a merge. The latched merge gesture and CUE's separate
// held-key list are preserved exactly.
import { indexFromKey, getOrderedSketches } from '../sketch-registry.js';

export function createKeyboardController(ctx) {
  const heldKeys = [];
  const heldCueKeys = [];

  function shortcutIndexFromEvent(event) {
    const digit = /^Digit([0-9])$/.exec(event.code || '');
    if (digit) return digit[1] === '0' ? 9 : Number(digit[1]) - 1;
    return indexFromKey(event.key);
  }

  function onKeydown(e) {
    if (ctx.getRole() !== 'control') return;

    if (e.code === 'Enter' && ctx.hasCueSession()) {
      e.preventDefault();
      if (!e.repeat) ctx.requestCuePrimary();
      return;
    }
    if (e.code === 'Escape' && (ctx.hasCueSession() || ctx.hasCueEntryPending())) {
      e.preventDefault();
      ctx.requestCueCancel();
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey || ctx.cueEditsLocked()) return;

    const target = e.target;
    const tag = target && target.tagName;
    const type = target && target.type;
    const isTextEntry =
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      (tag === 'INPUT' &&
        ['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week'].includes(type)) ||
      !!(target && target.isContentEditable);
    if (isTextEntry) return;

    const editingSelection = ctx.getEditingSelection();
    if (editingSelection.merge) {
      const bp = ctx.getEditingParams('__merge');
      if (e.key === '+' || e.key === '=' || e.key === '-') {
        const activeKey = bp.mode === 1 ? 'add' : 'mix';
        const delta = e.key === '-' ? -0.05 : 0.05;
        const cur = typeof bp[activeKey] === 'number' ? bp[activeKey] : 0.5;
        const next = Math.max(0, Math.min(1, Math.round((cur + delta) * 100) / 100));
        ctx.requestParamChange('__merge', { [activeKey]: next });
        e.preventDefault();
        return;
      }
      if (e.key === 'Tab') {
        ctx.requestParamChange('__merge', { mode: bp.mode === 1 ? 0 : 1 });
        e.preventDefault();
        return;
      }
    }

    const index = shortcutIndexFromEvent(e);
    if (index < 0 || index >= getOrderedSketches().length) return;

    if (e.shiftKey) {
      if (e.repeat) return;
      heldKeys.length = 0;
      if (heldCueKeys.some((held) => held.code === e.code)) return;
      if (heldCueKeys.length === 0) {
        heldCueKeys.push({ code: e.code, index });
        ctx.requestCueSelection(ctx.selectionFromIndices(index));
      } else if (heldCueKeys.length === 1) {
        heldCueKeys.push({ code: e.code, index });
        const lo = Math.min(heldCueKeys[0].index, index);
        const hi = Math.max(heldCueKeys[0].index, index);
        ctx.requestCueSelection(ctx.selectionFromIndices(lo, [lo, hi]));
      }
      e.preventDefault();
      return;
    }

    if (e.repeat || heldKeys.some((held) => held.code === e.code)) return;

    if (heldKeys.length === 0) {
      heldCueKeys.length = 0;
      heldKeys.push({ code: e.code, index });
      ctx.requestSelection(ctx.selectionFromIndices(index));
    } else if (heldKeys.length === 1) {
      heldKeys.push({ code: e.code, index });
      const lo = Math.min(heldKeys[0].index, index);
      const hi = Math.max(heldKeys[0].index, index);
      ctx.requestSelection(ctx.selectionFromIndices(lo, [lo, hi]));
    }
  }

  function onKeyup(e) {
    if (ctx.getRole() !== 'control') return;
    const pos = heldKeys.findIndex((held) => held.code === e.code);
    if (pos >= 0) heldKeys.splice(pos, 1);
    const cuePos = heldCueKeys.findIndex((held) => held.code === e.code);
    if (cuePos >= 0) heldCueKeys.splice(cuePos, 1);
  }

  function onBlur() {
    if (ctx.getRole() !== 'control') return;
    heldKeys.length = 0;
    heldCueKeys.length = 0;
  }

  return {
    onKeydown,
    onKeyup,
    onBlur,
    clearHeldKeys: () => { heldKeys.length = 0; heldCueKeys.length = 0; },
    clearLiveHeldKeys: () => { heldKeys.length = 0; },
    clearCueHeldKeys: () => { heldCueKeys.length = 0; },
  };
}
