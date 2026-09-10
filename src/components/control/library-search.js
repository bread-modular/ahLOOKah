// Pattern Library search + favourites helpers.
//
// Both are control-panel UI state persisted in localStorage (the same policy as
// the collapsed-group list), not runtime authority: they never ride the
// BroadcastChannel bus, and the screen window never reads them. Favourites are
// stored as an array of stable sketch ids in the order they were added, so they
// survive reloads, media re-registration and a settings export/import.
import { STORAGE } from '../../platform/constants.js';

// Pseudo-group rendered above the themed groups. It exists only in the control
// panel's library view: it is never a SKETCHES `group`, so GROUP_ORDER, the pad,
// the pattern registry and the smoke registry guard are untouched.
export const FAVOURITES_GROUP = 'Favourites';

// A corrupted or missing entry must never break boot (same policy as media
// metadata): fall back to "no favourites".
export function loadFavouriteIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE.libraryFavourites));
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const ids = [];
    for (const id of raw) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

export function saveFavouriteIds(ids) {
  try {
    localStorage.setItem(STORAGE.libraryFavourites, JSON.stringify(ids));
  } catch {
    // Persistence is best-effort (quota / privacy modes); the UI still updates.
  }
}

// Unknown ids are deliberately kept in storage rather than pruned: a media or
// projection pattern can be unresolvable for a moment (unreadable metadata,
// another window mid-update) and a star must not be lost because of that.
export function resolveFavourites(ids, sketches) {
  const byId = new Map(sketches.map((sketch) => [sketch.id, sketch]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export function toggleFavourite(ids, id) {
  if (typeof id !== 'string' || !id) return ids;
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
}

// Enter is the control window's global "GO LIVE" gesture (KeyboardController),
// but on a focused utility button it must activate that button instead. Stopping
// the keydown keeps the button's native activation — which fires the click — and
// never lets the window-level shortcut see the keystroke. Used by the favourite
// stars and both Clear-search buttons; pattern buttons are deliberately left
// alone so the CUE flow (stage with Shift+click, take with Enter) is unchanged.
export function stopEnterPropagation(event) {
  if (event.key === 'Enter') event.stopPropagation();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
// The query is split into whitespace-separated terms and EVERY term must match,
// so "video glitch" narrows the list instead of widening it. Matching is
// case-insensitive over the pattern's name, id, group, description and type
// keywords, so "camera" finds the Video FX group and "mapping" the projection
// patterns even though those words are not in every pattern's name.
export function parseQuery(query) {
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

export function searchableText(sketch) {
  // The id counts in both spellings: the raw form matches "ripple-lattice" typed
  // verbatim, the spaced form matches "ripple lattice" as two separate terms.
  const id = String(sketch.id || '');
  const parts = [sketch.name, sketch.group, sketch.description, id, id.replace(/-/g, ' ')];
  if (sketch.camera) parts.push('camera', 'webcam');
  if (sketch.media) parts.push('media', sketch.kind === 'video' ? 'video' : 'image');
  if (sketch.projection) parts.push('projection', 'mapping', 'surface');
  return parts.filter(Boolean).join(' ').toLowerCase();
}

export function matchesQuery(sketch, terms) {
  if (!terms.length) return true;
  const haystack = searchableText(sketch);
  return terms.every((term) => haystack.includes(term));
}

// Empty terms = "no query" = every sketch (the caller then skips filtering).
export function filterSketches(sketches, terms) {
  if (!terms.length) return sketches;
  return sketches.filter((sketch) => matchesQuery(sketch, terms));
}
