// Registry of user-loaded media patterns (local images / videos).
//
// Media patterns are dynamic sketch entries: the file bytes live in IndexedDB
// (media/media-store.js) and only lightweight metadata is persisted in
// localStorage (viz2_media_patterns). Both windows (control + screen) call
// registerMediaSketches(SKETCHES) at module-boot time, so every window can
// resolve, select and render a media pattern id without any async boot step.
//
// Sketch ids use the `media-<id>` prefix and can never collide with the static
// registry. Entries carry `media: true` so the library UI can offer removal.
import createMediaPatternFactory, {
  createAudioController as createMediaAudioController,
  AUDIO_CONTROL_SCHEMA as MEDIA_AUDIO_CONTROL_SCHEMA,
  mediaParamsFor,
} from '../sketches/media_pattern.js';

export const MEDIA_STORAGE_KEY = 'viz2_media_patterns';
export const MEDIA_GROUP = 'Media';

// Validate a stored metadata record. Returns null for anything malformed so a
// corrupted localStorage entry can never break boot.
function sanitizeMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, name, kind } = raw;
  if (typeof id !== 'string' || !id.length || id.length > 64) return null;
  if (kind !== 'image' && kind !== 'video') return null;
  const safeName = typeof name === 'string' && name.trim().length
    ? name.trim().slice(0, 80)
    : 'Untitled media';
  return { id, name: safeName, kind };
}

export function mediaSketchId(mediaId) {
  return `media-${mediaId}`;
}

export function loadMediaMeta() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(MEDIA_STORAGE_KEY));
  } catch {
    saved = [];
  }
  if (!Array.isArray(saved)) saved = [];
  return saved.map(sanitizeMeta).filter(Boolean);
}

function saveMediaMeta(list) {
  localStorage.setItem(MEDIA_STORAGE_KEY, JSON.stringify(list));
}

// Build the SKETCHES entry for one media pattern. The factory closes over the
// metadata only; the blob is fetched lazily from IndexedDB inside the sketch.
export function buildMediaSketchEntry(meta) {
  return {
    id: mediaSketchId(meta.id),
    name: meta.name,
    factory: createMediaPatternFactory(meta),
    audioTransport: 'pattern-controls',
    createAudioController: createMediaAudioController,
    audioControlSchema: MEDIA_AUDIO_CONTROL_SCHEMA,
    params: mediaParamsFor(meta.kind),
    group: MEDIA_GROUP,
    media: true,
    kind: meta.kind,
  };
}

// Sync the SKETCHES array with the persisted metadata list. Idempotent; safe to
// call on every boot and after every cross-window 'media-patterns' message.
export function registerMediaSketches(sketches, snapshot = undefined) {
  const metas = Array.isArray(snapshot) ? snapshot.slice(0, 256).map(sanitizeMeta).filter(Boolean) : loadMediaMeta();
  const wanted = new Map(metas.map((meta) => [mediaSketchId(meta.id), meta]));

  // Drop entries whose metadata disappeared (removed in the other window).
  for (let i = sketches.length - 1; i >= 0; i--) {
    if (sketches[i]?.media && !wanted.has(sketches[i].id)) sketches.splice(i, 1);
  }
  // Append missing entries (declaration order = metadata order), and replace
  // entries whose name/kind changed elsewhere (e.g. a rename in the other
  // window) so the in-memory entry — including the factory closure over the
  // display name — stays in sync.
  for (const [sketchId, meta] of wanted) {
    const idx = sketches.findIndex((sketch) => sketch.id === sketchId);
    if (idx === -1) {
      sketches.push(buildMediaSketchEntry(meta));
    } else if (sketches[idx].name !== meta.name || sketches[idx].kind !== meta.kind) {
      sketches[idx] = buildMediaSketchEntry(meta);
    }
  }
}

// Persist + register a freshly stored media record (called by the runtime
// command after the blob landed in IndexedDB).
export function addMediaPattern(sketches, meta) {
  const clean = sanitizeMeta(meta);
  if (!clean) throw new Error('Invalid media pattern metadata.');
  const list = loadMediaMeta().filter((entry) => entry.id !== clean.id);
  list.push(clean);
  saveMediaMeta(list);
  registerMediaSketches(sketches);
  return clean;
}

// Persist the removal and drop the sketch entry. Returns true when removed.
export function removeMediaPattern(sketches, mediaId) {
  const list = loadMediaMeta();
  const next = list.filter((entry) => entry.id !== mediaId);
  if (next.length === list.length) return false;
  saveMediaMeta(next);
  registerMediaSketches(sketches);
  return true;
}

// Rename a media pattern. Validates centrally: trims, rejects blank values,
// caps at 80 chars, no-ops unchanged names. Returns the sanitized new name,
// or null when nothing changed / the id is unknown.
export function renameMediaPattern(sketches, mediaId, name) {
  const clean = typeof name === 'string' ? name.trim().slice(0, 80) : '';
  if (!clean) return null;
  const list = loadMediaMeta();
  const entry = list.find((item) => item.id === mediaId);
  if (!entry || entry.name === clean) return null;
  entry.name = clean;
  saveMediaMeta(list);
  registerMediaSketches(sketches);
  return clean;
}

// Human-friendly display name derived from the file name ("my_loop.mp4" ->
// "my_loop"). Only the extension is stripped; the rest is kept verbatim so
// the library label matches the file the user picked.
export function mediaDisplayName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  return (base || 'Untitled media').slice(0, 80);
}
