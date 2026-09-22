// One outstanding wakeup at most. The owner acknowledges after analysis, so a
// busy/frozen main thread cannot accumulate a backlog of stale audio ticks.
self.onmessage = () => {
  setTimeout(() => self.postMessage(null), 34);
};
