import { test, expect } from '@playwright/test';
import { BUILTIN_PATTERNS } from '../src/patterns/builtins.js';
import { EXPANSION_PATTERNS, RESTORED_CAMERA_PATTERNS } from '../src/sketches/expansion/index.js';
import { createExpansionController } from '../src/sketches/expansion/runtime.js';
import { BAND_PARAMS } from '../src/sketches/band-reactive.js';
import { FEATURE_SCHEMA } from '../src/sketches/feature-controls.js';

// Scoped expansion-cohort contract: the 9 researched patterns plus the 2
// restored legacy camera looks are present with their intended distribution,
// params, and controller bindings. This spec owns the expansion cohort only —
// it asserts nothing about the whole-app total or group order (see
// tests/catalog/ for those contracts).

const ALL = [...EXPANSION_PATTERNS, ...RESTORED_CAMERA_PATTERNS];

test('expansion cohort: 9 new + 2 restored present with intended distribution', { tag: '@core' }, () => {
  expect(EXPANSION_PATTERNS).toHaveLength(9);
  expect(RESTORED_CAMERA_PATTERNS.map((s) => s.id)).toEqual(['video-edge-glow', 'video-thermal']);
  expect(ALL.every(Boolean)).toBe(true);
  const byId = new Map(BUILTIN_PATTERNS.map((s) => [s.id, s]));
  for (const s of ALL) expect(byId.get(s.id), s.id).toBe(s);
  // Remaining entries per existing visual category. No Media/Projection Mapping additions.
  const expected = { Simple: 0, Rhythmic: 0, '3D': 2, 'Cinematic / Shaders': 1, 'Neon / Lasers': 0, 'Video FX': 2, 'Glitch / Effects': 2, Basics: 1, Alphas: 1 };
  for (const [group, count] of Object.entries(expected)) {
    expect(EXPANSION_PATTERNS.filter((s) => s.group === group), group).toHaveLength(count);
  }
  expect(RESTORED_CAMERA_PATTERNS.every((s) => s.group === 'Video FX' && s.camera)).toBe(true);
  expect(EXPANSION_PATTERNS.filter((s) => s.camera).map((s) => s.id)).toEqual(['video-datamosh', 'video-rolling-shutter']);
});

test('expansion cohort: shared controller identity, band schema, and param contracts', { tag: '@core' }, () => {
  // Every entry: own controller identity (never the replacement/shared ones),
  // shared band schema/sliders, transport, description and docs of band roles.
  for (const s of ALL) {
    expect(s.createAudioController, s.id).toBe(createExpansionController);
    expect(s.audioControlSchema, s.id).toBe(FEATURE_SCHEMA);
    expect(s.audioTransport, s.id).toBe('pattern-controls');
    expect(s.audioReactive, s.id).toBe(true);
    expect(s.params.filter((p) => ['bass', 'mid', 'high'].includes(p.key)), s.id).toEqual(BAND_PARAMS);
    expect(s.description, s.id).toMatch(/bass/i);
    expect(s.description, s.id).toMatch(/mid/i);
    expect(s.description, s.id).toMatch(/high/i);
    expect(new Set(s.params.map((p) => p.key)).size, s.id).toBe(s.params.length);
    for (const p of s.params) expect(p.min, `${s.id}.${p.key}`).toBeLessThan(p.max);
  }
  // Alphas carry no hue slider (grayscale by construction); restored pair keep
  // their exact legacy param schema with a tasteful lower default amount.
  for (const s of EXPANSION_PATTERNS.filter((s) => s.group === 'Alphas')) expect(s.params.some((p) => p.key === 'hue')).toBe(false);
  for (const s of RESTORED_CAMERA_PATTERNS) {
    expect(s.params.map((p) => p.key)).toEqual(['amount', 'detail', 'hue', 'mirror', 'bass', 'mid', 'high']);
    expect(s.params[0].default).toBe(0.5);
  }
});
