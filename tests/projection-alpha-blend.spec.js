import { test, expect } from '@playwright/test';
import { registerProjectionSketches, validProjectionPatch } from '../src/projection/projection-registry.js';

test.use({ launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

async function pixels(page, points) {
  const shot = await page.screenshot();
  return page.evaluate(async ({ b64, points }) => {
    const image = new Image(); image.src = `data:image/png;base64,${b64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3));
  }, { b64: shot.toString('base64'), points });
}

test('Alpha Blend defaults off, is per pattern, and only accepts numeric checkbox values', () => {
  const sketches = [];
  registerProjectionSketches(sketches, [
    { id: 'projection-one', name: 'One', surfaces: [] },
    { id: 'projection-two', name: 'Two', surfaces: [] },
  ]);
  for (const sketch of sketches) {
    expect(sketch.params).toEqual([{ key: 'alphaBlend', label: 'Alpha Blend', min: 0, max: 1, step: 1, default: 0 }]);
    for (const value of [0, 1]) expect(validProjectionPatch(sketch, {}, { alphaBlend: value })).toBe(true);
    for (const value of [-1, 2, .5, true, '1', null, NaN, Infinity]) {
      expect(validProjectionPatch(sketch, {}, { alphaBlend: value })).toBe(false);
    }
  }
});

for (const fallbackAtStartup of [false, true]) {
  test(`Alpha Blend preserves colors, source alpha, underlying layers and smoothing (${fallbackAtStartup ? 'CSS startup' : 'GPU then context loss'})`, async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 400 });
    await page.goto('/docs/');
    await page.setContent(`<style>
      html, body { margin: 0; background: #0000ff; }
      #host { position: absolute; inset: 0; }
      #host canvas { background: black; }
    </style><div id="host"></div>`);
    await page.addStyleTag({ url: '/src/styles/projection-mapping.css' });
    await page.evaluate(async (fallbackAtStartup) => {
      const { ProjectionLayer } = await import('/src/projection/ProjectionLayer.js');
      const { surfaceQuadValues } = await import('/src/projection/projection-registry.js');
      const rect = (a, b) => [{ x: a, y: a }, { x: b, y: a }, { x: b, y: b }, { x: a, y: b }];
      const values = { ...surfaceQuadValues('sbase', rect(.1, .9)), ...surfaceQuadValues('stop', rect(.25, .75)) };
      const getContext = HTMLCanvasElement.prototype.getContext;
      if (fallbackAtStartup) HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        return type === 'webgl2' ? null : getContext.call(this, type, ...args);
      };
      const layer = new ProjectionLayer({ host: document.querySelector('#host'), pattern: { id: 'projection-fixture' },
        getParams: () => values, getSize: () => [400, 400] });
      HTMLCanvasElement.prototype.getContext = getContext;
      for (const id of ['sbase', 'stop']) {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 400;
        const ctx = canvas.getContext('2d');
        if (id === 'sbase') { ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 400, 400); }
        else {
          for (const [i, color] of ['#000', '#00ff00', '#404040', 'rgba(0,0,255,0.5)'].entries()) {
            ctx.fillStyle = color; ctx.fillRect(i * 100, 0, 100, 400);
          }
        }
        layer.sources.append(canvas);
        const node = { surface: { id } }; layer.children.push(node); layer.capture(node, canvas);
      }
      window.fixture = { layer, values };
    }, fallbackAtStartup);
    const points = [[60, 200], [120, 200], [175, 200], [220, 200], [280, 200], [20, 200]];
    await expect.poll(async () => (await pixels(page, points)).filter((_, i) => i !== 4)).toEqual([
      [255, 0, 0], [0, 0, 0], [0, 255, 0], [64, 64, 64], [0, 0, 0],
    ]);
    const enable = async (value) => page.evaluate((value) => {
      window.fixture.values.alphaBlend = value; window.fixture.layer.queueRender();
    }, value);
    await enable(1);
    const expected = [[255, 0, 0], [255, 0, 0], [0, 255, 0], [64, 64, 64], [127, 0, 128], [0, 0, 255]];
    await expect.poll(() => pixels(page, points)).toEqual(expected);
    // The same static capture can switch between masked and opaque rendering.
    await enable(0);
    await expect.poll(async () => (await pixels(page, points))[1]).toEqual([0, 0, 0]);
    await enable(1);
    await expect.poll(() => pixels(page, points)).toEqual(expected);
    await page.evaluate(() => { window.fixture.values['stop:mappingEdgeBlur'] = 25; window.fixture.layer.queueRender(); });
    const edge = [[175, 125]];
    await expect.poll(async () => (await pixels(page, edge))[0][0]).toBeGreaterThan(110);
    const smoothed = (await pixels(page, edge))[0];
    expect(smoothed[0]).toBeLessThan(145);
    expect(smoothed[1]).toBeGreaterThan(110);
    expect(smoothed[1]).toBeLessThan(145);
    if (!fallbackAtStartup) {
      await expect(page.locator('.projection-layer')).not.toHaveAttribute('data-fallback', 'true');
      await page.evaluate(() => window.fixture.layer.renderer.gl.getExtension('WEBGL_lose_context').loseContext());
      await expect(page.locator('.projection-layer')).toHaveAttribute('data-fallback', 'true');
      const css = (await pixels(page, edge))[0];
      css.forEach((channel, i) => expect(Math.abs(channel - smoothed[i])).toBeLessThan(8));
    }
    await page.evaluate(() => { window.fixture.values['stop:mappingEdgeBlur'] = 0; window.fixture.layer.queueRender(); });
    await expect.poll(() => pixels(page, points)).toEqual(expected);
    await enable(0);
    await expect.poll(async () => (await pixels(page, points))[1]).toEqual([0, 0, 0]);
    await page.evaluate(() => window.fixture.layer.dispose());
    await expect(page.locator('.projection-filter-defs')).toHaveCount(0);
  });
}

test('Alpha Blend keys before minification and refreshes cached masks after capture and resize', async ({ page }) => {
  await page.goto('/docs/');
  const result = await page.evaluate(async () => {
    const { ScreenMappingRenderer } = await import('/src/screen-mapping-renderer.js');
    const { IDENTITY_QUAD } = await import('/src/screen-mapping.js');
    const output = document.createElement('canvas');
    const renderer = new ScreenMappingRenderer(output, { alpha: true });
    renderer.configure(IDENTITY_QUAD, 32, 32);
    const source = document.createElement('canvas'); source.width = source.height = 256;
    const ctx = source.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#00ff00';
    for (let x = 0; x < 256; x += 2) ctx.fillRect(x, 0, 1, 256);
    renderer.capture(source);
    const draw = (alphaBlend) => {
      renderer.renderSurfaces([{ canvas: source, quad: IDENTITY_QUAD }], { alphaBlend });
      const pixel = new Uint8Array(4);
      renderer.gl.readPixels(16, 16, 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, pixel);
      return [...pixel];
    };
    const masked = draw(true), opaque = draw(false), maskedAgain = draw(true);
    source.width = source.height = 64;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 64, 64); renderer.capture(source);
    const black = draw(true);
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 64, 64); renderer.capture(source);
    const red = draw(true);
    const glError = renderer.gl.getError();
    renderer.release(source);
    const textures = renderer.textures.size;
    renderer.dispose();
    return { masked, opaque, maskedAgain, black, red, glError, textures };
  });
  expect(result.masked).toEqual([0, 128, 0, 128]);
  expect(result.opaque).toEqual([0, 128, 0, 255]);
  expect(result.maskedAgain).toEqual(result.masked);
  expect(result.black).toEqual([0, 0, 0, 0]);
  expect(result.red).toEqual([255, 0, 0, 255]);
  expect(result.glError).toBe(0);
  expect(result.textures).toBe(0);
});

test('Alpha Blend enabled at startup retains early-draw wrappers through async canvas attachment', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 400 });
  await page.goto('/docs/');
  await page.setContent('<style>html,body{margin:0;background:#0000ff}#host{position:absolute;inset:0}</style><div id="host"></div>');
  await page.addStyleTag({ url: '/src/styles/projection-mapping.css' });
  await page.evaluate(async () => {
    const { ProjectionLayer } = await import('/src/projection/ProjectionLayer.js');
    const { ProgramRuntime } = await import('/src/program-runtime.js');
    const { surfaceQuadValues } = await import('/src/projection/projection-registry.js');
    const values = { alphaBlend: 1, ...surfaceQuadValues('stop', [
      { x: .25, y: .25 }, { x: .75, y: .25 }, { x: .75, y: .75 }, { x: .25, y: .75 },
    ]) };
    const layer = new ProjectionLayer({ host: document.querySelector('#host'), pattern: { id: 'projection-early' },
      getParams: () => values, getSize: () => [400, 400] });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 400;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 400, 400);
    ctx.fillStyle = '#00ff00'; ctx.fillRect(200, 0, 200, 400);
    layer.sources.append(canvas);
    const node = { surface: { id: 'stop' }, projection: layer, host: layer.sources, sketch: { id: 'solid-color' } };
    layer.children = [node];
    // The draw/compositor wins the race against p5's asynchronous attachment.
    layer.capture(node, canvas); layer.render();
    const runtime = Object.assign(Object.create(ProgramRuntime.prototype), {
      disposed: false, nodes: [node], projectionLayers: [layer], attached: new Set(), selection: { merge: false },
      _mark() {}, _checkReady() {},
    });
    runtime._attachCanvas({ canvas }, 0);
    window.earlyAlpha = layer;
  });
  await expect(page.locator('.projection-alpha-surface > canvas')).toHaveCount(1);
  const points = [[50, 200], [150, 200], [250, 200], [350, 200]];
  const expected = [[0, 0, 255], [0, 0, 255], [0, 255, 0], [0, 0, 255]];
  await expect.poll(() => pixels(page, points)).toEqual(expected);
  await page.evaluate(() => window.earlyAlpha.renderer.gl.getExtension('WEBGL_lose_context').loseContext());
  await expect(page.locator('.projection-layer')).toHaveAttribute('data-fallback', 'true');
  await expect(page.locator('.projection-alpha-surface > canvas')).toHaveCount(1);
  await expect.poll(() => pixels(page, points)).toEqual(expected);
  await page.evaluate(() => window.earlyAlpha.dispose());
});
