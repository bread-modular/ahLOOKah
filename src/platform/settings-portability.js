// Settings export / import — move every persisted ahLOOKah setting from one
// browser (or machine) to another as a single JSON file.
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
//
// What never travels: per-window/session keys (tab id, singleton leases, audio
// capture lease). Those are runtime coordination, not settings.
import { STORAGE } from './constants.js';
import { MEDIA_STORAGE_KEY, sanitizeMediaMeta } from '../media/media-registry.js';
import { PROJECTION_STORAGE_KEY } from '../projection/projection-registry.js';
import { listMediaRecords, replaceMediaRecords, isMediaLinked } from '../media/media-store.js';

export const SETTINGS_FILE_KIND = 'ahlookah-settings';
export const SETTINGS_FILE_VERSION = 1;

const APP_ID = 'ahlookah';
const MAX_FILE_CHARS = 4_000_000;
const MAX_STORAGE_VALUE_CHARS = 1_000_000;
const MAX_MEDIA_ENTRIES = 256;
const MAX_MEDIA_FILE_NAME_CHARS = 255;

// Persisted settings, in a fixed order. Ephemeral coordination keys
// (viz2_tab_id, viz2_singleton_*, viz2_audio_capture_lease) are deliberately
// absent — importing them would make one window think another owns a lease.
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

// Local-date file name so an operator with several exports can tell them apart.
export function settingsFileName(now = new Date()) {
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return `ahlookah-settings-${stamp}.json`;
}

function mediaEntryFromRecord(record) {
  const base = sanitizeMediaMeta(record);
  if (!base) return null;
  return {
    ...base,
    mime: typeof record.mime === 'string' ? record.mime.slice(0, 100) : '',
    size: Number.isFinite(record.size) ? record.size : null,
    addedAt: Number.isFinite(record.addedAt) ? record.addedAt : Date.now(),
    fileName: typeof record.fileName === 'string' && record.fileName.trim()
      ? record.fileName.trim().slice(0, MAX_MEDIA_FILE_NAME_CHARS)
      : null,
  };
}

// Snapshot everything the file should carry. Never throws: a storage failure
// just yields a smaller export.
export async function collectSettings() {
  const storage = {};
  for (const key of SETTINGS_STORAGE_KEYS) {
    try {
      const value = localStorage.getItem(key);
      if (value !== null) storage[key] = value;
    } catch {
      /* private mode / quota — skip this key */
    }
  }
  let media = [];
  try {
    media = (await listMediaRecords()).map(mediaEntryFromRecord).filter(Boolean).slice(0, MAX_MEDIA_ENTRIES);
  } catch {
    media = [];
  }
  return {
    app: APP_ID,
    kind: SETTINGS_FILE_KIND,
    version: SETTINGS_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    storage,
    media,
  };
}

export function serializeSettings(payload) {
  return JSON.stringify(payload, null, 2);
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

// Validate a picked file. Returns { ok: true, payload } or { ok: false, error }.
// Every accepted field is re-sanitized so a hand-edited file can never write
// an unexpected key or an oversized value.
export function parseSettingsFile(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'The file is empty.' };
  if (text.length > MAX_FILE_CHARS) return { ok: false, error: 'The file is too large to be an ahLOOKah settings export.' };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'That file is not an ahLOOKah settings export.' };
  }
  if (raw.kind !== SETTINGS_FILE_KIND || raw.app !== APP_ID) {
    return { ok: false, error: 'That file was not exported by ahLOOKah.' };
  }
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    return { ok: false, error: 'The settings file has an unrecognized version.' };
  }
  if (raw.version > SETTINGS_FILE_VERSION) {
    return { ok: false, error: `The settings file was written by a newer ahLOOKah version (v${raw.version}).` };
  }

  const storage = {};
  const source = raw.storage;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, error: 'The settings section of the file is missing or malformed.' };
  }
  for (const [key, value] of Object.entries(source)) {
    if (!SETTINGS_KEY_SET.has(key)) continue;
    if (typeof value !== 'string' || value.length > MAX_STORAGE_VALUE_CHARS) continue;
    storage[key] = value;
  }

  const media = [];
  const seen = new Set();
  if (!Array.isArray(raw.media)) {
    return { ok: false, error: 'The media section of the file is missing or malformed.' };
  }
  for (const entry of raw.media.slice(0, MAX_MEDIA_ENTRIES)) {
    const clean = mediaEntryFromRecord(entry);
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    media.push(clean);
  }

  return { ok: true, payload: { storage, media } };
}

// Apply a validated payload. Replace semantics: the destination mirrors the
// source, so allowlisted settings the file omits are cleared rather than left
// behind (that is what "move my settings" means). Media records are replaced
// wholesale with metadata-only entries.
export async function applySettings(payload) {
  const storage = payload?.storage && typeof payload.storage === 'object' ? payload.storage : {};
  const media = Array.isArray(payload?.media) ? payload.media : [];

  let storageWritten = 0;
  let storageRemoved = 0;
  for (const key of SETTINGS_STORAGE_KEYS) {
    try {
      if (Object.prototype.hasOwnProperty.call(storage, key)) {
        localStorage.setItem(key, storage[key]);
        storageWritten += 1;
      } else if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        storageRemoved += 1;
      }
    } catch {
      /* quota / private mode — keep applying the remaining keys */
    }
  }

  await replaceMediaRecords(media);
  const unlinkedMedia = await listUnlinkedMedia();

  return { storageWritten, storageRemoved, mediaRestored: media.length, unlinkedMedia };
}

// Media patterns whose file this browser cannot reach (no handle, no legacy
// blob). After an import that is every restored pattern, which is what the UI
// reports so the operator knows which files still need re-linking.
export async function listUnlinkedMedia() {
  try {
    const records = await listMediaRecords();
    const names = [];
    for (const record of records) {
      if (!record) continue;
      const linked = await isMediaLinked(record.id);
      if (!linked) names.push(typeof record.name === 'string' && record.name ? record.name : 'Untitled media');
    }
    return names;
  } catch {
    return [];
  }
}
