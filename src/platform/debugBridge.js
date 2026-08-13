// Development `window.__viz` debug facade. The full getter-based facade is only
// installed in DEV; a minimal safe stub is installed early (before the async
// singleton handshake) so waitForFunction predicates never throw on a blocked or
// still-booting page. The stub mirrors the legacy `initEarlyViz` surface,
// including the noise/eq/cue getters that tests read immediately after reload.
export function installEarlyVizStub(getters = {}) {
  try {
    const prev = window.__viz || {};
    window.__viz = prev;
    const early = window.__viz;
    for (const [name, fn] of Object.entries(getters)) {
      if (!(name in early)) {
        try {
          Object.defineProperty(early, name, { get: fn, configurable: true });
        } catch { /* noop */ }
      }
    }
  } catch { /* noop */ }
}

export function installDebugBridge(getters, extras = {}) {
  if (!import.meta.env.DEV) return;
  window.__viz = {};
  for (const [name, fn] of Object.entries(getters)) {
    Object.defineProperty(window.__viz, name, { get: fn, configurable: true, enumerable: true });
  }
  // Non-getter entries: live mutable references and callable methods.
  for (const [name, value] of Object.entries(extras)) {
    window.__viz[name] = value;
  }
}

// Mark the page blocked for the minimal facade.
export function markVizBlocked(role) {
  try {
    window.__viz = window.__viz || {};
    window.__viz.singletonBlocked = true;
    window.__viz.singletonError = true;
    window.__viz.role = role;
    window.__vizSingletonError = window.__vizSingletonError || { role };
  } catch { /* noop */ }
}
