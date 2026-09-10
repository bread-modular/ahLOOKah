import { test, expect } from '@playwright/test';
import { SKETCHES, getGroups } from '../src/sketch-registry.js';
import { EXPANSION_PATTERNS, RESTORED_CAMERA_PATTERNS } from '../src/sketches/expansion/index.js';
import { createExpansionController } from '../src/sketches/expansion/runtime.js';
import { BAND_PARAMS, BAND_SCHEMA } from '../src/sketches/band-reactive.js';

const ALL = [...EXPANSION_PATTERNS, ...RESTORED_CAMERA_PATTERNS];

test('expansion provenance: 21 new + 2 restored, registry totals 91, category order intact', { tag: '@core' }, () => {
  expect(EXPANSION_PATTERNS).toHaveLength(21);
  expect(RESTORED_CAMERA_PATTERNS.map((s) => s.id)).toEqual(['video-edge-glow', 'video-thermal']);
  expect(ALL.every(Boolean)).toBe(true);
  expect(SKETCHES).toHaveLength(91);
  expect(new Set(SKETCHES.map((s) => s.id)).size).toBe(91);
  // Exactly two new entries per existing visual category, plus the three
  // Techno 3D descendants in 3D. No Media/Projection Mapping additions.
  const expected = { Simple: 2, Rhythmic: 2, '3D': 5, 'Cinematic / Shaders': 2, 'Neon / Lasers': 2, 'Video FX': 2, 'Glitch / Effects': 2, Basics: 2, Alphas: 2 };
  for (const [group, count] of Object.entries(expected)) {
    expect(EXPANSION_PATTERNS.filter((s) => s.group === group), group).toHaveLength(count);
  }
  expect(RESTORED_CAMERA_PATTERNS.every((s) => s.group === 'Video FX' && s.camera)).toBe(true);
  expect(EXPANSION_PATTERNS.filter((s) => s.camera).map((s) => s.id)).toEqual(['video-datamosh', 'video-rolling-shutter']);
  // Group labels/order unchanged; Media & Projection Mapping untouched.
  expect(getGroups()).toEqual(['Simple', 'Rhythmic', '3D', 'Cinematic / Shaders', 'Neon / Lasers', 'Video FX', 'Glitch / Effects', 'Basics', 'Alphas', 'Media', 'Projection Mapping']);
  expect(SKETCHES.slice(0, 4).map((s) => s.id)).toEqual(['circles', 'bars', 'techno3d', 'character3d']);
  expect(SKETCHES.find((s) => s.id === 'checkerboard').audioReactive).toBe(false);
  // Every entry: own controller identity (never the replacement/shared ones),
  // shared band schema/sliders, transport, description and docs of band roles.
  for (const s of ALL) {
    expect(s.createAudioController, s.id).toBe(createExpansionController);
    expect(s.audioControlSchema, s.id).toBe(BAND_SCHEMA);
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
