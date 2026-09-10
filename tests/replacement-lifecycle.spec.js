import { test, expect } from '@playwright/test';

const GROUPS = { 'Video FX': ['video-slit-scan', 'video-facet-fold'] };

// Isolated real-p5 renderer, with a deterministic camera frame. Unlike a fake
// webcam's moving clock this allows exact audio-on/off pixel comparisons.
async function mount(page, id) {
  await page.setViewportSize({ width: 360, height: 240 });
  await page.goto('/docs/patterns.html');
  await page.evaluate(async (id) => {
    const { default: p5 } = await import('/node_modules/p5/lib/p5.esm.js');
    const { SKETCHES, defaultParamValues } = await import('/src/sketch-registry.js');
    const { disposeP5Instance } = await import('/src/program-runtime.js');
    const sketch = SKETCHES.find((s) => s.id === id);
    const params = { ...defaultParamValues(id), speed: 0 };
    const controller = sketch.createAudioController();
    let features = {};
    let reads = 0;
    const mediaReady = [];
    const streams = [];
    const intervals = [];
    const context = {
      audioControls: {
        read() {
          reads++;
          return controller.update({ shared: { getFeatures: () => features }, params, deltaSeconds: 1 / 60 });
        },
      },
      createCapture(p, _constraints, onReady) {
        const source = document.createElement('canvas');
        source.width = 320; source.height = 180;
        const ctx = source.getContext('2d');
        const paint = () => {
          const gradient = ctx.createLinearGradient(0, 0, 320, 180);
          gradient.addColorStop(0, '#102855');
          gradient.addColorStop(0.45, '#efc148');
          gradient.addColorStop(1, '#dc3872');
          ctx.fillStyle = gradient; ctx.fillRect(0, 0, 320, 180);
          ctx.fillStyle = '#ffffff'; ctx.fillRect(30, 20, 60, 80);
          ctx.fillStyle = '#123017'; ctx.fillRect(190, 35, 100, 90);
          ctx.fillStyle = '#20dca2'; ctx.beginPath(); ctx.arc(135, 120, 28, 0, Math.PI * 2); ctx.fill();
        };
        paint();
        const stream = source.captureStream(30);
        streams.push(stream);
        intervals.push(setInterval(paint, 33));
        const capture = p.createVideo([]);
        capture.elt.muted = true;
        capture.elt.playsInline = true;
        mediaReady.push(new Promise((resolve) => capture.elt.addEventListener('loadeddata', () => {
          onReady(); resolve();
        }, { once: true })));
        capture.elt.srcObject = stream;
        capture.elt.play();
        return capture;
      },
    };
    const poison = { isStarted: true, getAnalysisFrame() { throw new Error('Output read raw audio'); } };
    const p = await new Promise((resolve) => new p5((p) => {
      sketch.factory(poison, null, params, context)(p);
      const setup = p.setup;
      p.setup = () => { setup(); p.noLoop(); resolve(p); };
    }));
    await Promise.all(mediaReady);
    window.__expanded = {
      p, params, sketch,
      async sample(nextFeatures = {}, patch = {}) {
        features = nextFeatures;
        Object.assign(params, patch);
        await p.redraw();
        const gl = p._renderer.GL;
        let pixels;
        if (gl) {
          pixels = new Uint8Array(p.width * p.height * 4);
          gl.readPixels(0, 0, p.width, p.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL render/readback error');
        } else pixels = p.drawingContext.getImageData(0, 0, p.width, p.height).data;
        return new Uint8Array(pixels);
      },
      get reads() { return reads; },
      dispose() {
        intervals.forEach(clearInterval);
        streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
        controller.dispose();
        disposeP5Instance(p);
      },
    };
  }, id);
}

test('checkerboard stays identical with audio, legacy pulse, audio loss and cached redraws', async ({ page }) => {
  await mount(page, 'checkerboard');
  const result = await page.evaluate(async () => {
    const h = window.__expanded;
    const base = await h.sample();
    const same = (a, b) => a.every((v, i) => v === b[i]);
    let paints = 0;
    const ctx = h.p.drawingContext;
    const fill = ctx.fillRect.bind(ctx);
    ctx.fillRect = (...args) => { paints++; return fill(...args); };
    const loud = await h.sample({ sub: 1.6, mid: 1.6, high: 1.6, energy: 1.6 }, { pulse: 2 });
    const silent = await h.sample();
    const cachedPaints = paints;
    const changed = await h.sample({}, { cell: 80 });
    const oldWidth = h.p.width;
    h.p.resizeCanvas(420, 260);
    h.p.windowResized();
    await h.sample();
    const { createAudioController } = await import('/src/sketches/checkerboard.js');
    const c = createAudioController();
    c.update({ params: { speed: 2, pulse: 2 }, shared: { getFeatures() { throw new Error('Checker read audio'); } } });
    return {
      sameLoud: same(base, loud), sameSilent: same(base, silent), changed: !same(base, changed),
      cachedPaints, paints, oldWidth,
      colors: [...new Set(Array.from(base).filter((_, i) => i % 4 < 3))],
    };
  });
  expect(result.sameLoud).toBe(true);
  expect(result.sameSilent).toBe(true);
  expect(result.changed).toBe(true);
  expect(result.cachedPaints).toBe(0);
  expect(result.paints).toBeGreaterThan(0);
  expect(result.colors.sort()).toEqual([0, 255]);
  await page.evaluate(() => window.__expanded.dispose());
});

test('new camera FX share one real capture across CUE, keep control placeholders, and release it', async ({ context, page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 480, height: 300 });
  await page.goto('/?role=screen');
  const control = await context.newPage();
  await control.goto('/?role=control');
  await control.waitForFunction(() => window.__viz.screenOnline);
  const cameras = GROUPS['Video FX'];
  for (let i = 0; i < cameras.length; i++) {
    await control.locator(`#pattern-library [data-id="${cameras[i]}"]`).click({ modifiers: i ? ['Shift'] : [] });
    if (i) {
      await page.waitForFunction(() => window.__viz.cue?.phase === 'ready');
      expect(await page.evaluate(() => window.__viz.runtimeCounts.camera)).toMatchObject({ streams: 1, consumers: 2 });
      await control.keyboard.press('Enter');
    }
    await page.waitForFunction((id) => window.__viz.patternId === id && !window.__viz.cue, cameras[i]);
    await expect(control.locator('#preview-stage .preview-empty')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__viz.runtimeCounts.camera)).toMatchObject({ streams: 1, consumers: 1 });
  }
  await control.locator('#pattern-library [data-id="truchet-relay"]').click();
  await page.waitForFunction(() => window.__viz.patternId === 'truchet-relay');
  await expect.poll(() => page.evaluate(() => window.__viz.runtimeCounts.camera)).toMatchObject({ streams: 0, consumers: 0 });
});


test('denied camera permission leaves the previous LIVE picture intact without leaking a lease', async ({ context, page }) => {
  await page.setViewportSize({ width: 480, height: 300 });
  await page.goto('/?role=screen');
  const control = await context.newPage();
  await control.goto('/?role=control');
  await control.waitForFunction(() => window.__viz.screenOnline);
  await control.locator('#pattern-library [data-id="truchet-relay"]').click();
  await page.waitForFunction(() => window.__viz.programs.live?.children[0] === 'truchet-relay');
  await page.evaluate(() => {
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    window.__deniedCameraRequests = 0;
    media.getUserMedia = (constraints) => {
      if (!constraints.video) return original(constraints);
      window.__deniedCameraRequests++;
      return Promise.reject(new DOMException('Camera denied for regression test', 'NotAllowedError'));
    };
  });
  await control.locator('#pattern-library [data-id="video-slit-scan"]').click({ modifiers: ['Shift'] });
  await page.waitForFunction(() => window.__deniedCameraRequests > 0 && window.__viz.cue?.phase === 'error');
  expect(await page.evaluate(() => window.__viz.programs.live.children)).toEqual(['truchet-relay']);
  await control.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__viz.runtimeCounts.camera)).toMatchObject({ streams: 0, consumers: 0 });
  await expect(page.locator('[data-program-role="live"] canvas').first()).toBeVisible();
});
