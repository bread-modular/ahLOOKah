// Role parsing and per-window identity. Nodes is an independent editor role;
// only screen/control roles enter the main application runtime and leases.
import { TAB_ID_KEY } from './constants.js';

export function resolveRole(search = window.location.search) {
  const role = new URLSearchParams(search).get('role');
  return role === 'nodes' || role === 'screen' ? role : 'control';
}

export function createWindowIdentity(search = window.location.search) {
  const role = resolveRole(search);
  const windowId = Math.random().toString(36).slice(2);
  const bootTime = Date.now();

  let tabId = null;
  try {
    tabId = sessionStorage.getItem(TAB_ID_KEY);
    if (!tabId) {
      tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(TAB_ID_KEY, tabId);
    }
  } catch {
    tabId = windowId;
  }

  return { role, windowId, tabId, bootTime };
}
