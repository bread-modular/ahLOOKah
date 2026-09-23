import { test, expect } from '@playwright/test';
import { BUILTIN_PATTERNS } from '../src/patterns/builtins.js';

const CONVERTED = ['video-chroma', 'video-kaleido', 'video-pixelate', 'video-trails',
  'video-dots-gpu', 'video-high-contrast'];
test('remaining Video FX descriptors retain optional camera sources', { tag: '@core' }, () => {
  const byId = new Map(BUILTIN_PATTERNS.map((pattern) => [pattern.id, pattern]));
  for (const id of CONVERTED) {
    expect(byId.get(id)?.fx).toEqual({ input: 'image' });
    expect(byId.get(id)?.camera).toBe(true);
  }
});

const SHADERS = [
  ['video-kaleido', '/src/sketches/video_kaleido.js', { segments: 4, speed: 0, zoom: 1, audioZoom: 0 }],
  ['video-pixelate', '/src/sketches/video_pixelate.js', { block: 2, audioBlocks: 0, levels: 0, tint: 0 }],
  ['video-high-contrast', '/src/sketches/webcam_high_contrast.js', { threshold: 0.35, contrast: 1, react: 0 }],
];

for (const [id, path, params] of SHADERS) {
  for (const migrated of [true, false]) {
    test(`${id} ${migrated ? 'controlled' : 'legacy'}: borrowed image, null, alpha, resize, camera`,
      { tag: '@core' }, async ({ page }) => {
        await page.setViewportSize({ width: 120, height: 80 });
        await page.goto('/tests/fixtures/render.html');
        const result = await page.evaluate(async ({ id, path, params, migrated }) => {
          const { default: VizCore } = await import('/src/core/index.js');
          const { default: factory } = await import(path);
          const canvas = document.createElement('canvas');
          canvas.width = 120; canvas.height = 80;
          const ctx = canvas.getContext('2d');
          const kaleido = id === 'video-kaleido';
          const drawFixture = (changed = false) => {
            ctx.clearRect(0, 0, 120, 80);
            ctx.fillStyle = kaleido ? '#000000' : changed ? '#000000' : '#ffffff';
            ctx.fillRect(0, 0, 60, 80);
            ctx.fillStyle = !changed ? (kaleido ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)') : '#000000';
            ctx.fillRect(60, 0, 60, 80);
            if (!kaleido) ctx.clearRect(8, 8, 20, 20);
          };
          drawFixture();
          let input = null;
          let sharedCapture = 0, rawCapture = 0, mediaReady = 0, reads = 0;
          const controls = migrated ? { read: () => ({ continuous: { sub: 0, mid: 0, high: 0, noise: 0, spin: 0 } }) } : null;
          const audio = { isStarted: true, getAnalysisFrame: () => null,
            getFrequencies: () => ({ left: new Uint8Array(512), right: new Uint8Array(512) }),
            getAmplitudes: () => ({}) };
          const make = (runtimeContext, capture) => new VizCore((p) => {
            p.createCapture = (_constraints, onReady) => {
              rawCapture++;
              if (!capture) throw new Error('FX opened raw camera');
              onReady(); return capture;
            };
            factory(audio, 'device-a', params, { ...runtimeContext, audioControls: controls })(p);
            const setup = p.setup;
            p.setup = () => { setup(); p.noLoop(); };
          });
          const ready = async (instance) => {
            await instance.whenReady();
            for (let i = 0; i < 30 && (!instance.frameCount || instance._redrawing); i++) {
              if (instance._error) throw instance._error;
              await new Promise(requestAnimationFrame);
            }
            if (instance._error || instance._redrawing) throw instance._error || new Error('initial draw');
          };
          const pixel = (instance, x, y) => {
            const out = document.createElement('canvas');
            out.width = instance.width; out.height = instance.height;
            const dest = out.getContext('2d', { willReadFrequently: true });
            dest.drawImage(instance.canvas, 0, 0);
            return Array.from(dest.getImageData(x, y, 1, 1).data);
          };
          const frame = (source, frameId) => ({ source, width: source.width, height: source.height,
            frameId, generation: 1, timestampMs: frameId * 16 });
          const fx = make({ inputMode: 'fx', getImageInput: () => { reads++; return input; },
            createCapture: () => { sharedCapture++; throw new Error('FX opened shared camera'); },
            reportMediaReady: () => { mediaReady++; } }, null);
          await ready(fx);
          const empty = pixel(fx, 30, 40);
          input = frame(canvas, 1);
          await fx.redraw();
          const sample = pixel(fx, kaleido ? 90 : 35, 40);
          const other = pixel(fx, kaleido ? 30 : 90, 40);
          const hole = kaleido ? null : pixel(fx, 17, 17);
          // Repaint the same canvas instance: the shader must re-upload it.
          drawFixture(true);
          input = frame(canvas, 2);
          await fx.redraw();
          const updated = pixel(fx, kaleido ? 90 : 35, 40);
          input = { ...frame(canvas, 3), width: 0 };
          await fx.redraw();
          const invalid = pixel(fx, 35, 40);
          input = null;
          await fx.redraw();
          const missing = pixel(fx, 35, 40);
          const tall = document.createElement('canvas');
          tall.width = 40; tall.height = 80;
          tall.getContext('2d').fillStyle = '#ffffff';
          tall.getContext('2d').fillRect(0, 0, 40, 80);
          input = frame(tall, 4);
          await fx.redraw();
          const bar = pixel(fx, 4, 40);
          const center = pixel(fx, 60, 40);
          fx.resizeCanvas(80, 120);
          await fx.redraw();
          const resized = { size: [fx.width, fx.height], side: pixel(fx, 4, 60),
            center: pixel(fx, 40, 60) };
          const fxError = fx._error?.message || null;
          await fx.remove();

          drawFixture();
          canvas.loadedmetadata = true;
          canvas.hide = () => {};
          const source = make({ inputMode: 'source', getImageInput: () => { throw new Error('source read graph'); },
            createCapture: (_p, _constraints, onReady) => {
              sharedCapture++; onReady(); return canvas;
            }, reportMediaReady: () => { mediaReady++; } }, canvas);
          await ready(source);
          const camera = pixel(source, kaleido ? 90 : 35, 40);
          const sourceError = source._error?.message || null;
          await source.remove();
          // Standalone callers still fall back to the raw capture API.
          const standalone = make({ reportMediaReady: () => { mediaReady++; } }, canvas);
          await ready(standalone);
          const raw = pixel(standalone, kaleido ? 90 : 35, 40);
          const standaloneError = standalone._error?.message || null;
          await standalone.remove();
          return { empty, sample, other, hole, updated, invalid, missing, bar, center,
            resized, camera, raw, fxError, sourceError, standaloneError,
            sharedCapture, rawCapture, mediaReady, reads };
        }, { id, path, params, migrated });

        expect([result.fxError, result.sourceError, result.standaloneError]).toEqual([null, null, null]);
        expect([result.sharedCapture, result.rawCapture, result.mediaReady]).toEqual([1, 1, 2]);
        expect(result.reads).toBe(7); // one input lookup per FX draw, including null/resize
        expect(result.empty[3]).toBe(0);
        expect(result.invalid[3]).toBe(0);
        expect(result.missing[3]).toBe(0);
        expect(result.sample[0]).toBeGreaterThan(160);
        if (id !== 'video-kaleido') expect(result.other[0]).toBeLessThan(80);
        if (id === 'video-kaleido') {
          expect(result.sample[3]).toBeGreaterThan(100);
          expect(result.sample[3]).toBeLessThan(145);
        } else {
          expect(result.sample[3]).toBe(255);
          expect(result.other[3]).toBeGreaterThan(110);
          expect(result.other[3]).toBeLessThan(145);
          expect(result.hole[3]).toBe(0);
        }
        expect(result.updated[0]).toBeLessThan(80);
        expect(result.bar[3]).toBe(0);
        expect(result.center[3]).toBe(255);
        expect(result.resized.size).toEqual([80, 120]);
        expect(result.resized.center[3]).toBe(255);
        expect(result.camera[0]).toBeLessThan(80); // camera remains selfie-mirrored
        expect(result.raw[0]).toBeLessThan(80);
      });
  }
}

test('video-trails FX retains alpha/contain, clears on disconnect and stamps each graph frame once',
  { tag: '@core' }, async ({ page }) => {
    await page.setViewportSize({ width: 120, height: 80 });
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async () => {
      const { default: VizCore } = await import('/src/core/index.js');
      const { default: factory } = await import('/src/sketches/video_trails.js');
      const canvas = document.createElement('canvas');
      canvas.width = 120; canvas.height = 80;
      const ctx = canvas.getContext('2d');
      const drawFixture = () => {
        ctx.clearRect(0, 0, 120, 80);
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 60, 80);
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(60, 0, 60, 80);
        ctx.clearRect(10, 10, 16, 16);
      };
      drawFixture();
      let input = null, sharedCapture = 0, rawCapture = 0, mediaReady = 0;
      const controls = { read: () => ({ continuous: { subLevel: 0 } }) };
      const make = (context, capture, audioControls = controls) => new VizCore((p) => {
        p.createCapture = (_constraints, onReady) => {
          rawCapture++;
          if (!capture) throw new Error('FX opened raw camera');
          onReady(); return capture;
        };
        factory({ isStarted: false }, 'device-a', { decay: 0, tintHue: 0, blend: 0 },
          { ...context, audioControls })(p);
        const setup = p.setup;
        p.setup = () => { setup(); p.noLoop(); };
      });
      const ready = async (instance) => {
        await instance.whenReady();
        for (let i = 0; i < 30 && (!instance.frameCount || instance._redrawing); i++) {
          if (instance._error) throw instance._error;
          await new Promise(requestAnimationFrame);
        }
        if (instance._error || instance._redrawing) throw instance._error || new Error('initial draw');
      };
      const pixel = (instance, x, y) => Array.from(instance.canvas.getContext('2d', { willReadFrequently: true })
        .getImageData(x, y, 1, 1).data);
      const frame = (source, frameId) => ({ source, width: source.width, height: source.height,
        frameId, generation: 1, timestampMs: frameId * 16 });
      const fx = make({ inputMode: 'fx', getImageInput: () => input,
        createCapture: () => { sharedCapture++; throw new Error('FX opened camera'); },
        reportMediaReady: () => { mediaReady++; } }, null);
      await ready(fx);
      const empty = pixel(fx, 40, 40);
      input = frame(canvas, 1);
      await fx.redraw();
      const left = pixel(fx, 40, 40);
      const right = pixel(fx, 90, 40);
      const hole = pixel(fx, 17, 17);
      await fx.redraw();
      const repeated = pixel(fx, 40, 40);
      input = frame(canvas, 2);
      await fx.redraw();
      const next = pixel(fx, 40, 40);
      input = null;
      await fx.redraw();
      const missing = pixel(fx, 40, 40);
      input = frame(canvas, 3);
      await fx.redraw();
      const reconnected = pixel(fx, 40, 40);
      const tall = document.createElement('canvas');
      tall.width = 40; tall.height = 80;
      tall.getContext('2d').fillStyle = 'white';
      tall.getContext('2d').fillRect(0, 0, 40, 80);
      input = frame(tall, 4);
      await fx.redraw();
      const bar = pixel(fx, 5, 40);
      const centered = pixel(fx, 60, 40);
      fx.resizeCanvas(80, 120);
      await fx.redraw();
      const resized = { size: [fx.width, fx.height], center: pixel(fx, 40, 60) };
      const fxError = fx._error?.message || null;
      await fx.remove();

      drawFixture();
      canvas.loadedmetadata = true;
      canvas.hide = () => {};
      const source = make({ getImageInput: () => { throw new Error('source read graph'); },
        createCapture: (_p, _constraints, onReady) => { sharedCapture++; onReady(); return canvas; },
        reportMediaReady: () => { mediaReady++; } }, canvas);
      await ready(source);
      const camera = pixel(source, 40, 40);
      const sourceError = source._error?.message || null;
      await source.remove();
      const standalone = make({ reportMediaReady: () => { mediaReady++; } }, canvas, null);
      await ready(standalone);
      const raw = pixel(standalone, 40, 40);
      const standaloneError = standalone._error?.message || null;
      await standalone.remove();
      return { empty, left, right, hole, repeated, next, missing, reconnected,
        bar, centered, resized, camera, raw, fxError, sourceError, standaloneError,
        sharedCapture, rawCapture, mediaReady };
    });
    expect([result.fxError, result.sourceError, result.standaloneError]).toEqual([null, null, null]);
    expect([result.sharedCapture, result.rawCapture, result.mediaReady]).toEqual([1, 1, 2]);
    expect(result.empty[3]).toBe(0);
    expect(result.left[0]).toBeGreaterThan(100);
    expect(result.right[0]).toBeLessThan(50);
    expect(result.right[3]).toBeGreaterThan(90);
    expect(result.right[3]).toBeLessThan(120);
    expect(result.hole[3]).toBe(0);
    expect(result.repeated).toEqual(result.left); // same graph frame is not restamped/faded
    expect(result.next[3]).toBeGreaterThan(result.left[3]);
    expect(result.missing[3]).toBe(0);
    expect(result.reconnected).toEqual(result.left); // feedback reset after disconnect
    expect(result.bar[3]).toBe(0);
    expect(result.centered[3]).toBeGreaterThan(0);
    expect(result.resized.size).toEqual([80, 120]);
    expect(result.resized.center[3]).toBeGreaterThan(0);
    expect(result.camera[0]).toBeLessThan(30); // legacy selfie mirror remains
    expect(result.raw[0]).toBeLessThan(30);
  });
