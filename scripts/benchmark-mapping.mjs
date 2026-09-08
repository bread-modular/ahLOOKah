// Synthetic mapper benchmark, not end-to-end video FPS. Deliberate one-pixel readback
// waits belong ONLY here, never in the interactive renderer or budget monitor.
// Start Vite first, then: BENCHMARK_URL=http://localhost:5273 node scripts/benchmark-mapping.mjs <baseline-git-ref>
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const baseURL = process.env.BENCHMARK_URL || 'http://localhost:5173';
const ref = process.argv[2] || 'HEAD';
const sources = {
  before: execFileSync('git', ['show', `${ref}:src/screen-mapping-renderer.js`], { encoding: 'utf8' }),
  after: readFileSync(new URL('../src/screen-mapping-renderer.js', import.meta.url), 'utf8'),
};
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.route('**/benchmark-mapper-*.js', (route) => {
    const version = route.request().url().includes('-before.js') ? 'before' : 'after';
    return route.fulfill({ contentType: 'application/javascript', body: sources[version].replace("'./screen-mapping.js'", "'/src/screen-mapping.js'") });
  });
  await page.goto(`${baseURL}/docs/`);
  const results = [];
  for (const [count, tiled, edgeBlur] of [[1, false, 0], [1, false, 12], [8, true, 0], [8, true, 12], [8, false, 12]]) {
    const rows = { before: [], after: [] };
    let gpu;
    // Alternate ordering to avoid assigning every cold run to the baseline.
    for (const version of ['before', 'after', 'after', 'before']) {
      const result = await page.evaluate(async ({ count, tiled, edgeBlur, version }) => {
        const { ScreenMappingRenderer } = await import(`/benchmark-mapper-${version}.js`);
        const { IDENTITY_QUAD } = await import('/src/screen-mapping.js');
        const output = document.createElement('canvas');
        const renderer = new ScreenMappingRenderer(output);
        renderer.configure(IDENTITY_QUAD, 960, 540);
        const gl = renderer.gl;
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        const surfaces = Array.from({ length: count }, (_, i) => {
          const canvas = document.createElement('canvas');
          canvas.width = 960; canvas.height = 540;
          const context = canvas.getContext('2d');
          context.fillStyle = `hsl(${i * 40} 80% 50%)`;
          context.fillRect(0, 0, canvas.width, canvas.height);
          const x = (i % 4) / 4, y = Math.floor(i / 4) / 2;
          const quad = tiled ? [{ x: x + .01, y: y + .01 }, { x: x + .24, y: y + .02 },
            { x: x + .24, y: y + .49 }, { x: x + .01, y: y + .48 }] : IDENTITY_QUAD;
          return { canvas, context, quad, edgeBlur };
        });
        const times = [];
        const pixel = new Uint8Array(4);
        for (let frame = 0; frame < 18; frame++) {
          const start = performance.now();
          for (const surface of surfaces) {
            surface.context.fillRect(frame, 0, 1, 1); // New source content, as with decoded video.
            renderer.capture(surface.canvas);
          }
          if (!renderer.renderSurfaces(surfaces)) throw new Error('Mapping did not present');
          // A readback forces Chromium to wait for execution, not just enqueue
          // GPU commands. Timing JS submission alone would undercount the work.
          gl.readPixels(20, 20, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR || pixel[3] !== 255) throw new Error('Invalid benchmark frame');
          if (frame >= 4) times.push(performance.now() - start);
        }
        renderer.dispose();
        return { times, gpu };
      }, { count, tiled, edgeBlur, version });
      rows[version].push(...result.times);
      gpu = result.gpu;
    }
    const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const beforeMs = median(rows.before), afterMs = median(rows.after);
    results.push({ count, layout: tiled ? 'tiled-warped' : 'full-frame', edgeBlur, beforeMs, afterMs,
      reductionPercent: Math.round((1 - afterMs / beforeMs) * 100), gpu });
  }
  console.log(JSON.stringify({ baseline: ref, resolution: '960x540', samplesPerVersion: 28, results }, null, 2));
} finally {
  await browser.close();
}
