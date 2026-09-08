import { test, expect } from '@playwright/test';

// Small, parked sources exercise intermediate alpha and calibration without a
// looping sketch or audio owner masking missing redraw/presentation work.
test.use({ viewport: { width: 320, height: 200 }, launchOptions: { args: [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
] } });

async function pixels(page) {
  const shot = await page.screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    return [.05, .275, .325, .5, .725, .95].map((x) => [...ctx.getImageData(Math.floor(x * img.width), 100, 1, 1).data].slice(0, 3));
  }, shot.toString('base64'));
}

for (const identity of [false, true]) {
  test(`mixed input alpha/feather matches CSS with post-FX (identity: ${identity})`, async ({ page }) => {
    await page.goto('/docs/');
    await page.setContent(`<link rel="stylesheet" href="/src/styles/stage.css">
      <style>body { margin:0; background:black; } canvas { width:100%; height:100%; }
      #projection { position:absolute; inset:0; background:red; }</style>
      <div id="screen-wrap"><div class="program-layer program-layer-live"><div id="projection"></div></div></div>`);
    await page.evaluate(async (identity) => {
      const { ScreenMappingLayer } = await import('/src/screen-mapping-layer.js');
      const mapping = { enabled: true, edgeBlur: 25, quad: identity ? null : [
        { x: .25, y: .1 }, { x: .75, y: .1 }, { x: .75, y: .9 }, { x: .25, y: .9 },
      ] };
      const layer = new ScreenMappingLayer({ host: document.querySelector('.program-layer'),
        getSize: () => [innerWidth, innerHeight], getMapping: () => mapping });
      layer.element.style.zIndex = '1';
      const source = document.createElement('canvas'); source.width = innerWidth; source.height = innerHeight;
      layer.sources.appendChild(source);
      const ctx = source.getContext('2d'); ctx.fillStyle = 'rgba(0, 0, 255, 0.5)'; ctx.fillRect(0, 0, source.width, source.height);
      layer.capture(source);
      window.layerTest = { layer, mapping, source };
    }, identity);
    await expect.poll(() => page.evaluate(() => window.layerTest.layer.presented)).toBe(true);
    for (const mode of ['normal', 'screen']) {
      for (const filter of ['none', 'brightness(1.5) contrast(0.5) saturate(0.6)']) {
        await page.evaluate(({ mode, filter }) => {
          const { layer } = window.layerTest;
          layer.element.style.opacity = '0.7'; layer.element.style.mixBlendMode = mode;
          document.getElementById('screen-wrap').style.filter = filter;
          delete layer.element.dataset.fallback;
          layer.sources.style.opacity = '0'; layer.renderer.canvas.style.display = '';
          layer.render();
        }, { mode, filter });
        const gpu = await pixels(page);
        await page.evaluate(() => {
          const { layer } = window.layerTest;
          // Simulate the real fallback state: GPU output off, CSS feather on.
          layer.element.dataset.fallback = 'true';
          layer.sources.style.opacity = '1'; layer.renderer.canvas.style.display = 'none';
        });
        const css = await pixels(page);
        expect(Math.max(...gpu.flatMap((rgb, i) => rgb.map((v, c) => Math.abs(v - css[i][c])))), JSON.stringify({ gpu, css, mode, filter })).toBeLessThanOrEqual(4);
      }
    }
    // A mapping edit presents from cached pixels, even though no source draws.
    await page.evaluate(() => {
      const { layer, mapping } = window.layerTest;
      mapping.edgeBlur = 0;
      delete layer.element.dataset.fallback;
      layer.renderer.canvas.style.display = '';
      layer.resize();
    });
    await expect.poll(() => page.evaluate(() => {
      const { layer } = window.layerTest; return layer.presentedRevision === layer.captureRevision;
    })).toBe(true);
    // Disable releases GPU resources and restores the original full-frame input.
    await page.evaluate(() => { const { layer, mapping } = window.layerTest; mapping.enabled = false; layer.resize(); });
    await expect(page.locator('.screen-mapped-output')).toHaveCount(0);
    await expect(page.locator('.screen-mapped-source canvas')).toHaveCSS('transform', 'none');
    await expect(page.locator('.screen-mapped-source canvas')).toHaveCSS('mask-image', 'none');
    await page.evaluate(() => window.layerTest.layer.dispose());
    await expect(page.locator('.screen-mapped-layer')).toHaveCount(0);
  });
}

test('mixed noLoop runtime re-enables calibration and gates fresh presentation', async ({ page }) => {
  await page.goto('/docs/');
  await page.setContent('<link rel="stylesheet" href="/src/styles/stage.css"><link rel="stylesheet" href="/src/styles/projection-mapping.css"><div id="screen-wrap"><div class="program-layer program-layer-live"></div></div>');
  await page.evaluate(async () => {
    const { default: p5 } = await import('/node_modules/.vite/deps/p5.js');
    const { ProgramRuntime } = await import('/src/program-runtime.js');
    const mapping = { enabled: false, edgeBlur: 15, quad: null };
    const ordinary = { id: 'test-static', params: [], factory: () => (p) => {
      p.setup = () => { p.createCanvas(innerWidth, innerHeight, p.WEBGL); p.setAttributes({ preserveDrawingBuffer: false }); p.noLoop(); };
      p.draw = () => p.background('blue');
    } };
    const projection = { id: 'test-projection', projection: true, surfaces: [], params: [] };
    const black = { id: 'solid-color', params: [], factory: () => (p) => {
      p.setup = () => { p.createCanvas(innerWidth, innerHeight); p.noLoop(); };
      p.draw = () => p.background('black');
    } };
    const runtime = new ProgramRuntime({ p5Constructor: p5, selection: { ids: ['test-projection', 'test-static'], merge: true },
      sketches: [ordinary, projection, black], layer: document.querySelector('.program-layer'),
      getParams: () => ({ mix: 1 }), getScreenMapping: () => mapping });
    window.runtimeTest = { runtime, mapping };
    await runtime.prepare();
    mapping.enabled = true;
    runtime.updateScreenMapping();
  });
  await expect(page.locator('.screen-mapped-source')).toHaveCSS('opacity', '0');
  await expect.poll(() => page.evaluate(() => {
    const layer = window.runtimeTest.runtime.screenMappingLayers[0];
    return layer.presentedRevision === layer.captureRevision;
  })).toBe(true);
  expect((await pixels(page))[3]).toEqual([0, 0, 255]); // Before any resume/fresh draw.
  await page.evaluate(async () => {
    const { runtime } = window.runtimeTest;
    await runtime.requestFreshFrame(8000, { parkAfter: true });
    if (!runtime.paused) throw new Error('Fresh-frame request did not park the runtime');
  });
  expect((await pixels(page))[3]).toEqual([0, 0, 255]);
  await page.locator('.screen-mapped-output').evaluate((canvas) => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await expect(page.locator('.screen-mapped-layer')).toHaveAttribute('data-fallback', 'true');
  expect((await pixels(page))[3]).toEqual([0, 0, 255]);
  await page.evaluate(() => { const { runtime, mapping } = window.runtimeTest; mapping.enabled = false; runtime.updateScreenMapping(); });
  await expect(page.locator('.screen-mapped-source canvas')).toHaveCSS('mask-image', 'none');
  expect((await pixels(page))[3]).toEqual([0, 0, 255]);
  await page.evaluate(() => window.runtimeTest.runtime.dispose());
  await expect(page.locator('.screen-mapped-layer')).toHaveCount(0);
});
