import { collectFolderReferences, applyFolderReferences } from './folder-portability.js';
import { sanitizeFolderReferences, FOLDER_REFERENCES_KEY } from './folderReferences.js';
import { PROJECT_FOLDERS_KEY } from './project-folders.js';
import { createHandleStorage } from './handleStorage.js';
import { scriptStorage } from '../custom-scripts/storage.js';
// Project save / load — move a whole ahLOOKah project (every persisted setting
// plus its library references and linked-directory identities) from one browser
// or machine to another as a single JSON file.
//
// The app menu drives this module:
//   * Save Project   — write the project to a file the operator picks (location
//                      and file name), falling back to a download.
//   * Open Project   — replace this browser's project with such a file.
//   * New Project    — clear everything project-scoped back to a fresh browser.
//
// What travels:
//   * every persisted setting in localStorage (params, pad order, EQ/noise
//     floor, screen calibration, projection layouts, device choices, panel
//     layout state), stored verbatim so the round-trip is lossless.
//   * media *metadata only* (id, display name, kind, mime, size, addedAt and
//     the file's name). Media bytes are never copied, and a
//     FileSystemFileHandle cannot leave the origin it was granted in, so
//     imported media patterns stay listed but must be re-linked to a local
//     file before they render (see media/media-store.js).
//   * the identity of each linked directory (Custom Scripts, Node Patterns,
//     Media) — a `folderId`, never a native handle. On the computer the project
//     was exported from that id resolves to the already-linked directory, so
//     switching between projects never asks to re-link what is already linked.
//     Anywhere else the id has no record and the operator is asked to link it.
//
// What never travels: per-window/session keys (tab id, singleton leases, audio
// capture lease). Those are runtime coordination, not project state.
import { STORAGE } from './constants.js';
import { MEDIA_STORAGE_KEY, sanitizeMediaMeta } from '../media/media-registry.js';
import { PROJECTION_STORAGE_KEY } from '../projection/projection-registry.js';
import { listMediaRecords, replaceMediaRecords, restoreMediaRecords, putMediaRecord, isMediaLinked } from '../media/media-store.js';

const nodesStorage = createHandleStorage('viz2-node-patterns');
const mediaFolderStorage = createHandleStorage('viz2-media-folder');
const PROJECT_LOCAL_KEYS = [FOLDER_REFERENCES_KEY, PROJECT_FOLDERS_KEY];
let recoverySnapshot = null; // Retained if a persistent failure prevents rollback in this tab.

function withProjectLock(work) {
  if (!navigator.locks?.request) return work();
  return navigator.locks.request('viz2-project-import', { ifAvailable: true }, (lock) => {
    if (!lock) throw new Error('Another project import is already in progress.');
    return work();
  });
}

export const SETTINGS_FILE_KIND = 'ahlookah-project';
// Pre-project exports used this kind; they still load (without directory
// identities, so every linked folder is confirmed by hand, as before).
export const LEGACY_SETTINGS_FILE_KIND = 'ahlookah-settings';
export const SETTINGS_FILE_VERSION = 2;

const APP_ID = 'ahlookah';
const MAX_FILE_CHARS = 4_000_000;
const MAX_STORAGE_VALUE_CHARS = 1_000_000;
const MAX_MEDIA_ENTRIES = 256;
const MAX_MEDIA_FILE_NAME_CHARS = 255;

// Persisted settings, in a fixed order. Ephemeral coordination keys
// (viz2_tab_id, viz2_singleton_*, viz2_audio_capture_lease) are deliberately
// absent — importing them would make one window think another owns a lease.
// The per-machine directory identities (viz2_project_folders) are absent too:
// the project file carries the ids that matter, and the local map must never be
// overwritten from another computer.
export const SETTINGS_STORAGE_KEYS = Object.freeze([
  STORAGE.params,
  STORAGE.slotOrder,
  STORAGE.effectOrder,
  STORAGE.noiseFloor,
  STORAGE.audio,
  STORAGE.video,
  STORAGE.deviceSetupDone,
  STORAGE.bandEqOpen,
  STORAGE.postFxOpen,
  STORAGE.libraryCollapsed,
  STORAGE.libraryFavourites,
  STORAGE.screenMapping,
  STORAGE.screenMappingEnabled,
  STORAGE.screenMappingEdgeBlur,
  STORAGE.screenMappingOpen,
  MEDIA_STORAGE_KEY,
  PROJECTION_STORAGE_KEY,
]);

const SETTINGS_KEY_SET = new Set(SETTINGS_STORAGE_KEYS);

function pad2(value) {
  return String(value).padStart(2, '0');
}

// Local-date file name so an operator with several projects can tell them apart.
export function projectFileName(now = new Date()) {
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return `ahlookah-project-${stamp}.json`;
}

function mediaEntryFromRecord(record) {
  const base = sanitizeMediaMeta(record);
  if (!base) return null;
  return {
    ...base,
    folderName: typeof record.folderName === 'string' && record.folderName.length <= 255 && !/[\\/\x00-\x1f]/.test(record.folderName) ? record.folderName : null,
    mime: typeof record.mime === 'string' ? record.mime.slice(0, 100) : '',
    size: Number.isFinite(record.size) ? record.size : null,
    addedAt: Number.isFinite(record.addedAt) ? record.addedAt : Date.now(),
    fileName: typeof record.fileName === 'string' && record.fileName.trim()
      ? record.fileName.trim().slice(0, MAX_MEDIA_FILE_NAME_CHARS)
      : null,
  };
}

function readLocal(keys) {
  return Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]));
}

function writeLocal(key, value) {
  if (localStorage.getItem(key) === value) return false;
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  // Storage adapters and quota failures must never turn a skipped write into a success.
  if (localStorage.getItem(key) !== value) throw new Error(`localStorage did not persist ${key}.`);
  return true;
}

// Read *all* recovery material before touching live project state. This includes
// native handles and full media records, not just the metadata that travels in JSON.
async function snapshotProject() {
  return {
    local: readLocal([...SETTINGS_STORAGE_KEYS, ...PROJECT_LOCAL_KEYS]),
    scripts: await scriptStorage('active'),
    scriptFolder: await scriptStorage('folder'),
    nodes: await nodesStorage('handles'),
    mediaFolder: await mediaFolderStorage('folder'),
    media: await listMediaRecords(),
  };
}

async function restoreProject(snapshot, { folders = true, media = true } = {}) {
  const failures = [];
  const attempt = async (name, fn) => {
    try { await fn(); } catch (error) { failures.push(`${name}: ${error.message}`); }
  };
  if (folders) {
    await attempt('Custom Scripts', () => scriptStorage('active', snapshot.scripts ?? null));
    await attempt('Scripts folder', () => scriptStorage('folder', snapshot.scriptFolder ?? null));
    await attempt('Node Patterns', () => nodesStorage('handles', snapshot.nodes ?? null));
    await attempt('Media folder', () => mediaFolderStorage('folder', snapshot.mediaFolder ?? null));
  }
  if (media) await attempt('Media records', () => restoreMediaRecords(snapshot.media));
  for (const [key, value] of Object.entries(snapshot.local)) {
    await attempt(key, () => writeLocal(key, value));
  }
  return failures;
}

// When a storage provider stays unavailable even during rollback, do not start
// another import over a mixed project. Keep the snapshot in this tab for an
// explicit retry once storage works again; no success or peer reload is emitted.
export function recoverProjectState() {
  return withProjectLock(recoverProjectStateLocked);
}

async function recoverProjectStateLocked() {
  if (!recoverySnapshot) return { ok: true, recovered: false };
  const failures = await restoreProject(recoverySnapshot);
  if (!failures.length) recoverySnapshot = null;
  return { ok: !failures.length, recovered: !failures.length, failures };
}

// Snapshot persisted settings and portable library references. Inaccessible
// settings/media must fail Save rather than yield an incomplete project file.
export async function collectSettings() {
  const storage = {};
  for (const [key, value] of Object.entries(readLocal(SETTINGS_STORAGE_KEYS))) {
    if (value !== null) {
      if (value.length > MAX_STORAGE_VALUE_CHARS) throw new Error(`Setting ${key} is too large to save.`);
      storage[key] = value;
    }
  }
  const records = await listMediaRecords();
  if (records.length > MAX_MEDIA_ENTRIES) throw new Error('Too many media records to save as one project.');
  const media = records.map(mediaEntryFromRecord);
  if (media.some(value => !value)) throw new Error('A media record cannot be saved.');
  return {
    app: APP_ID,
    kind: SETTINGS_FILE_KIND,
    version: SETTINGS_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    storage,
    media,
    folders: await collectFolderReferences(media),
  };
}

export function serializeSettings(payload) {
  const text = JSON.stringify(payload, null, 2);
  if (text.length > MAX_FILE_CHARS) throw new Error('Project is too large to save as one file.');
  return text;
}

export function downloadSettingsFile(text, fileName) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// Save Project — the browser picks the location and the file name
// ---------------------------------------------------------------------------

// File System Access save picker. Without it (Firefox/Safari, some embedded
// webviews) Save Project falls back to a plain download of the same file.
export function canUseSaveFilePicker() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

// Ask for a destination. This must run inside the click that started the save —
// before collecting the (slower) project snapshot — so the browser's user
// activation is still valid. Rejects with AbortError when the picker is dismissed.
export async function pickProjectSaveTarget(fileName) {
  return window.showSaveFilePicker({
    id: 'ahlookah-project',
    suggestedName: fileName,
    types: [{ description: 'ahLOOKah project', accept: { 'application/json': ['.json'] } }],
  });
}

// Write the serialized project through a picked handle. A failed write aborts the
// stream, so a half-written project file never stays on disk.
export async function writeProjectText(handle, text) {
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch { /* already closed */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// New Project
// ---------------------------------------------------------------------------

// Keys that describe this machine rather than the project: the device choices and
// the one-time setup gate survive New Project, so starting fresh never asks the
// operator to re-pick a camera or re-run setup.
const MACHINE_KEY_SET = new Set([STORAGE.audio, STORAGE.video, STORAGE.deviceSetupDone]);

// New Project: forget everything project-scoped — settings, media patterns, the
// portable folder hints and the current directory identities. Linked handles are
// cleared by the section services as they unlink; the remembered-handle registry
// is deliberately left alone, so an older project file still resumes its folders
// on this computer without re-linking.
export function clearProject() {
  return withProjectLock(clearProjectLocked);
}

async function clearProjectLocked() {
  if (recoverySnapshot) throw new Error('Recover the previous project before starting a new one.');
  const before = await snapshotProject();
  let storageCleared = 0;
  let mediaTouched = false;
  try {
    for (const key of SETTINGS_STORAGE_KEYS) {
      if (!MACHINE_KEY_SET.has(key) && writeLocal(key, null)) storageCleared += 1;
    }
    writeLocal(FOLDER_REFERENCES_KEY, null);
    writeLocal(PROJECT_FOLDERS_KEY, null); // Remembered directory registry is separate IDB.
    mediaTouched = true;
    await replaceMediaRecords([]);
    return { storageCleared, mediaCleared: before.media.length };
  } catch (error) {
    const rollbackFailures = await restoreProject(before, { folders: false, media: mediaTouched });
    if (rollbackFailures.length) recoverySnapshot = before;
    throw projectCommitError(error, rollbackFailures);
  }
}

// Validate a picked file. Returns { ok: true, payload } or { ok: false, error }.
// Every accepted field is re-sanitized so a hand-edited file can never write
// an unexpected key or an oversized value.
export function parseSettingsFile(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'The file is empty.' };
  if (text.length > MAX_FILE_CHARS) return { ok: false, error: 'The file is too large to be an ahLOOKah project file.' };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'That file is not an ahLOOKah project file.' };
  }
  if (raw.app !== APP_ID || (raw.kind !== SETTINGS_FILE_KIND && raw.kind !== LEGACY_SETTINGS_FILE_KIND)) {
    return { ok: false, error: 'That file was not exported by ahLOOKah.' };
  }
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    return { ok: false, error: 'The project file has an unrecognized version.' };
  }
  if (raw.version > SETTINGS_FILE_VERSION) {
    return { ok: false, error: `The project file was written by a newer ahLOOKah version (v${raw.version}).` };
  }

  const storage = {};
  const source = raw.storage;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, error: 'The settings section of the file is missing or malformed.' };
  }
  for (const [key, value] of Object.entries(source)) {
    if (!SETTINGS_KEY_SET.has(key)) continue; // Older/newer files may have other keys.
    if (typeof value !== 'string' || value.length > MAX_STORAGE_VALUE_CHARS) {
      return { ok: false, error: `Invalid or oversized setting: ${key}.` };
    }
    storage[key] = value;
  }

  const media = [];
  const seen = new Set();
  if (!Array.isArray(raw.media) || raw.media.length > MAX_MEDIA_ENTRIES) {
    return { ok: false, error: 'The media section of the file is missing, malformed or too large.' };
  }
  for (const entry of raw.media) {
    const clean = mediaEntryFromRecord(entry);
    if (!clean || seen.has(clean.id)) return { ok: false, error: 'Invalid or duplicate media record.' };
    seen.add(clean.id);
    media.push(clean);
  }

  let folders;
  try { folders = sanitizeFolderReferences(raw.folders); }
  catch (error) { return { ok: false, error: error.message }; }
  return { ok: true, payload: { storage, media, ...(folders ? { folders } : {}) } };
}

// Apply a validated payload. Replace semantics: the destination mirrors the
// source, so allowlisted settings the file omits are cleared rather than left
// behind (that is what "save this project here" means). Media records are
// replaced wholesale with metadata-only entries — then re-pointed at the adopted
// Media directory, so a project reopened on the computer it came from keeps its
// media without a single re-link.
function projectCommitError(cause, rollbackFailures) {
  const error = new Error(`Project storage failed: ${cause.message}`);
  error.cause = cause;
  error.rollbackFailures = rollbackFailures;
  error.recoveryAvailable = rollbackFailures.length > 0;
  return error;
}

// Treat a missing file as unlinked, but never mistake an IndexedDB write failure
// for a missing file. The latter must abort the whole import and trigger rollback.
async function relinkMediaStrict(folder) {
  if (!folder || typeof folder.getFileHandle !== 'function') return 0;
  let count = 0;
  for (const record of await listMediaRecords()) {
    if (record.handle || !record.fileName || record.folderName !== folder.name) continue;
    let handle;
    try {
      handle = await folder.getFileHandle(record.fileName);
      await handle.getFile();
    } catch { continue; }
    await putMediaRecord({ ...record, handle });
    count += 1;
  }
  return count;
}

// All validation and recovery reads finish before the first write. Browser
// localStorage and separate IndexedDB databases cannot share one transaction:
// on commit failure we restore their exact pre-import values/handles, and expose
// failed rollback steps instead of announcing a successful Open.
export function applySettings(payload) {
  return withProjectLock(() => applySettingsLocked(payload));
}

async function applySettingsLocked(payload) {
  const staged = parseSettingsFile(JSON.stringify({ app: APP_ID, kind: SETTINGS_FILE_KIND,
    version: SETTINGS_FILE_VERSION, storage: payload?.storage, media: payload?.media, folders: payload?.folders }));
  if (!staged.ok) throw new Error(staged.error);
  const { storage, media, folders: references } = staged.payload;
  if (recoverySnapshot) {
    const recovery = await recoverProjectStateLocked();
    if (!recovery.ok) {
      const error = new Error('Recover the previous project before opening another. Keep this tab open and retry once storage is available.');
      error.rollbackFailures = recovery.failures;
      throw error;
    }
  }
  const before = await snapshotProject();
  let foldersTouched = false;
  let mediaTouched = false;
  let storageWritten = 0;
  let storageRemoved = 0;
  try {
    for (const key of SETTINGS_STORAGE_KEYS) {
      if (Object.hasOwn(storage, key)) {
        if (writeLocal(key, storage[key])) storageWritten += 1;
      } else if (writeLocal(key, null)) storageRemoved += 1;
    }
    foldersTouched = true;
    const folders = await applyFolderReferences(references);
    mediaTouched = true;
    await replaceMediaRecords(media);
    const mediaRelinked = await relinkMediaStrict(folders.mediaFolder);
    const unlinkedMedia = await listUnlinkedMedia({ strict: true });
    // project-folders intentionally returns null on write errors. Verify the
    // identity map and portable hints so no swallowed localStorage error passes.
    const expectedIdentities = {};
    if (references) for (const section of ['scripts', 'nodes', 'media']) {
      const ref = references[section];
      if (ref.folderName && ref.folderId) expectedIdentities[section] = ref.folderId;
    }
    const identities = JSON.parse(localStorage.getItem(PROJECT_FOLDERS_KEY) || '{}');
    if (references) for (const section of ['scripts', 'nodes', 'media']) {
      const ref = references[section];
      if (!ref.folderName && identities?.[section]) throw new Error(`Folder identity was not cleared for ${section}.`);
      if (folders.pending.some(item => item.section === section && item.reason !== 'missing')) continue;
      if (ref.folderName && (!identities?.[section]?.id || identities[section].name !== ref.folderName ||
        (expectedIdentities[section] && identities[section].id !== expectedIdentities[section]))) {
        throw new Error(`Folder identity was not saved for ${section}.`);
      }
    }
    if (references && !localStorage.getItem(FOLDER_REFERENCES_KEY)) throw new Error('Folder references were not saved.');
    if (!references && localStorage.getItem(FOLDER_REFERENCES_KEY)) throw new Error('Old folder references were not cleared.');
    return {
      storageWritten, storageRemoved, mediaRestored: media.length, mediaRelinked,
      unlinkedMedia, folderReferences: references || null,
      resolvedFolders: folders.resolved, pendingFolders: folders.pending, reconnectFolders: folders.reconnect,
    };
  } catch (error) {
    const rollbackFailures = await restoreProject(before, { folders: foldersTouched, media: mediaTouched });
    if (rollbackFailures.length) recoverySnapshot = before;
    throw projectCommitError(error, rollbackFailures);
  }
}

// Media patterns whose file this browser cannot reach (no handle, no legacy
// blob). After a save on another computer that is every restored pattern, which
// is what the UI reports so the operator knows which files still need re-linking.
export async function listUnlinkedMedia({ strict = false } = {}) {
  try {
    const records = await listMediaRecords();
    const names = [];
    for (const record of records) {
      if (!record) continue;
      const linked = await isMediaLinked(record.id, { strict });
      if (!linked) names.push(typeof record.name === 'string' && record.name ? record.name : 'Untitled media');
    }
    return names;
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

// Sketch ids (media patterns) whose file this browser cannot reach — used to mark
// those patterns in the library and pad.
export async function listUnlinkedMediaIds() {
  try {
    const records = await listMediaRecords();
    const ids = [];
    for (const record of records) {
      if (!record?.id) continue;
      if (!await isMediaLinked(record.id)) ids.push(`media-${record.id}`);
    }
    return ids;
  } catch {
    return [];
  }
}
