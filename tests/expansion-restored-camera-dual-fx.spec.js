import { test, expect } from '@playwright/test';
import { RESTORED_CAMERA_PATTERNS } from '../src/sketches/expansion/restored-camera.js';

const IDS = ['video-edge-glow', 'video-thermal'];

test('restored camera looks advertise image FX while retaining their source camera contract', { tag: '@core' }, () => {
  expect(RESTORED_CAMERA_PATTERNS.map(pattern => pattern.id)).toEqual(IDS);
  for (const pattern of RESTORED_CAMERA_PATTERNS) {
    expect(pattern).toMatchObject({ group: 'Video FX', camera: true, fx: { input: 'image' } });
  }
});

for (const id of IDS) {
  test(`${id}: borrowed FX updates, transparency, orientation and camera-source parity`,
    { tag: '@core' }, async ({ page }) => {
      await page.setViewportSize({ width: 96, height: 64 });
      await page.goto('/tests/fixtures/render.html');
      const result = await page.evaluate(async (id) => {
        const { default: VizCore } = await import('/src/core/index.js');
        const { RESTORED_CAMERA_PATTERNS } = await import('/src/sketches/expansion/restored-camera.js');
        const pattern = RESTORED_CAMERA_PATTERNS.find(pattern => pattern.id === id);
        const canvas = document.createElement('canvas');
        canvas.width = 96; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        function paint() {
          ctx.clearRect(0, 0, 96, 64);
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 48, 32);
          ctx.fillStyle = '#000000'; ctx.fillRect(48, 0, 48, 32);
          ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 32, 48, 32);
          ctx.fillStyle = 'rgba(255, 0, 0, 0.5)'; ctx.fillRect(48, 32, 48, 32);
          ctx.clearRect(16, 16, 12, 12);
        }
        paint();
        let input = null, sharedCalls = 0, rawCalls = 0, readyCalls = 0;
        const params = { amount: 0, mirror: 1, detail: 4, hue: .52 };
        const audioControls = { read: () => ({ continuous: { bass: 0, mid: 0, high: 0 } }) };
        const frame = (source) => ({ source, width: source.width, height: source.height,
          frameId: 1, timestampMs: 16, generation: 1 });
        function make(runtime, rawCapture) {
          return new VizCore(p => {
            p.createCapture = (_constraints, onReady) => {
              rawCalls++;
              if (!rawCapture) throw new Error('FX tried raw camera capture');
              onReady();
              return rawCapture;
            };
            pattern.factory(null, 'camera-1', params, runtime)(p);
            const setup = p.setup;
            p.setup = () => { setup(); p.noLoop(); };
          });
        }
        async function initial(instance) {
          await instance.whenReady();
          for (let i = 0; i < 30 && (instance.frameCount === 0 || instance._redrawing); i++) {
            if (instance._error) throw instance._error;
            await new Promise(requestAnimationFrame);
          }
          if (instance._error || instance.frameCount === 0 || instance._redrawing)
            throw instance._error || new Error('Initial draw did not finish');
        }
        function pixel(instance, x, y) {
          const out = document.createElement('canvas');
          out.width = 96; out.height = 64;
          const dest = out.getContext('2d', { willReadFrequently: true });
          dest.drawImage(instance.canvas, 0, 0);
          return [...dest.getImageData(x, y, 1, 1).data];
        }
        const fx = make({ inputMode: 'fx', audioControls,
          getImageInput: () => input,
          createCapture: () => { sharedCalls++; throw new Error('FX tried shared camera capture'); },
          reportMediaReady: () => { readyCalls++; } });
        let fxError, sourceError, standaloneError;
        let empty, left, right, green, hole, halfAlpha, updated, changed, changedAlpha,
          invalid, disconnected, bar, center, topBar, bottomCenter, sourceLeft, sourceRight,
          sourceHole, standaloneLeft, cameraCover, tall;
        try {
          await initial(fx);
          empty = pixel(fx, 6, 6);
          // Keep the SAME frame object and canvas across draws; neither a new
          // identity nor a new frameId should be required to sample new pixels.
          input = frame(canvas);
          await fx.redraw();
          left = pixel(fx, 6, 6);
          right = pixel(fx, 54, 6);
          green = pixel(fx, 6, 42);
          hole = pixel(fx, 22, 22);
          halfAlpha = pixel(fx, 78, 42);
          ctx.fillStyle = 'black'; ctx.fillRect(0, 0, 48, 16);
          await fx.redraw();
          updated = pixel(fx, 6, 6);
          params.amount = 1;
          await fx.redraw();
          changed = pixel(fx, 6, 42);
          changedAlpha = pixel(fx, 78, 42);
          input = { ...frame(canvas), width: 0 };
          await fx.redraw();
          invalid = pixel(fx, 6, 6);
          input = null;
          await fx.redraw();
          disconnected = pixel(fx, 6, 6);
          params.amount = 0;
          tall = document.createElement('canvas');
          tall.width = 32; tall.height = 64;
          tall.getContext('2d').fillStyle = 'white';
          tall.getContext('2d').fillRect(0, 0, 32, 64);
          input = frame(tall);
          await fx.redraw();
          bar = pixel(fx, 6, 42);
          center = pixel(fx, 48, 42);
          const wide = document.createElement('canvas');
          wide.width = 96; wide.height = 32;
          wide.getContext('2d').fillStyle = 'white';
          wide.getContext('2d').fillRect(0, 0, 96, 32);
          input = frame(wide);
          await fx.redraw();
          topBar = pixel(fx, 48, 6);
          bottomCenter = pixel(fx, 48, 32);
          fxError = fx._error?.message || null;
        } finally { await fx.remove(); }

        // Source mode keeps the camera's selfie mirror, cover crop and opaque
        // fallback, and does not consult the graph input even when provided.
        paint();
        Object.assign(canvas, { videoWidth: 96, videoHeight: 64, readyState: 4 });
        const capture = { elt: canvas, hide() {} };
        const source = make({ audioControls,
          getImageInput: () => { throw new Error('source read FX input'); },
          createCapture: (_p, constraints, onReady) => {
            sharedCalls++;
            if (constraints.video.deviceId.exact !== 'camera-1' || constraints.audio !== false)
              throw new Error('Source camera constraints changed');
            onReady(); return capture;
          }, reportMediaReady: () => { readyCalls++; } });
        try {
          await initial(source);
          sourceLeft = pixel(source, 6, 6);
          sourceRight = pixel(source, 54, 6);
          sourceHole = pixel(source, 22, 22);
          sourceError = source._error?.message || null;
        } finally { await source.remove(); }
        const standalone = make({ audioControls,
          getImageInput: () => { throw new Error('source read FX input'); },
          reportMediaReady: () => { readyCalls++; } }, capture);
        try {
          await initial(standalone);
          standaloneLeft = pixel(standalone, 6, 6);
          standaloneError = standalone._error?.message || null;
        } finally { await standalone.remove(); }
        // Source's cover crop fills the viewport even for a narrow camera.
        Object.assign(tall, { videoWidth: 32, videoHeight: 64, readyState: 4 });
        const narrow = make({ audioControls,
          createCapture: (_p, _constraints, onReady) => {
            sharedCalls++; onReady(); return { elt: tall, hide() {} };
          }, reportMediaReady: () => { readyCalls++; } });
        try { await initial(narrow); cameraCover = pixel(narrow, 6, 42); }
        finally { await narrow.remove(); }
        return { empty, left, right, green, hole, halfAlpha, updated, changed,
          changedAlpha, invalid, disconnected, bar, center, topBar, bottomCenter,
          sourceLeft, sourceRight, sourceHole, standaloneLeft, cameraCover,
          sharedCalls, rawCalls, readyCalls, fxError, sourceError, standaloneError };
      }, id);
      expect([result.fxError, result.sourceError, result.standaloneError]).toEqual([null, null, null]);
      expect([result.sharedCalls, result.rawCalls, result.readyCalls]).toEqual([2, 1, 3]);
      expect(result.empty[3]).toBe(0);
      expect(result.invalid[3]).toBe(0);
      expect(result.disconnected[3]).toBe(0);
      expect(result.left[0]).toBeGreaterThan(230); // FX: no selfie mirror, no Y flip
      expect(result.right[0]).toBeLessThan(25);
      expect(result.green[1]).toBeGreaterThan(230); // correct upper/lower orientation
      expect(result.hole[3]).toBe(0);
      expect(result.halfAlpha[3]).toBeGreaterThan(110);
      expect(result.halfAlpha[3]).toBeLessThan(145);
      expect(result.halfAlpha[0]).toBeGreaterThan(230); // unpremultiplied red
      expect(result.updated[0]).toBeLessThan(25); // same canvas AND frame object
      expect(Math.abs(result.green[1] - result.changed[1])).toBeGreaterThan(20);
      expect(result.changedAlpha[3]).toBeGreaterThan(110);
      expect(result.changedAlpha[3]).toBeLessThan(145);
      expect(result.bar[3]).toBe(0);
      expect(result.center[0]).toBeGreaterThan(230);
      expect(result.topBar[3]).toBe(0);
      expect(result.bottomCenter[0]).toBeGreaterThan(230);
      expect(result.sourceLeft[0]).toBeLessThan(25); // source: original mirror
      expect(result.sourceRight[0]).toBeGreaterThan(230);
      expect(result.sourceHole[3]).toBe(255); // camera stays opaque
      expect(result.standaloneLeft[0]).toBeLessThan(25);
      expect(result.cameraCover[3]).toBe(255); // camera keeps cover, not contain
    });
}

test('restored FX chain samples each completed WebGL canvas again on the next tick',
  { tag: '@core' }, async ({ page }) => {
    await page.setViewportSize({ width: 96, height: 64 });
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async () => {
      const { default: VizCore } = await import('/src/core/index.js');
      const { RESTORED_CAMERA_PATTERNS } = await import('/src/sketches/expansion/restored-camera.js');
      const input = document.createElement('canvas');
      input.width = 96; input.height = 64;
      const ctx = input.getContext('2d');
      const paint = color => {
        ctx.fillStyle = color; ctx.fillRect(0, 0, 48, 32);
        ctx.fillStyle = 'black'; ctx.fillRect(48, 0, 48, 32);
        ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 32, 48, 32);
        ctx.clearRect(16, 16, 12, 12);
      };
      paint('white');
      const frame = source => ({ source, width: source.width, height: source.height,
        frameId: 1, timestampMs: 16, generation: 1 });
      function make(pattern, getImageInput) {
        return new VizCore(p => {
          p.createCapture = () => { throw new Error('FX opened a camera'); };
          pattern.factory(null, null, { amount: 0, mirror: 1 }, {
            inputMode: 'fx', getImageInput,
            audioControls: { read: () => ({ continuous: { bass: 0, mid: 0, high: 0 } }) },
            createCapture: () => { throw new Error('FX opened a shared camera'); },
          })(p);
          const setup = p.setup;
          p.setup = () => { setup(); p.noLoop(); };
        });
      }
      async function ready(p) {
        await p.whenReady();
        for (let i = 0; i < 30 && (p.frameCount === 0 || p._redrawing); i++) {
          if (p._error) throw p._error;
          await new Promise(requestAnimationFrame);
        }
        if (p._error || p.frameCount === 0 || p._redrawing)
          throw p._error || new Error('Initial draw did not finish');
      }
      const first = make(RESTORED_CAMERA_PATTERNS[0], () => frame(input));
      let second;
      try {
        await ready(first);
        second = make(RESTORED_CAMERA_PATTERNS[1], () => frame(first.canvas));
        await ready(second);
        const out = document.createElement('canvas');
        out.width = 96; out.height = 64;
        const dest = out.getContext('2d', { willReadFrequently: true });
        const pixel = (x, y) => {
          dest.clearRect(0, 0, 96, 64);
          dest.drawImage(second.canvas, 0, 0);
          return [...dest.getImageData(x, y, 1, 1).data];
        };
        const left = pixel(6, 6), right = pixel(54, 6);
        const green = pixel(6, 42), hole = pixel(22, 22);
        paint('black');
        await first.redraw();
        await second.redraw();
        return { left, right, green, hole, updated: pixel(6, 6),
          errors: [first._error?.message || null, second._error?.message || null] };
      } finally {
        if (second) await second.remove();
        await first.remove();
      }
    });
    expect(result.errors).toEqual([null, null]);
    expect(result.left[0]).toBeGreaterThan(230);
    expect(result.right[0]).toBeLessThan(25);
    expect(result.green[1]).toBeGreaterThan(230);
    expect(result.hole[3]).toBe(0);
    expect(result.updated[0]).toBeLessThan(25);
  });
