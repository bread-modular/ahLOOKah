import { test, expect } from '@playwright/test';
import { adaptPattern } from '../src/custom-scripts/adapter.js';
import { stageSources } from '../src/custom-scripts/compiler.js';
import { SharedAudioAnalysisView, PatternAudioControlEngine } from '../src/pattern-audio-engine.js';
import { PatternAudioControlStore, PatternAudioControlBinding } from '../src/pattern-audio-controls.js';
import { makeAudioFeatures, getBandSplit, setBandSplit } from '../src/sketches/audio-features.js';
import { createFeatureController, FEATURE_SCHEMA, SILENT_FEATURES, response, accent } from '../src/sketches/feature-controls.js';

const pattern = (extra = {}, report = (e) => { throw Error(e); }) => adaptPattern({
  file: 'test.viz.js', definition: { id: 'custom-test', name: 'Test', draw() {}, ...extra },
}, report);
const tone = (hz = 100, db = -40, rms = .1) => {
  const left = new Float32Array(1024).fill(-120);
  left[Math.round(hz * 2048 / 48000)] = db;
  return { left, right: left.slice(), waveformLeft: new Float32Array([0, .1, -.1]), sampleRate: 48000, fftSize: 2048, rms };
};
const tick = (frame, features = {}) => ({ frame, shared: new SharedAudioAnalysisView(frame, 1 / 60, () => features), deltaSeconds: 1 / 60 });

test.describe('Custom script built-in reactivity @core', () => {
  test('default is the actual feature pipeline: relaxation, range changes, split and shared extraction', () => {
    const script = pattern();
    expect(script.audioControlSchema).toBe(FEATURE_SCHEMA);
    const actual = script.createAudioController();
    const reference = createFeatureController();
    const analyze = makeAudioFeatures();
    const values = [];
    for (let i = 0; i < 240; i++) {
      const frame = tone(100, i < 180 ? -40 : -34);
      const shared = new SharedAudioAnalysisView(frame, 1 / 60, (f, dt) => analyze(f, {}, dt));
      const input = { frame, shared, deltaSeconds: 1 / 60 };
      const got = actual.update(input);
      expect(got).toEqual(reference.update(input));
      expect(shared.diagnostics.featureBuilds).toBe(1);
      values.push(got.continuous.bass);
    }
    expect(values[179]).toBeLessThan(values[0]);
    expect(values[180]).toBeGreaterThan(values[179] + .2);
    const split = getBandSplit();
    try {
      for (const [hz, key] of [[100, 'bass'], [1000, 'mid'], [8000, 'high']]) {
        const bands = pattern().createAudioController().update(tick(tone(hz))).continuous;
        expect(bands[key]).toBeGreaterThan(0);
        for (const other of ['bass', 'mid', 'high'].filter(k => k !== key)) expect(bands[other]).toBe(0);
      }
      setBandSplit({ low: 1200, high: 2800 });
      const moved = pattern().createAudioController().update(tick(tone(1000))).continuous;
      expect(moved.bass).toBeGreaterThan(0);
      expect(moved.mid).toBe(0);
    } finally { setBandSplit(split); actual.dispose(); reference.dispose(); }
  });

  test('gains are single, bounded and independent; helpers are exact normalizers', () => {
    const input = tick(tone(), { sub: .1, mid: .2, high: .3, kick: .8, snare: .6, hat: .4, beat: 1 });
    const run = params => pattern().createAudioController().update({ ...input, params }).continuous;
    const one = run({});
    const half = run({ bass: .5, mid: .5, high: .5 });
    for (const key of Object.keys(one)) expect(half[key]).toBeCloseTo(one[key] / 2, 12);
    const muted = run({ bass: 0 });
    for (const key of ['bass', 'kick', 'beat']) expect(muted[key]).toBe(0);
    for (const key of ['mid', 'high', 'snare', 'hat']) expect(muted[key]).toBe(one[key]);
    expect(run({ bass: 0, mid: 0, high: 0 })).toEqual(SILENT_FEATURES);
    expect(run({ bass: NaN, mid: Infinity })).toEqual(one);
    expect(run({ bass: 200 })).toEqual(run({ bass: 2 }));
    expect(response(1.6)).toBe(.5); expect(accent(.7)).toBe(.5);
    for (const helper of [response, accent]) {
      for (const x of [undefined, NaN, Infinity, -10]) expect(helper(x)).toBe(0);
      expect(helper(200)).toBe(1);
    }
  });

  test('independent slot state, reset after disconnect, silent release and idempotent retirement', () => {
    const a = pattern().createAudioController();
    const b = pattern().createAudioController();
    const live = tick(tone());
    const first = a.update(live);
    for (let i = 0; i < 180; i++) a.update(tick(tone()));
    expect(b.update(live)).toEqual(first);
    expect(a.update(live).continuous.bass).toBeLessThan(first.continuous.bass);
    expect(a.update({}).continuous).toEqual(SILENT_FEATURES);
    expect(a.update(live)).toEqual(first);
    for (let i = 0; i < 240; i++) a.update(tick(tone(100, -120, 0)));
    expect(a.update(tick(tone(100, -120, 0))).continuous).toEqual(SILENT_FEATURES);
    a.dispose(); a.dispose();
    expect(a.update(live).continuous).toEqual(SILENT_FEATURES);
    expect(pattern().createAudioController().update(live)).toEqual(first);
  });

  test('custom audio keeps raw access/schema/events/state; reactive is lazy and computed once', () => {
    const input = tick(tone(), { kick: .7 });
    const schema = { continuous: { bass: { min: 0, max: 100, neutral: 0 } }, arrays: { bins: { min: 0, max: 255, maxLength: 512 } }, events: { hit: { fields: {} } } };
    let useReactive = false, disposals = 0, calls = 0;
    const script = pattern({ audio: { schema, update(ctx, state) {
      calls++;
      expect(ctx.frame).toBe(input.frame); expect(ctx.shared).toBe(input.shared);
      expect(ctx.shared.getByteWaveforms().left).toHaveLength(3);
      expect(ctx.response).toBe(response); expect(ctx.accent).toBe(accent);
      if (useReactive) {
        expect(ctx.reactive).toBe(ctx.reactive);
        expect(ctx.reactive).toEqual(createFeatureController().update(input).continuous);
      }
      state.count = (state.count || 0) + 1;
      return { continuous: { bass: 80 + state.rng() }, arrays: { bins: ctx.shared.getByteFrequencies().left.slice(0, 32) }, events: [{ type: 'hit', id: `hit-${state.count}` }] };
    }, dispose() { disposals++; } } });
    expect(script.audioControlSchema).toBe(schema);
    const controller = script.createAudioController({ rng: () => .5 });
    const first = controller.update(input);
    expect(first.continuous).toEqual({ bass: 80.5 });
    expect(first.events[0].id).toBe('hit-1'); expect(first.arrays.bins).toHaveLength(32);
    expect(input.shared.diagnostics.featureBuilds).toBe(0);
    useReactive = true;
    expect(controller.update(input).events[0].id).toBe('hit-2');
    expect(input.shared.diagnostics.featureBuilds).toBe(1);
    controller.dispose(); controller.dispose(); controller.update(input);
    expect(disposals).toBe(1); expect(calls).toBe(2);
    const errors = [];
    const bad = pattern({ audio: { schema, update() { return { continuous: { bass: NaN } }; } } }, e => errors.push(e));
    expect(bad.createAudioController().update(input).continuous.bass).toBe(0);
    expect(errors[0]).toContain('values do not match audio.schema');
    // Original API-v1/raw-only source still passes the trusted compiler unchanged.
    expect(stageSources([{ name: 'old.viz.js', text: `api.requireVersion(1); api.create({id:'custom-old',name:'Old',audio:{schema:{},update({frame,shared},state){shared.getByteFrequencies();return {}; }},draw({audio,controls}){}});` }])).toHaveLength(1);
  });

  test('real engine/store transport preserves default channels, stale decay and stream lifecycle', () => {
    let now = 100;
    const script = pattern({ params: [{ key: 'bass', label: 'Bass', min: 0, max: 2, step: .05, default: 1 }] });
    const engine = new PatternAudioControlEngine({ ownerId: 'owner', getSketchById: id => id === script.id ? script : null, now: () => now });
    const descriptor = { runtimeId: 'consumer:1:0', patternId: script.id, role: 'live', childIndex: 0, paramsRevision: 1, params: { bass: 1 }, audioTransport: 'pattern-controls', audioControlSchema: script.audioControlSchema };
    const plan = { type: 'pattern-audio-plan', version: 1, consumerSessionId: 'consumer', planRevision: 1, sentAt: now, complete: true, slots: [descriptor] };
    const store = new PatternAudioControlStore({ consumerSessionId: 'consumer', now: () => now });
    store.setPlan(plan);
    expect(engine.receivePlan(plan).accepted).toBe(true);
    const step = sequence => engine.update({ frame: tone(), deltaSeconds: 1 / 60, captureTime: now, sequence }).packets[0];
    const first = step(1);
    expect(first.slots[0].continuous.bass).toBeGreaterThan(0);
    expect(store.acceptPacket(first)).toMatchObject({ accepted: true, slots: 1 });
    const binding = new PatternAudioControlBinding(store, descriptor.runtimeId);
    expect(binding.read().continuous).toEqual(first.slots[0].continuous);
    const before = [...engine.controllers.values()][0].controller;
    descriptor.paramsRevision = 2;
    descriptor.params = { bass: .5 };
    expect(engine.receivePlan({ ...plan, slots: [descriptor] }).accepted).toBe(true);
    expect([...engine.controllers.values()][0].controller).toBe(before);
    engine.beginStream();
    expect(engine.controllers.size).toBe(0);
    expect(before.update(tick(tone())).continuous).toEqual(SILENT_FEATURES);
    descriptor.params = { bass: 1 }; descriptor.paramsRevision = 1;
    engine.receivePlan({ ...plan, slots: [descriptor] });
    const restarted = step(1);
    expect(restarted.streamGeneration).not.toBe(first.streamGeneration);
    expect(restarted.slots[0].continuous).toEqual(first.slots[0].continuous);
    expect(store.acceptPacket(restarted).accepted).toBe(true);
    now += 10000;
    const stale = binding.read().continuous;
    for (const value of Object.values(stale)) expect(value).toBeLessThan(.00001);
    engine.forgetConsumer('consumer');
    expect(engine.controllers.size).toBe(0);
    expect(engine.diagnostics.controllerErrors).toBe(0);
  });

  test('renderer reads binding once, exposes helpers without FFT, preserves raw object and custom meanings', () => {
    let packet = { continuous: { ...SILENT_FEATURES, bass: 1.6, kick: .7 } }, reads = 0;
    const audio = { getAnalysisFrame() { throw Error('renderer must not analyze'); } };
    const binding = { read() { reads++; return packet; } };
    const run = (custom = false, bound = true) => {
      let ctx;
      const p = { remove() {}, createCanvas() {}, noLoop() {} };
      const script = pattern({ setup(c) { ctx = c; }, draw(c) { ctx = c; }, ...(custom ? { audio: { schema: { continuous: { bass: { min: 0, max: 100, neutral: 0 } } }, update() {} } } : {}) });
      script.factory(audio, null, {}, bound ? { audioControls: binding } : {})(p);
      p.setup(); expect(ctx.reactive).toEqual(SILENT_FEATURES);
      p.draw();
      expect(ctx.audio).toBe(audio); expect(ctx.response).toBe(response); expect(ctx.accent).toBe(accent);
      return { p, get ctx() { return ctx; } };
    };
    const a = run();
    expect(reads).toBe(1); expect(a.ctx.reactive.bass).toBe(1.6);
    a.ctx.reactive.bass = 99; expect(packet.continuous.bass).toBe(1.6);
    packet = { continuous: { ...SILENT_FEATURES, bass: .8 } }; a.p.draw();
    expect(a.ctx.reactive.bass).toBe(.8);
    packet = undefined; a.p.draw(); expect(a.ctx.reactive).toEqual(SILENT_FEATURES);
    expect(run(false, false).ctx.reactive).toEqual(SILENT_FEATURES);
    packet = { continuous: { bass: 80 } };
    const custom = run(true); expect(custom.ctx.reactive).toEqual(SILENT_FEATURES);
    expect(custom.ctx.controls.read().continuous.bass).toBe(80);
    a.p.remove(); expect(a.ctx.reactive).toEqual(SILENT_FEATURES);
  });
});
