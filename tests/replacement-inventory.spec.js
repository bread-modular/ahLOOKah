import { test, expect } from '@playwright/test';
import { BUILTIN_PATTERNS } from '../src/patterns/builtins.js';
import { REPLACEMENT_PATTERNS } from '../src/sketches/replacements/index.js';

// Scoped replacement-cohort contract: the 10 named replacements are present in
// the catalog with their intended distribution and bindings. This spec owns the
// replacement cohort only — it asserts nothing about the whole-app total,
// source layout, or group order (see tests/catalog/ for those contracts).
//
// The original migration digests (removed-ID list, retained signatures, file
// hashes) are preserved as evidence at
// docs/history/replacement-inventory-62617ff.json.

const RETIRED_IDS = [
  'dot-grid', 'pulse-stripes', 'cross-pulse', 'diamond-tiles', 'radial-spokes',
  'triangle-mesh', 'ring-grid', 'hatch-weave', 'dash-lanes', 'beat-weave',
  'ripple-lattice', 'polygon-tunnel', 'orbital-cages', 'silk-flow', 'prism-caustics',
  'laser-fan', 'neon-hex', 'data-rain', 'signal-tear', 'pulse-grid',
  'wave-stack', 'beat-orbit', 'level-blocks', 'helix-tower', 'perspective-floor',
  'gyro-rings', 'depth-frames', 'ember-drift', 'velvet-fog', 'prism-flare',
  'molten-glass', 'laser-harp', 'neon-frame', 'beam-cascade', 'circuit-pulse',
  'pixel-sort', 'vhs-tracking', 'block-shift', 'interference',
  'video-edge-glow', 'video-thermal',
  'video-prism-split', 'video-ripple-lens', 'video-mirror-tiles', 'video-halftone',
  'video-solarize', 'video-wave-warp', 'video-duotone',
  'alpha-rings', 'alpha-bars', 'alpha-grid', 'alpha-spot', 'alpha-sweep',
  'alpha-diamonds', 'alpha-fog', 'alpha-waves',
  'vignette', 'split-tone', 'sweep-band', 'grid-lines',
];

// The expansion wave deliberately restored exactly two retired legacy camera
// looks; every other retired id stays absent unless explicitly re-adopted.
const RESTORED_IDS = new Set(['video-thermal', 'video-edge-glow']);

test('replacement cohort: 10 named patterns present with intended distribution and bindings', { tag: '@core' }, () => {
  expect(REPLACEMENT_PATTERNS).toHaveLength(10);
  const byId = new Map(BUILTIN_PATTERNS.map((s) => [s.id, s]));
  for (const s of REPLACEMENT_PATTERNS) {
    expect(byId.get(s.id), s.id).toBe(s);
    expect(s.audioTransport, s.id).toBe('pattern-controls');
    expect(typeof s.factory, s.id).toBe('function');
    expect(typeof s.createAudioController, s.id).toBe('function');
    expect(s.audioControlSchema && typeof s.audioControlSchema, s.id).toBe('object');
  }
  const expected = { Simple: 1, Rhythmic: 1, '3D': 0, 'Cinematic / Shaders': 2, 'Neon / Lasers': 0, 'Video FX': 2, 'Glitch / Effects': 2, Basics: 0, Alphas: 2 };
  for (const [group, count] of Object.entries(expected)) {
    expect(REPLACEMENT_PATTERNS.filter((s) => s.group === group), group).toHaveLength(count);
  }
});

test('replacement retirement policy: restored camera ids allowed, other retired ids absent', { tag: '@core' }, () => {
  expect(RETIRED_IDS).toHaveLength(60);
  const byId = new Map(BUILTIN_PATTERNS.map((s) => [s.id, s]));
  for (const id of RETIRED_IDS) {
    expect(byId.has(id), id).toBe(RESTORED_IDS.has(id));
  }
});
