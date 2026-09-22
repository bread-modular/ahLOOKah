import { folderSupportError } from '../platform/folderAccess.js';
import { createHandleStorage } from '../platform/handleStorage.js';
export const scriptStorage = createHandleStorage('viz2-custom-scripts');
export function supportError() {
  return folderSupportError('Custom Scripts');
}
