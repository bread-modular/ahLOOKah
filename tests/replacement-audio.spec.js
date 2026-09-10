import { test, expect } from '@playwright/test';
import { SKETCHES, defaultParamValues } from '../src/sketch-registry.js';
import { BAND_PARAMS, BAND_SCHEMA, SILENT_BANDS, createBandController, makeBandReader, responsiveBands, scaleBands } from '../src/sketches/band-reactive.js';
import { makeAudioFeatures, setBandSplit } from '../src/sketches/audio-features.js';
import { PatternAudioControlEngine } from '../src/pattern-audio-engine.js';
import { PatternAudioControlStore } from '../src/pattern-audio-controls.js';

import { REPLACEMENT_PATTERNS } from '../src/sketches/replacements/index.js';
const IDS = REPLACEMENT_PATTERNS.map(s => s.id);
const getSketch = (id) => SKETCHES.find((s) => s.id === id);

function spectrum(range, { sampleRate = 48000, rightOnly = false, db = -48 } = {}) {
  const fftSize = 2048;
  const left = new Float32Array(fftSize / 2).fill(-120);
  const right = new Float32Array(fftSize / 2).fill(-120);
  if (range) for (let i = Math.ceil(range[0] * fftSize / sampleRate); i <= Math.floor(range[1] * fftSize / sampleRate); i++) {
    if (!rightOnly) left[i] = db;
    right[i] = db;
  }
  return { left, right, sampleRate, fftSize, rms: range ? 0.1 : 0 };
}

test.describe('replacement band response', { tag: '@core' }, () => {
  test('only the 18 replacements opt in; legacy Bars and shared slider defaults stay linear', () => {
    expect(IDS).toHaveLength(18);
    expect(SKETCHES.filter((s) => s.createAudioController === createBandController).map((s) => s.id).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      const sketch = getSketch(id);
      expect(sketch.audioReactive, id).toBe(true);
      expect(sketch.params.filter((p) => ['bass', 'mid', 'high'].includes(p.key)), id).toEqual(BAND_PARAMS);
      expect(sketch.audioControlSchema).toBe(BAND_SCHEMA);
    }
    expect(BAND_PARAMS.map(({ min, max, default: value }) => [min, max, value])).toEqual([[0, 2, 1], [0, 2, 1], [0, 2, 1]]);
    const features = Object.freeze({ sub: 0.2, mid: 0.4, high: 0.8 });
    expect(scaleBands(features, { bass: 0.5, mid: 0, high: 2 })).toEqual({ bass: 0.1, mid: 0, high: 1.6 });
    const bars = getSketch('bars').createAudioController();
    expect(bars.update({ shared: { getFeatures: () => features }, params: {} }).continuous).toMatchObject({ bass: 0.2, mid: 0.4, high: 0.8 });
    bars.dispose();
  });

  test('bounded soft knee is strong at modest levels, monotonic, independent, and linearly reducible to exact zero', () => {
    for (const value of [0.05, 0.1, 0.2, 0.4]) {
      const result = responsiveBands({ sub: value, mid: value, high: value });
      expect(result.bass).toBeGreaterThan(value * 2.5);
      expect(result.mid).toBe(result.bass);
      expect(result.high).toBe(result.bass);
    }
    const features = Object.freeze({ sub: 0.3, mid: 0.55, high: 0.8, energy: 1.6, kick: 1.4, snare: 1.4, hat: 1.4 });
    const full = responsiveBands(features);
    for (const band of ['bass', 'mid', 'high']) for (const slider of [0, 0.05, 0.25, 0.5, 1, 2]) {
      const result = responsiveBands(features, { [band]: slider });
      for (const key of ['bass', 'mid', 'high']) expect(result[key]).toBeCloseTo(full[key] * (key === band ? slider : 1), 12);
    }
    expect(responsiveBands(features, { bass: 0, mid: 0, high: 0 })).toEqual(SILENT_BANDS);
    expect(responsiveBands({ energy: 1.6, kick: 1.4, snare: 1.4, hat: 1.4 })).toEqual(SILENT_BANDS);
    expect(responsiveBands(null)).toEqual(SILENT_BANDS);
    expect(responsiveBands({ sub: NaN, mid: Infinity, high: -1 })).toEqual(SILENT_BANDS);
    expect(responsiveBands({ sub: 900, mid: 900, high: 900 }, { bass: 900, mid: -3, high: NaN })).toEqual({ bass: 3.2, mid: 0, high: 1.6 });
    let previous = -1;
    for (let i = 0; i <= 160; i++) {
      const value = responsiveBands({ sub: i / 100 }).bass;
      expect(value).toBeGreaterThan(previous);
      expect(value).toBeLessThanOrEqual(1.6);
      previous = value;
    }
    expect(responsiveBands({ sub: 1e-8 }).bass).toBeLessThan(6e-8); // no sqrt/noise pedestal
  });

  test('raw Hz bands and standalone reader agree at 30/60/120 Hz, respect crossovers, and decay without fake beats', () => {
    try {
      for (const sampleRate of [44100, 48000, 96000]) for (const [band, range] of [['bass', [40, 145]], ['mid', [350, 2200]], ['high', [6000, 12000]]]) {
        const finals = [];
        for (const fps of [30, 60, 120]) {
          const params = { bass: 1, mid: 1, high: 1 };
          let frame = null;
          const audio = { isStarted: true, getAnalysisFrame: () => frame };
          const reader = makeBandReader(audio, params);
          const analyze = makeAudioFeatures();
          expect(reader(1 / fps)).toEqual(SILENT_BANDS);
          let controls;
          for (let i = 0; i < fps; i++) {
            frame = spectrum(range, { sampleRate, rightOnly: band === 'high' });
            const measured = analyze(frame, {}, 1 / fps);
            controls = reader(1 / fps);
            expect(controls).toEqual(responsiveBands(measured, params));
          }
          expect(controls[band]).toBeGreaterThan(0.5);
          for (const other of ['bass', 'mid', 'high'].filter((b) => b !== band)) expect(controls[other]).toBe(0);
          finals.push(controls[band]);
          params[band] = 0;
          expect(reader(1 / fps)).toEqual(SILENT_BANDS); // mute a held envelope immediately
          params[band] = 1;
          audio.isStarted = false;
          let previous = Infinity;
          for (let i = 0; i < fps * 3; i++) {
            controls = reader(1 / fps);
            expect(controls[band]).toBeLessThanOrEqual(previous);
            previous = controls[band];
          }
          expect(controls[band]).toBeLessThan(0.00001);
        }
        expect(Math.max(...finals) - Math.min(...finals)).toBeLessThan(0.00001);
      }
      // A moved bass/mid crossover must move the modulation too. No fixed kick
      // detector or total energy is allowed to reintroduce the muted band.
      setBandSplit({ low: 700, high: 2800 });
      const reader = makeBandReader({ isStarted: true, getAnalysisFrame: () => spectrum([400, 550]) }, {});
      let result;
      for (let i = 0; i < 60; i++) result = reader(1 / 60);
      expect(result.bass).toBeGreaterThan(0.4);
      expect(result.mid).toBe(0);
      expect(result.high).toBe(0);
    } finally {
      setBandSplit({ low: 180, high: 2800 });
    }
  });

  test('all replacement controllers travel through real engine/schema/store once, with live revisions and stale/owner-loss neutral decay', () => {
    let now = 0;
    let sequence = 0;
    const engine = new PatternAudioControlEngine({ ownerId: 'source', getSketchById: getSketch, now: () => now });
    const store = new PatternAudioControlStore({ consumerSessionId: 'screen', interpolationDelayMs: 0, now: () => now });
    const slots = IDS.map((id, i) => ({
      runtimeId: `replacement-${i}`, patternId: id, role: i % 2 ? 'cue' : 'live', childIndex: 0,
      paramsRevision: 1, params: defaultParamValues(id), audioTransport: 'pattern-controls', audioControlSchema: BAND_SCHEMA,
    }));
    const plan = { type: 'pattern-audio-plan', version: 1, consumerSessionId: 'screen', planRevision: 1, sentAt: now, complete: true, slots };
    expect(engine.receivePlan(plan).accepted).toBe(true);
    store.setPlan(plan);
    const tick = (frame) => {
      now += 1000 / 30;
      const result = engine.update({ frame, now, captureTime: now, sequence: ++sequence, deltaSeconds: 1 / 30 });
      expect(result.shared.diagnostics.featureBuilds).toBe(1);
      expect(store.acceptPacket(result.packets[0])).toMatchObject({ accepted: true, slots: IDS.length });
      return result;
    };
    const silence = tick(spectrum(null));
    for (const slot of silence.packets[0].slots) expect(slot.continuous).toEqual(SILENT_BANDS);
    let active;
    for (let i = 0; i < 20; i++) active = tick(spectrum([40, 12000]));
    const expected = responsiveBands(active.shared.getFeatures());
    for (const slot of slots) {
      expect(store.createBinding(slot.runtimeId).read().continuous).toEqual(expected);
      for (const value of Object.values(expected)) expect(value).toBeGreaterThan(0.5);
    }
    slots[0] = { ...slots[0], paramsRevision: 2, params: { ...slots[0].params, bass: 0, mid: 0.5, high: 0 } };
    expect(engine.receivePlan(plan).accepted).toBe(true);
    store.setPlan(plan);
    expect(store.read(slots[0].runtimeId).continuous).toEqual(SILENT_BANDS);
    active = tick(spectrum([40, 12000]));
    const normal = responsiveBands(active.shared.getFeatures());
    expect(store.read(slots[0].runtimeId).continuous).toEqual({ bass: 0, mid: normal.mid * 0.5, high: 0 });
    expect(store.read(slots[1].runtimeId).continuous).toEqual(normal);
    now += 900;
    const decaying = store.read(slots[1].runtimeId);
    expect(decaying.isFresh).toBe(false);
    expect(decaying.continuous.bass).toBeGreaterThan(0);
    expect(decaying.continuous.bass).toBeLessThan(normal.bass);
    now += 400;
    expect(store.read(slots[1].runtimeId).continuous).toEqual(SILENT_BANDS);
    tick(spectrum([40, 12000]));
    store.clearForOwnerLoss();
    now += 400;
    for (const slot of slots) expect(store.read(slot.runtimeId).continuous).toEqual(SILENT_BANDS);
    expect(engine.getDiagnostics().controllerErrors).toBe(0);
    expect(store.getDiagnostics().droppedSchema).toBe(0);
    engine.disposeControllers();
  });

  test('replacement shader fallback has no idle audio and matches bound controls without double applying sliders or scanning output FFT', async ({ page }) => {
    await page.goto('/docs/patterns.html');
    const results = await page.evaluate(async () => {
      const { SKETCHES } = await import('/src/sketch-registry.js');
      const { makeAudioFeatures } = await import('/src/sketches/audio-features.js');
      const { responsiveBands } = await import('/src/sketches/band-reactive.js');
      const output = [];
      for (const id of ['truchet-relay', 'cellular-gate']) {
        const sketch = SKETCHES.find((s) => s.id === id);
        const params = { speed: 0, bass: 0.5, mid: 0, high: 2 };
        const left = new Float32Array(1024).fill(-50);
        let frame = { left, right: left, sampleRate: 48000, fftSize: 2048, rms: 0.1 };
        let rawReads = 0;
        let bindingReads = 0;
        let sent = null;
        const makeP = () => ({
          width: 360, height: 240, windowWidth: 360, windowHeight: 240, deltaTime: 1000 / 60,
          canvas: { style: {} }, uniforms: {},
          pixelDensity() {}, createCanvas() {}, noStroke() {}, shader() {}, rect() {},
          createShader() { return { setUniform: (key, value) => { this.uniforms[key] = value; } }; },
        });
        const fallback = makeP();
        sketch.factory({ isStarted: true, getAnalysisFrame() { rawReads++; return frame; } }, null, params)(fallback);
        fallback.setup();
        const bound = makeP();
        const poison = { isStarted: true, getAnalysisFrame() { throw new Error('Renderer must not scan FFT'); } };
        sketch.factory(poison, null, params, { audioControls: { read() { bindingReads++; return sent; } } })(bound);
        bound.setup();
        const analyze = makeAudioFeatures();
        let match = true;
        for (let i = 0; i < 30; i++) {
          frame = { ...frame };
          sent = { continuous: responsiveBands(analyze(frame, {}, 1 / 60), params) };
          fallback.draw(); bound.draw();
          for (const name of ['uSub', 'uMid', 'uHigh']) match &&= fallback.uniforms[name] === bound.uniforms[name];
        }
        sent = null;
        bound.draw();
        const idle = makeP();
        sketch.factory(null, null, params)(idle); idle.setup();
        for (let i = 0; i < 30; i++) idle.draw();
        output.push({ id, match, rawReads, bindingReads, bound: ['uSub', 'uMid', 'uHigh'].map((key) => bound.uniforms[key]), idle: ['uSub', 'uMid', 'uHigh'].map((key) => idle.uniforms[key]) });
      }
      return output;
    });
    for (const result of results) expect(result).toMatchObject({ match: true, rawReads: 30, bindingReads: 31, bound: [0, 0, 0], idle: [0, 0, 0] });
  });
});
