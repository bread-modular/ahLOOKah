// Centralized teardown for pagehide/unload/HMR. Services register disposers and
// one dispose() releases them all exactly once.
export function createWindowLifecycle({ onDispose }) {
  const disposers = [];
  let disposed = false;

  function trackListener(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    disposers.push(() => target.removeEventListener(type, handler, opts));
  }

  function track(fn) {
    disposers.push(fn);
    return fn;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    disposers.splice(0).forEach((fn) => { try { fn(); } catch { /* noop */ } });
    if (onDispose) onDispose();
  }

  return { trackListener, track, dispose, get disposed() { return disposed; } };
}
