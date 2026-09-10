import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { EXPANSION_PATTERNS } from '../src/sketches/expansion/index.js';

// Fixed raster + software GL for reproducible evidence across this host's runs.
test.use({ viewport: { width: 320, height: 180 }, launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });
const output = process.env.EXPANSION_ARTIFACTS || 'test-results/expansion-evidence';

// Same audit contract as the replacement wave: deterministic silence, exact
// zero-disables, per-band structural change at modest (0.2) analyzer levels.
for (const sketch of EXPANSION_PATTERNS) test(`${sketch.id}: synchronized animated A/B, bands, mute and bounds`, { tag: '@patterns' }, async ({ page }) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && /shader|WebGL|p5.js/i.test(m.text())) errors.push(m.text()); });
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async id => (await import('/tests/fixtures/replacement-renderer.js')).audit(id), sketch.id);
  const dir = `${output}/${sketch.id}`; await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/metrics.json`, JSON.stringify({ id: result.id, ...result.metrics }, null, 2));
  for (const [name, image] of Object.entries(result.stills)) await writeFile(`${dir}/${name}.png`, Buffer.from(image.split(',')[1], 'base64'));
  for (let i = 0; i < result.animation.length; i++) for (const [name, image] of Object.entries(result.animation[i])) {
    await writeFile(`${dir}/${name}-${String(i).padStart(2, '0')}.png`, Buffer.from(image.split(',')[1], 'base64'));
  }
  const m = result.metrics;
  expect(m.duplicate.maxDelta, 'duplicate silence must match bit-for-bit').toBe(0);
  expect(m.zero.maxDelta, 'all sliders zero must equal animated silence').toBe(0);
  // Full-frame perceptibility floors, not a few changed bytes. Edge relocation is
  // computed on normalized luma, so brightness-only gains cannot satisfy it.
  expect(m.modest.rgb, 'modest RGB mean').toBeGreaterThan(6);
  expect(m.modest.coverage, 'modest changed pixel area').toBeGreaterThan(.1);
  expect(m.modest.edge, 'modest geometry edge area').toBeGreaterThan(.015);
  for (const level of ['strong', 'pulse']) {
    expect(m[level].rgb, level).toBeGreaterThan(3);
    expect(m[level].coverage, level).toBeGreaterThan(.05);
  }
  for (const band of ['bass', 'mid', 'high']) {
    expect(m.bands[band].rgb, `${band} RGB`).toBeGreaterThan(2);
    expect(m.bands[band].coverage, `${band} coverage`).toBeGreaterThan(.035);
    expect(m.bands[band].edge, `${band} structural edges`).toBeGreaterThan(.006);
    expect(m.bands[band].edgeRelocation, `${band} normalized edge relocation`).toBeGreaterThan(.12);
    expect(m.muted[band].maxDelta, `${band} zero disables`).toBe(0);
    expect(m.independent[band].maxDelta, `${band} mute preserves other bands`).toBe(0);
  }
  expect(m.max.lit, 'maximum audio cannot black out').toBeGreaterThan(.03);
  expect(m.max.dark, 'maximum audio cannot wash out').toBeGreaterThan(.03);
  if (sketch.group === 'Alphas') expect(m.max.grayscale).toBe(true);
  expect(errors).toEqual([]);
});
