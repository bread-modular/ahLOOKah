import { test, expect } from '@playwright/test';
import { SKETCHES } from '../src/sketch-registry.js';
import { BAND_PARAMS, BAND_SCHEMA, SILENT_BANDS } from '../src/sketches/band-reactive.js';
import {
  createExpansionController, expansionBands, makeExpansionReader, measuredSupport, response,
} from '../src/sketches/expansion/runtime.js';
import { EXPANSION_PATTERNS, RESTORED_CAMERA_PATTERNS } from '../src/sketches/expansion/index.js';
import { makeAudioFeatures, setBandSplit } from '../src/sketches/audio-features.js';
import { PatternAudioControlEngine, SharedAudioAnalysisView } from '../src/pattern-audio-engine.js';
import { PatternAudioControlStore } from '../src/pattern-audio-controls.js';

const OWNED = [...EXPANSION_PATTERNS, ...RESTORED_CAMERA_PATTERNS];
const bands = ['bass', 'mid', 'high'];
const defaults = (s) => Object.fromEntries(s.params.map((p) => [p.key, p.default]));
const spectrum = (hz = 0, { sampleRate = 48000, rightOnly = false, rms = .001, db = -72 } = {}) => {
  const left = new Float32Array(1024).fill(-120), right = left.slice();
  if (hz) { const bin = Math.round(hz * 2048 / sampleRate); right[bin] = db; if (!rightOnly) left[bin] = db; }
  return { left, right, sampleRate, fftSize: 2048, rms: hz ? rms : 0 };
};

test.describe('expansion signal support', { tag: '@core' }, () => {
  test('owned entries opt in locally; schemas, shared sliders and legacy Bars stay unchanged', () => {
    for (const s of OWNED) {
      expect(SKETCHES.find((p) => p.id === s.id)?.createAudioController).toBe(createExpansionController);
      expect(s.audioControlSchema).toBe(BAND_SCHEMA);
      expect(s.params.filter((p) => bands.includes(p.key))).toEqual(BAND_PARAMS);
    }
    const bars = SKETCHES.find((s) => s.id === 'bars').createAudioController();
    expect(bars.update({ shared: { getFeatures: () => ({ sub: .2, mid: .4, high: .8 }) }, params: {} }).continuous).toMatchObject({ bass: .2, mid: .4, high: .8 });
    bars.dispose();
  });

  test('finite weak knee and loud shoulder; slider stays exactly linear through final geometry', () => {
    const features = { sub: .015, mid: .03, high: .008 }, base = expansionBands(features);
    expect(response(base.bass)).toBeGreaterThan(.12);
    for (const band of bands) for (const gain of [0, .05, .25, .5, 1, 1.5, 2]) {
      const next = expansionBands(features, { [band]: gain });
      for (const key of bands) expect(response(next[key])).toBeCloseTo(response(base[key]) * (band === key ? gain : 1), 12);
    }
    expect(expansionBands(null)).toEqual(SILENT_BANDS);
    expect(expansionBands({ sub: NaN, mid: Infinity, high: -1 })).toEqual(SILENT_BANDS);
    expect(expansionBands({ energy: 1, kick: 1, snare: 1, hat: 1 })).toEqual(SILENT_BANDS);
    expect(expansionBands({ sub: 1e-8 }).bass).toBeLessThan(5e-7);
    expect(expansionBands({ sub: 900 }, { bass: 900 }).bass).toBeCloseTo(3.2, 12);
    let prior = -1;
    for (let i = 0; i <= 160; i++) { const x = expansionBands({ sub: i / 100 }).bass; expect(x).toBeGreaterThan(prior); prior = x; }
    expect(expansionBands({ sub: 1.2 }).bass - expansionBands({ sub: .6 }).bass).toBeGreaterThan(.15);
  });

  test('cleaned RMS gate, right-only Hz split, once-per-shared-view scan and immediate mute of held envelopes', () => {
    try {
      for (const sr of [44100, 48000, 96000]) for (const [i, hz] of [90, 900, 7000].entries()) {
        const frame = spectrum(hz, { sampleRate: sr, rightOnly: true });
        const shared = new SharedAudioAnalysisView(frame);
        const support = measuredSupport(shared);
        expect(measuredSupport(shared)).toBe(support); // one cached scan per shared view
        expect(support[bands[i]]).toBeGreaterThan(.02);
        for (const key of bands.filter((b) => b !== bands[i])) expect(support[key]).toBe(0);
        const c = createExpansionController();
        for (let n = 0; n < 20; n++) c.update({ shared });
        expect(c.update({ shared, params: { bass: 0, mid: 0, high: 0 } }).continuous).toEqual(SILENT_BANDS);
        // Noise-floor owns rms; even a hot FFT cannot bypass its cleaned gate.
        expect(measuredSupport({ frame: { ...frame, rms: 0 } })).toEqual(SILENT_BANDS);
      }
      setBandSplit({ low: 1200, high: 2800 });
      const changed = measuredSupport({ frame: spectrum(900) });
      expect(changed.bass).toBeGreaterThan(0); expect(changed.mid).toBe(0);
    } finally { setBandSplit({ low: 180, high: 2800 }); }
  });

  test('weak fresh treble after a loud passage: canonical reads exact zero, integrated support still moves', () => {
    const analyze = makeAudioFeatures();
    const loud = spectrum(90, { db: -18, rms: .5 });
    for (let i = 2; i < 700; i++) loud.left[i] = -18;
    loud.right = loud.left.slice();
    for (let i = 0; i < 40; i++) analyze({ ...loud }, {}, 1 / 60);
    const silence = spectrum(0, { rms: 0 });
    for (let i = 0; i < 90; i++) analyze({ ...silence }, {}, 1 / 60);
    const weak = spectrum(7000, { db: -66, rms: .004 });
    let canonical;
    for (let i = 0; i < 6; i++) canonical = analyze({ ...weak }, {}, 1 / 60);
    // The documented failure mode: power/bin + slow AGC buries fresh weak treble.
    expect(canonical.high).toBeLessThan(1e-5);
    const shared = new SharedAudioAnalysisView({ ...weak }, 1 / 60, (f, dt) => analyze(f, {}, dt));
    const support = measuredSupport(shared);
    expect(support.high).toBeGreaterThan(.05);
    expect(support.bass).toBe(0); expect(support.mid).toBe(0);
    const c = createExpansionController();
    let out;
    for (let i = 0; i < 30; i++) out = c.update({ shared, deltaSeconds: 1 / 60 });
    expect(out.continuous.high).toBeGreaterThan(.5);       // usable geometry drive recovered
    expect(out.continuous.bass).toBeLessThan(.01);         // no cross-band leakage (envelope residue only)
    expect(c.update({ shared, params: { high: 0 }, deltaSeconds: 1 / 60 }).continuous.high).toBe(0);
    c.dispose();
  });

  test('standalone matches the real capture controller at 30/60/120Hz and decays without fake beats', () => {
    const finals = [];
    for (const fps of [30, 60, 120]) {
      let frame = null;
      const audio = { isStarted: true, getAnalysisFrame: () => frame }, params = { bass: .5, mid: 0, high: 2 };
      const reader = makeExpansionReader(audio, params), analyze = makeAudioFeatures(), c = createExpansionController();
      expect(reader(1 / fps)).toEqual(SILENT_BANDS);
      let out;
      for (let i = 0; i < fps; i++) {
        frame = spectrum(7000);
        const shared = new SharedAudioAnalysisView(frame, 1 / fps, (f, dt) => analyze(f, {}, dt));
        out = reader(1 / fps);
        expect(out).toEqual(c.update({ shared, params, deltaSeconds: 1 / fps }).continuous);
      }
      finals.push(out.high);
      params.high = 0; expect(reader(1 / fps)).toEqual(SILENT_BANDS);
      params.high = 2; audio.isStarted = false;
      let previous = Infinity;
      for (let i = 0; i < fps * 4; i++) { out = reader(1 / fps); expect(out.high).toBeLessThanOrEqual(previous); previous = out.high; }
      expect(out.high).toBeLessThan(1e-7);
    }
    expect(Math.max(...finals) - Math.min(...finals)).toBeLessThan(1e-5);
  });

  test('all owned controllers pass engine/schema/store, independent revisions and stale/owner-loss neutrality', () => {
    let now = 0, sequence = 0;
    const engine = new PatternAudioControlEngine({ ownerId: 'capture', getSketchById: (id) => OWNED.find((s) => s.id === id), now: () => now });
    const store = new PatternAudioControlStore({ consumerSessionId: 'screen', now: () => now, interpolationDelayMs: 0 });
    const slots = OWNED.map((s, i) => ({ runtimeId: `e${i}`, patternId: s.id, role: 'live', childIndex: 0, paramsRevision: 1, params: defaults(s), audioControlSchema: s.audioControlSchema, audioTransport: s.audioTransport }));
    const plan = { type: 'pattern-audio-plan', version: 1, consumerSessionId: 'screen', planRevision: 1, sentAt: 0, complete: true, slots };
    expect(engine.receivePlan(plan).accepted).toBe(true); store.setPlan(plan);
    const tick = (frame) => {
      now += 1000 / 30;
      const r = engine.update({ frame, now, captureTime: now, sequence: ++sequence, deltaSeconds: 1 / 30 });
      expect(r.shared.diagnostics.featureBuilds).toBe(1);
      expect(store.acceptPacket(r.packets[0])).toMatchObject({ accepted: true, slots: OWNED.length });
      return r;
    };
    tick(spectrum());
    for (const s of slots) expect(store.read(s.runtimeId).continuous).toEqual(SILENT_BANDS);
    for (let i = 0; i < 20; i++) tick(spectrum(7000));
    const before = store.read('e1').continuous;
    expect(response(before.high)).toBeGreaterThan(.18);
    for (const s of slots) expect(store.read(s.runtimeId).continuous).toEqual(before);
    slots[0] = { ...slots[0], paramsRevision: 2, params: { ...slots[0].params, bass: 0, mid: 0, high: .5 } };
    expect(engine.receivePlan(plan).accepted).toBe(true); store.setPlan(plan);
    expect(store.read('e0').continuous).toEqual(SILENT_BANDS);
    for (let i = 0; i < 20; i++) tick(spectrum(7000));
    expect(store.read('e0').continuous.high).toBeCloseTo(store.read('e1').continuous.high * .5, 6);
    now += 900; expect(store.read('e1').isFresh).toBe(false);
    now += 400; expect(store.read('e1').continuous).toEqual(SILENT_BANDS);
    tick(spectrum(7000)); store.clearForOwnerLoss(); now += 400;
    for (const s of slots) expect(store.read(s.runtimeId).continuous).toEqual(SILENT_BANDS);
    expect(engine.getDiagnostics().controllerErrors).toBe(0); expect(store.getDiagnostics().droppedSchema).toBe(0);
    engine.disposeControllers();
  });
});

test('expansion detector respects a genuinely captured/subtracted noise profile, not only an RMS mock', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const out = await page.evaluate(async () => {
    const nf = await import('/src/noise-floor.js');
    const { measuredSupport, createExpansionController } = await import('/src/sketches/expansion/runtime.js');
    const { SharedAudioAnalysisView } = await import('/src/pattern-audio-engine.js');
    const make = () => { const left = new Float32Array(1024).fill(-100); left[300] = -70; return { left, right: left.slice(), rms: .001, sampleRate: 48000, fftSize: 2048 }; };
    nf.clearNoiseFloor(); const before = measuredSupport({ frame: make() });
    try {
      nf.startNoiseCapture(.2); nf.feedNoiseCapture(make());
      await new Promise((resolve) => setTimeout(resolve, 240));
      const capture = nf.feedNoiseCapture(make());
      const frame = make(); nf.applyNoiseFloor(frame);
      const shared = new SharedAudioAnalysisView(frame);
      return { done: capture.done, before, after: measuredSupport(shared), controls: createExpansionController().update({ shared }).continuous, rms: frame.rms };
    } finally { nf.clearNoiseFloor(); }
  });
  expect(out.done).toBe(true); expect(out.before.high).toBeGreaterThan(.02);
  expect(out.rms).toBeLessThan(.0001); expect(out.after).toEqual({ bass: 0, mid: 0, high: 0 }); expect(out.controls).toEqual({ bass: 0, mid: 0, high: 0 });
});

test('expansion shader fallback equals bound controls without double gain/FFT; live speed zero freezes phase, not audio', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const out = await page.evaluate(async () => {
    const { FIELD_PATTERNS } = await import('/src/sketches/expansion/fields.js');
    const { makeExpansionReader } = await import('/src/sketches/expansion/runtime.js');
    const results = [];
    for (const sketch of FIELD_PATTERNS) {
      const params = { speed: .6, bass: .5, mid: 0, high: 2 };
      let frame = null, rawReads = 0, boundReads = 0, sent;
      const audio = { isStarted: true, getAnalysisFrame: () => { rawReads++; return frame; } };
      const reference = makeExpansionReader({ isStarted: true, getAnalysisFrame: () => frame }, params);
      const makeP = () => ({
        width: 320, height: 180, windowWidth: 320, windowHeight: 180, deltaTime: 1000 / 60, canvas: { style: {} }, uniforms: {},
        pixelDensity() { }, createCanvas() { }, noStroke() { }, shader() { }, rect() { },
        createShader() { return { setUniform: (k, v) => { this.uniforms[k] = v; } }; },
      });
      const a = makeP(), b = makeP();
      sketch.factory(audio, null, params)(a);
      sketch.factory({ isStarted: true, getAnalysisFrame() { throw new Error('Output FFT scan'); } }, null, params,
        { audioControls: { read() { boundReads++; return { continuous: sent }; } } })(b);
      a.setup(); b.setup();
      let same = true;
      for (let i = 0; i < 20; i++) {
        if (i > 1) { const left = new Float32Array(1024).fill(-120); left[300] = -70; frame = { left, right: left, rms: .001, sampleRate: 48000, fftSize: 2048 }; }
        sent = reference(1 / 60); a.draw(); b.draw();
        same &&= JSON.stringify(a.uniforms) === JSON.stringify(b.uniforms);
      }
      const phase = a.uniforms.uTime;
      params.speed = 0; params.high = 0; sent = reference(1 / 60); a.draw(); b.draw();
      results.push({ id: sketch.id, same, phase, frozen: a.uniforms.uTime, muted: a.uniforms.uHigh, rawReads, boundReads });
    }
    return results;
  });
  for (const r of out) { expect(r.same, r.id).toBe(true); expect(r.phase).toBeGreaterThan(0); expect(r.frozen).toBe(r.phase); expect(r.muted).toBe(0); expect(r.rawReads).toBe(21); expect(r.boundReads).toBe(21); }
});
