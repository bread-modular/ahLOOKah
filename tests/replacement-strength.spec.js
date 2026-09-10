import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { GRAPHIC_PATTERNS } from '../src/sketches/replacements/graphic.js';
import { FIELD_PATTERNS } from '../src/sketches/replacements/fields.js';
import { SPATIAL_PATTERNS } from '../src/sketches/replacements/spatial.js';
import { VIDEO_PATTERNS } from '../src/sketches/replacements/video.js';
const OWNED = [...GRAPHIC_PATTERNS, ...FIELD_PATTERNS, ...SPATIAL_PATTERNS, ...VIDEO_PATTERNS];
const root = 'test-results/replacement-strength';
const bands = ['bass', 'mid', 'high'];
let recordings;
test.use({ viewport: { width: 320, height: 180 }, launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] } });
// Run this focused file with --workers=1: one real recording session, reused by
// all pattern renderers. No repeated mic acquisition or full-suite invocation.
test.beforeAll(async ({ browser }) => {
  test.setTimeout(60_000);
  fs.mkdirSync(`${root}/before`, { recursive: true });
  for (const name of ['runtime', 'graphic', 'fields', 'spatial', 'video']) {
    const source = execFileSync('git', ['show', `9f707fe:src/sketches/replacements/${name}.js`], { encoding: 'utf8' })
      .replaceAll("'../band-reactive.js'", "'/src/sketches/band-reactive.js'").replaceAll("'../shader-utils.js'", "'/src/sketches/shader-utils.js'");
    // Avoid notifying Vite's watcher when a failed test restarts its worker.
    if (!fs.existsSync(`${root}/before/${name}.js`) || fs.readFileSync(`${root}/before/${name}.js`, 'utf8') !== source) fs.writeFileSync(`${root}/before/${name}.js`, source);
  }
  recordings = {};
  const page = await browser.newPage();
  await page.goto('/tests/fixtures/render.html');
  try {
    for (const band of bands) {
      if (process.env.REPLACEMENT_REUSE_CAPTURE === '1') recordings[band] = JSON.parse(fs.readFileSync(`${root}/analyzer-${band}.json`, 'utf8'));
      else {
        recordings[band] = await page.evaluate(async band => (await import('/tests/fixtures/replacement-pipeline.js')).captureAnalyzer(band, -60), band);
        fs.writeFileSync(`${root}/analyzer-${band}.json`, JSON.stringify(recordings[band]));
      }
      expect(recordings[band].smoothing).toBe(.12);
      const key = band === 'bass' ? 'sub' : band;
      expect(Math.max(...recordings[band].measurements.slice(-24).map(f => f[key]))).toBeLessThan(.01);
    }
  } finally { await page.close(); }
});
for (const sketch of OWNED) test(`${sketch.id}: weak real pipeline has three distinct animated structural responses`, { tag: '@patterns' }, async ({ page }, info) => {
  test.setTimeout(90_000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async ({ id, recordings }) => (await import('/tests/fixtures/replacement-strength-audit.js')).auditStrength(id, recordings), { id: sketch.id, recordings });
  fs.writeFileSync(`${root}/${sketch.id}.json`, JSON.stringify(result));
  const { animation, beforeAnimation, stills, ...metrics } = result;
  await info.attach('structural-temporal-metrics', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
  expect(result.zero.maxDelta, 'zero gain = exact animated silence, all frames').toBe(0);
  for (const band of bands) {
    const m = result.bands[band];
    expect.soft(m.actual.relocation, `${band}: contour relocation at -60 dBFS`).toBeGreaterThan(.18);
    expect.soft(m.actual.edge, `${band}: changed edge area`).toBeGreaterThan(.003);
    expect.soft(m.actual.geometry, `${band}: oriented spatial geometry`).toBeGreaterThan(.04);
    expect.soft(m.actual.temporal, `${band}: motion beyond autonomous/camera baseline`).toBeGreaterThan(.003);
    expect.soft(m.actual.temporal, `${band}: better than 9f707fe through identical pipeline`).toBeGreaterThan(m.before.temporal * 2 + .001);
    expect.soft(m.weak.relocation, `${band}: independently injected 0.015 feature`).toBeGreaterThan(.1);
    expect.soft(m.weak.geometry, `${band}: weak structure not only tint`).toBeGreaterThan(.025);
    expect.soft(Math.max(...m.amplitude), `${band}: available weak input is not gated away`).toBeGreaterThan(.2);
  }
  for (const [pair, distance] of Object.entries(result.pairwise)) expect.soft(distance, `${pair}: different geometry signatures at equal input`).toBeGreaterThan(.035);
  expect(errors).toEqual([]);
});
