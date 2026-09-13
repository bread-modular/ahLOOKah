import { test, expect } from '@playwright/test';

// Core lifecycle contract. Pins the semantics ProgramRuntime depends on:
// a default canvas exists before setup, setup may be async, exactly one draw
// runs after setup even when setup calls noLoop(), redraw() forces and awaits a
// frame while parked, loop() resumes, and remove() tears everything down.

test('core lifecycle: default canvas, async setup, one draw after noLoop, redraw and resume', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { default: VizCore } = await import('/src/core/index.js');
    const rafs = (count) => new Promise((resolve) => {
      let left = count;
      const step = () => { if (--left <= 0) resolve(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });

    const log = [];
    const draws = [];
    let instance = null;
    instance = new VizCore((p) => {
      // The sketch function runs synchronously with the instance.
      log.push(['sketch', Boolean(p.canvas), p.width, p.height]);
      p.setup = async () => {
        await Promise.resolve();
        log.push(['setup', p.width, p.height, p.canvas.tagName]);
        p.createCanvas(64, 48);
        log.push(['after-createCanvas', p.width, p.height, p.canvas.width, p.canvas.height]);
        p.noLoop();
      };
      p.draw = () => {
        draws.push({ frameCount: p.frameCount, deltaTime: p.deltaTime, millis: Math.round(p.millis()) });
        return undefined;
      };
    });
    // Construction alone must not run setup yet.
    log.push(['constructed', Boolean(instance.canvas)]);
    await rafs(3);
    const afterSetup = { draws: draws.length, frames: instance.frameCount, setupDone: instance._setupDone, looping: instance.isLooping() };

    // redraw() must force exactly one frame while parked and await the draw.
    let drawFinished = false;
    const originalDraw = instance.draw;
    instance.draw = () => { originalDraw(); drawFinished = true; };
    const redrawResult = await instance.redraw();
    const afterRedraw = { draws: draws.length, drawFinished, returned: redrawResult === instance };

    // loop() resumes the rAF loop and draws immediately.
    instance.loop();
    await rafs(3);
    const afterResume = { draws: draws.length, looping: instance.isLooping() };

    // remove() during an active loop stops drawing and detaches the canvas.
    instance.noLoop();
    const beforeRemove = document.querySelectorAll('canvas').length;
    await instance.remove();
    const removal = await instance.remove();
    const afterRemove = {
      canvases: document.querySelectorAll('canvas').length,
      beforeRemove,
      removed: instance._removed,
      resolved: removal === undefined || removal !== null,
      renderer: instance._renderer,
    };
    await rafs(2);
    return {
      log, draws, afterSetup, afterRedraw, afterResume, afterRemove, afterRemoveDraws: draws.length,
    };
  });

  expect(result.log[0]).toEqual(['sketch', false, 0, 0]);
  expect(result.log[1]).toEqual(['constructed', false]);
  // Default 100x100 canvas exists before setup and is resized by createCanvas.
  expect(result.log[2]).toEqual(['setup', 100, 100, 'CANVAS']);
  expect(result.log[3]).toEqual(['after-createCanvas', 64, 48, 64, 48]);
  expect(result.afterSetup.draws).toBe(1);
  expect(result.afterSetup.frames).toBe(1);
  expect(result.afterSetup.setupDone).toBe(true);
  expect(result.afterSetup.looping).toBe(false);
  expect(result.draws[0].frameCount).toBe(1);
  expect(result.draws[0].deltaTime).toBeGreaterThanOrEqual(0);
  expect(result.afterRedraw.draws).toBe(2);
  expect(result.afterRedraw.drawFinished).toBe(true);
  expect(result.afterRedraw.returned).toBe(true);
  expect(result.afterResume.draws).toBeGreaterThan(2);
  expect(result.afterResume.looping).toBe(true);
  expect(result.afterRemove.canvases).toBe(0);
  expect(result.afterRemove.beforeRemove).toBe(1);
  expect(result.afterRemove.removed).toBe(true);
  expect(result.afterRemove.resolved).toBe(true);
  expect(result.afterRemove.renderer).toBeNull();
  expect(result.afterRemoveDraws).toBe(result.afterResume.draws);
});

test('core lifecycle: windows resize hook and setFrameRate', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { default: VizCore } = await import('/src/core/index.js');
    const resizeCalls = [];
    const instance = new VizCore((p) => {
      p.setup = () => {
        p.createCanvas(32, 32);
        p.noLoop();
      };
      p.draw = () => {};
      p.windowResized = () => resizeCalls.push([p.windowWidth, p.windowHeight]);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const targetBefore = instance.getTargetFrameRate();
    instance.frameRate(30);
    window.dispatchEvent(new Event('resize'));
    const target = instance.getTargetFrameRate();
    const reported = instance.frameRate();
    await instance.remove();
    return { resizeCalls, targetBefore, target, reportedType: typeof reported };
  });
  expect(result.targetBefore).toBe(60);
  expect(result.target).toBe(30);
  expect(result.resizeCalls.length).toBe(1);
  expect(result.reportedType).toBe('number');
});

test('core media: createVideo parents a hidden element and remove() detaches it', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { default: VizCore } = await import('/src/core/index.js');
    const instance = new VizCore((p) => {
      p.setup = () => {
        p.createCanvas(32, 32);
        p.noLoop();
      };
      p.draw = () => {};
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const parentedBefore = document.querySelectorAll('video').length;
    const element = instance.createVideo([]);
    const afterCreate = document.querySelectorAll('video').length;
    const isBodyChild = element.elt.parentNode === document.body;
    const hiddenByDefault = getComputedStyle(element.elt).display === 'none';
    const preload = element.elt.preload;
    const muted = element.elt.muted;
    // p5 keeps media elements in the sketch's registry so remove() can clean up.
    const registered = instance._elements.includes(element);

    element.hide();
    const hiddenAfterHide = getComputedStyle(element.elt).display === 'none';
    element.show();
    const visibleAfterShow = getComputedStyle(element.elt).display !== 'none';

    element.remove();
    const afterRemove = document.querySelectorAll('video').length;
    await instance.remove();
    return {
      parentedBefore, afterCreate, isBodyChild, hiddenByDefault, preload, muted,
      registered, hiddenAfterHide, visibleAfterShow, afterRemove,
    };
  });

  expect(result.parentedBefore).toBe(0);
  expect(result.afterCreate).toBe(1);
  expect(result.isBodyChild).toBe(true);
  expect(result.hiddenByDefault).toBe(true);
  expect(result.preload).toBe('auto');
  expect(result.muted).toBe(true);
  expect(result.registered).toBe(true);
  expect(result.hiddenAfterHide).toBe(true);
  expect(result.visibleAfterShow).toBe(true);
  expect(result.afterRemove).toBe(0);
});
