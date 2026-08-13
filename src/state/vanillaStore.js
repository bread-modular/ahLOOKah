// Minimal in-house vanilla store. A faithful drop-in replacement for the
// `zustand/vanilla` `createStore` primitive this app previously used, covering
// exactly the API surface the runtime and `useVizStore` rely on:
//
//   store.getState()            -> current state snapshot
//   store.setState(partial)     -> shallow-merge an object, or apply a
//                                  function updater (s) => next
//   store.setState(partial, replace) -> replace instead of merge
//   store.subscribe(listener)   -> unsubscribe fn; listener is called as
//                                  (state, previousState) on every change
//   store.getInitialState()     -> initial state snapshot
//
// Semantics intentionally mirror zustand/vanilla:
//   - Object.is bail-out: listeners fire only when the next state identity
//     differs from the current one.
//   - Object partials are shallow-merged (Object.assign); non-object/null
//     values (or `replace` truthy) replace the state outright.
//   - Listeners are a Set, so each listener is invoked once per change.

const createStoreImpl = (createState) => {
  let state;
  const listeners = new Set();

  const setState = (partial, replace) => {
    const nextState = typeof partial === 'function' ? partial(state) : partial;
    if (!Object.is(nextState, state)) {
      const previousState = state;
      state =
        (replace != null ? replace : typeof nextState !== 'object' || nextState === null)
          ? nextState
          : Object.assign({}, state, nextState);
      listeners.forEach((listener) => listener(state, previousState));
    }
  };

  const getState = () => state;
  const getInitialState = () => initialState;

  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const api = { setState, getState, getInitialState, subscribe };
  const initialState = (state = createState(setState, getState, api));
  return api;
};

export const createStore = (createState) =>
  createState ? createStoreImpl(createState) : createStoreImpl;
