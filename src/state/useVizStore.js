import { useSyncExternalStore } from 'react';

// Selective subscription to the per-window vanilla Zustand store. The selector
// must return a primitive (or a reference that only changes when its slice does)
// so unrelated store updates never rerender the whole panel.
export function useVizStore(store, selector) {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
