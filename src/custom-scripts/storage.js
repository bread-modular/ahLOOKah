import { createHandleStorage } from '../platform/handleStorage.js';
export const scriptStorage = createHandleStorage('viz2-custom-scripts');
export function supportError() {
  if (!globalThis.isSecureContext) return 'Use HTTPS or localhost to choose a scripts folder.';
  if (typeof globalThis.showDirectoryPicker !== 'function') return 'Custom Scripts requires desktop Chrome with File System Access. No upload fallback is used.';
  return '';
}
