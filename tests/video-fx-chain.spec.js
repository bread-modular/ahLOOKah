import { test, expect } from '@playwright/test';

test('new Video FX chain: 2D trails → WebGL high contrast → WebGL pixelate uses completed, fresh frames',
  { tag: '@core' }, async ({ page }) => {
    await page.setViewportSize({ width: 120, height: 80 });
    await page.goto('/tests/fixtures/render.html');
    const result = await page.evaluate(async () => {
      const { default: VizCore } = await import('/src/core/index.js');
      const { default: trails } = await import('/src/sketches/video_trails.js');
      const { default: contrast } = await import('/src/sketches/webcam_high_contrast.js');
      const { default: pixelate } = await import('/src/sketches/video_pixelate.js');
      const upstream = document.createElement('canvas');
      upstream.width = 120; upstream.height = 80;
      const ctx = upstream.getContext('2d');
      const fill = (color) => {
        ctx.fillStyle = color; ctx.fillRect(0, 0, 60, 80);
        ctx.fillStyle = 'black'; ctx.fillRect(60, 0, 60, 80);
      };
      fill('white');
      let image = null, id = 1, captures = 0;
      const frame = (source) => ({ source, width: source.width, height: source.height,
        frameId: id, generation: 1, timestampMs: id * 16 });
      const controls = { read: () => ({ continuous: { subLevel: 0, sub: 0, mid: 0, high: 0, noise: 0 } }) };
      const make = (factory, params, getImageInput) => new VizCore((p) => {
        p.createCapture = () => { captures++; throw new Error('FX opened raw camera'); };
        factory(null, null, params, { inputMode: 'fx', audioControls: controls,
          getImageInput, createCapture: () => { captures++; throw new Error('FX opened shared camera'); } })(p);
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
      const first = make(trails, { tintHue: 0, decay: 0 }, () => image);
      await ready(first);
      const second = make(contrast, { threshold: 0.15, contrast: 1 }, () => frame(first.canvas));
      await ready(second);
      const third = make(pixelate, { block: 2, audioBlocks: 0, levels: 0 }, () => frame(second.canvas));
      await ready(third);
      const pixel = (instance, x, y) => {
        const copy = document.createElement('canvas');
        copy.width = 120; copy.height = 80;
        const dest = copy.getContext('2d', { willReadFrequently: true });
        dest.drawImage(instance.canvas, 0, 0);
        return Array.from(dest.getImageData(x, y, 1, 1).data);
      };
      image = frame(upstream);
      await first.redraw(); await second.redraw(); await third.redraw();
      const bright = pixel(third, 30, 40);
      const darkSide = pixel(third, 90, 40);
      // Disconnect once to clear temporal feedback, then repaint the very same
      // source canvas and rerun the chain at a new graph frame ID.
      image = null;
      await first.redraw();
      fill('black'); id++;
      image = frame(upstream);
      await first.redraw(); await second.redraw(); await third.redraw();
      const changed = pixel(third, 30, 40);
      const errors = [first._error?.message || null, second._error?.message || null,
        third._error?.message || null];
      await third.remove(); await second.remove(); await first.remove();
      return { bright, darkSide, changed, errors, captures };
    });
    expect(result.errors).toEqual([null, null, null]);
    expect(result.captures).toBe(0);
    expect(result.bright[0]).toBeGreaterThan(150);
    expect(result.darkSide[0]).toBeLessThan(80);
    expect(result.changed[0]).toBeLessThan(80);
  });
