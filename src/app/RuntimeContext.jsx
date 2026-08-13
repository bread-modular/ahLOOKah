import { createContext, useContext } from 'react';

// Provides the per-window vanilla store and the composed runtime/command API.
// Components read state through `useVizStore` and invoke `runtime.commands`.
export const RuntimeContext = createContext(null);

export function useRuntime() {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error('useRuntime must be used within RuntimeContext.Provider');
  return ctx;
}
