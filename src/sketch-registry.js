import { NODE_PATTERNS_GROUP } from './nodes/routes.js';
// Shared registry of all visualization sketches.
// Used by the screen window (to load sketches) and the control panel (to render buttons).
//
// SKETCHES is the MUTABLE runtime catalog: it starts as a copy of the pure
// built-in catalog (src/patterns/builtins.js — shipped patterns only) and then
// media, projection, and node patterns register into this same array at module
// load; custom scripts register through their service. Built-in-only consumers
// and tests should import BUILTIN_PATTERNS instead of filtering SKETCHES.
//
// New built-ins are self-describing `src/sketches/<id>.pattern.js` modules and
// are discovered automatically — adding one never edits this file. See
// docs/built-in-pattern-extensibility.md.
//
// Each entry may declare a `params` array. Every param gets a slider in the
// control panel; values are broadcast to the screen and injected live into the
// sketch factory as a plain object (mutated in place), so sketches can read
// `params.bass` etc. every frame.
//
// Param shape:
//   { key, label, min, max, step, default }
//
// Ordering: SKETCHES starts in canonical declaration order (and the order used
// inside the pattern library). The control panel's FIXED pattern pad holds 10
// slots (keys 1-9/0); the assigned sketch ids are persisted in localStorage
// (viz2_slot_order) and read via getOrderedSketches(), which returns exactly
// the 10 pad sketches. Older builds persisted a full order (viz2_effect_order);
// it is migrated once — its first 10 valid ids become the pad, gaps filled
// from DEFAULT_PAD_IDS, then declaration order.
//
// Group taxonomy (every entry carries a `group` field, used by the library):
//   Simple              — lightweight shapes and a non-reactive checkerboard
//   Rhythmic            — beat/band-driven 2D visuals (spectrum/pulse/waveform)
//   3D                  — perspective / depth-driven looks
//   Cinematic / Shaders — GPU-first cinematic looks
//   Neon / Lasers       — synthwave, neon & laser aesthetics
//   Video FX            — live camera-input effects
//   Glitch / Effects    — glitch / digital-artifact effects
//   Basics              — simple building-block patterns
//   Alphas              — grayscale-on-black looks for Alpha Blend mapping
import { BUILTIN_PATTERNS } from './patterns/builtins.js';

export { BUILTIN_PATTERNS } from './patterns/builtins.js';

export const SKETCHES = [...BUILTIN_PATTERNS];

// Default pad assignment: the ten pre-refactor declaration slots, frozen as an
// explicit policy so future library growth can never silently reassign keyboard
// shortcuts 1-9/0. Saved viz2_slot_order assignments and viz2_effect_order
// migration still take precedence (see loadSlotOrder).
export const DEFAULT_PAD_IDS = Object.freeze([
  'circles',
  'bars',
  'techno3d',
  'character3d',
  'pulse-rings',
  'particle-storm',
  'chroma-mandala',
  'starfield-rush',
  'echo-ripples',
  'laser-grid',
]);

// Reserved id for the global dual-effect blend params (shown in merge mode).
// It intentionally cannot collide with a sketch id, so it is safe to store in
// the same param store (viz2_params) as per-effect params.
export const BLEND_ID = '__merge';

// Blend params replace the individual effect sliders while two effects are
// merged. One level slider drives either `mix` (crossfade base -> overlay) or
// `add` (additive screen-blend layering) depending on `mode` (0 = Blend,
// 1 = Additive — the default is Blend @ 0.5). The panel renders the toggle
// and a single slider; `mode` is stored here so it persists and syncs.
export const BLEND_PARAMS = [
  { key: 'mix', label: 'Blend', min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: 'add', label: 'Additive', min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: 'mode', label: 'Mode', min: 0, max: 1, step: 1, default: 0 },
];

export function defaultBlendValues() {
  const out = {};
  for (const def of BLEND_PARAMS) out[def.key] = def.default;
  return out;
}

// Reserved id for the global band-split crossovers (bass|mid and mid|high in
// Hz). Like BLEND_ID it rides the shared param store + broadcast pipeline, so
// the EQ separators persist and sync across windows for free. Edited by the
// control panel's band-split EQ; applied by the screen to the feature
// extractor (see sketches/audio-features.js setBandSplit).
export const BANDS_ID = '__bands';

// Defaults mirror MUSICAL_BANDS so nothing changes until a handle moves.
export const BAND_SPLIT_DEFAULTS = Object.freeze({ low: 180, high: 2800 });

// Reserved id for the global post-processing trim (brightness / contrast /
// saturation). Same reserved-id trick as BLEND_ID/BANDS_ID: rides the shared
// param store + broadcast pipeline, so the sliders persist and sync across
// windows for free. Applied by the screen as a CSS filter on the stage
// wrapper (see applyPostFx in main.js). Every slider is an OFFSET around the
// natural level: 0 = untouched output, -100 = fully reduced, +100 = doubled.
export const POSTFX_ID = '__postfx';

export const POSTFX_PARAMS = [
  { key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1, default: 0 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, default: 0 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, default: 0 },
];

export function defaultPostFxValues() {
  const out = {};
  for (const def of POSTFX_PARAMS) out[def.key] = def.default;
  return out;
}

// Number of pad slots / effects that get keyboard shortcuts (1-9, 0 = 10th)
export const SHORTCUT_COUNT = 10;

// localStorage key that stores the pattern pad assignment
// (array of exactly SHORTCUT_COUNT sketch ids, positions 0-9 = keys 1-0)
export const SLOT_ORDER_KEY = 'viz2_slot_order';

// Legacy key (pre-pad builds): the full reorderable effect list. Its first 10
// valid ids seed the pad on first boot after an upgrade (see loadSlotOrder).
export const EFFECT_ORDER_KEY = 'viz2_effect_order';

// Group display order for the pattern library. Any group not listed here
// (e.g. one added by a future sketch) is appended after these.
export const GROUP_ORDER = [
  'Simple',
  'Rhythmic',
  '3D',
  'Cinematic / Shaders',
  'Neon / Lasers',
  'Video FX',
  'Glitch / Effects',
  'Basics',
  'Alphas',
  'Media',
  'Custom Scripts',
  NODE_PATTERNS_GROUP,
  'Projection Mapping',
];

// Group names present in SKETCHES, in GROUP_ORDER (unknown groups appended).
// 'Media' is always present: it hosts the add-media control even before the
// user has loaded any media patterns.
const ALWAYS_PRESENT_GROUPS = new Set(['Media', 'Projection Mapping', 'Custom Scripts', NODE_PATTERNS_GROUP]);

export function getGroups() {
  const present = [];
  const seen = new Set();
  for (const s of SKETCHES) {
    if (s.group && !seen.has(s.group)) {
      seen.add(s.group);
      present.push(s.group);
    }
  }
  const ordered = GROUP_ORDER.filter((g) => seen.has(g) || ALWAYS_PRESENT_GROUPS.has(g));
  for (const g of present) if (!ordered.includes(g)) ordered.push(g);
  return ordered;
}

// Sketches in a group, in declaration order. Camera-input effects are included
// (Video FX renders in the library like every other group).
export function getSketchesByGroup(group) {
  return SKETCHES.filter((s) => s.group === group);
}

// Load the legacy full order (viz2_effect_order), dropping unknown ids.
function loadLegacyEffectOrder() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(EFFECT_ORDER_KEY));
  } catch {
    saved = [];
  }
  if (!Array.isArray(saved)) saved = [];
  const known = new Set(SKETCHES.map((s) => s.id));
  return saved.filter((id) => known.has(id));
}

// The pattern pad assignment (array of SHORTCUT_COUNT unique sketch ids).
// Resolution order:
//   1. viz2_slot_order if present -> keep its valid ids (in order, capped).
//   2. Otherwise migrate legacy viz2_effect_order -> its first 10 valid ids.
//   3. Fill any remaining gaps from declaration order so the pad is always full.
// Nothing is written back here — the pad only persists once the user edits it.
export function loadSlotOrder() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(SLOT_ORDER_KEY));
  } catch {
    saved = [];
  }
  if (!Array.isArray(saved)) saved = [];

  const known = new Set(SKETCHES.map((s) => s.id));
  const valid = [];
  const seen = new Set();
  for (const id of saved) {
    if (valid.length >= SHORTCUT_COUNT) break;
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      valid.push(id);
    }
  }

  // First boot on an upgraded build: seed the pad from the old full order.
  if (valid.length === 0 && !localStorage.getItem(SLOT_ORDER_KEY)) {
    for (const id of loadLegacyEffectOrder()) {
      if (valid.length >= SHORTCUT_COUNT) break;
      if (!seen.has(id)) {
        seen.add(id);
        valid.push(id);
      }
    }
  }

  for (const id of DEFAULT_PAD_IDS) {
    if (valid.length >= SHORTCUT_COUNT) break;
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      valid.push(id);
    }
  }
  for (const s of SKETCHES) {
    if (valid.length >= SHORTCUT_COUNT) break;
    if (!seen.has(s.id)) {
      seen.add(s.id);
      valid.push(s.id);
    }
  }
  return valid.slice(0, SHORTCUT_COUNT);
}

export function saveSlotOrder(order) {
  localStorage.setItem(SLOT_ORDER_KEY, JSON.stringify(order));
}

// The 10 pad sketches in pad order (falls back to declaration order).
// All existing callers (screen loading, keyboard shortcuts, merge blending)
// index into this list, so they keep working unchanged.
export function getOrderedSketches() {
  const order = loadSlotOrder();
  const byId = new Map(SKETCHES.map((s) => [s.id, s]));
  return order.map((id) => byId.get(id)).filter(Boolean);
}

// Keyboard keys that select a pattern (1-9, 0 = 10th)
export function indexFromKey(key) {
  if (key >= '1' && key <= '9') return parseInt(key, 10) - 1;
  if (key === '0') return 9;
  return -1;
}

// Build a fresh { key: value } object from a sketch's param defaults
export function defaultParamValues(id) {
  if (id === BLEND_ID) return defaultBlendValues();
  if (id === BANDS_ID) return { ...BAND_SPLIT_DEFAULTS };
  if (id === POSTFX_ID) return defaultPostFxValues();
  const out = {};
  const sketch = SKETCHES.find((s) => s.id === id);
  const defs = (sketch && sketch.params) || [];
  for (const def of defs) out[def.key] = def.default;
  return out;
}

// ---------------------------------------------------------------------------
// User-loaded media patterns (local images / videos)
// ---------------------------------------------------------------------------
// Registered synchronously at module load so BOTH windows resolve media ids
// before any param/selection validation runs. Metadata comes from localStorage;
// the file bytes are fetched lazily from IndexedDB inside the sketch factory.
import { registerMediaSketches } from './media/media-registry.js';
registerMediaSketches(SKETCHES);

import { registerProjectionSketches } from './projection/projection-registry.js';
registerProjectionSketches(SKETCHES);

import { registerNodeSketches } from './nodes/registry.js';
registerNodeSketches(SKETCHES);
