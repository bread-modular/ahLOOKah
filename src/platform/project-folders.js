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

export const PROJECT_FOLDERS_KEY = 'viz2_project_folders';
export const FOLDER_ID_PATTERN = /^[\w-]{1,100}$/;
// One record per linked directory per project; the cap only bounds long-term
// churn (every relink to a new directory adds a record).
const MAX_REMEMBERED_FOLDERS = 200;
const INDEX_KEY = '__index';

const storage = createHandleStorage('viz2-project-folders');

export function newFolderId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* noop */ }
  return `p${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function validFolderId(value) {
  return typeof value === 'string' && FOLDER_ID_PATTERN.test(value) && value !== INDEX_KEY;
}

// Remember `handle` under `id`. A handle that cannot be structured-cloned (an
// exotic host, a test double) is still remembered as an identity without a
// native handle, so recall can report "remembered here, but not reachable"
// instead of pretending the directory was never used.
export async function rememberProjectFolder(id, section, handle) {
  if (!validFolderId(id) || !handle) return false;
  const record = {
    id,
    section: typeof section === 'string' ? section : '',
    name: typeof handle.name === 'string' ? handle.name.slice(0, 255) : '',
    savedAt: Date.now(),
  };
  try {
    await storage(id, { ...record, handle });
  } catch {
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

async function rememberedIds() {
  try {
    const value = await storage(INDEX_KEY);
    return Array.isArray(value) ? value.filter(validFolderId) : [];
  } catch { return []; }
}

export async function recallProjectFolder(id) {
  if (!validFolderId(id)) return null;
  try {
    const record = await storage(id);
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch { return null; }
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

// Bind a section to a directory identity — the project file's id on import, or a
// fresh id the first time a folder is linked. The identity is intentionally NOT
// regenerated on relink: the project keeps pointing at "this project's scripts
// directory", which is what makes the same file reusable on another machine.
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

// Ensure the section owns an identity and that its handle is reachable by id on
// this computer. Called when a folder is linked and again on export, so an
// already-linked folder (from before this feature, or after a pruned record) is
// registered under the id the project file will carry.
export async function ensureProjectFolder(section, handle, id = null) {
  if (!handle) return null;
  const nextId = validFolderId(id) ? id : projectFolderId(section) || newFolderId();
  const identity = bindProjectFolder(section, nextId, handle.name);
  await rememberProjectFolder(nextId, section, handle);
  return identity;
}
