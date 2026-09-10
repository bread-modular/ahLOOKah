import { test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// Evidence generator (not an assertion suite): renders the restored camera pair
// through the deterministic fixture and saves stills for the review sheet.
test.use({ viewport: { width: 320, height: 180 }, launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });
test('restored camera stills', { tag: '@patterns' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const images = await page.evaluate(async () => {
    const { renderTimeline, png } = await import('/tests/fixtures/replacement-renderer.js');
    const out = {};
    for (const id of ['video-edge-glow', 'video-thermal']) {
      const silence = await renderTimeline(id, () => ({}), {}, null, false, { staticCamera: true });
      const loud = await renderTimeline(id, () => ({ sub: .6, mid: .6, high: .6 }), {}, null, false, { staticCamera: true });
      out[id] = { silence: png(silence[20]), loud: png(loud[20]) };
    }
    return out;
  });
  await mkdir('test-results/expansion-evidence', { recursive: true });
  for (const [id, stills] of Object.entries(images)) {
    for (const [name, data] of Object.entries(stills)) {
      await writeFile(`test-results/expansion-evidence/${id}-${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
    }
  }
});
