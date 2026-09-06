import { test, expect } from '@playwright/test';

// Shader-level colour/alpha checks complement the real p5/Output-window tests.
// Sample well inside the quad so this compares compositing, not edge coverage.
test('mapped merge and post-FX match CSS, including transparent and unpreserved WebGL sources', async ({ page }) => {
  await page.goto('/docs/');
  await page.setContent(`
    <style>
      html,body { margin:0; background:#000; }
      #stage,#layer { position:fixed; inset:0; isolation:isolate; transform-origin:0 0; }
      canvas { position:absolute; inset:0; width:100%; height:100%; }
      #output { display:none; }
    </style>
    <div id="stage"><div id="layer"><canvas id="base"></canvas><canvas id="overlay"></canvas></div></div>
    <canvas id="output"></canvas>
  `);
  await page.evaluate(async () => {
    const { ScreenMappingRenderer } = await import('/src/screen-mapping-renderer.js');
    const { quadToMatrix3d } = await import('/src/screen-mapping.js');
    const base = document.getElementById('base');
    const overlay = document.getElementById('overlay');
    base.width = overlay.width = innerWidth;
    base.height = overlay.height = innerHeight;
    const ctx = base.getContext('2d');
    ctx.fillStyle = 'rgba(180, 65, 20, 0.8)';
    ctx.fillRect(0, 0, base.width, base.height);
    const sourceGl = overlay.getContext('webgl2', { preserveDrawingBuffer: false, premultipliedAlpha: true });
    sourceGl.clearColor(0.12 * 0.6, 0.5 * 0.6, 0.85 * 0.6, 0.6);
    sourceGl.clear(sourceGl.COLOR_BUFFER_BIT);
    const quad = [{ x: 0.1, y: 0.15 }, { x: 0.8, y: 0.1 }, { x: 0.9, y: 0.95 }, { x: 0.15, y: 0.8 }];
    document.getElementById('stage').style.transform = quadToMatrix3d(quad, innerWidth, innerHeight);
    const renderer = new ScreenMappingRenderer(document.getElementById('output'));
    renderer.configure(quad, innerWidth, innerHeight, devicePixelRatio);
    // Capture in the same callback that drew the WebGL source.
    renderer.capture(base);
    renderer.capture(overlay);
    window.mappingTest = { renderer, base, overlay };
  });

  const centerPixel = async () => {
    const shot = await page.screenshot();
    return page.evaluate(async (b64) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data].slice(0, 3);
    }, shot.toString('base64'));
  };

  for (const mode of [0, 1]) {
    for (const postFx of [{}, { brightness: 25, contrast: 30, saturation: -40 }, { brightness: 150, contrast: -50, saturation: 40 }]) {
      const blend = { mode, mix: 0.4, add: 0.7 };
      await page.evaluate(({ blend, postFx }) => {
        const { overlay } = window.mappingTest;
        overlay.style.opacity = String(blend.mode === 1 ? blend.add : blend.mix);
        overlay.style.mixBlendMode = blend.mode === 1 ? 'screen' : 'normal';
        document.getElementById('stage').style.filter = `brightness(${1 + (postFx.brightness || 0) / 100}) contrast(${1 + (postFx.contrast || 0) / 100}) saturate(${1 + (postFx.saturation || 0) / 100})`;
        document.getElementById('output').style.display = 'none';
      }, { blend, postFx });
      const css = await centerPixel();
      await page.evaluate(({ blend, postFx }) => {
        const { renderer, base, overlay } = window.mappingTest;
        document.getElementById('output').style.display = 'block';
        renderer.render({ canvases: [base, overlay], blend, postFx });
      }, { blend, postFx });
      const mapped = await centerPixel();
      for (let channel = 0; channel < 3; channel += 1) {
        expect(Math.abs(mapped[channel] - css[channel]), JSON.stringify({ mode, postFx, css, mapped })).toBeLessThanOrEqual(3);
      }
    }
  }
  // The cached texture is independent of a source buffer cleared after paint.
  const before = await centerPixel();
  await page.evaluate(() => {
    const { renderer, base, overlay } = window.mappingTest;
    const gl = overlay.getContext('webgl2');
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.render({ canvases: [base, overlay], blend: { mode: 1, add: 0.7 }, postFx: { brightness: 150, contrast: -50, saturation: 40 } });
  });
  expect(await centerPixel()).toEqual(before);
  await page.evaluate(() => window.mappingTest.renderer.dispose());
});
