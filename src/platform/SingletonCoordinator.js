// Singleton enforcement: one control + one screen per browser. Uses a
// BroadcastChannel handshake + localStorage lease so both simultaneous opens and
// direct-URL tabs are blocked, while a reload of the same tab (same TAB_ID via
// sessionStorage) is allowed to reclaim ownership.
import { SINGLETON_KEY, SINGLETON_LEASE_MS, SINGLETON_HEARTBEAT_MS } from './constants.js';

export function createSingletonCoordinator({ role, windowId, tabId, bootTime, channel }) {
  let heartbeatTimer = 0;
  let isOwner = false;

  function getKey() {
    return role === 'screen' ? SINGLETON_KEY.screen : SINGLETON_KEY.control;
  }

  function readLease() {
    try {
      const raw = localStorage.getItem(getKey());
      if (!raw) return null;
      const lease = JSON.parse(raw);
      if (!lease || typeof lease.tabId !== 'string' || typeof lease.expires !== 'number') return null;
      if (lease.expires <= Date.now()) {
        try { localStorage.removeItem(getKey()); } catch { /* noop */ }
        return null;
      }
      return lease;
    } catch { return null; }
  }

  function writeLease() {
    try {
      const lease = { tabId, windowId, bootTime, expires: Date.now() + SINGLETON_LEASE_MS };
      localStorage.setItem(getKey(), JSON.stringify(lease));
    } catch { /* noop */ }
  }

  function clearLease() {
    try {
      const cur = readLease();
      if (cur && cur.tabId === tabId) localStorage.removeItem(getKey());
    } catch { /* noop */ }
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    writeLease();
    isOwner = true;
    heartbeatTimer = setInterval(() => writeLease(), SINGLETON_HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = 0;
    isOwner = false;
  }

  function enforce() {
    return new Promise((resolve) => {
      const claims = [];
      const alives = [];
      const handler = (e) => {
        const msg = e.data || {};
        if (!msg || msg.role !== role) return;
        if (msg.type === 'singleton-claim' && msg.windowId !== windowId && msg.tabId !== tabId) {
          claims.push(msg);
        } else if (msg.type === 'singleton-alive' && msg.windowId !== windowId && msg.tabId !== tabId) {
          alives.push(msg);
        }
      };
      channel.addEventListener('message', handler);
      const existingLease = readLease();
      try {
        channel.postMessage({ type: 'singleton-claim', role, windowId, tabId, bootTime });
      } catch { /* noop */ }
      setTimeout(() => {
        channel.removeEventListener('message', handler);
        if (existingLease && existingLease.tabId !== tabId) {
          const cur = readLease();
          if (cur && cur.tabId !== tabId && cur.expires > Date.now()) {
            resolve(false);
            return;
          }
        }
        if (alives.length > 0) {
          resolve(false);
          return;
        }
        if (claims.length > 0) {
          const all = [{ windowId, tabId, bootTime }, ...claims];
          all.sort((a, b) => a.bootTime !== b.bootTime ? a.bootTime - b.bootTime : (a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0));
          if (all[0].windowId !== windowId) {
            resolve(false);
            return;
          }
        }
        const lateLease = readLease();
        if (lateLease && lateLease.tabId !== tabId) {
          resolve(false);
          return;
        }
        resolve(true);
      }, 420);
    });
  }

  return {
    readLease,
    writeLease,
    clearLease,
    startHeartbeat,
    stopHeartbeat,
    enforce,
    get isOwner() { return isOwner; },
    get key() { return getKey(); },
  };
}
