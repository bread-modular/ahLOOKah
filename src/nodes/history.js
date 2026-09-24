import { useCallback, useRef } from 'react';

// Undo/redo for the editor's *draft* — the graph plus its dependency manifest.
// Selection, canvas view, the in-progress graph name and unapplied Script text
// are transient editor state (exactly as they are for Save), so they stay
// outside the history: a graph shortcut must never quietly rewrite the text the
// operator is typing, and the fields keep the browser's own undo because the
// shortcut is never read inside an editable element.
//
// Every committed draft mutation goes through one path (useDraftHistory's
// `apply`), which records the *previous* draft before the new one is stored. A
// live gesture — a node drag, a slider drag, a held arrow key — would otherwise
// fill the stack with one entry per frame, so an edit may name a merge key:
// consecutive edits sharing a key inside a short window collapse into the single
// entry that opened the gesture. A node drag uses a token unique to that one
// gesture, so two drags are never a single step; a parameter uses its own
// identity (`param:<node>:<key>`), so two sliders never share one. `seal()` runs
// on every pointer release: it closes the window (the next gesture on the very
// same control is a new step) and drops a gesture that ended exactly where it
// began, so an undo never burns a step on a no-visible-change.

// Bounded like the rest of the editor's bookkeeping: deep enough for real work,
// short enough that one pattern file can never grow an unbounded frame.
export const HISTORY_LIMIT = 100;
// A gesture's frames arrive continuously; a keyed repeat (a typed literal) is
// only the same step while it stays this close together.
export const MERGE_WINDOW_MS = 500;

// Entries are detached copies: a stored draft can never be rewritten by a later
// edit even if some future mutation stops building new objects.
const snapshot = draft => ({ graph: structuredClone(draft.graph), dependencies: structuredClone(draft.dependencies || []) });
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function createDraftHistory({ limit = HISTORY_LIMIT, now = () => Date.now() } = {}) {
  const past = [], future = [];
  let gesture = { key: null, at: 0, entry: null };
  const remember = (stack, draft) => {
    const entry = snapshot(draft);
    stack.push(entry);
    if (stack.length > limit) stack.shift();
    return entry;
  };
  return {
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    // Record the draft an edit is about to replace. A continuation of the current
    // gesture records nothing — the entry that opened the gesture stays — while
    // every other edit opens a new entry and invalidates the redo branch, exactly
    // like a fresh edit in any editor.
    record(draft, { merge = null, windowMs = MERGE_WINDOW_MS } = {}) {
      const at = now();
      if (merge !== null && merge === gesture.key && at - gesture.at < windowMs) { gesture.at = at; return false; }
      const entry = remember(past, draft);
      future.length = 0;
      gesture = { key: merge, at, entry };
      return true;
    },
    // A pointer release ends the current gesture. A gesture that ended exactly
    // where it started leaves no entry behind, so the next undo is a real change.
    seal(current) {
      const { entry } = gesture;
      gesture = { key: null, at: 0, entry: null };
      if (!entry || !current || !same(entry, current)) return false;
      const index = past.indexOf(entry);
      if (index < 0) return false;
      past.splice(index, 1);
      return true;
    },
    undo(current) {
      if (!past.length) return null;
      const restored = past.pop();
      remember(future, current);
      gesture = { key: null, at: 0, entry: null };
      return restored;
    },
    redo(current) {
      if (!future.length) return null;
      const restored = future.pop();
      remember(past, current);
      gesture = { key: null, at: 0, entry: null };
      return restored;
    },
    // The draft the next undo would install, without moving either stack: the
    // editor asks before restoring a draft that would take unapplied Script text
    // with it.
    peek(direction = 'undo') {
      const stack = direction === 'redo' ? future : past;
      return stack.length ? stack[stack.length - 1] : null;
    },
    reset() { past.length = 0; future.length = 0; gesture = { key: null, at: 0, entry: null }; },
  };
}

// One React binding around the core. The latest draft is tracked in a ref rather
// than derived from the rendered value: several edits can land in one task (one
// drag frame, a keystroke that both validates and writes), and each one has to
// build on the one before it. Recording never happens inside a React state
// updater, which React is free to run more than once.
export function useDraftHistory(value, setValue, config = {}) {
  const history = useRef(null);
  if (!history.current) history.current = createDraftHistory(config);
  const latest = useRef(value);
  latest.current = value;
  const apply = useCallback((next, options) => {
    const base = latest.current;
    const resolved = typeof next === 'function' ? next(base) : next;
    // An edit that changes nothing is not a step: not in the history, and not a
    // re-render either.
    if (!resolved || same(base, resolved)) return false;
    history.current.record(base, options);
    latest.current = resolved;
    setValue(resolved);
    return true;
  }, [setValue]);
  const undo = useCallback(() => {
    const restored = history.current.undo(latest.current);
    if (restored) { latest.current = restored; setValue(restored); }
    return restored;
  }, [setValue]);
  const redo = useCallback(() => {
    const restored = history.current.redo(latest.current);
    if (restored) { latest.current = restored; setValue(restored); }
    return restored;
  }, [setValue]);
  const seal = useCallback(() => history.current.seal(latest.current), []);
  const reset = useCallback(() => history.current.reset(), []);
  const peek = useCallback((direction = 'undo') => history.current.peek(direction), []);
  return { apply, undo, redo, seal, reset, peek };
}
