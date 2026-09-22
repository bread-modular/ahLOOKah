import { BUILTIN_PATTERNS } from '../src/patterns/builtins.js';
import { test, expect } from '@playwright/test';
import { SMOKE_PATTERNS } from './smoke-patterns.js';

// Full-catalog render coverage: one named test per built-in pattern, generated
// from the real catalog. New patterns receive render coverage automatically —
// there is no hand-maintained id list to extend.
//
// The bounded @smoke representatives (SMOKE_PATTERNS) stay a separate,
// deliberate contract: one inexpensive pattern per established category.
const SMOKE_IDS = new Set(Object.values(SMOKE_PATTERNS));

test.describe('built-in patterns render without errors', { tag: '@patterns' }, () => {
  for (const { id } of BUILTIN_PATTERNS) {
    test(`renders ${id} without errors`, { tag: SMOKE_IDS.has(id) ? '@smoke' : [] }, async ({ context, page }) => {
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
