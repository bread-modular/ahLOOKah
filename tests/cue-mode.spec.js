import { test, expect } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';

async function openScreenAndControl(context, page) {
  await page.goto(SCREEN_URL);
  const control = await context.newPage();
  await control.goto(CONTROL_URL);
  await page.waitForFunction(() => window.__viz.patternId === 'circles');
  await expect(control.locator('#cue-preview-controls')).toBeHidden();
  return control;
}

async function setRange(control, selector, value) {
  await control.locator(selector).evaluate((el, next) => {
    el.value = String(next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function cueWithShift(control, key) {
  await control.keyboard.down('Shift');
  await control.keyboard.press(key);
  await control.keyboard.up('Shift');
}

async function enterCue(control) {
  await cueWithShift(control, '1');
}

async function goLive(control) {
  await control.keyboard.press('Enter');
}

// Hold compositor callbacks on the output only. This makes the revision gate
// deterministic without faking p5: a newly edited candidate can draw, but it
// cannot report READY until the held output compositor callbacks are released.
async function holdScreenAnimationFrames(page) {
  await page.evaluate(() => {
    if (window.__cueRafHold) return;
    const originalRequest = window.requestAnimationFrame;
    const originalCancel = window.cancelAnimationFrame;
    const callbacks = new Map();
    let nextId = 1;
    window.__cueRafHold = { originalRequest, originalCancel, callbacks };
    window.requestAnimationFrame = (callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => callbacks.delete(id);
  });
}

async function releaseScreenAnimationFrames(page) {
  await page.evaluate(() => {
    const hold = window.__cueRafHold;
    if (!hold) return;
    window.requestAnimationFrame = hold.originalRequest;
    window.cancelAnimationFrame = hold.originalCancel;
    const callbacks = [...hold.callbacks.values()];
    delete window.__cueRafHold;
    callbacks.forEach((callback) => hold.originalRequest.call(window, callback));
  });
}

test.describe('CUE mode', () => {
  test('shares a single output camera stream between LIVE and CUE consumers', async ({ page }) => {
    await page.goto(SCREEN_URL);
    const result = await page.evaluate(async () => {
      const media = navigator.mediaDevices;
      const original = media.getUserMedia;
      let calls = 0;
      Object.defineProperty(media, 'getUserMedia', {
        configurable: true,
        value: async () => {
          calls += 1;
          return new MediaStream();
        },
      });
      try {
        const { SharedCameraSource } = await import('/shared-camera-source.js');
        const source = new SharedCameraSource();
        const makeP = () => ({
          createVideo: () => ({
            elt: document.createElement('video'),
            hide() {},
          }),
        });
        const first = source.acquire({ p: makeP(), deviceId: 'camera-a', constraints: { video: true }, onReady() {} });
        const second = source.acquire({ p: makeP(), deviceId: 'camera-a', constraints: { video: true }, onReady() {} });
        await Promise.resolve();
        await Promise.resolve();
        const active = source.diagnostics();
        first.release();
        second.release();
        const released = source.diagnostics();
        return { calls, active, released };
      } finally {
        Object.defineProperty(media, 'getUserMedia', { configurable: true, value: original });
      }
    });

    expect(result.calls).toBe(1);
    expect(result.active).toMatchObject({ streams: 1, consumers: 2, devices: ['camera-a'] });
    expect(result.released).toMatchObject({ streams: 0, consumers: 0 });
  });

  test('parents program canvases at construction and safely serializes/disposes fresh-frame waiters', async ({ page }) => {
    await page.goto(SCREEN_URL);
    const result = await page.evaluate(async () => {
      const { ProgramRuntime } = await import('/program-runtime.js');
      const originalRequest = window.requestAnimationFrame;
      const originalCancel = window.cancelAnimationFrame;
      const callbacks = new Map();
      let nextId = 1;
      window.requestAnimationFrame = (callback) => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) => callbacks.delete(id);
      const flushRaf = () => {
        const batch = [...callbacks.values()];
        callbacks.clear();
        batch.forEach((callback) => callback(performance.now()));
      };

      const instances = [];
      class FakeP5 {
        constructor(sketch, parent) {
          this._removed = false;
          this.loopCalls = 0;
          this.noLoopCalls = 0;
          this.canvas = document.createElement('canvas');
          (parent || document.body).appendChild(this.canvas);
          this.initialParent = this.canvas.parentElement;
          const p = {};
          sketch(p);
          this.p = p;
          instances.push(this);
        }
        setup() { this.p.setup?.(); }
        draw() { this.p.draw?.(); }
        loop() { this.loopCalls += 1; }
        noLoop() { this.noLoopCalls += 1; }
        remove() {
          this._removed = true;
          this.canvas.remove();
        }
      }

      let runtime;
      try {
        const layer = document.createElement('div');
        document.body.appendChild(layer);
        runtime = new ProgramRuntime({
          p5Constructor: FakeP5,
          selection: { ids: ['fake'], merge: false },
          sketches: [{
            id: 'fake',
            factory: () => (p) => {
              p.setup = () => {};
              p.draw = () => {};
            },
          }],
          audio: null,
          videoDeviceId: null,
          getParams: () => ({}),
          layer,
          warmTimeoutMs: 1_000,
        });

        const ready = runtime.prepare();
        const instance = instances[0];
        instance.setup();
        instance.draw();
        flushRaf();
        flushRaf();
        await ready;

        const first = runtime.requestFreshFrame(1_000, { parkAfter: true });
        instance.draw();
        // This request arrives after the first draw but before its compositor
        // confirmation. It must get a new frame and prevent the first request
        // from parking the renderer underneath it.
        const second = runtime.requestFreshFrame(1_000, { parkAfter: false });
        flushRaf();
        flushRaf();
        const pauseBeforeSecondFrame = instance.noLoopCalls;
        instance.draw();
        flushRaf();
        flushRaf();
        await Promise.all([first, second]);
        const pauseAfterSecondFrame = instance.noLoopCalls;

        const pending = runtime.requestFreshFrame(1_000, { parkAfter: false });
        instance.draw();
        runtime.dispose();
        flushRaf();
        flushRaf();
        const disposeResult = await Promise.race([
          pending.then(() => 'resolved', (error) => error.message),
          new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50)),
        ]);

        return {
          parentedAtConstruction: instance.initialParent === layer,
          pauseBeforeSecondFrame,
          pauseAfterSecondFrame,
          disposeResult,
        };
      } finally {
        runtime?.dispose();
        window.requestAnimationFrame = originalRequest;
        window.cancelAnimationFrame = originalCancel;
      }
    });

    expect(result.parentedAtConstruction).toBe(true);
    expect(result.pauseBeforeSecondFrame).toBe(0);
    expect(result.pauseAfterSecondFrame).toBe(0);
    expect(result.disposeResult).toBe('Program runtime was disposed.');
  });

  test('keeps a warming camera runtime looping until media-ready plus a later draw', async ({ page }) => {
    await page.goto(SCREEN_URL);
    const result = await page.evaluate(async () => {
      const { ProgramRuntime } = await import('/program-runtime.js');
      const originalRequest = window.requestAnimationFrame;
      const originalCancel = window.cancelAnimationFrame;
      const callbacks = new Map();
      let nextId = 1;
      window.requestAnimationFrame = (callback) => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) => callbacks.delete(id);
      const flushRaf = () => {
        const batch = [...callbacks.values()];
        callbacks.clear();
        batch.forEach((callback) => callback(performance.now()));
      };

      const instances = [];
      class FakeP5 {
        constructor(sketch, parent) {
          this._removed = false;
          this.noLoopCalls = 0;
          this.canvas = document.createElement('canvas');
          (parent || document.body).appendChild(this.canvas);
          const p = {};
          sketch(p);
          this.p = p;
          instances.push(this);
        }
        setup() { this.p.setup?.(); }
        draw() { this.p.draw?.(); }
        loop() {}
        noLoop() { this.noLoopCalls += 1; }
        remove() { this._removed = true; this.canvas.remove(); }
      }

      let runtime;
      let reportMediaReady;
      try {
        const layer = document.createElement('div');
        document.body.appendChild(layer);
        runtime = new ProgramRuntime({
          p5Constructor: FakeP5,
          selection: { ids: ['camera-fake'], merge: false },
          sketches: [{
            id: 'camera-fake',
            camera: true,
            factory: (_audio, _device, _params, context) => (p) => {
              p.setup = () => context.createCapture(p, { video: true }, () => {});
              p.draw = () => {};
            },
          }],
          audio: null,
          videoDeviceId: null,
          getParams: () => ({}),
          layer,
          cameraSource: {
            acquire({ onReady }) {
              reportMediaReady = onReady;
              return { capture: {}, release() {} };
            },
          },
          warmTimeoutMs: 1_000,
        });

        let readyResolved = false;
        const ready = runtime.prepare().then(() => { readyResolved = true; });
        const instance = instances[0];
        instance.setup();
        // Pre-media draws are deliberately insufficient for camera readiness.
        instance.draw();
        const fresh = runtime.requestFreshFrame(1_000, { parkAfter: true });
        instance.draw();
        flushRaf();
        flushRaf();
        await fresh;
        const beforeMedia = { readyResolved, noLoopCalls: instance.noLoopCalls };

        reportMediaReady();
        await Promise.resolve();
        const afterMediaBeforeDraw = readyResolved;
        instance.draw();
        flushRaf();
        flushRaf();
        await ready;

        return {
          beforeMedia,
          afterMediaBeforeDraw,
          readyAfterMediaDraw: readyResolved,
        };
      } finally {
        runtime?.dispose();
        window.requestAnimationFrame = originalRequest;
        window.cancelAnimationFrame = originalCancel;
      }
    });

    expect(result.beforeMedia).toEqual({ readyResolved: false, noLoopCalls: 0 });
    expect(result.afterMediaBeforeDraw).toBe(false);
    expect(result.readyAfterMediaDraw).toBe(true);
  });

  test('stages an isolated program and only persists it after TAKE', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    const storageBefore = await control.evaluate(() => localStorage.getItem('viz2_params'));

    await enterCue(control);
    await page.waitForFunction(() => window.__viz.cue?.phase === 'same');
    await expect(control.locator('#preview-title')).toHaveText('CUE PREVIEW');
    await expect(control.locator('#cue-preview-controls')).toBeVisible();
    await expect(control.locator('#cue-primary .transport-action')).toHaveText('GO LIVE');

    // CUE Bars (slot 3); Circles remains the screen program while it warms.
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'bars');
    expect(await page.evaluate(() => window.__viz.patternId)).toBe('circles');
    await expect(control.locator('#pattern-pad [data-index="0"]')).toHaveClass(/live-active/);
    await expect(control.locator('#pattern-pad [data-index="2"]')).toHaveClass(/cue-active/);

    await setRange(control, '#params-list input[data-key="gain"]', 3);
    await page.waitForFunction(() => window.__viz.cueParams?.bars?.gain === 3);
    expect(await control.evaluate(() => localStorage.getItem('viz2_params'))).toBe(storageBefore);

    await page.waitForFunction(() => window.__viz.cue?.phase === 'ready');
    await goLive(control);
    await page.waitForFunction(() => window.__viz.cue === null && window.__viz.patternId === 'bars');
    await page.waitForFunction(() => window.__viz.params.gain === 3);
    await control.waitForFunction(() => {
      const stored = JSON.parse(localStorage.getItem('viz2_params') || '{}');
      return stored.bars?.gain === 3;
    });
    await expect(control.locator('#preview-title')).toHaveText('LIVE PREVIEW');
  });

  test('uses Shift pattern selection and preview-overlay transport without a top bar', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);

    await expect(control.locator('#transport-bar')).toHaveCount(0);
    await control.keyboard.press('CapsLock');
    expect(await page.evaluate(() => window.__viz.cue)).toBeNull();

    await control.locator('#pattern-pad [data-index="2"]').click({ modifiers: ['Shift'] });
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'bars');
    expect(await page.evaluate(() => window.__viz.patternId)).toBe('circles');
    await expect(control.locator('#cue-preview-controls')).toBeVisible();
    await expect(control.locator('#cue-primary .transport-action')).toHaveText('GO LIVE');
    await expect(control.locator('#cue-cancel')).toBeEnabled();

    const overlayLayout = await control.evaluate(() => {
      const preview = document.querySelector('.preview-surface').getBoundingClientRect();
      const overlay = document.querySelector('#cue-preview-controls');
      const overlayRect = overlay.getBoundingClientRect();
      const previewPane = document.querySelector('#preview-pane').getBoundingClientRect();
      const libraryPane = document.querySelector('#library-pane').getBoundingClientRect();
      return {
        position: getComputedStyle(overlay).position,
        insidePreview: overlayRect.left >= preview.left
          && overlayRect.right <= preview.right
          && overlayRect.top >= preview.top
          && overlayRect.bottom <= preview.bottom,
        panesShareTop: Math.abs(previewPane.top - libraryPane.top) < 1,
      };
    });
    expect(overlayLayout).toEqual({ position: 'absolute', insidePreview: true, panesShareTop: true });

    // A library-only Shift-click also begins/updates CUE and preview re-renders
    // must not remove the sibling overlay controls.
    await control.locator('#pattern-library [data-id="plasma-waves"]').click({ modifiers: ['Shift'] });
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'plasma-waves');
    await expect(control.locator('#cue-preview-controls')).toBeVisible();
    await expect(control.locator('#cue-primary')).toHaveCount(1);

    await control.locator('#cue-cancel').click();
    await page.waitForFunction(() => window.__viz.cue === null);
    await expect(control.locator('#cue-preview-controls')).toBeHidden();

    await cueWithShift(control, '3');
    await page.waitForFunction(() => window.__viz.cue?.phase === 'ready');
    await control.locator('#cue-primary').click();
    await page.waitForFunction(() => window.__viz.cue === null && window.__viz.patternId === 'bars');
  });

  test('Escape cancels a staged candidate without changing LIVE or storage', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    const storageBefore = await control.evaluate(() => localStorage.getItem('viz2_params'));

    await enterCue(control);
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'bars');
    await setRange(control, '#params-list input[data-key="gain"]', 2.5);
    await page.waitForFunction(() => window.__viz.cueParams?.bars?.gain === 2.5);

    await control.keyboard.press('Escape');
    await page.waitForFunction(() => window.__viz.cue === null);
    expect(await page.evaluate(() => window.__viz.patternId)).toBe('circles');
    expect(await control.evaluate(() => localStorage.getItem('viz2_params'))).toBe(storageBefore);
    await expect(control.locator('#cue-cancel')).toBeDisabled();
    await expect(control.locator('#preview-title')).toHaveText('LIVE PREVIEW');
  });

  test('cue post-processing stays isolated and is promoted with the warmed program', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    const storedBefore = await control.evaluate(() => localStorage.getItem('viz2_params'));

    await enterCue(control);
    await setRange(control, '#post-fx-list input[data-key="brightness"]', 25);
    await page.waitForFunction(() => window.__viz.cueParams?.__postfx?.brightness === 25);
    expect(await control.evaluate(() => localStorage.getItem('viz2_params'))).toBe(storedBefore);
    await page.waitForFunction(() => window.__viz.cue?.phase === 'ready');
    await page.waitForFunction(() => {
      const cue = document.querySelector('.program-layer-cue');
      return cue && cue.style.filter.includes('brightness(1.25)');
    });

    await goLive(control);
    await page.waitForFunction(() => window.__viz.cue === null && window.__viz.postfx.brightness === 25);
    await page.waitForFunction(() => document.getElementById('screen-wrap').style.filter.includes('brightness(1.25)'));
  });

  test('number merge gestures and blend shortcuts route to CUE', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    const liveBlend = await page.evaluate(() => ({ ...window.__viz.blend }));

    await enterCue(control);
    await control.keyboard.down('1');
    await control.keyboard.down('3');
    await page.waitForFunction(() => JSON.stringify(window.__viz.cue?.selection?.ids) === '["circles","bars"]');
    await control.keyboard.up('3');
    await control.keyboard.up('1');

    await control.keyboard.press('+');
    await page.waitForFunction(() => window.__viz.cueParams?.__merge?.mix === 0.55);
    expect(await page.evaluate(() => window.__viz.blend.mix)).toBe(liveBlend.mix);
    expect(await page.evaluate(() => window.__viz.patternId)).toBe('circles');
    await page.waitForFunction(() => window.__viz.cue?.phase === 'ready');
    expect(await page.evaluate(() => window.__viz.runtimeCounts.total)).toBeLessThanOrEqual(3);

    await control.keyboard.press('Escape');
    await page.waitForFunction(() => window.__viz.cue === null);
  });

  test('a TAKE requested while warming remains safe and promotes once ready', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);

    await enterCue(control);
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.cue?.phase === 'warming' || window.__viz.cue?.phase === 'ready');
    await goLive(control);

    // Whether this was already READY or still warming, the old LIVE program is
    // never removed before the staged one becomes visible.
    await page.waitForFunction(() => window.__viz.cue === null && window.__viz.patternId === 'bars');
    // The retired LIVE runtime is disposed on the frame after the promoted
    // canvas becomes visible, so allow that deliberately safe teardown frame.
    await page.waitForFunction(() => window.__viz.runtimeCounts.total <= 1);
  });

  test('serializes burst cue edits and batches Post-FX reset values', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    await enterCue(control);
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'bars');

    // Native range input events can arrive much faster than cross-window
    // acknowledgements. The last value must win instead of being rejected stale.
    await control.locator('#params-list input[data-key="gain"]').evaluate((input) => {
      for (const value of ['1.4', '1.8', '2.4']) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await page.waitForFunction(() => window.__viz.cueParams?.bars?.gain === 2.4);

    await setRange(control, '#post-fx-list input[data-key="brightness"]', 30);
    await setRange(control, '#post-fx-list input[data-key="contrast"]', -20);
    await setRange(control, '#post-fx-list input[data-key="saturation"]', 40);
    await control.locator('#post-fx-reset-btn').click();
    await page.waitForFunction(() => {
      const post = window.__viz.cueParams?.__postfx;
      return post?.brightness === 0 && post?.contrast === 0 && post?.saturation === 0;
    });
    expect(await page.evaluate(() => window.__viz.cue?.phase)).not.toBe('error');
  });

  test('rejects stale cue revisions without mutating the staged bank', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    await enterCue(control);
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'bars');
    await page.waitForFunction(() => Boolean(window.__viz.cueParams?.bars));
    const cue = await page.evaluate(() => window.__viz.cue);
    const original = await page.evaluate(() => window.__viz.cueParams.bars.gain);

    await control.evaluate(({ sessionId, revision }) => {
      const channel = new BroadcastChannel('viz2_channel');
      channel.postMessage({
        type: 'cue-params',
        sessionId,
        baseRevision: revision - 1,
        id: 'bars',
        values: { gain: 3 },
        windowId: 'stale-test',
      });
      channel.close();
    }, cue);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__viz.cueParams.bars.gain)).toBe(original);
  });

  test('rejects stale unscoped LIVE visual params during CUE while keeping Band Split global', async ({ context, page }) => {
    const controlA = await openScreenAndControl(context, page);
    const controlB = await context.newPage();
    await controlB.goto(CONTROL_URL);

    // Establish a non-default LIVE program, visual parameter, and filter so a
    // leak is observable both in the renderer and persisted canonical bank.
    await controlA.locator('#pattern-pad [data-index="2"]').click();
    await page.waitForFunction(() => window.__viz.patternId === 'bars');
    await setRange(controlA, '#params-list input[data-key="gain"]', 1.4);
    await setRange(controlA, '#post-fx-list input[data-key="brightness"]', 12);
    await page.waitForFunction(() => window.__viz.params.gain === 1.4
      && window.__viz.postfx.brightness === 12);
    const baselineStorage = await controlA.evaluate(() => localStorage.getItem('viz2_params'));

    await cueWithShift(controlA, '1'); // CUE Circles; Bars remains LIVE.
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'circles');

    // Mimic a delayed legacy sender that did not know CUE was already accepted.
    // It bypasses requestParamChange on purpose and must never mutate LIVE.
    await controlB.evaluate(() => {
      const channel = new BroadcastChannel('viz2_channel');
      channel.postMessage({ type: 'params', id: 'bars', values: { gain: 3 }, windowId: 'unaware-control' });
      channel.postMessage({ type: 'params', id: '__postfx', values: { brightness: 80 }, windowId: 'unaware-control' });
      channel.close();
    });
    await page.waitForFunction(() => window.__viz.cue
      && window.__viz.params.gain === 1.4
      && window.__viz.postfx.brightness === 12);

    expect(await page.evaluate(() => document.querySelector('.program-layer-live').style.filter)).toContain('brightness(1.12)');
    for (const control of [controlA, controlB]) {
      expect(await control.evaluate(() => window.__viz.params.gain)).toBe(1.4);
      expect(await control.evaluate(() => window.__viz.postfx.brightness)).toBe(12);
      expect(await control.evaluate(() => localStorage.getItem('viz2_params'))).toBe(baselineStorage);
    }

    // Band split is system-scoped, so the same legacy delivery remains valid
    // during CUE and is echoed from the screen as an accepted LIVE update.
    await controlB.evaluate(() => {
      const channel = new BroadcastChannel('viz2_channel');
      channel.postMessage({ type: 'params', id: '__bands', values: { low: 240 }, windowId: 'unaware-control' });
      channel.close();
    });
    await page.waitForFunction(() => window.__viz.bands.low === 240);
    await expect.poll(() => controlA.evaluate(() => window.__viz.bands.low)).toBe(240);
    await expect.poll(() => controlB.evaluate(() => window.__viz.bands.low)).toBe(240);

    await controlA.keyboard.press('Escape');
    await page.waitForFunction(() => window.__viz.cue === null);
  });

  test('commits the cue bank into every control before returning to LIVE', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    await enterCue(control);
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'bars');
    await setRange(control, '#params-list input[data-key="gain"]', 2.5);
    await page.waitForFunction(() => window.__viz.cueParams?.bars?.gain === 2.5);

    const second = await context.newPage();
    await second.goto(CONTROL_URL);
    await page.waitForFunction(() => window.__viz.cue?.phase === 'ready');
    await goLive(control);
    await page.waitForFunction(() => window.__viz.cue === null && window.__viz.patternId === 'bars');
    await expect(second.locator('#params-list input[data-key="gain"]')).toHaveValue('2.5');

    // A later live edit from the second panel must mutate the adopted program
    // bank rather than an old stale object.
    await setRange(second, '#params-list input[data-key="gain"]', 1.5);
    await page.waitForFunction(() => window.__viz.params.gain === 1.5);
  });

  test('supersedes a warming selection with SAME AS LIVE before TAKE', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    await enterCue(control);
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'bars');

    // Returning to the live ID invalidates Bars immediately. TAKE must end the
    // transaction rather than promoting its stale asynchronous callback.
    await control.keyboard.press('1');
    await page.waitForFunction(() =>
      window.__viz.cue?.phase === 'same'
      && window.__viz.cue?.selection?.ids?.[0] === 'circles'
    );
    await goLive(control);
    await page.waitForFunction(() => window.__viz.cue === null && window.__viz.patternId === 'circles');
    await page.waitForFunction(() => window.__viz.runtimeCounts.total <= 1);
  });

  test('late-open controls receive the active cue state', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    await enterCue(control);
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'bars');

    const second = await context.newPage();
    await second.goto(CONTROL_URL);
    await expect(second.locator('#preview-title')).toHaveText('CUE PREVIEW');
    await expect(second.locator('#cue-preview-controls')).toBeVisible();
    await expect(second.locator('#cue-preview-phase')).toContainText('CUE');
    await expect(second.locator('#pattern-pad [data-index="0"]')).toHaveClass(/live-active/);
    await expect(second.locator('#pattern-pad [data-index="2"]')).toHaveClass(/cue-active/);

    await control.keyboard.press('Escape');
  });

  test('reports WARMING after a cue edit until that revision completes a fresh output frame', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    await enterCue(control);
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.cue?.phase === 'ready');
    const readyRevision = await page.evaluate(() => window.__viz.cue.revision);

    await holdScreenAnimationFrames(page);
    try {
      await setRange(control, '#params-list input[data-key="gain"]', 2.2);
      await page.waitForFunction((previousRevision) => {
        const cue = window.__viz.cue;
        return cue
          && cue.revision > previousRevision
          && cue.phase === 'warming'
          && cue.renderedRevision !== cue.revision;
      }, readyRevision);
    } finally {
      await releaseScreenAnimationFrames(page);
    }

    await page.waitForFunction(() => {
      const cue = window.__viz.cue;
      return cue?.phase === 'ready' && cue.renderedRevision === cue.revision;
    });
    await control.keyboard.press('Escape');
  });

  test('locks edits immediately for queued TAKE and preserves the final queued change', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    await enterCue(control);
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.cue?.phase === 'ready');

    // Keep the input and Enter edge in one control-window task. The range
    // mutation is still queued locally when GO LIVE is requested, so this
    // asserts the immediate local transaction lock rather than a later reply.
    await holdScreenAnimationFrames(page);
    try {
      await control.locator('#params-list input[data-key="gain"]').evaluate((input) => {
        input.value = '2.7';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
        }));
      });

      await expect(control.locator('#cue-primary')).toBeDisabled();
      await expect(control.locator('#params-list input[data-key="gain"]')).toBeDisabled();
      await expect(control.locator('#cue-cancel')).toBeEnabled();
    } finally {
      await releaseScreenAnimationFrames(page);
    }

    await page.waitForFunction(() => window.__viz.cue === null
      && window.__viz.patternId === 'bars'
      && window.__viz.params.gain === 2.7);
  });

  test('CANCEL remains available while a revision-bound TAKE is pending', async ({ context, page }) => {
    const control = await openScreenAndControl(context, page);
    await enterCue(control);
    await control.keyboard.press('3');
    await page.waitForFunction(() => window.__viz.cue?.phase === 'ready');

    await holdScreenAnimationFrames(page);
    try {
      await setRange(control, '#params-list input[data-key="gain"]', 2.3);
      await page.waitForFunction(() => window.__viz.cue?.phase === 'warming');
      await goLive(control);
      await page.waitForFunction(() => window.__viz.cue?.phase === 'take-pending');
      await expect(control.locator('#cue-cancel')).toBeEnabled();
      await control.keyboard.press('Escape');
      await page.waitForFunction(() => window.__viz.cue === null);
    } finally {
      await releaseScreenAnimationFrames(page);
    }

    expect(await page.evaluate(() => window.__viz.patternId)).toBe('circles');
  });
});
