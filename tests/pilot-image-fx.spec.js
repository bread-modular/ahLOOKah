import { test, expect } from '@playwright/test';
import { BUILTIN_PATTERNS } from '../src/patterns/builtins.js';

const PILOTS = ['video-chroma', 'video-dots-gpu'];

test('only converted camera built-ins declare image FX capability', { tag: '@core' }, () => {
  expect(BUILTIN_PATTERNS.filter((pattern) => pattern.fx).map((pattern) => pattern.id)).toEqual(PILOTS);
  for (const id of PILOTS) {
    const pattern = BUILTIN_PATTERNS.find((item) => item.id === id);
    expect(pattern.camera).toBe(true); // source mode still owns a camera
    expect(pattern.fx).toEqual({ input: 'image' });
  }
  expect(BUILTIN_PATTERNS.find((pattern) => pattern.id === 'video-kaleido').fx).toBeUndefined();
  expect(BUILTIN_PATTERNS.find((pattern) => pattern.id === 'video-high-contrast').fx).toBeUndefined();
});

for (const id of PILOTS) {
  for (const migrated of [true, false]) {
    test(`${id} ${migrated ? 'controlled audio' : 'legacy audio'}: borrowed FX canvas, alpha/fit, camera source parity`,
      { tag: '@core' }, async ({ page }) => {
        await page.setViewportSize({ width: 96, height: 64 });
        await page.goto('/tests/fixtures/render.html');
        const result = await page.evaluate(async ({ id, migrated }) => {
          const { default: VizCore } = await import('/src/core/index.js');
          const { default: chroma } = await import('/src/sketches/video_chroma.js');
          const { default: dots } = await import('/src/sketches/webcam_dots_gpu.js');
          const factory = id === 'video-chroma' ? chroma : dots;
          const params = id === 'video-chroma'
            ? { keyHue: 120, tolerance: 0.03, softness: 0.02, bgMode: 0,
              bgHue: 300, bgSat: 1, bgBright: 0.65, audioReact: 0 }
            : { spacing: 12, glitch: 0, react: 0 };
          const controls = migrated ? { read: () => ({ continuous: { sub: 0, mid: 0, high: 0 } }) } : null;
          const audio = { isStarted: true, getFrequencies: () => ({ left: new Uint8Array(512) }),
            getAnalysisFrame: () => null };
          const canvas = document.createElement('canvas');
          canvas.width = 96; canvas.height = 64;
          const ctx = canvas.getContext('2d');
          const fixture = () => {
            ctx.clearRect(0, 0, 96, 64);
            ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 48, 32);
            ctx.fillStyle = 'black'; ctx.fillRect(48, 0, 48, 32);
            ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 32, 48, 32);
            ctx.fillStyle = 'rgba(255, 0, 0, 0.5)'; ctx.fillRect(48, 32, 48, 32);
            ctx.clearRect(16, 16, 12, 12);
          };
          fixture();
          let input = null;
          let captureCalls = 0;
          let rawCalls = 0;
          let readyCalls = 0;
          const make = (runtimeContext, rawCapture) => new VizCore((p) => {
            p.createCapture = (...args) => { rawCalls++; if (!rawCapture) throw new Error('FX opened raw capture');
              args[1]?.(); return rawCapture; };
            factory(audio, 'camera-1', params, runtimeContext)(p);
            const setup = p.setup;
            p.setup = () => { setup(); p.noLoop(); };
          });
          const ready = async (instance) => {
            await instance.whenReady();
            // The core's mandatory first draw occurs after whenReady; wait for
            // its actual completion rather than guessing a duration.
            for (let i = 0; i < 20 && (instance.frameCount === 0 || instance._redrawing); i++) {
              if (instance._error) throw instance._error;
              await new Promise(requestAnimationFrame);
            }
            if (instance._error) throw instance._error;
            if (instance.frameCount === 0 || instance._redrawing) throw new Error('Initial draw did not finish');
          };
          const pixel = (instance, x, y) => {
            const out = document.createElement('canvas');
            out.width = 96; out.height = 64;
            const dest = out.getContext('2d', { willReadFrequently: true });
            dest.drawImage(instance.canvas, 0, 0);
            return Array.from(dest.getImageData(x, y, 1, 1).data);
          };
          const frame = (source, frameId) => ({ source, width: source.width, height: source.height,
            frameId, timestampMs: frameId * 16, generation: 1 });
          const fx = make({ inputMode: 'fx', audioControls: controls,
            getImageInput: () => input,
            createCapture: () => { captureCalls++; throw new Error('FX opened shared capture'); },
            reportMediaReady: () => { readyCalls++; } }, null);
          await ready(fx);
          const empty = pixel(fx, 6, 6);
          input = frame(canvas, 1);
          await fx.redraw();
          const topLeft = pixel(fx, 6, 6);
          const topRight = pixel(fx, 54, 6);
          const bottomLeft = pixel(fx, 6, 42);
          const hole = pixel(fx, 22, 22);
          const halfAlpha = pixel(fx, 78, 42);
          // Content changes without replacing the upstream canvas object.
          ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 48, 32);
          input = frame(canvas, 2);
          await fx.redraw();
          const updated = pixel(fx, 6, 6);
          input = { ...frame(canvas, 3), width: 0 };
          await fx.redraw();
          const invalid = pixel(fx, 6, 6);
          input = null;
          await fx.redraw();
          const disconnected = pixel(fx, 6, 6);
          // New aspect: transparent bars at left/right, not stretched/cropped.
          const tall = document.createElement('canvas');
          tall.width = 32; tall.height = 64;
          const tallCtx = tall.getContext('2d');
          tallCtx.fillStyle = 'white';
          tallCtx.fillRect(0, 0, 32, 64);
          input = frame(tall, 4);
          await fx.redraw();
          const bar = pixel(fx, 6, 42);
          const center = pixel(fx, id === 'video-chroma' ? 48 : 50, 42);
          const fxError = fx._error?.message || null;
          await fx.remove();

          // Standalone/source mode still takes the camera, ignores getImageInput,
          // and displays the legacy selfie mirror (right side is at screen left).
          fixture();
          canvas.loadedmetadata = true;
          canvas.hide = () => {};
          const source = make({ audioControls: controls,
            getImageInput: () => { throw new Error('source read FX input'); },
            createCapture: (_p, constraints, onReady) => {
              captureCalls++; onReady(); return canvas;
            }, reportMediaReady: () => { readyCalls++; } }, canvas);
          await ready(source);
          const sourceLeft = pixel(source, 6, 6);
          const sourceRight = pixel(source, 54, 6);
          const sourceError = source._error?.message || null;
          await source.remove();
          // Preserve the raw createCapture fallback for standalone callers.
          const standalone = make({ audioControls: controls,
            reportMediaReady: () => { readyCalls++; } }, canvas);
          await ready(standalone);
          const standaloneLeft = pixel(standalone, 6, 6);
          const standaloneError = standalone._error?.message || null;
          await standalone.remove();

          return { empty, topLeft, topRight, bottomLeft, hole, halfAlpha, updated,
            invalid, disconnected, bar, center, sourceLeft, sourceRight, standaloneLeft,
            captureCalls, rawCalls, readyCalls, fxError, sourceError, standaloneError };
        }, { id, migrated });

        expect(result.fxError).toBeNull();
        expect(result.sourceError).toBeNull();
        expect(result.standaloneError).toBeNull();
        expect(result.captureCalls).toBe(1); // shared capture source only
        expect(result.rawCalls).toBe(1); // standalone source fallback only
        expect(result.readyCalls).toBe(2); // both source paths, never FX
        expect(result.empty[3]).toBe(0);
        expect(result.invalid[3]).toBe(0);
        expect(result.disconnected[3]).toBe(0);
        expect(result.topLeft[0]).toBeGreaterThan(200); // white pixel on the left
        expect(result.topRight[0]).toBeLessThan(30); // black pixel on the right
        if (id === 'video-chroma') {
          expect(result.bottomLeft[0]).toBeGreaterThan(80); // green was keyed to pink BG
          expect(result.bottomLeft[2]).toBeGreaterThan(80);
          expect(result.bottomLeft[1]).toBeLessThan(80);
        } else {
          expect(result.bottomLeft[0]).toBeGreaterThan(40); // lower green quadrant makes dots
        }
        expect(result.updated[0]).toBeLessThan(30); // same canvas, new frame
        expect(result.hole[3]).toBe(0);
        expect(result.halfAlpha[3]).toBeGreaterThan(110);
        expect(result.halfAlpha[3]).toBeLessThan(145);
        expect(result.bar[3]).toBe(0);
        expect(result.center[3]).toBe(255);
        expect(result.sourceLeft[0]).toBeLessThan(30); // source selfie mirror
        expect(result.sourceRight[0]).toBeGreaterThan(200);
        expect(result.standaloneLeft[0]).toBeLessThan(30);
      });
  }
}

test('two pilot FX consume completed 2D → WebGL → WebGL frames without stale textures',
  { tag: '@core' }, async ({ page }) => {
    await page.setViewportSize({ width: 96, height: 64 });
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async () => {
      const { default: VizCore } = await import('/src/core/index.js');
      const { default: chroma } = await import('/src/sketches/video_chroma.js');
      const { default: dots } = await import('/src/sketches/webcam_dots_gpu.js');
      const canvas = document.createElement('canvas');
      canvas.width = 96; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      const fill = (color) => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 48, 64);
        ctx.fillStyle = 'black';
        ctx.fillRect(48, 0, 48, 64);
      };
      fill('white');
      let first, second;
      let revision = 1;
      const frame = (source) => ({ source, width: source.width, height: source.height,
        frameId: revision, timestampMs: 16 * revision, generation: 1 });
      const controls = { read: () => ({ continuous: { sub: 0, mid: 0, high: 0 } }) };
      const make = (factory, params, getImageInput) => new VizCore((p) => {
        p.createCapture = () => { throw new Error('FX opened camera'); };
        factory(null, null, params, { inputMode: 'fx', audioControls: controls,
          getImageInput, createCapture: () => { throw new Error('FX requested capture'); } })(p);
        const setup = p.setup;
        p.setup = () => { setup(); p.noLoop(); };
      });
      const waitInitialDraw = async (p) => {
        await p.whenReady();
        for (let i = 0; i < 20 && (p.frameCount === 0 || p._redrawing); i++) {
          if (p._error) throw p._error;
          await new Promise(requestAnimationFrame);
        }
        if (p._error || p._redrawing) throw p._error || new Error('Draw did not finish');
      };
      first = make(chroma, { audioReact: 0 }, () => frame(canvas));
      await waitInitialDraw(first);
      second = make(dots, { spacing: 12, glitch: 0, react: 0 }, () => frame(first.canvas));
      await waitInitialDraw(second);
      const sample = () => {
        const out = document.createElement('canvas');
        out.width = 96; out.height = 64;
        const ctx2 = out.getContext('2d', { willReadFrequently: true });
        ctx2.drawImage(second.canvas, 0, 0);
        return Array.from(ctx2.getImageData(6, 6, 1, 1).data);
      };
      await first.redraw();
      await second.redraw();
      const white = sample();
      fill('black');
      revision++;
      await first.redraw();
      await second.redraw();
      const black = sample();
      const errors = [first._error?.message || null, second._error?.message || null];
      await second.remove();
      await first.remove();
      return { white, black, errors };
    });
    expect(result.errors).toEqual([null, null]);
    expect(result.white[0]).toBeGreaterThan(200);
    expect(result.black[0]).toBeLessThan(30);
  });
