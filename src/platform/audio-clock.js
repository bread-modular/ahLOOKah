// Capture analysis is not visual work: it must not depend on the owner's rAF.
// A worker wakeup keeps the existing analyser/control bus ticking while another
// tab renders. This is best effort, not protection from browser/OS suspension.
export function createAudioClock(tick) {
  let worker = null, timer = null, running = false;
  const fallback = () => {
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      if (!running) return;
      try { tick(performance.now()); } finally { fallback(); }
    }, 34);
  };
  const stop = () => {
    running = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    worker?.terminate();
    worker = null;
  };
  return {
    start() {
      if (running) return;
      running = true;
      try {
        const clock = new Worker(new URL('./audio-clock.worker.js', import.meta.url), { type: 'module' });
        worker = clock;
        clock.onmessage = () => {
          if (!running || worker !== clock) return;
          try { tick(performance.now()); } finally {
            if (running && worker === clock) clock.postMessage(null);
          }
        };
        clock.onerror = () => {
          if (!running || worker !== clock) return;
          clock.terminate(); worker = null;
          // CSP/unsupported workers: retain foreground operation; background
          // document timers can be heavily throttled in this degraded mode.
          fallback();
        };
        clock.postMessage(null);
      } catch {
        worker?.terminate(); worker = null;
        fallback();
      }
    },
    stop,
  };
}
