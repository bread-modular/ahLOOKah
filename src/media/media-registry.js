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
export function registerMediaSketches(sketches) {
  const metas = loadMediaMeta();
  const wanted = new Map(metas.map((meta) => [mediaSketchId(meta.id), meta]));

  // Drop entries whose metadata disappeared (removed in the other window).
  for (let i = sketches.length - 1; i >= 0; i--) {
    if (sketches[i]?.media && !wanted.has(sketches[i].id)) sketches.splice(i, 1);
  }
  // Append missing entries (declaration order = metadata order).
  for (const [sketchId, meta] of wanted) {
    if (!sketches.some((sketch) => sketch.id === sketchId)) {
      sketches.push(buildMediaSketchEntry(meta));
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

// Human-friendly display name derived from the file name ("my_loop.mp4").
export function mediaDisplayName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  return (base || 'Untitled media').slice(0, 80);
}
