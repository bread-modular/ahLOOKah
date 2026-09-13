import { test, expect } from '@playwright/test';

const CAMERA_IDS = ['video-datamosh', 'video-rolling-shutter', 'video-edge-glow', 'video-thermal'];

// Isolated real-p5 renderer with a deterministic camera frame (same protocol as
// the replacement lifecycle suite): exact audio-on/off pixel comparisons,
// controller/renderer disposal, and capture release.
async function mount(page, id) {
  await page.setViewportSize({ width: 360, height: 240 });
  await page.goto('/docs/patterns.html');
  await page.evaluate(async (id) => {
    const { default: VizCore } = await import('/src/core/index.js');
    const { SKETCHES, defaultParamValues } = await import('/src/sketch-registry.js');
    const { disposeVizInstance } = await import('/src/program-runtime.js');
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
    const p = await new Promise((resolve) => new VizCore((p) => {
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
        disposeVizInstance(p);
      },
    };
  }, id);
}

test('expansion camera FX consume shared capture, react independently per band, and dispose cleanly', { tag: '@patterns' }, async ({ page }) => {
  test.setTimeout(120_000);
  for (const id of CAMERA_IDS) {
    await mount(page, id);
    const result = await page.evaluate(async (id) => {
      const h = window.__expanded;
      const delta = (a, b) => {
        let sum = 0, changed = 0;
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          sum += d; if (d > 12) changed++;
        }
        return { rgb: sum / (a.length * 0.75), coverage: changed / (a.length / 4) };
      };
      const luma = (a) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += a[i] + a[i + 1] + a[i + 2]; return s / (a.length * 0.75); };
      const silenceA = await h.sample({});
      const silenceB = await h.sample({});
      const bands = {};
      // Static fixture frames legitimately hide datamosh bass at modest levels
      // (stale blocks of a still image are identical), so bass is driven at a
      // strong-but-realistic level there; mid/high use moderate levels.
      const level = id === 'video-datamosh' ? { sub: 1.6, mid: 0.3, high: 0.3 } : { sub: 0.3, mid: 0.3, high: 0.3 };
      for (const [band, feature] of [['bass', 'sub'], ['mid', 'mid'], ['high', 'high']]) {
        const driven = await h.sample({ [feature]: level[feature] });
        const muted = await h.sample({ [feature]: 0.9 }, { [band]: 0 });
        delete h.params[band];
        let mutedMaxDelta = 0;
        for (let i = 0; i < muted.length; i++) mutedMaxDelta = Math.max(mutedMaxDelta, Math.abs(muted[i] - silenceA[i]));
        bands[band] = { driven: delta(silenceA, driven), mutedMaxDelta };
      }
      const loud = await h.sample({ sub: 1.6, mid: 1.6, high: 1.6 });
      const after = await h.sample({});
      return {
        deterministic: delta(silenceA, silenceB).rgb,
        bands,
        loudRgb: delta(silenceA, loud).rgb,
        restored: delta(silenceA, after).rgb,
        luma: luma(silenceA),
        reads: h.reads,
      };
    }, id);
    expect(result.deterministic, `${id} silence stable`).toBe(0);
    expect(result.reads, `${id} reads`).toBeGreaterThan(0);
    expect(result.luma, `${id} camera image present`).toBeGreaterThan(10);
    for (const [band, m] of Object.entries(result.bands)) {
      expect(m.driven.rgb, `${id} ${band} responds`).toBeGreaterThan(0.5);
      expect(m.mutedMaxDelta, `${id} ${band} zero disables`).toBe(0);
    }
    expect(result.loudRgb, `${id} full mix`).toBeGreaterThan(1);
    expect(result.restored, `${id} returns to silence`).toBe(0);
    await page.evaluate(() => window.__expanded.dispose());
    const leftover = await page.evaluate(() => document.querySelectorAll('canvas').length);
    expect(leftover, `${id} canvases removed`).toBe(0);
  }
});
