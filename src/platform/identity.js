// Role parsing and per-window identity. Only `?role=screen` selects the screen;
// every other URL (including `/` and `/?role=control`) is a control window.
import { TAB_ID_KEY } from './constants.js';

export function resolveRole(search = window.location.search) {
  return new URLSearchParams(search).get('role') === 'screen' ? 'screen' : 'control';
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
