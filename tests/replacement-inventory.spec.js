import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SKETCHES, getGroups } from '../src/sketch-registry.js';
import { REPLACEMENT_PATTERNS } from '../src/sketches/replacements/index.js';
const inventory = JSON.parse(readFileSync(new URL('./fixtures/replacement-inventory.json', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');

test('replacement provenance: exactly 60 removed, 50 older unchanged, 10 new, category order intact', { tag: '@core' }, () => {
  const registry = readFileSync('src/sketch-registry.js', 'utf8');
  const retained = registry.slice(registry.indexOf('export const SKETCHES = ['), registry.indexOf('  // Preserve all 50 older entries'));
  expect(hash(retained), 'exact original 50 registry declarations, including factory/controller bindings').toBe(inventory.retainedDeclarationSha256);
  expect(SKETCHES).toHaveLength(71);
  expect(inventory.removed).toHaveLength(60);
  expect(inventory.older).toHaveLength(50);
  expect(REPLACEMENT_PATTERNS).toHaveLength(10);
  expect(new Set(SKETCHES.map(s => s.id)).size).toBe(71);
  // The expansion wave restored exactly two removed legacy camera looks
  // (video-thermal, video-edge-glow); every other removed id stays absent.
  const restored = new Set(['video-thermal', 'video-edge-glow']);
  for (const id of inventory.removed) expect(SKETCHES.some(s => s.id === id), id).toBe(restored.has(id));
  expect(SKETCHES.slice(0, 50).map(s => s.id)).toEqual(inventory.older.map(s => s.id));
  for (const saved of inventory.older) {
    const s = SKETCHES.find(s => s.id === saved.id);
    const signature = hash(JSON.stringify(s));
    expect(signature, saved.id).toBe(saved.signature);
  }
  for (const [path, digest] of Object.entries(inventory.files)) expect(hash(readFileSync(path)), path).toBe(digest);
  const groups = ['Simple', 'Rhythmic', '3D', 'Cinematic / Shaders', 'Neon / Lasers', 'Video FX', 'Glitch / Effects', 'Basics', 'Alphas'];
  const expected = { Simple: 1, Rhythmic: 1, '3D': 0, 'Cinematic / Shaders': 2, 'Neon / Lasers': 0, 'Video FX': 2, 'Glitch / Effects': 2, Basics: 0, Alphas: 2 };
  for (const group of groups) expect(REPLACEMENT_PATTERNS.filter(s => s.group === group), group).toHaveLength(expected[group]);
  expect(getGroups()).toEqual([...groups, 'Media', 'Projection Mapping', 'Custom Scripts']);
  expect(SKETCHES.slice(0, 4).map(s => s.id)).toEqual(['circles', 'bars', 'techno3d', 'character3d']);
  expect(SKETCHES.find(s => s.id === 'checkerboard').audioReactive).toBe(false);
});
