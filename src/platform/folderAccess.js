// Shared browser filesystem backend. Feature repositories own their transactions
// and content semantics; all folder picking, permissions and filtering live here.

// Brave ships the File System Access entry points switched off, so "no picker" is
// not the same as "unsupported browser": the capability report has to say which
// browser is talking before it can say what to do about it. Chrome, Edge, Chromium
// and Opera expose the API normally; Brave needs its own flag and a relaunch, which
// is offered as something to try — never as a guaranteed supported path.
const SUPPORTED_BROWSERS = 'Chrome, Edge, Chromium or Opera';
export const FILE_SYSTEM_ACCESS_FLAG = 'brave://flags/#file-system-access-api';

// One short, actionable sentence per cause — no explanation. The Brave sentence
// names the fix but not the flag URL: a page cannot navigate Chromium to `brave://`,
// so the URL lives in the support modal (FolderSupportModal), which offers copy.
export function folderSupportMessage(reason, label = 'Folders') {
  const subject = label.toLowerCase();
  if (reason === 'insecure-context') return `Open ${subject} over HTTPS or localhost.`;
  if (reason === 'brave-disabled') return `Brave blocks ${subject}. Enable File System Access, then relaunch Brave.`;
  return `Use ${SUPPORTED_BROWSERS} to link ${subject}.`;
}

// Only Brave defines `navigator.brave`, and its `isBrave()` answers with a Promise
// (it cannot be awaited from a synchronous capability check), so a thenable — or a
// plain `true` — counts as Brave and an explicit `false` does not.
function isBrave(scope) {
  const brave = scope?.navigator?.brave;
  if (typeof brave?.isBrave !== 'function') return false;
  const answer = brave.isBrave();
  return answer === true || typeof answer?.then === 'function';
}

// Why a picker is missing, as a code the UI can word precisely, or `null` when the
// requested entry point exists. Pure over the passed scope (and picker name), so it
// is unit-testable without a browser.
export function folderCapability(picker = 'showDirectoryPicker', scope = globalThis) {
  if (!scope?.isSecureContext) return 'insecure-context';
  if (typeof scope[picker] === 'function') return null;
  if (isBrave(scope)) return 'brave-disabled';
  return 'unsupported-browser';
}

export function folderSupportError(label = 'Folders', picker = 'showDirectoryPicker', scope = globalThis) {
  const reason = folderCapability(picker, scope);
  return reason ? folderSupportMessage(reason, label) : '';
}

// What the UI needs to react to a missing picker: the cause, the sentence to show and
// — only for Brave, where a flag exists — the URL to copy. `null` means nothing to
// show. Pure over the passed scope (and picker name) like `folderCapability`.
export function folderSupportInfo(label = 'Folders', picker = 'showDirectoryPicker', scope = globalThis) {
  const reason = folderCapability(picker, scope);
  if (!reason) return null;
  return {
    code: reason,
    message: folderSupportMessage(reason, label),
    flagUrl: reason === 'brave-disabled' ? FILE_SYSTEM_ACCESS_FLAG : null,
  };
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
