// The Script node's persistent state store.
//
// A Script *body* may read and write `state.<name>` slots (and `state.<name>[i]`
// buffers). That store lives here, not in the language front ends: one flat
// Float64Array per node, owned by the GraphRuntime that is currently running the
// node. The compiled program only carries the layout (slot count, initial values
// and a description for the inspector); the interpreter receives the array and
// does plain indexed reads and writes.
//
// Five rules make persistence predictable, and each one is tested:
//
//  1. **One update per node per tick.** `run()` is keyed by the runtime's frame
//     counter. A second evaluation inside the same frame (the inspector's
//     readout, a parameter view, any other reader) returns that tick's result
//     instead of running the body again — so `state.n = state.n + 1` counts
//     frames, never readers. A reader that arrives after the tick advanced runs
//     the node for the new tick, so a branch the renderer does not reach still
//     advances while it is being inspected.
//  2. **`dt` is real elapsed time, bounded.** It is the seconds since this node's
//     previous update, clamped to MAX_STATE_STEP (0.25 s) and 0 on the first
//     update. A paused graph, a hidden tab or an unreachable branch therefore
//     resumes with a small, bounded step instead of one huge jump.
//  3. **A failed body changes nothing.** The body runs against a copy of the
//     store and the copy is committed only when the evaluation produced no
//     error, a finite value and finite stored numbers. A transient error leaves
//     the history exactly as the tick found it.
//  4. **State is memory, never data.** Nothing here is serialized: the store is
//     created with its node's runtime and dies with it (a new source, a reloaded
//     pattern or a reloaded page starts from the declared initial values).
//     `reset()` is the explicit, user-facing way back to those values.
//  5. **State follows time, not pixels.** An update is never rolled back because
//     the renderer discarded the frame it belonged to: a tick that ran advances
//     the store once, whether its image is committed or retired by a mid-flight
//     edit or a resize, and the next tick then continues from there with its own
//     (small) dt. Nothing is lost and nothing is counted twice.
import { MAX_STATE_STEP, SCRIPT_STATE_NAME } from './script-core.js';

const EMPTY_LAYOUT = { slots: 0, init: [], entries: [] };
const finiteStore = values => {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false;
  return true;
};

export function createScriptStateStore() {
  const nodes = new Map();
  // The layout comes from the retained scriptProgram() entry (the same object
  // scriptValue() receives): `compiled.program.state`. A body that failed to
  // compile has no layout at all, and a node whose source changed — the runtime
  // is normally rebuilt for that — can never keep a store the new layout would
  // index out of bounds, because a different slot count replaces the record.
  const layoutOf = entry => (entry?.compiled?.ok ? entry.compiled.program?.state : null) || EMPTY_LAYOUT;
  const record = (id, entry) => {
    const layout = layoutOf(entry);
    const existing = nodes.get(id);
    if (existing && existing.slots === layout.slots) return existing;
    const next = {
      slots: layout.slots,
      entries: layout.entries,
      initial: layout.slots ? Float64Array.from(layout.init) : null,
      values: layout.slots ? Float64Array.from(layout.init) : null,
      lastTime: null, tick: -1, cache: null,
    };
    nodes.set(id, next);
    return next;
  };
  const reset = id => {
    const store = nodes.get(id);
    if (!store) return false;
    // Initial values, not zeros: a buffer declared as [0, 1, 0, 1] resets to that.
    if (store.values) store.values.set(store.initial);
    store.lastTime = null; store.tick = -1; store.cache = null;
    return true;
  };
  return {
    // evaluate(dt, state) runs the compiled body; it must return the shared
    // scriptResult shape ({ value, error, uses, language }) and must not throw.
    // `entry` is the retained scriptProgram() entry the runtime already holds.
    run(id, { tick, time, entry }, evaluate) {
      const store = record(id, entry);
      if (store.cache && store.cache.tick === tick) return store.cache.result;
      const dt = store.lastTime === null ? 0 : Math.min(MAX_STATE_STEP, Math.max(0, time - store.lastTime));
      const scratch = store.values ? store.values.slice() : null;
      const evaluated = evaluate(dt, scratch) || { value: 0, error: 'Script: evaluation produced no result → 0.' };
      const result = { value: evaluated.value, error: evaluated.error || null, uses: evaluated.uses ?? null, language: evaluated.language, dt, committed: false };
      if (!result.error && scratch && !finiteStore(scratch)) {
        result.value = 0;
        result.error = `Script: a ${SCRIPT_STATE_NAME} value is not finite → 0.`;
      }
      if (!result.error && Number.isFinite(result.value)) {
        if (scratch) store.values.set(scratch);
        result.committed = true;
      }
      // Timing advances with the tick even when the body failed: dt measures
      // real elapsed time, not "time since the last success".
      store.lastTime = time; store.tick = tick; store.cache = { tick, result };
      return result;
    },
    // The inspector readout: slot and buffer contents, or null when this node
    // has no state at all. Read-only — never advances anything.
    readout(id) {
      const store = nodes.get(id);
      if (!store?.values) return null;
      return store.entries.map(({ name, kind, size, base }) => ({
        name, kind, size,
        value: kind === 'buffer' ? null : store.values[base],
        values: kind === 'buffer' ? Array.from(store.values.subarray(base, base + size)) : null,
      }));
    },
    reset,
    drop(id) { return nodes.delete(id); },
    clear() { nodes.clear(); },
    size() { return nodes.size; },
  };
}
