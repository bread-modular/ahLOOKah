import { expect, test } from '@playwright/test';

const SCREEN_URL = '/?role=screen';
const CONTROL_URL = '/?role=control';

test.describe('pattern-specific audio controls', () => {
  test('validates, orders, interpolates, resets streams, and consumes events once', async ({ page }) => {
    await page.goto(SCREEN_URL);
    const result = await page.evaluate(async () => {
      const { PatternAudioControlStore } = await import('/src/pattern-audio-controls.js');
      const { AUDIO_CONTROL_SCHEMA } = await import('/src/sketches/waveform_tunnel.js');
      let now = 0;
      const store = new PatternAudioControlStore({
        consumerSessionId: 'consumer-a',
        now: () => now,
        interpolationDelayMs: 33,
      });
      const descriptor = {
        runtimeId: 'consumer-a:1:0',
        patternId: 'waveform-tunnel',
        role: 'live',
        childIndex: 0,
        paramsRevision: 1,
        params: { rings: 46, twist: 1, scale: 1, sub: 1 },
        audioTransport: 'pattern-controls',
        audioControlSchema: AUDIO_CONTROL_SCHEMA,
      };
      store.setPlan({ consumerSessionId: 'consumer-a', planRevision: 1, complete: true, slots: [descriptor] });
      const packet = (sequence, generation, hue, event = false) => ({
        type: 'pattern-audio-controls',
        version: 1,
        consumerSessionId: 'consumer-a',
        planRevision: 1,
        audioOwnerId: 'owner-a',
        streamGeneration: generation,
        sequence,
        captureTime: now,
        slots: [{
          runtimeId: descriptor.runtimeId,
          paramsRevision: 1,
          continuous: { hueOffset: hue, twist: 0, tunnelScale: 1, shimmerAmount: 0 },
          arrays: { ringRadii: new Float32Array(46).fill(300 + hue) },
          events: event ? [{ id: 'spark-1', type: 'shimmer' }] : [],
        }],
      });

      // The tunnel schema has no shimmer event, so a malformed event is safely
      // dropped while the rest of the packet remains non-fatal.
      const malformedEvent = store.acceptPacket(packet(1, 'stream-a', 0, true));
      now = 33;
      const acceptedFirst = store.acceptPacket(packet(2, 'stream-a', 0));
      now = 66;
      const acceptedSecond = store.acceptPacket(packet(3, 'stream-a', 100));
      now = 82;
      const interpolated = store.read(descriptor.runtimeId);
      const marked = store.noteDraw(descriptor.runtimeId);
      const rendered = store.hasRenderedAfter(descriptor.runtimeId, 1, 0);
      const duplicate = store.acceptPacket(packet(3, 'stream-a', 100));
      const beforeReset = store.getDiagnostics().streamResets;
      const reset = store.acceptPacket(packet(1, 'stream-b', 25));
      const afterReset = store.getDiagnostics().streamResets;
      const fresh = store.read(descriptor.runtimeId);

      return {
        malformedEvent,
        acceptedFirst,
        acceptedSecond,
        interpolatedHue: interpolated.continuous.hueOffset,
        interpolatedRadius: interpolated.arrays.ringRadii[0],
        marked,
        rendered,
        duplicate,
        reset,
        streamReset: afterReset > beforeReset,
        freshHue: fresh.continuous.hueOffset,
        diagnostics: store.getDiagnostics(),
      };
    });

    expect(result.malformedEvent).toMatchObject({ accepted: true, slots: 0 });
    expect(result.acceptedFirst).toMatchObject({ accepted: true, slots: 1 });
    expect(result.acceptedSecond).toMatchObject({ accepted: true, slots: 1 });
    expect(result.interpolatedHue).toBeGreaterThan(40);
    expect(result.interpolatedHue).toBeLessThan(60);
    expect(result.interpolatedRadius).toBeGreaterThan(340);
    expect(result.interpolatedRadius).toBeLessThan(360);
    expect(result.marked).toBe(true);
    expect(result.rendered).toBe(true);
    expect(result.duplicate).toMatchObject({ accepted: false, reason: 'sequence' });
    expect(result.reset).toMatchObject({ accepted: true, slots: 1 });
    expect(result.streamReset).toBe(true);
    expect(result.freshHue).toBe(25);
    expect(result.diagnostics.droppedSchema).toBeGreaterThan(0);
  });

  test('rebases a coalesced pilot fresh-frame gate to the latest controls revision', async ({ page }) => {
    await page.goto(SCREEN_URL);
    const result = await page.evaluate(async () => {
      const { ProgramRuntime } = await import('/src/program-runtime.js');
      const { PatternAudioControlStore } = await import('/src/pattern-audio-controls.js');
      const { SKETCHES } = await import('/src/sketch-registry.js');
      const checkerboard = SKETCHES.find((sketch) => sketch.id === 'checkerboard');
      const originalRequest = window.requestAnimationFrame;
      const originalCancel = window.cancelAnimationFrame;
      const callbacks = new Map();
      let nextRafId = 1;
      let now = 0;
      let runtime;
      const instances = [];
      const observed = [];
      window.requestAnimationFrame = (callback) => {
        const id = nextRafId++;
        callbacks.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) => callbacks.delete(id);
      const flushRaf = () => {
        const batch = [...callbacks.values()];
        callbacks.clear();
        batch.forEach((callback) => callback(now));
      };

      class FakeP5 {
        constructor(sketch, parent) {
          this._removed = false;
          this.canvas = document.createElement('canvas');
          parent.appendChild(this.canvas);
          const p = {};
          sketch(p);
          this.p = p;
          instances.push(this);
        }
        setup() { this.p.setup?.(); }
        draw() { this.p.draw?.(); }
        loop() {}
        noLoop() {}
        remove() { this._removed = true; this.canvas.remove(); }
      }

      const params = Object.fromEntries(checkerboard.params.map((definition) => [definition.key, definition.default]));
      const store = new PatternAudioControlStore({
        consumerSessionId: 'consumer-a',
        now: () => now,
        interpolationDelayMs: 0,
      });
      const sketch = {
        ...checkerboard,
        // Keep the real pilot transport schema while making p5 rendering fully
        // deterministic: the fake renderer only reads its controls binding.
        factory: (_audio, _device, _params, context) => (p) => {
          p.setup = () => {};
          p.draw = () => {
            const controls = context.audioControls.read();
            observed.push({
              revision: controls.paramsRevision,
              hue: controls.continuous.uHueA,
            });
          };
        },
      };
      const packet = (descriptor, sequence, hue) => ({
        type: 'pattern-audio-controls',
        version: 1,
        consumerSessionId: 'consumer-a',
        planRevision: 1,
        audioOwnerId: 'owner-a',
        streamGeneration: 'stream-a',
        sequence,
        captureTime: now,
        slots: [{
          runtimeId: descriptor.runtimeId,
          paramsRevision: descriptor.paramsRevision,
          continuous: {
            uHueA: hue,
            uHueB: params.hueB,
            uCell: params.cell,
            uPhase: 0,
          },
          arrays: {},
          events: [],
        }],
      });

      try {
        const layer = document.createElement('div');
        document.body.appendChild(layer);
        runtime = new ProgramRuntime({
          p5Constructor: FakeP5,
          selection: { ids: ['checkerboard'], merge: false },
          sketches: [sketch],
          audio: null,
          videoDeviceId: null,
          getParams: () => params,
          layer,
          generation: 1,
          consumerSessionId: 'consumer-a',
          audioControlStore: store,
          warmTimeoutMs: 1_000,
        });
        const ready = runtime.prepare();
        const instance = instances[0];
        instance.setup();
        instance.draw();
        flushRaf();
        flushRaf();
        await ready;

        let descriptor = runtime.getAudioSlotDescriptors()[0];
        store.setPlan({ consumerSessionId: 'consumer-a', planRevision: 1, complete: true, slots: [descriptor] });
        now = 10;
        store.acceptPacket(packet(descriptor, 1, params.hueA));
        instance.draw();

        const first = runtime.requestFreshFrame(1_000, { parkAfter: true });
        // This is a rapid CUE edit before p5 has made the first request's draw.
        params.hueA = 0.91;
        const second = runtime.requestFreshFrame(1_000, { parkAfter: false });
        descriptor = runtime.getAudioSlotDescriptors()[0];
        const oldRevisionPacket = store.acceptPacket(packet({
          ...descriptor,
          paramsRevision: descriptor.paramsRevision - 1,
        }, 2, 0.58));
        instance.draw();
        const pendingAfterStaleControls = runtime.hasPendingFreshFrame;
        let secondSettled = false;
        second.then(() => { secondSettled = true; });
        await Promise.resolve();
        const settledBeforeMatchingControls = secondSettled;

        now = 20;
        const latestPacket = store.acceptPacket(packet(descriptor, 3, params.hueA));
        instance.draw();
        flushRaf();
        flushRaf();
        await Promise.all([first, second]);

        return {
          revision: descriptor.paramsRevision,
          oldRevisionPacket,
          pendingAfterStaleControls,
          latestPacket,
          settledBeforeMatchingControls,
          observed,
        };
      } finally {
        runtime?.dispose();
        window.requestAnimationFrame = originalRequest;
        window.cancelAnimationFrame = originalCancel;
      }
    });

    expect(result.revision).toBe(2);
    expect(result.oldRevisionPacket).toMatchObject({ accepted: true, slots: 0 });
    expect(result.pendingAfterStaleControls).toBe(true);
    expect(result.latestPacket).toMatchObject({ accepted: true, slots: 1 });
    expect(result.settledBeforeMatchingControls).toBe(false);
    expect(result.observed.at(-1)).toEqual({ revision: 2, hue: 0.91 });
  });

  test('does not bank Circles events while a CUE slot is parked', async ({ page }) => {
    await page.goto(SCREEN_URL);
    const result = await page.evaluate(async () => {
      const { PatternAudioControlStore } = await import('/src/pattern-audio-controls.js');
      const { AUDIO_CONTROL_SCHEMA } = await import('/src/sketches/circles.js');
      let now = 0;
      const descriptor = {
        runtimeId: 'consumer-a:cue:0',
        patternId: 'circles',
        role: 'cue',
        childIndex: 0,
        paramsRevision: 1,
        audioTransport: 'pattern-controls',
        audioControlSchema: AUDIO_CONTROL_SCHEMA,
      };
      const store = new PatternAudioControlStore({
        consumerSessionId: 'consumer-a',
        now: () => now,
        staleAfterMs: 1_000,
        eventMaxAgeMs: 250,
      });
      store.setPlan({ consumerSessionId: 'consumer-a', planRevision: 1, complete: true, slots: [descriptor] });
      const binding = store.createBinding(descriptor.runtimeId);
      const packet = (sequence, id) => ({
        type: 'pattern-audio-controls',
        version: 1,
        consumerSessionId: 'consumer-a',
        planRevision: 1,
        audioOwnerId: 'owner-a',
        streamGeneration: 'stream-a',
        sequence,
        captureTime: now,
        slots: [{
          runtimeId: descriptor.runtimeId,
          paramsRevision: 1,
          continuous: {
            pump: 1,
            midBrightness: 0,
            strokeWeight: 1,
            movementMultiplier: 1,
            glitchAmount: 0,
            noiseIntensity: 0,
            scanlineAlpha: 0,
          },
          arrays: {},
          events: [{ id, type: 'hat-spawn', count: 1 }],
        }],
      });

      binding.setEventDeliveryEnabled(false);
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        now += 20;
        store.acceptPacket(packet(sequence, `parked-${sequence}`));
      }
      const whileParked = {
        controlsRemainFresh: binding.read().isFresh,
        events: binding.consumeEvents(),
        state: binding.getState(),
      };

      now += 20;
      binding.setEventDeliveryEnabled(true);
      store.acceptPacket(packet(6, 'post-take'));
      const firstLiveDraw = binding.consumeEvents();
      const secondLiveDraw = binding.consumeEvents();
      return {
        whileParked,
        firstLiveDraw,
        secondLiveDraw,
        diagnostics: store.getDiagnostics(),
      };
    });

    expect(result.whileParked.controlsRemainFresh).toBe(true);
    expect(result.whileParked.events).toEqual([]);
    expect(result.whileParked.state.queuedEvents).toBe(0);
    expect(result.whileParked.state.eventDeliveryEnabled).toBe(false);
    expect(result.firstLiveDraw).toEqual([{ id: 'post-take', type: 'hat-spawn', count: 1, sequence: 6 }]);
    expect(result.secondLiveDraw).toEqual([]);
    expect(result.diagnostics.droppedSuppressedEvents).toBe(5);
  });

  test('shares lazy byte conversions and emits bounded controls per independent runtime', async ({ page }) => {
    await page.goto(SCREEN_URL);
    const result = await page.evaluate(async () => {
      const { PatternAudioControlEngine } = await import('/src/pattern-audio-engine.js');
      const { SKETCHES } = await import('/src/sketch-registry.js');
      let now = 0;
      const byId = (id) => SKETCHES.find((sketch) => sketch.id === id);
      const slot = (id, runtimeId, childIndex) => {
        const sketch = byId(id);
        return {
          runtimeId,
          patternId: id,
          role: 'live',
          childIndex,
          paramsRevision: 1,
          params: Object.fromEntries(sketch.params.map((definition) => [definition.key, definition.default])),
          audioTransport: 'pattern-controls',
        };
      };
      const engine = new PatternAudioControlEngine({
        ownerId: 'owner-a',
        getSketchById: byId,
        now: () => now,
      });
      engine.expectConsumer('consumer-a');
      const slowChecker = slot('checkerboard', 'consumer-a:2:0', 2);
      const fastChecker = slot('checkerboard', 'consumer-a:3:0', 3);
      fastChecker.params.speed = 2;
      const slots = [
        slot('circles', 'consumer-a:1:0', 0),
        slot('waveform-tunnel', 'consumer-a:1:1', 1),
        slowChecker,
        fastChecker,
      ];
      const acceptedPlan = engine.receivePlan({
        type: 'pattern-audio-plan',
        version: 1,
        consumerSessionId: 'consumer-a',
        planRevision: 1,
        sentAt: now,
        complete: true,
        slots,
      });
      const frame = {
        left: new Float32Array(1024).fill(-50),
        right: new Float32Array(1024).fill(-48),
        waveformLeft: new Float32Array(2048).fill(0.15),
        waveformRight: new Float32Array(2048).fill(-0.15),
        sampleRate: 48000,
        fftSize: 2048,
      };
      now = 34;
      const tick = engine.update({ frame, deltaSeconds: 1 / 30, captureTime: 1, sequence: 1, now });
      const packet = tick.packets[0];
      const tunnel = packet.slots.find((entry) => entry.runtimeId === 'consumer-a:1:1');
      const checkerA = packet.slots.find((entry) => entry.runtimeId === 'consumer-a:2:0');
      const checkerB = packet.slots.find((entry) => entry.runtimeId === 'consumer-a:3:0');
      const diagnostics = engine.getDiagnostics();
      const bars = byId('bars');
      const acceptedBarsPlan = engine.receivePlan({
        type: 'pattern-audio-plan',
        version: 1,
        consumerSessionId: 'consumer-a',
        planRevision: 2,
        sentAt: now,
        complete: true,
        slots: [{
          runtimeId: 'consumer-a:bars:0',
          patternId: bars.id,
          role: 'live',
          childIndex: 0,
          paramsRevision: 1,
          params: Object.fromEntries(bars.params.map((definition) => [definition.key, definition.default])),
          audioTransport: 'pattern-controls',
        }],
      });
      const rejectedOtherTransport = engine.receivePlan({
        type: 'pattern-audio-plan',
        version: 1,
        consumerSessionId: 'consumer-a',
        planRevision: 3,
        sentAt: now,
        complete: true,
        slots: [{
          runtimeId: 'consumer-a:invalid:0',
          patternId: bars.id,
          role: 'live',
          childIndex: 0,
          paramsRevision: 1,
          params: Object.fromEntries(bars.params.map((definition) => [definition.key, definition.default])),
          audioTransport: ['analysis', 'frame'].join('-'),
        }],
      });
      return {
        acceptedPlan,
        acceptedBarsPlan,
        rejectedOtherTransport,
        engineExposesRawPath: ['rawRequired', 'recordRawFrame'].some((key) => typeof engine[key] === 'function'),
        slotCount: packet.slots.length,
        ringCount: tunnel.arrays.ringRadii.length,
        finiteRings: [...tunnel.arrays.ringRadii].every(Number.isFinite),
        checkerPhases: [checkerA.continuous.uPhase, checkerB.continuous.uPhase],
        byteFrequencyBuilds: tick.shared.diagnostics.byteFrequencyBuilds,
        byteWaveformBuilds: tick.shared.diagnostics.byteWaveformBuilds,
        controllerCount: diagnostics.activeControllers.length,
      };
    });

    expect(result.acceptedPlan).toMatchObject({ accepted: true });
    expect(result.acceptedBarsPlan).toMatchObject({ accepted: true });
    expect(result.rejectedOtherTransport).toMatchObject({ accepted: false, reason: 'malformed' });
    expect(result.engineExposesRawPath).toBe(false);
    expect(result.slotCount).toBe(4);
    expect(result.ringCount).toBe(46);
    expect(result.finiteRings).toBe(true);
    expect(result.checkerPhases[0]).not.toBe(result.checkerPhases[1]);
    expect(result.byteFrequencyBuilds).toBe(1);
    expect(result.byteWaveformBuilds).toBe(1);
    expect(result.controllerCount).toBe(4);
  });

  test('runs every pilot in the embedded preview through its own controls slot', async ({ page }) => {
    await page.goto(CONTROL_URL);
    await page.waitForFunction(() => window.__viz.audioOwner);
    await page.evaluate(() => {
      const frame = {
        left: new Float32Array(1024).fill(-48),
        right: new Float32Array(1024).fill(-47),
        waveformLeft: new Float32Array(2048).fill(0.1),
        waveformRight: new Float32Array(2048).fill(-0.1),
        sampleRate: 48000,
        fftSize: 2048,
        time: 1,
      };
      window.__viz.captureAudio.isStarted = true;
      window.__viz.captureAudio.getAnalysisFrame = () => frame;
    });

    for (const patternId of ['checkerboard', 'circles', 'waveform-tunnel']) {
      await page.locator(`#pattern-library [data-id="${patternId}"]`).click();
      await expect(page.locator(`#preview-stage canvas[data-preview-sketch="${patternId}"]`)).toBeVisible();
      await page.waitForFunction((id) => {
        const slots = window.__viz.patternAudio?.store?.slots || {};
        return Object.values(slots).some((slot) => slot.patternId === id && slot.fresh);
      }, patternId);
    }
    const diagnostics = await page.evaluate(() => window.__viz.patternAudio?.engine);
    expect(diagnostics.controllerErrors).toBe(0);
    expect(diagnostics).not.toHaveProperty('rawFramesSent');
    expect(diagnostics).not.toHaveProperty('rawFramesSkipped');
    expect(diagnostics).not.toHaveProperty('rawBytes');
  });

  test('gates a pilot CUE on a matching controls packet and consumed draw', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await control.waitForFunction(() => window.__viz.audioOwner);
    await control.evaluate(() => {
      const frame = {
        left: new Float32Array(1024).fill(-45),
        right: new Float32Array(1024).fill(-45),
        waveformLeft: new Float32Array(2048).fill(0.12),
        waveformRight: new Float32Array(2048).fill(-0.12),
        sampleRate: 48000,
        fftSize: 2048,
        time: 1,
      };
      window.__viz.captureAudio.isStarted = true;
      window.__viz.captureAudio.getAnalysisFrame = () => frame;
    });

    await control.locator('#pattern-library [data-id="checkerboard"]').click({ modifiers: ['Shift'] });
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'checkerboard');
    await page.waitForFunction(() => window.__viz.cue?.phase === 'ready');
    const state = await page.evaluate(() => {
      const slots = Object.values(window.__viz.patternAudio?.store?.slots || {});
      return {
        cue: window.__viz.cue,
        checker: slots.find((slot) => slot.patternId === 'checkerboard'),
      };
    });

    expect(state.cue.renderedRevision).toBe(state.cue.revision);
    expect(state.checker.fresh).toBe(true);
    expect(state.checker.renderMarker).toBeGreaterThan(0);
  });

  test('takes a rapidly edited pilot CUE only after its newest controls revision draws', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await control.waitForFunction(() => window.__viz.audioOwner);
    await control.evaluate(() => {
      const frame = {
        left: new Float32Array(1024).fill(-45),
        right: new Float32Array(1024).fill(-45),
        waveformLeft: new Float32Array(2048).fill(0.12),
        waveformRight: new Float32Array(2048).fill(-0.12),
        sampleRate: 48000,
        fftSize: 2048,
        time: 1,
      };
      window.__viz.captureAudio.isStarted = true;
      window.__viz.captureAudio.getAnalysisFrame = () => frame;
    });

    await control.locator('#pattern-library [data-id="checkerboard"]').click({ modifiers: ['Shift'] });
    await page.waitForFunction(() => window.__viz.cue?.selection?.ids?.[0] === 'checkerboard');
    await page.waitForFunction(() => window.__viz.cue?.phase === 'ready');
    const initialRevision = await page.evaluate(() => window.__viz.cue.revision);

    await page.evaluate(() => {
      const originalRequest = window.requestAnimationFrame;
      const originalCancel = window.cancelAnimationFrame;
      const callbacks = new Map();
      let nextId = 1;
      window.__pilotCueRafHold = { originalRequest, originalCancel, callbacks };
      window.requestAnimationFrame = (callback) => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) => callbacks.delete(id);
    });

    try {
      const speed = control.locator('#params-list input[data-key="speed"]');
      await speed.evaluate((input) => {
        input.value = '0.9';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForFunction((revision) => window.__viz.cue?.revision > revision, initialRevision, { polling: 50 });
      const firstRevision = await page.evaluate(() => window.__viz.cue.revision);

      await speed.evaluate((input) => {
        input.value = '1.75';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForFunction((revision) => window.__viz.cue?.revision > revision, firstRevision, { polling: 50 });
      const latestRevision = await page.evaluate(() => window.__viz.cue.revision);
      await control.waitForFunction((revision) => window.__viz.cue?.revision >= revision, latestRevision);
      await control.keyboard.press('Enter');
      await page.waitForFunction(() => window.__viz.cue?.phase === 'take-pending', null, { polling: 50 });
    } finally {
      await page.evaluate(() => {
        const hold = window.__pilotCueRafHold;
        if (!hold) return;
        window.requestAnimationFrame = hold.originalRequest;
        window.cancelAnimationFrame = hold.originalCancel;
        const callbacks = [...hold.callbacks.values()];
        delete window.__pilotCueRafHold;
        callbacks.forEach((callback) => hold.originalRequest.call(window, callback));
      });
    }

    await page.waitForFunction(() => window.__viz.cue === null
      && window.__viz.patternId === 'checkerboard'
      && window.__viz.params.speed === 1.75);
    await page.waitForFunction(() => {
      const slots = Object.values(window.__viz.patternAudio?.store?.slots || {});
      const slot = slots.find((entry) => entry.patternId === 'checkerboard');
      return slot
        && slot.fresh
        && slot.renderMarker > 0
        && slot.renderedParamsRevision === slot.paramsRevision;
    });

    const state = await page.evaluate(() => {
      const slots = Object.values(window.__viz.patternAudio?.store?.slots || {});
      return {
        speed: window.__viz.params.speed,
        checker: slots.find((entry) => entry.patternId === 'checkerboard'),
      };
    });
    expect(state.speed).toBe(1.75);
    expect(state.checker.renderedParamsRevision).toBe(state.checker.paramsRevision);
  });

  test('routes a live pilot through controls without screen-side audio facade calls', async ({ context, page }) => {
    await page.goto(SCREEN_URL);
    const control = await context.newPage();
    await control.goto(CONTROL_URL);
    await control.waitForFunction(() => window.__viz.audioOwner);

    await control.evaluate(() => {
      const bins = 1024;
      const frame = {
        left: new Float32Array(bins).fill(-48),
        right: new Float32Array(bins).fill(-48),
        waveformLeft: new Float32Array(2048).fill(0.1),
        waveformRight: new Float32Array(2048).fill(-0.1),
        sampleRate: 48000,
        fftSize: 2048,
        time: 1,
      };
      window.__viz.captureAudio.isStarted = true;
      window.__viz.captureAudio.getAnalysisFrame = () => frame;
    });

    await control.locator('.pattern-btn[data-id="checkerboard"]').click();
    await page.waitForFunction(() => window.__viz.patternId === 'checkerboard');
    await page.waitForFunction(() => {
      const slots = window.__viz.patternAudio?.store?.slots || {};
      return Object.values(slots).some((slot) => slot.patternId === 'checkerboard' && slot.fresh);
    });

    await page.evaluate(() => {
      const provider = window.__viz.audio;
      window.__pilotFacadeCalls = {};
      for (const name of ['getAnalysisFrame', 'getFrequencies', 'getWaveforms', 'getAmplitudes']) {
        provider[name] = () => {
          window.__pilotFacadeCalls[name] = (window.__pilotFacadeCalls[name] || 0) + 1;
          return null;
        };
      }
    });
    await page.waitForTimeout(250);
    const verification = await Promise.all([
      page.evaluate(() => window.__pilotFacadeCalls),
      control.evaluate(() => window.__viz.patternAudio?.engine),
    ]);

    expect(Object.values(verification[0])).toEqual([]);
    expect(verification[1]).not.toHaveProperty('rawFramesSent');
    expect(verification[1]).not.toHaveProperty('rawFramesSkipped');
    expect(verification[1]).not.toHaveProperty('rawBytes');
    expect(verification[1].controllerErrors).toBe(0);
  });
});
