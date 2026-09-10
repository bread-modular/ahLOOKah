import { test, expect } from '@playwright/test';
import { EXPANSION_PATTERNS, RESTORED_CAMERA_PATTERNS } from '../src/sketches/expansion/index.js';
import { PatternAudioControlEngine } from '../src/pattern-audio-engine.js';
import { PatternAudioControlStore } from '../src/pattern-audio-controls.js';

// Fixed raster + software GL for reproducible renderer comparisons.
test.use({ viewport: { width: 320, height: 180 }, launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

// Sustained, music-like input must produce VISIBLY RHYTHMIC modulation through
// the actual capture controller path — not a lift that saturates into static
// maximum deformation. This feeds a 120 BPM kick/snare/hats arrangement through
// the real engine/store and measures temporal modulation depth, beat coherence
// and non-pinning of the emitted band controls.
const OWNED = [...EXPANSION_PATTERNS, ...RESTORED_CAMERA_PATTERNS];
const defaults = (s) => Object.fromEntries(s.params.map((p) => [p.key, p.default]));

// One analysis frame: three musical sources with per-frame gains.
function musicFrame({ kick = 0, snare = 0, hat = 0, sampleRate = 48000 }) {
  const fftSize = 2048;
  const left = new Float32Array(fftSize / 2).fill(-120);
  const right = left.slice();
  const place = (hz, db, width = 2) => {
    const bin = Math.round(hz * fftSize / sampleRate);
    for (let i = Math.max(1, bin - width); i <= Math.min(left.length - 1, bin + width); i++) {
      left[i] = db; right[i] = db;
    }
  };
  // Spectral peaks decay in dB with the envelope, like real drum tails.
  if (kick > 0.02) { place(55, -50 + 38 * kick, 3); place(95, -56 + 36 * kick, 3); }
  if (snare > 0.02) { place(900, -52 + 34 * snare, 4); place(1800, -58 + 32 * snare, 4); }
  if (hat > 0.02) { place(7000, -56 + 30 * hat, 3); place(11000, -62 + 28 * hat, 3); }
  const rms = 0.002 + kick * 0.07 + snare * 0.04 + hat * 0.012;
  return { left, right, sampleRate, fftSize, rms };
}

// 120 BPM: kick on quarters, snare on 2&4, hats on 8ths, at 60fps over 4 bars.
function arrangement(frameIndex, fps = 60) {
  const beat = frameIndex / (fps / 2); // 0.5s per beat
  const phase = beat % 1;
  const env = (p, rate) => Math.exp(-p * rate);
  const kick = (beat % 2) < 1 ? env(phase, 14) : 0;              // quarters 1 & 3
  const snare = (beat % 2) >= 1 ? env(phase, 18) : 0;           // quarters 2 & 4
  const hatPhase = (beat * 2) % 1;
  const hat = env(hatPhase, 22) * 0.9;
  return musicFrame({ kick: Math.min(1, kick), snare: Math.min(1, snare), hat: Math.min(1, hat) });
}

test('sustained musical arrangement drives deep, beat-coherent, unsaturated band modulation via the real engine/store path', { tag: '@core' }, () => {
  let now = 0, sequence = 0;
  const engine = new PatternAudioControlEngine({ ownerId: 'music', getSketchById: (id) => OWNED.find((s) => s.id === id), now: () => now });
  const store = new PatternAudioControlStore({ consumerSessionId: 'screen', now: () => now, interpolationDelayMs: 0 });
  const slots = OWNED.map((s, i) => ({ runtimeId: `m${i}`, patternId: s.id, role: 'live', childIndex: 0, paramsRevision: 1, params: defaults(s), audioControlSchema: s.audioControlSchema, audioTransport: s.audioTransport }));
  const plan = { type: 'pattern-audio-plan', version: 1, consumerSessionId: 'screen', planRevision: 1, sentAt: 0, complete: true, slots };
  expect(engine.receivePlan(plan).accepted).toBe(true); store.setPlan(plan);

  const fps = 60, frames = fps * 8; // 4 bars
  const timeline = [];
  for (let i = 0; i < frames; i++) {
    now += 1000 / fps;
    // Keep the plan lease alive across the 8-second arrangement (3.5s lease).
    if (i % 120 === 0) { plan.sentAt = now; expect(engine.receivePlan(plan).accepted).toBe(true); store.setPlan(plan); }
    const result = engine.update({ frame: arrangement(i, fps), now, captureTime: now, sequence: ++sequence, deltaSeconds: 1 / fps });
    expect(result.packets.length, `packet ${i}`).toBeGreaterThan(0);
    expect(store.acceptPacket(result.packets[0]).accepted).toBe(true);
    timeline.push(structuredClone(store.read('m0').continuous));
  }
  expect(engine.getDiagnostics().controllerErrors).toBe(0);
  expect(store.getDiagnostics().droppedSchema).toBe(0);

  // Every pattern receives the identical control stream (single shared scan).
  for (const s of slots) expect(store.read(s.runtimeId).continuous).toEqual(timeline.at(-1));

  const series = (band) => timeline.map((c) => c[band]);
  for (const band of ['bass', 'mid', 'high']) {
    const s = series(band);
    const min = Math.min(...s), max = Math.max(...s), mean = s.reduce((a, v) => a + v, 0) / s.length;
    // Modulation depth: the control breathes through a large fraction of its span.
    expect(max - min, `${band} depth`).toBeGreaterThan(0.3);
    expect(max, `${band} peak`).toBeGreaterThan(0.4);
    // Not pinned: the control spends most of the arrangement away from its ceiling.
    const nearMax = s.filter((v) => v > 0.9 * max).length / s.length;
    expect(nearMax, `${band} pinned fraction`).toBeLessThan(0.45);
    expect(mean / max, `${band} duty`).toBeLessThan(0.85);
    // Beat coherence: the strongest positive rises cluster within 90ms of an
    // onset (rise-based, so slow AGC drift cannot fake coherence).
    const rises = s.map((v, i) => (i ? Math.max(0, v - s[i - 1]) : 0));
    const sorted = [...rises.keys()].sort((a, b2) => rises[b2] - rises[a]).slice(0, 8);
    const onsets = band === 'bass' ? [0, 2, 4, 6, 8, 10, 12, 14] : band === 'mid' ? [1, 3, 5, 7, 9, 11, 13, 15] : Array.from({ length: 32 }, (_, k) => k * 0.5);
    const coherent = sorted.filter((i) => {
      const beat = i / (fps / 2);
      return onsets.some((o) => Math.abs(beat - o) < 0.18);
    }).length;
    expect(coherent / sorted.length, `${band} onset coherence`).toBeGreaterThan(0.6);
  }
  engine.disposeControllers();
});

test('musical modulation is visible at the renderer: beat frames differ structurally from off-beat frames', { tag: '@patterns' }, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { renderTimeline, difference } = await import('/tests/fixtures/replacement-renderer.js');
    // Kick-locked control stream recorded the way the engine emits it: attack
    // at the beat, exponential decay after — 12 frames per beat at DT=1/20.
    const beat = [];
    for (let i = 0; i < 24; i++) {
      const p = (i % 12) / 12;
      const kick = Math.exp(-p * 6);
      beat.push({ continuous: { bass: 1.6 * kick, mid: 1.2 * Math.exp(-p * 9), high: 0.8 * Math.exp(-p * 14) }, arrays: {}, events: [] });
    }
    const out = {};
    for (const id of ['lissajous-scope', 'step-sequencer', 'voxel-cascade']) {
      const silent = await renderTimeline(id, () => ({}), {});
      const driven = await renderTimeline(id, () => ({}), {}, beat);
      // Sample AT the beat attacks (frames 1/13 sit on kick transients).
      const metrics = [1, 2, 13, 14].map((i) => difference(silent[i], driven[i]));
      out[id] = {
        rgb: metrics.reduce((a, m) => a + m.rgb, 0) / metrics.length,
        coverage: metrics.reduce((a, m) => a + m.coverage, 0) / metrics.length,
        edge: metrics.reduce((a, m) => a + m.edge, 0) / metrics.length,
        // Beat-to-beat temporal variation inside the driven stream itself.
        motion: (difference(driven[1], driven[7]).rgb + difference(driven[13], driven[19]).rgb) / 2,
      };
    }
    return out;
  });
  for (const [id, m] of Object.entries(result)) {
    expect(m.rgb, id).toBeGreaterThan(3);
    expect(m.coverage, id).toBeGreaterThan(0.05);
    expect(m.edge, id).toBeGreaterThan(0.01);
    expect(m.motion, `${id} temporal variation`).toBeGreaterThan(1.5);
  }
});
