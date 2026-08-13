// BroadcastChannel wrapper. Preserves the original semantics: add `windowId`,
// post to the channel, then dispatch the same complete message locally because
// BroadcastChannel does not echo to its sender.
export function createBroadcastBus(channelName, { windowId, handleMessage }) {
  const channel = new BroadcastChannel(channelName);

  function broadcast(msg) {
    const full = { ...msg, windowId };
    channel.postMessage(full);
    handleMessage(full);
  }

  channel.onmessage = (e) => handleMessage(e.data || {});

  return {
    broadcast,
    post(msg) {
      channel.postMessage({ ...msg, windowId });
    },
    close() {
      try { channel.close(); } catch { /* noop */ }
    },
    get channel() { return channel; },
  };
}
