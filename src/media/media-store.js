// Persistence for user-supplied media patterns (images / videos).
//
// Design: NO file bytes are stored in IndexedDB. Only a tiny record is kept:
//   { id, name, kind, mime, size, addedAt, handle }
// where `handle` is a FileSystemFileHandle from window.showOpenFilePicker()
// (Desktop Chrome target). Handles are structured-cloneable, so they persist in
// IndexedDB like a saved "file path". The actual media is loaded from disk into
// RAM lazily — when the pattern is activated (sketch instantiated) — via
// handle.getFile() and a blob object URL, which Chrome streams off disk.
//
// Permission model: reading requires a read grant. Chrome (122+) persists
// grants across restarts; if a grant is missing the loader reports
// 'permission' and the sketch shows a "click to grant access" hint (the click
// provides the user gesture requestPermission needs).
//
// Same-session loads are served from an in-memory cache (liveSources) so a
// freshly picked file never round-trips through IndexedDB.
//
// Fallback for environments without the File System Access API: the library
// accepts <input type="file"> selections and stores the File object directly
// (legacy 'blob' field) — those only live for the current session.

const DB_NAME = 'viz2_media';
const DB_VERSION = 2;
const STORE_NAME = 'media';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'];
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv'];

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ogv: 'video/ogg',
};

let dbPromise = null;

// id -> { handle } | { file } for sources picked in this session.
const liveSources = new Map();

// Chrome requires accept extensions to be dotted (".png"), while the
// classification helpers above use bare extensions.
function pickerTypes() {
  const withDot = (extensions) => extensions.map((ext) => `.${ext}`);
  return [
    {
      description: 'Images & videos',
      accept: {
        'image/*': withDot(IMAGE_EXTENSIONS),
        'video/*': withDot(VIDEO_EXTENSIONS),
      },
    },
  ];
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      } else if (request.oldVersion < 2) {
        // v1 stored file blobs; v2 stores only path-equivalent handles. Drop
        // stale byte copies rather than keeping them around.
        try {
          request.transaction.objectStore(STORE_NAME).clear();
        } catch {
          /* store may not exist yet */
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Unable to open the media database.'));
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error('The media database is blocked by another connection.'));
    };
  });
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Media database request failed.'));
  });
}

async function withStore(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let result;
    try {
      result = run(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Media database transaction failed.'));
  });
}

export function canUseFileSystemPicker() {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// Classify a picked file by extension (mime types from the picker are not
// reliable for every container).
export function mediaKindForName(name) {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  return null;
}

export function mimeForName(name) {
  return MIME_BY_EXT[extensionOf(name)] || '';
}

// Fallback classification for <input type="file"> File objects.
export function mediaKindForFile(file) {
  if (!file) return null;
  if (file.type && file.type.startsWith('image/')) return 'image';
  if (file.type && file.type.startsWith('video/')) return 'video';
  return mediaKindForName(file.name || '');
}

// Open the File System Access picker and describe each picked file.
// Returns [{ handle, name, kind, mime, size }].
export async function pickMediaFiles() {
  const handles = await window.showOpenFilePicker({
    multiple: true,
    types: pickerTypes(),
  });
  return handles.map(describeHandle);
}

// Single-file variant used when re-linking an imported media pattern.
// Returns { handle, name, kind, mime, size } or null when nothing was picked.
export async function pickMediaFile() {
  const handles = await window.showOpenFilePicker({
    multiple: false,
    types: pickerTypes(),
  });
  const handle = handles?.[0];
  return handle ? describeHandle(handle) : null;
}

function describeHandle(handle) {
  const name = handle.name || 'Untitled media';
  return {
    handle,
    name,
    kind: mediaKindForName(name),
    mime: mimeForName(name),
    size: null,
  };
}

// Persist a media record. `handle` (FileSystemFileHandle) or `file`
// (fallback File object). Handles/files are also cached in memory for the
// session so activation never depends on an IndexedDB round-trip.
export async function putMediaRecord(record) {
  if (record.handle) liveSources.set(record.id, { handle: record.handle });
  else if (record.file) liveSources.set(record.id, { file: record.file });
  const persisted = {
    id: record.id,
    name: record.name,
    kind: record.kind,
    mime: record.mime || '',
    size: record.size ?? null,
    addedAt: record.addedAt || Date.now(),
    // Path-equivalent hint for settings export/relink: the file's name (the
    // File System Access API never exposes the full path).
    fileName: record.fileName || record.handle?.name || record.file?.name || null,
    handle: record.handle || null,
    blob: record.file || null,
  };
  try {
    await withStore('readwrite', (store) => {
      store.put(persisted);
    });
  } catch (error) {
    // Not every "handle" survives the structured clone (test mocks, exotic
    // hosts). Keep at least the metadata so the pattern list still persists.
    await withStore('readwrite', (store) => {
      store.put({ ...persisted, handle: null, blob: null });
    });
  }
  return record;
}

export async function getMediaRecord(id) {
  return withStore('readonly', (store) => requestToPromise(store.get(id)));
}

// Every persisted media record (metadata + handles). Used by settings export,
// which keeps only the path-equivalent metadata.
export async function listMediaRecords() {
  const records = await withStore('readonly', (store) => requestToPromise(store.getAll()));
  return Array.isArray(records) ? records : [];
}

// Replace every persisted record with metadata-only entries (settings import).
// File handles/blobs never cross a settings file, so imported media patterns
// stay listed but need a relink before they can render.
export async function replaceMediaRecords(records) {
  liveSources.clear();
  await withStore('readwrite', (store) => {
    store.clear();
    for (const record of records) {
      store.put({ ...record, handle: null, blob: null });
    }
  });
}

export async function deleteMediaRecord(id) {
  liveSources.delete(id);
  await withStore('readwrite', (store) => {
    store.delete(id);
  });
}

// Rename a persisted media record (display name only). Reads the stored
// record, patches just the name, and writes it back so the handle/blob and
// all other fields survive untouched. Returns the new name, or null when the
// record does not exist.
export async function renameMediaRecord(id, name) {
  const clean = typeof name === 'string' ? name.trim().slice(0, 80) : '';
  if (!clean) return null;
  const existing = await withStore('readonly', (store) => requestToPromise(store.get(id)));
  if (!existing) return null;
  if (existing.name === clean) return null;
  await withStore('readwrite', (store) => {
    store.put({ ...existing, name: clean });
  });
  return clean;
}

export function isLiveSource(id) {
  return liveSources.has(id);
}

// True when a media pattern can still reach its file in THIS browser: an
// in-session source, a persisted FileSystemFileHandle (even one that needs a
// click to re-grant read access), or a legacy fallback blob.
//
// False means the pattern only has metadata left — it was imported from a
// settings file, or its file disappeared from disk — so the UI offers
// Relink File to point it at a local file again.
export async function isMediaLinked(id) {
  if (typeof id !== 'string' || !id) return false;
  const cached = liveSources.get(id);
  if (cached?.handle || cached?.file) return true;

  let record = null;
  try {
    record = await getMediaRecord(id);
  } catch {
    return false;
  }
  if (!record) return false;
  if (record.blob) return true;

  const handle = record.handle;
  if (!handle || typeof handle.getFile !== 'function') return false;

  let permission = 'granted';
  try {
    permission = await handle.queryPermission({ mode: 'read' });
  } catch {
    permission = 'granted';
  }
  if (permission === 'denied') return false;
  // 'prompt' still resolves through the click-to-grant path in the pattern.
  if (permission !== 'granted') return true;

  try {
    await handle.getFile();
    return true;
  } catch (error) {
    // A granted handle only fails here when the file is gone from disk.
    return error?.name !== 'NotFoundError';
  }
}

// Load a media pattern's file from disk and return an object URL.
// - record: metadata from the registry/store (may carry a handle or legacy blob)
// - Returns { status: 'ready', url, revoke } | { status: 'permission' } |
//   { status: 'missing' }.
export async function loadMediaUrl(record) {
  if (!record) return { status: 'missing' };

  // Legacy fallback record (file-input path): bytes were stored directly.
  if (record.blob) {
    try {
      return { status: 'ready', url: URL.createObjectURL(record.blob), revoke: () => {} };
    } catch {
      return { status: 'missing' };
    }
  }

  // Prefer the in-session cache (a freshly picked handle), then the persisted
  // handle from IndexedDB.
  const cached = liveSources.get(record.id) || {};
  const handle = cached.handle || record.handle;
  if (!handle || typeof handle.getFile !== 'function') return { status: 'missing' };

  let permission = 'granted';
  try {
    permission = await handle.queryPermission({ mode: 'read' });
  } catch {
    permission = 'prompt';
  }
  if (permission !== 'granted') {
    try {
      permission = await handle.requestPermission({ mode: 'read' });
    } catch {
      return { status: 'permission' };
    }
    if (permission !== 'granted') return { status: 'permission' };
  }

  try {
    const file = await handle.getFile();
    liveSources.set(record.id, { handle });
    return { status: 'ready', url: URL.createObjectURL(file), revoke: () => {} };
  } catch (error) {
    return { status: 'missing' };
  }
}