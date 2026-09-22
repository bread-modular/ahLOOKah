// Shared browser filesystem backend. Feature repositories own their transactions
// and content semantics; all folder picking, permissions and filtering live here.
export function folderSupportError(label = 'Folders') {
  if (!globalThis.isSecureContext) return `${label} require HTTPS or localhost.`;
  if (typeof globalThis.showDirectoryPicker !== 'function') return `${label} require desktop Chrome with File System Access.`;
  return '';
}

export async function folderPermission(handle, mode = 'read', request = false) {
  if (!handle) throw new Error('Link a folder first.');
  let value = await handle.queryPermission({ mode });
  if (value !== 'granted' && request) value = await handle.requestPermission({ mode });
  return value;
}

export async function requireFolderPermission(handle, mode = 'read', request = false) {
  const value = await folderPermission(handle, mode, request);
  if (value !== 'granted') throw new Error('Permission denied or expired. Click Refresh folder to reconnect, or Link Folder again.');
  return value;
}

export async function chooseFolder({ id, mode = 'read', label } = {}) {
  const error = folderSupportError(label);
  if (error) throw new Error(error);
  // Keep native prompts outside work queues: called directly from a gesture.
  const handle = await globalThis.showDirectoryPicker({ id, mode });
  if (!handle) throw new DOMException('Canceled', 'AbortError');
  await requireFolderPermission(handle, mode, true);
  return handle;
}

export async function scanFolder(handle, { accepts, limit = 256, onLimit } = {}) {
  const entries = [];
  for await (const [name, file] of handle.entries()) {
    if (file.kind !== 'file' || !accepts(name)) continue;
    if (entries.length >= limit) {
      if (onLimit) { onLimit(); break; }
      throw new Error(`Folder: maximum ${limit} matching files`);
    }
    entries.push({ name, handle: file });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// Resolve only a supported direct child; never accept paths from a UI/export.
export async function linkedFile(handle, name, accepts) {
  if (typeof name !== 'string' || !name || /[\\/]/.test(name) || !accepts(name)) throw new Error('Choose a supported file inside the linked folder.');
  try { return await handle.getFileHandle(name); }
  catch (error) { throw new Error(`${name}: ${error.message}. Refresh folder or Relink Folder.`); }
}
