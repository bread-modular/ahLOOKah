import { test, expect } from '@playwright/test';

// Smoke test: every newly added effect loads and renders without page errors.
const NEW_IDS = [
  'laser-grid',
  'strobe-pulse',
  'plasma-waves',
  'vortex-spiral',
  'glitch-matrix',
  'orbital-rings',
  'shockwave-beats',
  'neon-ribbons',
  'prism-burst',
  'cosmic-web',
  'event-horizon',
  'liquid-chrome',
  'laser-cathedral',
  'cymatic-bloom',
  'holo-swarm',
  'ion-tempest',
  'crystal-reliquary',
  'neural-cascade',
  'aurora-reactor',
  'warp-loom',
];

test.describe('new effects smoke test', () => {
  for (const id of NEW_IDS) {
    test(`renders ${id} without errors`, async ({ context, page }) => {
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.goto('/'); // screen window
      const control = await context.newPage();
      await control.goto('/?role=control');
      await control.locator(`.pattern-btn[data-id="${id}"]`).click();
      await page.waitForFunction((expected) => window.__viz.patternId === expected, id);
      // Let it render a few frames
      await page.waitForTimeout(500);
      await expect(page.locator('canvas')).toBeVisible();
      expect(errors).toEqual([]);
      await control.close();
    });
  }
});
