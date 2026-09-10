import { test, expect } from '@playwright/test';
import { EXPANSION_PATTERNS, RESTORED_CAMERA_PATTERNS } from '../src/sketches/expansion/index.js';

test.use({ viewport: { width: 320, height: 180 }, launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

test('all expansion patterns render min/max visual settings at max band gains and resize without invalid geometry', { tag: '@patterns' }, async ({ page }) => {
  test.setTimeout(120_000); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/tests/fixtures/render.html');
  const results = await page.evaluate(async (ids) => {
    const { renderTimeline } = await import('/tests/fixtures/replacement-renderer.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const methods = ['arc', 'lineTo', 'moveTo', 'transform', 'setTransform', 'scale', 'translate', 'rotate', 'fillRect', 'rect', 'drawImage'];
    for (const key of methods) {
      const original = CanvasRenderingContext2D.prototype[key];
      CanvasRenderingContext2D.prototype[key] = function (...args) {
        if (args.some((v) => typeof v === 'number' && !Number.isFinite(v))) throw new Error(`Nonfinite geometry: ${key}`);
        return original.apply(this, args);
      };
    }
    const results = [];
    for (const id of ids) {
      const s = SKETCHES.find((x) => x.id === id);
      for (const edge of ['min', 'max']) {
        const patch = { ...Object.fromEntries(s.params.map((p) => [p.key, p[edge]])), bass: 2, mid: 2, high: 2 };
        const frames = await renderTimeline(id, () => ({ sub: 1.6, mid: 1.6, high: 1.6 }), patch, null, true);
        results.push({ id, edge, resized: frames.resized, bytes: frames[23].length });
      }
    }
    return results;
  }, [...EXPANSION_PATTERNS, ...RESTORED_CAMERA_PATTERNS].map((s) => s.id));
  expect(results).toHaveLength(46);
  for (const result of results) { expect(result.resized, result.id).toEqual([480, 270]); expect(result.bytes).toBe(320 * 180 * 4); }
  expect(errors).toEqual([]);
});
