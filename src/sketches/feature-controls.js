// Shared musical feature transport for the replacement + expansion waves.
//
// MAPPING PROVENANCE (copied from the three reference implementations, NOT a
// new normalization/sensitivity invention):
//  - Techno 3D (src/sketches/techno3d.js) and Circles (src/sketches/circles.js):
//    direct multiplicative mappings — a band level times its panel gain,
//    added on top of constant structural motion. Zero gain removes exactly
//    that band's response.
//  - Ion Tempest (src/sketches/ion_tempest.js): every canonical feature gets
//    its own visual role, gated by the associated slider:
//      kick/beat <- bass gain, snare <- mid gain, hat <- high gain
//    with clamps at the same 1.4 ceiling used by makeAudioFeatures. Its idle
//    fallback (fabricated beats when no frame exists) is deliberately NOT
//    copied: silence stays silent here.
//  - Sustained bass/mid/high LEVELS keep the previously proven within-band
//    dynamics (integrated cleaned band power supplement + adaptive dB-baseline
//    deviation), because loud continuous music otherwise saturates a direct
//    level mapping into a plateau. This is the one piece of the prior wave
//    worth preserving, and it now feeds ONLY the three level channels.
//
// The controller emits eight independent channels instead of folding the
// music into three values: bass/mid/high (sustained levels), kick/snare/hat/
// beat (percussion envelopes) and energy (aggregate of the gated levels).
import { getBandSplit } from './audio-features.js';
import { bounded } from './band-reactive.js';

export const SILENT_FEATURES = Object.freeze({
  bass: 0, mid: 0, high: 0,
  kick: 0, snare: 0, hat: 0, beat: 0, energy: 0,
});

// Schema for the 8-channel transport. Level channels keep the established
// 0..3.2 range (dynamics ceiling 2.6 x max gain 2, response() maps back to
// 0..1). Percussion channels mirror the 0..1.4 envelope ceiling of
// makeAudioFeatures / Ion Tempest's AUDIO_CONTROL_SCHEMA. Energy aggregates
// the gated levels, so it shares the level range.
export const FEATURE_SCHEMA = Object.freeze({
  continuous: {
    bass: { min: 0, max: 3.2, neutral: 0 },
    mid: { min: 0, max: 3.2, neutral: 0 },
    high: { min: 0, max: 3.2, neutral: 0 },
    kick: { min: 0, max: 1.4, neutral: 0 },
    snare: { min: 0, max: 1.4, neutral: 0 },
    hat: { min: 0, max: 1.4, neutral: 0 },
    beat: { min: 0, max: 1.4, neutral: 0 },
    energy: { min: 0, max: 3.2, neutral: 0 },
  },
  arrays: {},
  events: {},
  neutral: { continuous: SILENT_FEATURES },
});

// Renderer-side normalizers. Levels map through the same linear response as
// before (final geometry amplitude stays LINEAR in the slider; no second
// compressor). Percussion envelopes normalize their 0..1.4 ceiling to 0..1.
export const response = (x) => bounded(x, 0, 0, 3.2) / 3.2;
export const accent = (x) => bounded(x, 0, 0, 1.4) / 1.4;

// Selective opt-in slider for patterns where percussion accents are part of
// the visual identity (rhythmic machines, lasers, the Techno 3D descendants).
// Renderer-side trim on top of the controller's band gating: the Bass/Mid/
// High sliders still gate their associated percussion; this only scales how
// loud the accents play. Zero mutes accents, default 1 is the designed mix.
export const ACCENTS_PARAM = Object.freeze({ key: 'accents', label: 'Percussion Accents', min: 0, max: 2, step: .05, default: 1 });
export const accentsGain = (params = {}) => bounded(params.accents, 1, 0, 2);

const smooth = (lo, hi, x) => { const v = bounded((x - lo) / (hi - lo), 0, 0, 1); return v * v * (3 - 2 * v); };

// Finite slope, no pedestal, plus a LINEAR shoulder that keeps growing with
// level, CAPPED at 1.65. The knee term (x/(x+.03)) lifts weak material while
// staying far from saturation by x≈.08, and the 1.3x linear term preserves
// loud/weak contrast: sustained output at .3 is ~1.55x the .08 level and at
// .85 ~2x, so loud music visibly out-drives quiet music instead of compressing
// into a plateau. The cap keeps a constant LOUD passage from pinning the
// sustained term at the 2.6 dynamics ceiling for seconds (the proven relaxation
// behavior): sustained input is pre-capped at 1.2, where the uncapped shape
// would peak at ~2.54 and starve the deviation terms of headroom.
const lift = (x) => { x = bounded(x, 0, 0, 1.2); return Math.min(1.65, x / (x + .03) + 1.3 * x); };

// ---------------------------------------------------------------------------
// Sustained-level support: canonical power/bin normalization + slow AGC can
// produce EXACT zero after a loud-to-quiet transition, especially for sparse
// treble. Multiplying that zero cannot help. Supplement it with cleaned,
// integrated band power (not bin mean). Capture-side only and cached ONCE per
// SharedAudioAnalysisView, shared by LIVE/CUE/merge instances. Never read an
// analyser in a bound output renderer.
// ---------------------------------------------------------------------------
const supportCache = new WeakMap();
const SILENT_DB = Object.freeze({ bass: -120, mid: -120, high: -120 });
const SILENT_SUPPORT = Object.freeze({ bass: 0, mid: 0, high: 0 });

function computeSupport(frame) {
  const channels = [frame.left, frame.right].filter((a) => a?.length);
  const count = Math.max(...channels.map((a) => a.length));
  const sampleRate = bounded(frame.sampleRate, 48000, 8000, 384000);
  const fftSize = bounded(frame.fftSize, count * 2, count * 2, 32768);
  const split = getBandSplit();
  const sums = [0, 0, 0];
  const power = (db) => 10 ** (bounded(db, -120, -120, 0) / 10);
  for (let i = 1; i < count; i++) {
    const hz = (i * sampleRate) / fftSize;
    if (hz < 30 || hz > 16000) continue;
    const band = hz < split.low ? 0 : hz < split.high ? 1 : 2;
    for (const channel of channels) sums[band] += power(channel[i]) / channels.length;
  }
  // Respect noise-floor's cleaned RMS override; do not undo its hard gate.
  let rms = frame.rms;
  if (!Number.isFinite(rms)) {
    let sum = 0;
    let samples = 0;
    for (const wave of [frame.waveformLeft, frame.waveformRight]) {
      if (wave?.length) {
        for (const value of wave) { sum += bounded(value, 0, -1, 1) ** 2; samples++; }
      }
    }
    rms = Math.sqrt(samples ? sum / samples : sums.reduce((a, b2) => a + b2, 0));
  }
  const gate = smooth(-72, -48, 20 * Math.log10(Math.max(1e-12, rms)));
  // Integrated band sums span decades between a single weak bin and full-range
  // program material. The (-85,-12) window keeps weak bins audible while loud
  // continuous music lands mid-scale (~0.5-0.7) instead of pinning at 1.0.
  const windowed = {};
  const db = {};
  for (const [i, key] of ['bass', 'mid', 'high'].entries()) {
    const sumDb = 10 * Math.log10(Math.max(1e-12, sums[i]));
    windowed[key] = smooth(-85, -12, sumDb) * gate;
    // Gated dB levels: deviation is measured in dB so a ±3-6dB within-band
    // change reads the same at ANY loudness. Quantized bin floors (-120dB)
    // integrate to phantom levels around -100dB; only bands with a real
    // windowed level may feed the reference.
    db[key] = windowed[key] > 1e-3 ? -120 + (sumDb + 120) * gate : -120;
  }
  return { windowed, db };
}

function supportOf(shared, frame) {
  if (!frame?.left?.length && !frame?.right?.length) return null;
  if (shared && supportCache.has(shared)) return supportCache.get(shared);
  const result = computeSupport(frame);
  if (shared) supportCache.set(shared, result);
  return result;
}

export function measuredSupport(shared, frame = shared?.frame) {
  return supportOf(shared, frame)?.windowed || SILENT_SUPPORT;
}

export function measuredSupportDb(shared, frame = shared?.frame) {
  return supportOf(shared, frame)?.db || SILENT_DB;
}

// ---------------------------------------------------------------------------
// The controller. Sustained levels use the proven within-band dynamics;
// percussion + energy use the references' direct gated mapping. The slider is
// applied AFTER all shaping (linear; zero is exactly silent), bands never
// mix, and there is no fabricated idle motion: no frame => all zeros.
// ---------------------------------------------------------------------------
export function createFeatureController() {
  const baseline = { ...SILENT_SUPPORT };
  const baselineDb = { bass: -120, mid: -120, high: -120 };
  const previous = { bass: -120, mid: -120, high: -120 };
  const flux = { ...SILENT_SUPPORT };
  const primed = { bass: false, mid: false, high: false };
  return {
    update({ shared, frame = shared?.frame, params = {}, deltaSeconds = 1 / 30 }) {
      const features = shared?.getFeatures?.() || {};
      const support = measuredSupport(shared, frame);
      const supportDb = measuredSupportDb(shared, frame);
      const dt = bounded(deltaSeconds, 1 / 30, 1 / 240, .1);
      const bassGain = bounded(params.bass, 1, 0, 2);
      const midGain = bounded(params.mid, 1, 0, 2);
      const highGain = bounded(params.high, 1, 0, 2);
      const continuous = {};
      for (const [i, key] of ['bass', 'mid', 'high'].entries()) {
        // One unified per-band level: AGC-normalized features or integrated
        // support, whichever is hotter. NO steady max() floor — the output is
        // driven by per-band TEMPORAL DEVIATION on top of a bounded,
        // self-relaxing sustained term, so 3-6dB within-band changes stay
        // visible over continuous music instead of saturating into a plateau.
        const raw = Math.max(bounded(features?.[['sub', 'mid', 'high'][i]], 0, 0, 1.6), support[key]);
        const level = support[key];
        const db = supportDb[key];
        // Prime the dB reference near the first observed level: without this a
        // -120 start keeps the deviation accent capped for ~5s after every
        // silence-to-music transition instead of relaxing within ~2s.
        if (db <= -119.5) primed[key] = false;
        else if (!primed[key]) {
          primed[key] = true;
          baselineDb[key] = db - 8;
          flux[key] = Math.max(flux[key], 8);
        }
        // Rise chase 1.2s (fall 3.5s): a sustained-level step reads as a
        // deviation accent that decays within ~1-2s, so constant loud passages
        // relax instead of pinning, while onsets still land exactly on the
        // beat through the much faster flux term.
        const settleTau = db > baselineDb[key] ? 1.2 : 3.5;
        baselineDb[key] += (db - baselineDb[key]) * (1 - Math.exp(-dt / settleTau));
        baseline[key] += (level - baseline[key]) * (1 - Math.exp(-dt / (level > baseline[key] ? 2.5 : 3.5)));
        const settled = Math.min(1, baseline[key] / Math.max(1e-6, level));
        // Positive flux in dB: onsets get a fast accent that decays on its own.
        const rise = Math.max(0, db - previous[key]);
        previous[key] = db;
        flux[key] = Math.max(rise, flux[key] * Math.exp(-dt / .12));
        if (flux[key] < 1e-2) flux[key] = 0;
        // Bounded sustained (shrinks as the signal settles) + dB deviation,
        // which dominates: elevation above the adaptive baseline plus flux.
        // No output-side smoothing: features arrive pre-smoothed, deviation
        // has its own flux decay, and onsets must land exactly on the beat.
        const sustained = lift(Math.min(raw, 1.2)) * (1 - .35 * settled);
        const above = Math.max(0, db - baselineDb[key]);
        const dyn = Math.min(2.6, sustained + Math.min(1.1, above * .12) + Math.min(.8, flux[key] * .08));
        // Slider AFTER shaping (linear; zero is exactly silent), schema-capped.
        continuous[key] = Math.min(3.2, dyn * [bassGain, midGain, highGain][i]);
      }
      // Percussion envelopes: the references' direct mapping — canonical
      // transient features times the ASSOCIATED slider, clamped to the same
      // 1.4 envelope ceiling makeAudioFeatures/Ion Tempest use. Bass gates
      // kick+beat, mid gates snare, high gates hat; zero disables exactly.
      continuous.kick = Math.min(1.4, bounded(features?.kick, 0, 0, 1.4) * bassGain);
      continuous.snare = Math.min(1.4, bounded(features?.snare, 0, 0, 1.4) * midGain);
      continuous.hat = Math.min(1.4, bounded(features?.hat, 0, 0, 1.4) * highGain);
      continuous.beat = Math.min(1.4, bounded(features?.beat, 0, 0, 1.4) * bassGain);
      // Energy is the aggregate of the GATED level channels (Techno 3D /
      // Circles style: a plain linear combination of what each band actually
      // contributes). Muting a band removes exactly its share; all-zero
      // sliders give exactly zero.
      continuous.energy = Math.min(3.2,
        continuous.bass * .42 + continuous.mid * .38 + continuous.high * .2);
      return { continuous, arrays: {}, events: [] };
    },
    dispose() {
      Object.assign(baseline, SILENT_SUPPORT);
      Object.assign(baselineDb, { bass: -120, mid: -120, high: -120 });
      Object.assign(previous, { bass: -120, mid: -120, high: -120 });
      Object.assign(flux, SILENT_SUPPORT);
      Object.assign(primed, { bass: false, mid: false, high: false });
    },
  };
}
