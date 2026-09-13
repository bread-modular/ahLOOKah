import { test, expect } from '@playwright/test';

// Canvas2D contract for the replacement core. Pins the density rules, color
// parsing overloads (HSB maxes, grayscale + alpha), blend modes, translucency,
// tint, density-aware get()/copy() including overlapping self-copies, text and
// offscreen Graphics buffers.
//
// Probe pixels are read from a TRANSPARENT canvas (p.clear()) so stored alpha
// stays meaningful instead of being composited over an opaque background.

test('core Canvas2D: pixel density, backing store and per-frame transform', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const rows = await page.evaluate(async () => {
    const { default: VizCore } = await import('/src/core/index.js');
    const out = [];
    const instance = new VizCore((p) => {
      p.setup = () => { p.createCanvas(40, 30); p.noLoop(); };
      p.draw = () => { p.background(20, 30, 40); };
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (const density of [1, 2, 1]) {
      instance.pixelDensity(density);
      for (const [w, h] of [[24, 16], [10, 20]]) {
        instance.resizeCanvas(w, h, true);
        await instance.redraw();
        const ctx = instance.drawingContext;
        const data = ctx.getImageData(0, 0, instance.canvas.width, instance.canvas.height).data;
        let transparent = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) transparent += 1;
        out.push({
          density,
          w,
          h,
          width: instance.width,
          height: instance.height,
          backing: [instance.canvas.width, instance.canvas.height],
          style: [instance.canvas.style.width, instance.canvas.style.height],
          transform: [ctx.getTransform().a, ctx.getTransform().d],
          pixel: [data[0], data[1], data[2], data[3]],
          transparent,
        });
      }
    }
    await instance.remove();
    return out;
  });
  expect(rows).toHaveLength(6);
  for (const row of rows) {
    expect(row).toMatchObject({
      width: row.w,
      height: row.h,
      backing: [row.w * row.density, row.h * row.density],
      style: [`${row.w}px`, `${row.h}px`],
      transform: [row.density, row.density],
      pixel: [20, 30, 40, 255],
      transparent: 0,
    });
  }
});

test('core Canvas2D: color modes, grayscale/alpha overloads, blend, tint, text and strokes', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const probes = await page.evaluate(async () => {
    const { default: VizCore } = await import('/src/core/index.js');
    // Each probe draws on a cleared (fully transparent) 8x8 canvas, so stored
    // alpha values are the real draw results.
    const probe = async (draw) => {
      const instance = new VizCore((p) => {
        p.setup = () => { p.createCanvas(8, 8); p.pixelDensity(1); p.noLoop(); };
        p.draw = () => { p.clear(); draw(p); };
      });
      await instance.whenReady();
      await instance.redraw();
      const ctx = instance.drawingContext;
      const sample = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
      const data = ctx.getImageData(0, 0, 8, 8).data;
      let lit = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 40) lit += 1;
      const result = { corner: sample(1, 1), center: sample(4, 4), lit };
      await instance.remove();
      return result;
    };

    return {
      hsbOpaque: await probe((p) => { p.colorMode(p.HSB, 360, 100, 100, 255); p.noStroke(); p.fill(120, 100, 100); p.rect(0, 0, 8, 8); }),
      hsbAlpha: await probe((p) => { p.colorMode(p.HSB, 360, 100, 100, 255); p.noStroke(); p.fill(0, 100, 100, 128); p.rect(0, 0, 8, 8); }),
      hsbUnit: await probe((p) => { p.colorMode(p.HSB, 1, 1, 1); p.noStroke(); p.fill(1 / 3, 1, 1); p.rect(0, 0, 8, 8); }),
      grayAlpha: await probe((p) => { p.noStroke(); p.fill(128, 128); p.rect(0, 0, 8, 8); }),
      twoArg: await probe((p) => { p.noStroke(); p.fill(90, 40); p.rect(0, 0, 8, 8); }),
      hsbDefaultMax: await probe((p) => { p.colorMode(p.HSB); p.noStroke(); p.fill(120, 100, 100); p.rect(0, 0, 8, 8); }),
      addBlend: await probe((p) => {
        p.noStroke();
        p.fill(80, 0, 0);
        p.rect(0, 0, 8, 8);
        p.blendMode(p.ADD);
        p.fill(40, 0, 0);
        p.rect(0, 0, 8, 8);
        p.blendMode(p.BLEND);
      }),
      tinted: await probe((p) => {
        const img = p.createImage(4, 4);
        img.loadPixels();
        for (let i = 0; i < img.pixels.length; i += 4) {
          img.pixels[i] = 255; img.pixels[i + 1] = 128; img.pixels[i + 2] = 64; img.pixels[i + 3] = 255;
        }
        img.updatePixels();
        p.noStroke();
        p.tint(128, 255, 255, 128);
        p.image(img, 0, 0, 8, 8);
        p.noTint();
      }),
      textPixels: await probe((p) => {
        p.noStroke();
        p.fill(255);
        p.textFont('monospace');
        p.textSize(9);
        p.textAlign(p.CENTER, p.CENTER);
        p.text('LIVE', 4, 4);
      }),
      strokes: await probe((p) => {
        p.stroke(255);
        p.strokeWeight(2);
        p.line(0, 4, 8, 4);
      }),
      shapes: await probe((p) => {
        p.noStroke();
        p.fill(255);
        p.circle(4, 4, 6);
      }),
    };
  });

  // HSB hue 120/360 = green; alpha 128/255 stays stored on a transparent canvas.
  expect(probes.hsbOpaque.corner).toEqual([0, 255, 0, 255]);
  expect(probes.hsbAlpha.corner).toEqual([255, 0, 0, 128]);
  expect(probes.hsbUnit.corner).toEqual([0, 255, 0, 255]);
  // HSB default maxima are (360, 100, 100, 1): a missing alpha is the maximum,
  // so the stored pixel is opaque.
  expect(probes.hsbDefaultMax.corner).toEqual([0, 255, 0, 255]);
  // 2-argument RGB fill is (gray, alpha).
  expect(probes.grayAlpha.corner).toEqual([128, 128, 128, 128]);
  // Canvas stores premultiplied alpha, so a translucent gray can round by 1 LSB
  // when it is read back; the alpha channel itself is exact.
  expect(probes.twoArg.corner[0]).toBeGreaterThanOrEqual(88);
  expect(probes.twoArg.corner[0]).toBeLessThanOrEqual(90);
  expect(probes.twoArg.corner[3]).toBe(40);
  // ADD is the canvas 'lighter' composite: 80 + 40 clamps to 120.
  expect(probes.addBlend.corner).toEqual([120, 0, 0, 255]);
  // Tint multiplies RGB and carries alpha: (255,128,64) × (128,255,255) → (128,128,64).
  expect(probes.tinted.corner[0]).toBeGreaterThanOrEqual(127);
  expect(probes.tinted.corner[0]).toBeLessThanOrEqual(129);
  expect(probes.tinted.corner[1]).toBe(128);
  expect(probes.tinted.corner[2]).toBe(64);
  expect(probes.tinted.corner[3]).toBeGreaterThanOrEqual(127);
  expect(probes.tinted.corner[3]).toBeLessThanOrEqual(129);
  expect(probes.textPixels.lit).toBeGreaterThan(4);
  expect(probes.strokes.center[0]).toBeGreaterThan(200);
  expect(probes.strokes.center[3]).toBe(255);
  expect(probes.shapes.center).toEqual([255, 255, 255, 255]);
  // Main p5 baseline: circle(4,4,6) covers the (1,1) edge pixel at alpha 24.
  // The old zero expectation accidentally endorsed a half-sized circle.
  expect(probes.shapes.corner).toEqual([255, 255, 255, 24]);
});

test('core Canvas2D: density-aware get/copy, overlapping self-copy, graphics buffers', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { default: VizCore } = await import('/src/core/index.js');
    const out = {};
    const instance = new VizCore((p) => {
      p.setup = () => { p.createCanvas(24, 12); p.pixelDensity(2); p.noLoop(); };
      p.draw = () => {
        p.clear();
        p.noStroke();
        // Four 2px-tall bands on the left: red, green, blue, yellow.
        const bands = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
        bands.forEach((color, index) => {
          p.fill(color[0], color[1], color[2]);
          p.rect(0, index * 2, 8, 2);
        });

        // get() copies a logical 8x8 region (density must not leak into the
        // logical coordinates) and image() blits it back at the same size.
        const band = p.get(0, 0, 8, 8);
        p.image(band, 8, 0, 8, 8);

        // Overlapping self-copy of the left bands: source rows 0-4 onto 2-6.
        // A snapshot copy keeps the third row green; an in-place copy smears the
        // red row over it (the green band would disappear).
        p.copy(0, 0, 8, 4, 0, 2, 8, 4);

        const graphics = p.createGraphics(6, 6);
        out.graphicsBackingBeforeDensity = [graphics.canvas.width, graphics.canvas.height];
        graphics.pixelDensity(1);
        graphics.noStroke();
        graphics.background(0, 255, 0);
        graphics.fill(255, 255, 0);
        graphics.rect(2, 2, 4, 4);
        out.graphicsBacking = [graphics.canvas.width, graphics.canvas.height];
        out.graphicsLogical = [graphics.width, graphics.height];
        out.graphicsTransform = graphics.drawingContext.getTransform().a;
        p.image(graphics, 18, 0, 6, 6);
        graphics.remove();
        out.graphicsRemoved = graphics.canvas.width;
      };
    });
    await instance.whenReady();
    await instance.redraw();
    const ctx = instance.drawingContext;

    const classify = ([r, g, b, a]) => {
      if (a < 40) return 'clear';
      if (r > 150 && g > 150 && b < 120) return 'yellow';
      if (r > 150 && g < 120 && b < 120) return 'red';
      if (g > 150 && r < 120 && b < 120) return 'green';
      if (b > 150 && r < 120 && g < 120) return 'blue';
      return 'mixed';
    };
    // Average a horizontal logical span for one logical row (density-aware) and
    // collapse the resulting per-row classes into an ordered sequence.
    const rowSequence = (x0, x1) => {
      const groups = [];
      for (let row = 0; row < 10; row += 1) {
        const data = ctx.getImageData(Math.round(x0 * 2), Math.round(row * 2), Math.round((x1 - x0) * 2), 2).data;
        let r = 0; let g = 0; let b = 0; let a = 0;
        const count = data.length / 4;
        for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; }
        const label = classify([r / count, g / count, b / count, a / count]);
        if (label === 'mixed' || label === 'clear') continue;
        if (groups[groups.length - 1] !== label) groups.push(label);
      }
      return groups;
    };
    const at = (x, y) => [...ctx.getImageData(Math.round(x * 2), Math.round(y * 2), 1, 1).data];
    out.bandSequence = rowSequence(9, 15);
    out.leftSequence = rowSequence(0, 4);
    out.row1 = at(2, 1);
    out.row7 = at(2, 7);
    out.graphicsBlit = at(19, 1);
    out.graphicsInner = at(21, 3);
    await instance.remove();
    return out;
  });

  // createGraphics inherits the parent density (2 here) until it is changed.
  expect(result.graphicsBackingBeforeDensity).toEqual([12, 12]);
  expect(result.graphicsBacking).toEqual([6, 6]);
  expect(result.graphicsLogical).toEqual([6, 6]);
  expect(result.graphicsTransform).toBe(1);
  expect(result.graphicsRemoved).toBe(0);
  // get() + image() round-trip preserves band order and count.
  expect(result.bandSequence).toEqual(['red', 'green', 'blue', 'yellow']);
  // Snapshot copy: red rows, then the still-green band (no smear), then yellow.
  expect(result.leftSequence).toEqual(['red', 'green', 'yellow']);
  expect(result.row1).toEqual([255, 0, 0, 255]);
  expect(result.row7).toEqual([255, 255, 0, 255]);
  expect(result.graphicsBlit).toEqual([0, 255, 0, 255]);
  expect(result.graphicsInner).toEqual([255, 255, 0, 255]);
});
