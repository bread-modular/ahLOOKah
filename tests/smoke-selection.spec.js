import { test, expect } from '@playwright/test';
import { SMOKE_PATTERNS } from './smoke-patterns.js';

// Bounded @smoke representatives: one deliberate inexpensive pattern per
// established built-in category. Ordinary additions to those categories never
// change this set. Introducing a NEW built-in category is a deliberate
// library-taxonomy decision (not an ordinary addition) and fails this test
// until a representative is added here — add one line to SMOKE_PATTERNS.
test('smoke representatives cover every built-in library group', { tag: ['@core', '@smoke'] }, async ({ page }) => {
  await page.goto('/?role=control');
  const { sketches, groups, dynamicGroups } = await page.evaluate(async () => {
    const { BUILTIN_PATTERNS, GROUP_ORDER } = await import('/src/sketch-registry.js');
    const { NODE_PATTERNS_GROUP } = await import('/src/nodes/routes.js');
    return {
      sketches: BUILTIN_PATTERNS.map(({ id, group }) => ({ id, group })),
      groups: GROUP_ORDER,
      dynamicGroups: ['Media', 'Projection Mapping', 'Custom Scripts', NODE_PATTERNS_GROUP],
    };
  });
  const builtinGroups = [...new Set(sketches.map((s) => s.group))].sort();
  // Representatives cover every built-in group; dynamic utility groups are
  // covered by their own lifecycle tests, not by pattern representatives.
  expect(Object.keys(SMOKE_PATTERNS).sort()).toEqual(builtinGroups);
  expect([...Object.keys(SMOKE_PATTERNS), ...dynamicGroups].sort()).toEqual([...groups].sort());
  for (const [group, id] of Object.entries(SMOKE_PATTERNS)) {
    expect(sketches.find((s) => s.id === id)?.group, id).toBe(group);
  }
});
