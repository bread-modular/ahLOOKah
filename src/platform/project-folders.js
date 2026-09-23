// Project directory identities.
//
// A project file travels with a stable id per linked directory (Custom Scripts,
// Node Patterns, Media) but never with a native handle: a FileSystemDirectoryHandle
// cannot leave the origin it was granted in, and it cannot be written to JSON at
// all. So the handle is kept here, in IndexedDB, under that id.
//
// Reopening a project on the SAME computer therefore resolves each directory by
// identity — no re-picking — while any other computer (or a wiped profile) has no
// record for the id, which is exactly how "this directory is not available here"
// is detected before the operator is asked to link it again.
//
// The current id per section lives in localStorage (`viz2_project_folders`); it is
// machine-local bookkeeping and is deliberately NOT part of a settings/project
// export — the exported `folders[section].folderId` is the transport field.
import { createHandleStorage } from './handleStorage.js';
import { folderReference, patchFolderReference, confirmFolderReference } from './folderReferences.js';

export const PROJECT_FOLDERS_KEY = 'viz2_project_folders';
export const FOLDER_ID_PATTERN = /^[\w-]{1,100}$/;
// One record per linked directory per project; the cap only bounds long-term
// churn (every relink to a new directory adds a record).
const MAX_REMEMBERED_FOLDERS = 200;
const INDEX_KEY = '__index';
const IDENTITY_LOCK = 'viz2-project-folders-identity';

const storage = createHandleStorage('viz2-project-folders');
const locked = (work) => globalThis.navigator?.locks?.request(IDENTITY_LOCK, work) || work();

async function sameDirectory(left, right) {
  if (!left || !right || typeof left.isSameEntry !== 'function') return false;
  try { return await left.isSameEntry(right); } catch { return false; }
}

export function newFolderId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* noop */ }
  return `p${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function validFolderId(value) {
  return typeof value === 'string' && FOLDER_ID_PATTERN.test(value) && value !== INDEX_KEY;
}

// Remember `handle` under `id` only if the id is unclaimed or already belongs
// to this physical directory. A handle that cannot be structured-cloned (an
// exotic host, a test double) is remembered without a native handle; it must be
// explicitly adopted on import rather than guessed from its basename later.
async function rememberUnlocked(id, section, handle) {
  if (!validFolderId(id) || !SECTIONS.has(section) || !handle) return false;
  let existing;
  try { existing = await storage(id); } catch { return false; } // Never overwrite after an uncertain read.
  if (existing && (existing.section !== section ||
      (existing.handle && !await sameDirectory(existing.handle, handle)))) return false;
  const record = {
    id,
    section,
    name: typeof handle.name === 'string' ? handle.name.slice(0, 255) : '',
    savedAt: Date.now(),
  };
  try {
    await storage(id, { ...record, handle });
  } catch {
    // A failed refresh of the SAME entry must not discard its old, usable
    // remembered handle merely because this write/clone failed.
    if (existing?.handle) return true;
    try { await storage(id, { ...record, handle: null }); } catch { return false; }
  }
  try {
    const ids = await rememberedIds();
    const next = [id, ...ids.filter((value) => value !== id)].slice(0, MAX_REMEMBERED_FOLDERS);
    for (const dropped of ids.filter((value) => !next.includes(value))) await storage(dropped, null);
    await storage(INDEX_KEY, next);
  } catch { /* the record itself is what matters; the index only bounds churn */ }
  return true;
}

export async function rememberProjectFolder(id, section, handle) {
  return locked(() => rememberUnlocked(id, section, handle));
}

async function rememberedIds() {
  try {
    const value = await storage(INDEX_KEY);
    return Array.isArray(value) ? value.filter(validFolderId) : [];
  } catch { return []; }
}

export async function recallProjectFolder(id, { strict = false } = {}) {
  if (!validFolderId(id)) return null;
  try {
    const record = await storage(id);
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch (error) {
    // Import must distinguish an unavailable database from an unknown id.
    if (strict) throw error;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Current identity per section (localStorage — never exported)
// ---------------------------------------------------------------------------
export const PROJECT_SECTIONS = ['scripts', 'nodes', 'media'];
const SECTIONS = new Set(PROJECT_SECTIONS);

function loadIdentities() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROJECT_FOLDERS_KEY));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const clean = {};
    for (const section of PROJECT_SECTIONS) {
      const entry = raw[section];
      if (!entry || typeof entry !== 'object') continue;
      const id = validFolderId(entry.id) ? entry.id : null;
      const name = typeof entry.name === 'string' && entry.name.length <= 255 ? entry.name : '';
      if (id) clean[section] = { id, name };
    }
    return clean;
  } catch {
    return {};
  }
}

function saveIdentities(identities) {
  try {
    if (Object.keys(identities).length) localStorage.setItem(PROJECT_FOLDERS_KEY, JSON.stringify(identities));
    else localStorage.removeItem(PROJECT_FOLDERS_KEY);
    return true;
  } catch {
    return false;
  }
}

export function projectFolderIdentity(section) {
  if (!SECTIONS.has(section)) return null;
  return loadIdentities()[section] || null;
}

export function projectFolderId(section) {
  return projectFolderIdentity(section)?.id || null;
}

// Bind a section to a directory identity — a known handle's id, an explicitly
// adopted imported id, or a fresh id for an ordinary link to a new directory.
// The remembered handle for a different physical directory is never overwritten.
export function bindProjectFolder(section, id, name = '') {
  if (!SECTIONS.has(section) || !validFolderId(id)) return null;
  const identities = loadIdentities();
  const clean = typeof name === 'string' ? name.slice(0, 255) : '';
  identities[section] = { id, name: clean || identities[section]?.name || '' };
  return saveIdentities(identities) ? identities[section] : null;
}

export function clearProjectFolder(section) {
  if (!SECTIONS.has(section)) return;
  const identities = loadIdentities();
  if (!identities[section]) return;
  delete identities[section];
  saveIdentities(identities);
}

// New Project: forget the current identity map. Remembered handles stay in
// IndexedDB (bounded, keyed by id) so an older project file can still resume its
// directories on this computer without re-linking.
export function clearProjectFolders() {
  return saveIdentities({});
}

// Ordinary links reuse an id only after comparing actual handles (including
// remembered directories from earlier projects). An explicit id is ONLY for the
// confirmed import/relink flow: an unresolved foreign id may be claimed here, but
// even confirmation cannot overwrite a different directory's existing handle.
export async function ensureProjectFolder(section, handle, id = null) {
  if (!SECTIONS.has(section) || !handle) return null;
  return locked(async () => {
    let nextId = null;
    if (validFolderId(id)) {
      const existing = await recallProjectFolder(id);
      if (existing && (existing.section !== section ||
          (existing.handle && !await sameDirectory(existing.handle, handle)))) {
        throw new Error('Project folder identity already belongs to another directory.');
      }
      nextId = id;
    } else {
      const current = projectFolderId(section);
      const remembered = current ? await recallProjectFolder(current) : null;
      if (remembered?.section === section && await sameDirectory(remembered.handle, handle)) nextId = current;
      if (!nextId) {
        for (const candidate of await rememberedIds()) {
          if (candidate === current) continue;
          const record = await recallProjectFolder(candidate);
          if (record?.section === section && await sameDirectory(record.handle, handle)) {
            nextId = candidate;
            break;
          }
        }
      }
      nextId ||= newFolderId();
    }
    if (!await rememberUnlocked(nextId, section, handle)) throw new Error('Could not remember project folder identity.');
    return bindProjectFolder(section, nextId, handle.name);
  });
}

// Called only after a section's user-initiated picker succeeds. Pending imports
// explicitly adopt their id; ordinary replacement may choose any folder name,
// but must drop file references inherited from a *different* directory. A fresh
// same-entry handle keeps both its directory id and its file references.
export async function registerLinkedProjectFolder(section, handle, previousHandle = null) {
  const ref = folderReference(section);
  const remembered = ref?.folderId ? await recallProjectFolder(ref.folderId) : null;
  const referenceHandle = (remembered?.section === section && remembered.handle) || previousHandle;
  const sameReference = await sameDirectory(referenceHandle, handle);
  const identity = await ensureProjectFolder(section, handle, ref?.needsRelink ? ref.folderId : null);
  if (ref && identity) {
    patchFolderReference(section, {
      folderName: handle.name,
      folderId: identity.id,
      ...(!ref.needsRelink && !sameReference ? { files: [] } : {}),
    });
    confirmFolderReference(section);
  }
  return identity;
}
