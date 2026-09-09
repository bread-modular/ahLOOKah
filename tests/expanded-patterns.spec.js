import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const GROUPS = {
  Simple: ['dot-grid', 'pulse-stripes', 'cross-pulse', 'diamond-tiles', 'radial-spokes'],
  Rhythmic: ['beat-weave', 'ripple-lattice'],
  '3D': ['polygon-tunnel', 'orbital-cages'],
  'Cinematic / Shaders': ['silk-flow', 'prism-caustics'],
  'Neon / Lasers': ['laser-fan', 'neon-hex'],
  'Glitch / Effects': ['data-rain', 'signal-tear'],
  'Video FX': ['video-edge-glow', 'video-thermal', 'video-prism-split', 'video-ripple-lens', 'video-mirror-tiles'],
};
const IDS = Object.values(GROUPS).flat();

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

test('expanded registry keeps groups, pad defaults and genuine band controls', async ({ page }) => {
  await page.goto('/?role=control');
  const result = await page.evaluate(async () => {
    const { SKETCHES, getOrderedSketches, getGroups } = await import('/src/sketch-registry.js');
    return {
      groupOrder: getGroups(),
      groups: Object.fromEntries(SKETCHES.map((s) => [s.id, s.group])),
      params: Object.fromEntries(SKETCHES.map((s) => [s.id, s.params.map((p) => p.key)])),
      camera: SKETCHES.filter((s) => s.camera).map((s) => s.id),
      ids: SKETCHES.map((s) => s.id),
      pad: getOrderedSketches().map((s) => s.id),
      checkerReactive: SKETCHES.find((s) => s.id === 'checkerboard').audioReactive,
    };
  });
  expect(new Set(result.ids).size).toBe(70);
  expect(result.groupOrder[0]).toBe('Simple');
  expect(result.groups.circles).toBe('Simple');
  expect(result.groups.bars).toBe('Simple');
  expect(result.groups.checkerboard).toBe('Simple');
  await expect(page.locator('.library-group-toggle').first()).toHaveText('Simple');
  expect(result.pad.slice(0, 4)).toEqual(['circles', 'bars', 'techno3d', 'character3d']);
  for (const [group, ids] of Object.entries(GROUPS)) for (const id of ids) {
    expect(result.groups[id], id).toBe(group);
    expect(result.params[id], id).toEqual(expect.arrayContaining(['bass', 'mid', 'high']));
    if (group === 'Video FX') expect(result.camera).toContain(id);
    await expect(page.locator(`#pattern-library [data-id="${id}"]`)).toHaveAttribute('title', /bass/i);
  }
  expect(result.checkerReactive).toBe(false);
  expect(result.params.checkerboard).not.toEqual(expect.arrayContaining(['pulse']));
});

test.describe('expanded pattern rendering', { tag: '@patterns' }, () => {
  for (const id of IDS) test(`${id}: visible, each band reactive, muted bands neutral, bounds and resize`, async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && /shader|WebGL|p5.js/i.test(m.text())) errors.push(m.text()); });
    await mount(page, id);
    const result = await page.evaluate(async () => {
      const h = window.__expanded;
      const baseline = await h.sample();
      const image = h.p.canvas.toDataURL();
      const difference = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
      const changed = {};
      const muted = {};
      for (const [key, feature] of [['bass', 'sub'], ['mid', 'mid'], ['high', 'high']]) {
        changed[key] = difference(baseline, await h.sample({ [feature]: 0.85 }));
        muted[key] = difference(baseline, await h.sample({ [feature]: 0.85 }, { [key]: 0 }));
        h.params[key] = 1;
      }
      const limits = {};
      for (const edge of ['min', 'max']) {
        const patch = Object.fromEntries(h.sketch.params.filter((d) => d.key !== 'speed').map((d) => [d.key, d[edge]]));
        const sample = await h.sample({ sub: 1.6, mid: 1.6, high: 1.6 }, patch);
        limits[edge] = sample.length;
      }
      h.p.resizeCanvas(420, 260);
      const resized = await h.sample();
      return {
        image, changed, muted, limits, reads: h.reads,
        nonblack: baseline.filter((v, i) => i % 4 < 3 && v > 15).length,
        resize: [h.p.canvas.width, h.p.canvas.height, resized.length],
      };
    });
    const imagePath = testInfo.outputPath(`${id}.png`);
    await writeFile(imagePath, Buffer.from(result.image.split(',')[1], 'base64'));
    await testInfo.attach('Default look', { path: imagePath, contentType: 'image/png' });
    expect(result.nonblack).toBeGreaterThan(300);
    for (const band of ['bass', 'mid', 'high']) {
      expect(result.changed[band], `${id} ${band} must affect pixels`).toBeGreaterThan(0.02);
      expect(result.muted[band], `${id} ${band}=0 must remove its contribution`).toBe(0);
    }
    expect(result.limits).toEqual({ min: 360 * 240 * 4, max: 360 * 240 * 4 });
    expect(result.resize).toEqual([420, 260, 420 * 260 * 4]);
    expect(result.reads).toBeGreaterThan(8);
    expect(errors).toEqual([]);
    await page.evaluate(() => window.__expanded.dispose());
  });
});

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

test('band controllers are bounded and basics geometry stays bounded at 4K', async ({ page }) => {
  await page.goto('/docs/patterns.html');
  const result = await page.evaluate(async () => {
    const { BASIC_PATTERNS } = await import('/src/sketches/basic-patterns.js');
    const { createBandController } = await import('/src/sketches/band-reactive.js');
    const bounded = createBandController().update({
      shared: { getFeatures: () => ({ sub: Infinity, mid: NaN, high: 900 }) },
      params: { bass: NaN, mid: -3, high: 900 },
    }).continuous;
    const counts = {};
    for (const sketch of BASIC_PATTERNS) {
      let calls = 0;
      const ctx = new Proxy({}, { get: () => () => { calls++; }, set: () => true });
      const p = {
        windowWidth: 3840, windowHeight: 2160, deltaTime: 16.667, drawingContext: ctx,
        pixelDensity() {}, createCanvas(w, h) { this.width = w; this.height = h; },
      };
      sketch.factory(null, null, { density: 32, size: 1 }, { audioControls: { read: () => ({ continuous: { bass: 3.2, mid: 3.2, high: 3.2 } }) } })(p);
      p.setup(); p.draw(); counts[sketch.id] = calls;
    }
    return { bounded, counts };
  });
  expect(result.bounded).toEqual({ bass: 0, mid: 0, high: 3.2 });
  for (const count of Object.values(result.counts)) expect(count).toBeLessThan(3000);
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
  await control.locator('#pattern-library [data-id="dot-grid"]').click();
  await page.waitForFunction(() => window.__viz.patternId === 'dot-grid');
  await expect.poll(() => page.evaluate(() => window.__viz.runtimeCounts.camera)).toMatchObject({ streams: 0, consumers: 0 });
});


test('denied camera permission leaves the previous LIVE picture intact without leaking a lease', async ({ context, page }) => {
  await page.setViewportSize({ width: 480, height: 300 });
  await page.goto('/?role=screen');
  const control = await context.newPage();
  await control.goto('/?role=control');
  await control.waitForFunction(() => window.__viz.screenOnline);
  await control.locator('#pattern-library [data-id="dot-grid"]').click();
  await page.waitForFunction(() => window.__viz.programs.live?.children[0] === 'dot-grid');
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
  await control.locator('#pattern-library [data-id="video-edge-glow"]').click({ modifiers: ['Shift'] });
  await page.waitForFunction(() => window.__deniedCameraRequests > 0 && window.__viz.cue?.phase === 'error');
  expect(await page.evaluate(() => window.__viz.programs.live.children)).toEqual(['dot-grid']);
  await control.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__viz.runtimeCounts.camera)).toMatchObject({ streams: 0, consumers: 0 });
  await expect(page.locator('[data-program-role="live"] canvas').first()).toBeVisible();
});
