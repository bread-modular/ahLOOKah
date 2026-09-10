import { REPLACEMENT_PATTERNS } from '../src/sketches/replacements/index.js';
import { EXPANSION_PATTERNS, RESTORED_CAMERA_PATTERNS } from '../src/sketches/expansion/index.js';
import { test, expect } from '@playwright/test';
import { SMOKE_PATTERNS } from './smoke-patterns.js';

// Smoke test: every newly added effect loads and renders without page errors.
const NEW_IDS = [
  'laser-grid',
  'strobe-pulse',
  'plasma-waves',
  'glitch-matrix',
  'neon-ribbons',
  'prism-burst',
  'event-horizon',
  'liquid-chrome',
  'laser-cathedral',
  'cymatic-bloom',
  'holo-swarm',
  'aurora-veil',
  'mandelbulb-drift',
  'storm-surge',
  'ink-dispersion',
  'infinity-mirror',
  'ion-tempest',
  'crystal-reliquary',
  'neural-cascade',
  'aurora-reactor',
  'warp-loom',
  // Basics group (added in the pattern-pad/library restructure)
  'solid-color',
  'gradient-wash',
  'color-bars',
  'noise-static',
  'film-grain',
  'checkerboard',
  // Video FX wave (camera-input) — 4 added by the video/glitch drop
  'video-chroma',
  'video-kaleido',
  'video-pixelate',
  'video-trails',
  // Glitch wave (procedural, no camera needed)
  'glitch-rgb-split',
  'glitch-scanlines',
  'glitch-slices',
  'glitch-crt',
  // Legacy camera-input effects now registered in the library (Video FX).
  // The test browser launches with fake media-stream flags, so these get a
  // synthetic camera; without one they would still render (black/fallback
  // frame) without crashing — the assertions below stay frame-agnostic.
  'video-dots-gpu',
  'video-high-contrast',
  ...REPLACEMENT_PATTERNS.map(s => s.id),
  // Expansion wave: 21 researched VJ/VFX patterns + 2 restored legacy camera looks.
  ...EXPANSION_PATTERNS.map(s => s.id),
  ...RESTORED_CAMERA_PATTERNS.map(s => s.id),
];

test.describe('new effects smoke test', { tag: '@patterns' }, () => {
  for (const id of new Set([...NEW_IDS, ...Object.values(SMOKE_PATTERNS)])) {
    test(`renders ${id} without errors`, { tag: Object.values(SMOKE_PATTERNS).includes(id) ? '@smoke' : [] }, async ({ context, page }) => {
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.goto('/?role=screen'); // screen window
      const control = await context.newPage();
      await control.goto('/?role=control');
      await control.locator(`#pattern-library .pattern-btn[data-id="${id}"]`).click();
      await page.waitForFunction((expected) => window.__viz.patternId === expected, id);
      // Let it render a few frames
      await page.waitForTimeout(500);
      // Main canvas is visible. Some sketches (e.g. Noise Static) also create a
      // hidden createGraphics buffer canvas (display:none), so scope to :visible.
      await expect(page.locator('canvas:visible').first()).toBeVisible();
      expect(errors).toEqual([]);
      await control.close();
    });
  }
});
