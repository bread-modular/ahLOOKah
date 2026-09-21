import { test, expect } from '@playwright/test';

// Controlled-audio end-to-end (plan section 11.5): the REAL capture pipeline
// (getUserMedia stream -> splitter -> analysers -> raw frames -> channel routing
// -> per-route features -> engine packets -> store) runs against synthetic
// oscillator devices created in the pool's own AudioContext. Nothing reaches the
// speakers and the editor never captures; only the physical input is replaced.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.editorCaptureCalls = 0;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.gumCalls = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const id = constraints?.audio?.deviceId?.exact || null;
      window.gumCalls.push(id);
      if (window.__deviceStreams && id && window.__deviceStreams[id]) return window.__deviceStreams[id];
      return real(constraints);
    };
  });
});

test('pinned devices feed separate nodes through real analysers with channel isolation', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/?role=nodes');
  await page.locator('body').click(); // sticky user activation: the shared context may run
  const result = await page.evaluate(async () => {
    const { AudioInputPool } = await import('/src/audio-input-pool.js');
    const { AudioManager } = await import('/src/audio-manager.js');
    const { PatternAudioControlEngine } = await import('/src/pattern-audio-engine.js');
    const { PatternAudioControlStore } = await import('/src/pattern-audio-controls.js');
    const { createSignalConsumers } = await import('/src/nodes/audio-provider.js');
    const { response } = await import('/src/sketches/feature-controls.js');
    const { NODE_AUDIO_SOURCE } = await import('/src/nodes/audio-source.js');
    const { PATTERN_AUDIO_PLAN_TYPE } = await import('/src/pattern-audio-protocol.js');

    const ctx = new AudioContext();
    await ctx.resume();
    if (ctx.state !== 'running') return { skipped: `AudioContext stayed ${ctx.state}; headless browser refused to run Web Audio` };

    // dev-A: identical tone on both channels (mono-like stereo).
    // dev-B: bass only on L, treble only on R — the channel isolation probe.
    const makeDevice = (leftHz, rightHz) => {
      const dest = ctx.createMediaStreamDestination();
      const merger = ctx.createChannelMerger(2);
      for (const [hz, channel] of [[leftHz, 0], [rightHz, 1]]) {
        const osc = ctx.createOscillator();
        osc.frequency.value = hz;
        const gain = ctx.createGain();
        gain.gain.value = .4;
        osc.connect(gain); gain.connect(merger, 0, channel);
        osc.start();
      }
      merger.connect(dest);
      return dest.stream; // never connected to ctx.destination
    };
    window.__deviceStreams = { 'dev-A': makeDevice(70, 70), 'dev-B': makeDevice(60, 7500) };

    const pool = new AudioInputPool({
      createManager: (deviceId) => new AudioManager({ allowFallback: false, feedNoise: false, contextProvider: () => ctx }),
    });
    const engine = new PatternAudioControlEngine({
      ownerId: 'e2e-owner',
      getSketchById: () => null,
      resolveRouteInput: (route) => pool.resolveRouteInput(route),
    });
    const store = new PatternAudioControlStore({ consumerSessionId: 'e2e-consumer' });
    const nodes = [
      { id: 'n-a', type: 'audio', band: 'bass', deviceId: 'dev-A', channel: 'mono' },
      { id: 'n-br', type: 'audio', band: 'high', deviceId: 'dev-B', channel: 'right' },
      { id: 'n-bl', type: 'audio', band: 'bass', deviceId: 'dev-B', channel: 'left' },
      { id: 'n-blh', type: 'audio', band: 'high', deviceId: 'dev-B', channel: 'left' },
    ];
    const consumer = createSignalConsumers(store, 'live', nodes);
    const slots = consumer.getAudioSlotDescriptors();
    store.setPlan({ consumerSessionId: 'e2e-consumer', planRevision: 1, version: 2, slots });
    const receive = engine.receivePlan({
      type: PATTERN_AUDIO_PLAN_TYPE, version: 2, consumerSessionId: 'e2e-consumer',
      planRevision: 1, sentAt: performance.now(), complete: true, slots,
    });
    pool.reconcileDemands(engine.getRouteDemands());
    // Two acquisitions for three routes over two devices; one shared context.
    await new Promise(r => setTimeout(r, 300));
    const acquisitions = window.gumCalls.length;
    let sequence = 0;
    const tick = () => {
      pool.sample();
      const { packets } = engine.update({
        frame: pool.resolveRouteInput({ deviceId: null, channel: 'mono' }).frame,
        deltaSeconds: 1 / 30, captureTime: performance.now(), sequence: ++sequence,
      });
      for (const packet of packets) store.acceptPacket(packet);
    };
    const warm = 90; // ~3s at 30Hz: envelopes ramp, AGC settles
    for (let i = 0; i < warm; i++) { tick(); await new Promise(r => setTimeout(r, 33)); }
    const scalars = {
      devAmonoBass: response(consumer.read('n-a').bass),
      devBrightHigh: response(consumer.read('n-br').high),
      devBleftBass: response(consumer.read('n-bl').bass),
      devBleftHigh: response(consumer.read('n-blh').high),
    };
    const sources = Object.fromEntries(slots.map((d, i) => [d.runtimeId, consumer.getNodeStatus(nodes[i].id).source]));
    // Teardown: dropping all demand releases the extra captures after the grace
    // period (heartbeats/ticks keep reconciling, which drives the expiry).
    consumer.dispose(); engine.forgetConsumer('e2e-consumer'); store.retireSlots(slots.map(s => s.runtimeId));
    pool.reconcileDemands([]);
    await new Promise(r => setTimeout(r, 400));
    pool.reconcileDemands([]);
    const stoppedAfter = [...pool.sources.values()].map(e => e.manager.stoppedCount);
    const contexts = [ctx].filter(c => c.state !== 'closed').length;
    await ctx.close();
    return {
      skipped: null, ctxState: 'running', acquisitions, scalars, sources,
      stoppedAfter, contexts,
      poolSnapshot: pool.getSnapshot(),
    };
  });
  if (result.skipped) {
    test.info().annotations.push({ type: 'skip-reason', description: result.skipped });
    return test.skip(true, result.skipped);
  }
  expect(result.ctxState).toBe('running');
  // Two physical devices admitted, three routes served, one acquisition each.
  expect(result.acquisitions).toBe(2);
  // dev-A mono bass follows the shared 70 Hz tone.
  expect(result.scalars.devAmonoBass).toBeGreaterThan(.15);
  // dev-B Right isolates the 7.5 kHz channel; dev-B Left isolates the 60 Hz one.
  expect(result.scalars.devBrightHigh).toBeGreaterThan(.15);
  expect(result.scalars.devBleftBass).toBeGreaterThan(.15);
  // Channel isolation: the left route never hears the right channel's treble.
  expect(result.scalars.devBleftHigh).toBeLessThan(result.scalars.devBrightHigh / 4);
  // Per-route source metadata is healthy and owner-scoped.
  for (const source of Object.values(result.sources)) {
    expect(source.status).toBe('running');
    expect(source.id).toContain('extra:');
  }
  // Dropping the demand released every extra capture after the grace period.
  expect(result.stoppedAfter.every(count => count > 0)).toBe(true);
  expect(result.poolSnapshot.sources).toEqual([]);
});
