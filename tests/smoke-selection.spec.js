import { test, expect } from '@playwright/test';
import { SMOKE_PATTERNS } from './smoke-patterns.js';

test('smoke representatives cover every registered library group', { tag: ['@core', '@smoke'] }, async ({ page }) => {
  await page.goto('/?role=control');
  const { sketches, groups } = await page.evaluate(async () => {
    const { SKETCHES, GROUP_ORDER } = await import('/src/sketch-registry.js');
    return { sketches: SKETCHES.map(({ id, group }) => ({ id, group })), groups: GROUP_ORDER };
  });
  expect(Object.keys(SMOKE_PATTERNS).sort()).toEqual([...new Set(sketches.map(s => s.group))].sort());
  expect([...Object.keys(SMOKE_PATTERNS), 'Media', 'Projection Mapping'].sort()).toEqual([...groups].sort());
  for (const [group, id] of Object.entries(SMOKE_PATTERNS)) {
    expect(sketches.find(s => s.id === id)?.group, id).toBe(group);
  }
});
