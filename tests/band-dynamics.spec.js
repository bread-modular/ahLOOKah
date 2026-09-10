import { test, expect } from '@playwright/test';
import { createReplacementController, measuredSupport as replacementSupport } from '../src/sketches/replacements/runtime.js';
import { createExpansionController, measuredSupport as expansionSupport } from '../src/sketches/expansion/runtime.js';
import { SharedAudioAnalysisView } from '../src/pattern-audio-engine.js';
import { makeAudioFeatures } from '../src/sketches/audio-features.js';

// Loud continuous/broadband regression alongside the weak-signal tests: the
// support window must NOT saturate for ordinary loud program material, and the
// controller dynamics must relax during unchanging loud passages while still
// tracking time-varying content (modulation depth + pulse coherence), per
// band, with exact silence/mute behavior and the noise gate intact.
const CONTROLLERS = [
  ['replacement', createReplacementController, replacementSupport],
  ['expansion', createExpansionController, expansionSupport],
];

// RMS-consistent pink broadband frame: per-bin power falls 1/f like real
// program material (not white, which would overstate treble by ~15dB), with
// the total waveform RMS deciding overall level.
const broadbandFrame = (rms, { sampleRate = 48000 } = {}) => {
  const left = new Float32Array(1024).fill(-120);
  const hzPerBin = sampleRate / 2048;
  const p0 = (rms * rms) / Math.log(16000 / 30); // ∫ P0/f df over 30Hz..16kHz = rms²
  for (let i = 2; i < 700; i++) {
    const hz = i * hzPerBin;
    left[i] = 10 * Math.log10(Math.max(1e-12, p0 / hz));
  }
  return { left, right: left.slice(), sampleRate, fftSize: 2048, rms };
};

const run = (Controller, frames, params = {}) => {
  const c = Controller();
  const analyze = makeAudioFeatures();
  const out = [];
  for (const frame of frames) {
    const shared = new SharedAudioAnalysisView(frame, 1 / 60, (f, dt) => analyze(f, {}, dt));
    out.push(c.update({ shared, params, deltaSeconds: 1 / 60 }).continuous);
  }
  c.dispose();
  return out;
};

test.describe('band dynamics under loud continuous/broadband material', { tag: '@core' }, () => {
  for (const [name, Controller, support] of CONTROLLERS) {
    test(`${name}: support window does not saturate for loud broadband material`, () => {
      for (const rms of [.06, .15, .3]) {
        const s = support({ frame: broadbandFrame(rms) });
        for (const band of ['bass', 'mid', 'high']) {
          expect(s[band], `rms ${rms} ${band}`).toBeGreaterThan(.15);
          expect(s[band], `rms ${rms} ${band} not pinned`).toBeLessThan(.96);
        }
      }
      // Program-level steps of 20dB stay resolvable (the old window reported
      // Δ≈0.004 over ±4dB around -32 and 0.0 around -24).
      const quiet = support({ frame: broadbandFrame(.03) });
      const loud = support({ frame: broadbandFrame(.3) });
      for (const band of ['bass', 'mid', 'high']) expect(loud[band] - quiet[band], band).toBeGreaterThan(.1);
      // Noise gate is intact: a hot FFT with cleaned-out RMS stays silent.
      expect(support({ frame: { ...broadbandFrame(.4), rms: 0 } })).toEqual({ bass: 0, mid: 0, high: 0 });
    });

    test(`${name}: unchanging loud passages relax; time-varying material modulates deeply and coherently`, () => {
      // 2s constant loud, then 4s of 2Hz level wobble plus 1Hz level pulses.
      const frames = [];
      for (let i = 0; i < 120; i++) frames.push(broadbandFrame(.28));
      for (let i = 0; i < 240; i++) {
        const t = i / 60;
        const wobble = .12 + .13 * (0.5 + 0.5 * Math.sin(t * Math.PI * 4));
        frames.push(broadbandFrame(wobble + ((t % 1) < .18 ? .22 : 0)));
      }
      const out = run(Controller, frames);
      const bass = out.map((c) => c.bass);
      const settlePhase = bass.slice(90, 120);   // end of the constant section
      const earlyPeak = Math.max(...bass.slice(0, 40));
      const settledMax = Math.max(...settlePhase);
      // Relaxation: by the end of a constant loud passage the control sits
      // well below its own initial response (not pinned at max deformation).
      expect(settledMax / earlyPeak, 'relaxation ratio').toBeLessThan(.7);
      expect(settledMax, 'relaxed floor stays visible').toBeGreaterThan(.05);
      // Time-varying section: deep modulation, and it returns to low values.
      const varying = bass.slice(120);
      const vMax = Math.max(...varying), vMin = Math.min(...varying);
      expect(vMax - vMin, 'modulation depth').toBeGreaterThan(.3);
      // Loud walls of sound keep a big picture with beats riding on top; the
      // control still relaxes meaningfully between pulses instead of pinning.
      expect(vMin / vMax, 'relaxes between pulses').toBeLessThan(.8);
      // Pulse coherence: the strongest frames cluster within ~230ms of the
      // 1Hz pulse onsets (which start at frame 120, every 60 frames).
      const top = [...varying.keys()].sort((a, b) => varying[b] - varying[a]).slice(0, 12);
      const coherent = top.filter((i) => (i % 60) < 14).length;
      expect(coherent / top.length, 'pulse coherence').toBeGreaterThan(.65);
      // Bands move independently: a bass-only level step leaves mid/high far
      // behind, and zero gain still disables exactly.
      const bassOnly = run(Controller, [
        ...Array.from({ length: 60 }, () => broadbandFrame(.1)),
        ...Array.from({ length: 60 }, () => {
          const f = broadbandFrame(.1);
          // Strictly below the 180Hz bass|mid crossover (bins 2-6 = 47-141Hz).
          for (let i = 2; i < 7; i++) { f.left[i] = -8; f.right[i] = -8; }
          return f;
        }),
      ]);
      const beforeStep = bassOnly[59], justAfter = bassOnly[65], lastB = bassOnly.at(-1);
      expect(justAfter.bass - beforeStep.bass, 'bass follows its own step').toBeGreaterThan(.3);
      expect(lastB.bass - beforeStep.bass, 'bass step persists').toBeGreaterThan(.3);
      // Band independence: mid does not jump at the bass step (slow adaptive
      // settling drift aside).
      expect(Math.abs(justAfter.mid - beforeStep.mid), 'mid unaffected by bass step').toBeLessThan(.1);
      const silent = run(Controller, Array.from({ length: 90 }, () => ({ ...broadbandFrame(.4), rms: 0 })));
      expect(silent.at(-1)).toEqual({ bass: 0, mid: 0, high: 0 });
      const muted = run(Controller, Array.from({ length: 60 }, () => broadbandFrame(.4)), { bass: 0, mid: 0, high: 0 });
      expect(muted.at(-1)).toEqual({ bass: 0, mid: 0, high: 0 });
      const half = run(Controller, Array.from({ length: 90 }, () => broadbandFrame(.35)), { bass: .5 });
      const full = run(Controller, Array.from({ length: 90 }, () => broadbandFrame(.35)), {});
      expect(half.at(-1).bass).toBeCloseTo(full.at(-1).bass * .5, 9);
      expect(half.at(-1).mid).toBeCloseTo(full.at(-1).mid, 9);
    });
  }

  test('both controllers agree within float error on identical material', () => {
    const frames = Array.from({ length: 180 }, (_, i) => broadbandFrame(.06 + .12 * (0.5 + 0.5 * Math.sin(i / 30))));
    const a = run(createReplacementController, frames);
    const b = run(createExpansionController, frames);
    for (let i = 0; i < frames.length; i++) {
      for (const band of ['bass', 'mid', 'high']) expect(Math.abs(a[i][band] - b[i][band])).toBeLessThan(1e-9);
    }
  });
});
