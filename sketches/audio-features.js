// Musical feature extraction for the GPU DJ effects.
//
// The old sketches average fixed FFT-bin ranges. That is inexpensive, but it
// misses most kick/bass content, depends on the input sample rate, ignores the
// right channel, and cannot distinguish a sustained note from a new hit. This
// extractor works in Hz, mixes both channels in the power domain, applies slow
// input-level compensation, and derives short transient envelopes for kicks,
// snares and hats using spectral flux.

const MIN_DB = -120;
const EPSILON = 1e-8;

export const MUSICAL_BANDS = Object.freeze({
  sub: [30, 180],
  mid: [180, 2800],
  high: [2800, 16000],
  kick: [35, 180],
  snare: [180, 4200],
  hat: [4500, 16000],
});

const LEVEL_WINDOWS = Object.freeze({
  // Higher bands naturally carry less average power, so their useful window
  // begins lower. Input gain compensation is applied before these mappings.
  sub: [-64, -16],
  mid: [-70, -20],
  high: [-76, -24],
});

// Live bass|mid and mid|high crossover frequencies (Hz). The control panel's
// band-split EQ drags these; the screen applies them here so every effect's
// Bass / Mid / High responsiveness sliders act on the selected ranges. The
// defaults mirror MUSICAL_BANDS, so nothing changes until a handle moves.
const bandSplit = {
  low: MUSICAL_BANDS.sub[1], // 180 Hz
  high: MUSICAL_BANDS.mid[1], // 2800 Hz
};

// Drag limits for the EQ separators (kept in sync with the panel rendering).
export const BAND_SPLIT_LIMITS = Object.freeze({
  lowMin: 40,
  lowMax: 1200,
  highMin: 400,
  highMax: 15000,
  // The two crossovers must stay at least this ratio apart so the three
  // bands never collapse into each other.
  minRatio: 1.25,
});

export function getBandSplit() {
  return { low: bandSplit.low, high: bandSplit.high };
}

export function setBandSplit({ low, high } = {}) {
  const L = BAND_SPLIT_LIMITS;
  if (Number.isFinite(low)) bandSplit.low = clamp(low, L.lowMin, L.lowMax);
  if (Number.isFinite(high)) bandSplit.high = clamp(high, L.highMin, L.highMax);
  // Never allow an inverted split; push the bass crossover back down.
  if (bandSplit.high < bandSplit.low * L.minRatio) {
    bandSplit.low = bandSplit.high / L.minRatio;
  }
  return getBandSplit();
}

// Display window of the control panel's band-split EQ: log frequency axis and
// the dB range the spectrum curve is drawn in (Ableton-style).
export const EQ_MIN_HZ = 30;
export const EQ_MAX_HZ = 16000;
export const EQ_DB_TOP = -20;
export const EQ_DB_BOTTOM = -90;

// Resample an analysis frame into a compact log-spaced dB spectrum for the
// control panel EQ (the capture owner broadcasts it at ~15fps).
// Channels are mixed in the power domain exactly like the feature extractor.
export function computeLogSpectrum(frame, points = 96, minHz = EQ_MIN_HZ, maxHz = EQ_MAX_HZ) {
  const left = frame?.left;
  const right = frame?.right;
  if (!left?.length && !right?.length) return null;

  const binCount = Math.max(left?.length || 0, right?.length || 0);
  const sampleRate = Math.max(8000, Number(frame.sampleRate) || 48000);
  const fftSize = Math.max(binCount * 2, Number(frame.fftSize) || binCount * 2);
  const topHz = Math.min(maxHz, sampleRate * 0.48);

  const channelCount = left?.length && right?.length ? 2 : 1;
  const binDb = new Float32Array(binCount);
  for (let i = 0; i < binCount; i++) {
    let power = 0;
    if (left?.length) power += dbToPower(left[Math.min(i, left.length - 1)]);
    if (right?.length) power += dbToPower(right[Math.min(i, right.length - 1)]);
    binDb[i] = powerToDb(power / channelCount);
  }

  const freqs = new Float32Array(points);
  const dbs = new Float32Array(points);
  const binHz = sampleRate / fftSize;
  const logMin = Math.log(minHz);
  const logSpan = Math.log(topHz / minHz);
  for (let k = 0; k < points; k++) {
    const hz = Math.exp(logMin + (logSpan * k) / (points - 1));
    freqs[k] = hz;
    // Linear interpolation between bins keeps the low end (few bins per
    // octave) smooth on the log axis.
    const pos = hz / binHz;
    const i0 = Math.min(Math.floor(pos), binCount - 1);
    const i1 = Math.min(i0 + 1, binCount - 1);
    const frac = clamp(pos - i0, 0, 1);
    dbs[k] = binDb[i0] * (1 - frac) + binDb[i1] * frac;
  }
  return { freqs, dbs, minHz, maxHz: topHz };
}

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smoothstep = (edge0, edge1, value) => {
  const x = clamp((value - edge0) / Math.max(edge1 - edge0, EPSILON));
  return x * x * (3 - 2 * x);
};
const timeAlpha = (seconds, dt) => 1 - Math.exp(-dt / Math.max(seconds, 0.001));
const finiteDb = (value) => (Number.isFinite(value) ? Math.max(value, MIN_DB) : MIN_DB);
const dbToPower = (db) => Math.pow(10, finiteDb(db) / 10);
const powerToDb = (power) => 10 * Math.log10(Math.max(power, EPSILON * EPSILON));

function makeSilentFeatures() {
  return {
    sub: 0,
    mid: 0,
    high: 0,
    energy: 0,
    kick: 0,
    snare: 0,
    hat: 0,
    beat: 0,
    impact: 0,
    inputLevel: 0,
  };
}

function waveformRms(frame) {
  if (Number.isFinite(frame?.rms)) return clamp(frame.rms, 0, 1);

  const left = frame?.waveformLeft;
  const right = frame?.waveformRight;
  if (!left?.length && !right?.length) return null;

  let sum = 0;
  let samples = 0;
  if (left?.length) {
    for (let i = 0; i < left.length; i++) {
      const value = Number.isFinite(left[i]) ? left[i] : 0;
      sum += value * value;
    }
    samples += left.length;
  }
  if (right?.length) {
    for (let i = 0; i < right.length; i++) {
      const value = Number.isFinite(right[i]) ? right[i] : 0;
      sum += value * value;
    }
    samples += right.length;
  }
  return samples ? Math.sqrt(sum / samples) : null;
}

function follow(current, target, attackSeconds, releaseSeconds, dt) {
  const seconds = target > current ? attackSeconds : releaseSeconds;
  return current + (target - current) * timeAlpha(seconds, dt);
}

function rangeToBins(range, sampleRate, fftSize, binCount) {
  const binHz = sampleRate / fftSize;
  const nyquist = sampleRate * 0.5;
  const low = clamp(range[0], 0, nyquist);
  const high = clamp(range[1], low, nyquist);
  const start = clamp(Math.ceil(low / binHz), 1, Math.max(1, binCount - 1));
  const end = clamp(Math.floor(high / binHz), start, Math.max(start, binCount - 1));
  return [start, end];
}

function bandPower(spectrumPower, range, sampleRate, fftSize) {
  const [start, end] = rangeToBins(range, sampleRate, fftSize, spectrumPower.length);
  let sum = 0;
  for (let i = start; i <= end; i++) sum += spectrumPower[i];
  return sum / Math.max(1, end - start + 1);
}

function bandFlux(currentDb, previousDb, range, sampleRate, fftSize, gainDb) {
  if (!previousDb || previousDb.length !== currentDb.length) return 0;
  const [start, end] = rangeToBins(range, sampleRate, fftSize, currentDb.length);
  let sum = 0;
  for (let i = start; i <= end; i++) {
    // Ignore tiny analyser flutter and weight rises by audibility so a noisy
    // disconnected input cannot manufacture a stream of false beats.
    const riseDb = Math.max(0, currentDb[i] - previousDb[i] - 0.35);
    const audible = smoothstep(-84, -30, currentDb[i] + gainDb);
    sum += riseDb * audible;
  }
  return sum / Math.max(1, end - start + 1);
}

function onsetFromFlux(stat, flux, dt, gate) {
  const meanBeforeUpdate = stat.mean;
  const deviationBeforeUpdate = stat.deviation;
  const threshold = meanBeforeUpdate + Math.max(0.045, deviationBeforeUpdate * 0.8);
  const onsetWidth = Math.max(0.2, deviationBeforeUpdate * 3 + meanBeforeUpdate * 0.32);
  const onset = smoothstep(threshold, threshold + onsetWidth, flux) * gate;

  // Adapt slowly enough that one transient remains exceptional, but quickly
  // enough to follow a change from a breakdown into a dense drop.
  stat.mean += (flux - stat.mean) * timeAlpha(0.7, dt);
  const deviation = Math.abs(flux - stat.mean);
  stat.deviation += (deviation - stat.deviation) * timeAlpha(0.95, dt);
  return onset;
}

// ---------------------------------------------------------------------------
// Shared feature frame — single scan per update, reused across consumers
// ---------------------------------------------------------------------------
// Multiple sketches (LIVE + CUE, or a 2-way merge) consume the same analysis
// frame each tick. Computing the full spectral scan and transient envelopes
// twice wastes CPU and makes beat decisions diverge if instances have slightly
// different histories. getSharedFeatures computes one feature object per
// update and reuses it, so all consumers sharing the same frame see
// identical beat/band state with one scan.
const sharedFeatureCache = new WeakMap();
let sharedAnalyser = null;

export function getSharedFeatures(frame, params = {}, deltaSeconds = 1 / 60) {
  if (!frame) return null;
  const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 60, 1 / 240, 0.1);
  const key = JSON.stringify(params || {});
  const cached = sharedFeatureCache.get(frame);
  if (cached && Math.abs(cached.dt - dt) < 1e-9 && cached.key === key) {
    return { ...cached.features };
  }
  if (!sharedAnalyser) sharedAnalyser = makeAudioFeatures();
  const features = sharedAnalyser(frame, params, dt);
  sharedFeatureCache.set(frame, { dt, key, features: { ...features } });
  return { ...features };
}

export function clearSharedFeaturesCache() {
  sharedAnalyser = null;
}

// Returns a stateful analyser. Create one per running effect so its envelopes
// reset cleanly when the DJ switches looks.
export function makeAudioFeatures() {
  let currentDb = null;
  let previousDb = null;
  let spectrumPower = null;
  let frameCount = 0;
  let elapsed = 0;
  let lastBeatAt = -10;
  let autoGainDb = 0;
  let gainInitialized = false;

  const levels = { sub: 0, mid: 0, high: 0, energy: 0 };
  const envelopes = { kick: 0, snare: 0, hat: 0, beat: 0 };
  const fluxStats = {
    kick: { mean: 0, deviation: 0 },
    snare: { mean: 0, deviation: 0 },
    hat: { mean: 0, deviation: 0 },
  };

  // Per-instance memo: dedup repeated calls with same frame object & dt &
  // params within the same tick so a single analyser doesn't double-scan
  // if called twice with the same frame (e.g., two uniforms reading it).
  let lastFrame = null;
  let lastDt = null;
  let lastKey = null;
  let lastOut = null;

  return (frame, params = {}, deltaSeconds = 1 / 60) => {
    const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 60, 1 / 240, 0.1);
    const key = JSON.stringify(params || {});
    if (frame && frame === lastFrame && dt === lastDt && key === lastKey && lastOut) {
      return { ...lastOut };
    }

    const left = frame?.left;
    const right = frame?.right;
    if (!left?.length && !right?.length) {
      elapsed += dt;
      levels.sub = follow(levels.sub, 0, 0.02, 0.16, dt);
      levels.mid = follow(levels.mid, 0, 0.025, 0.2, dt);
      levels.high = follow(levels.high, 0, 0.012, 0.11, dt);
      levels.energy = follow(levels.energy, 0, 0.025, 0.22, dt);
      envelopes.kick *= Math.exp(-dt / 0.16);
      envelopes.snare *= Math.exp(-dt / 0.12);
      envelopes.hat *= Math.exp(-dt / 0.075);
      envelopes.beat *= Math.exp(-dt / 0.21);
      const out = {
        ...makeSilentFeatures(),
        sub: levels.sub,
        mid: levels.mid,
        high: levels.high,
        energy: levels.energy,
        kick: envelopes.kick,
        snare: envelopes.snare,
        hat: envelopes.hat,
        beat: envelopes.beat,
        impact: Math.max(envelopes.kick, envelopes.snare * 0.72, envelopes.hat * 0.42),
      };
      lastFrame = frame;
      lastDt = dt;
      lastKey = key;
      lastOut = out;
      return { ...out };
    }

    const binCount = Math.max(left?.length || 0, right?.length || 0);
    if (!currentDb || currentDb.length !== binCount) {
      currentDb = new Float32Array(binCount);
      previousDb = null;
      spectrumPower = new Float32Array(binCount);
      frameCount = 0;
    }

    elapsed += dt;

    const channelCount = left?.length && right?.length ? 2 : 1;
    for (let i = 0; i < binCount; i++) {
      let power = 0;
      if (left?.length) power += dbToPower(left[Math.min(i, left.length - 1)]);
      if (right?.length) power += dbToPower(right[Math.min(i, right.length - 1)]);
      power /= channelCount;
      spectrumPower[i] = power;
      currentDb[i] = powerToDb(power);
    }

    const sampleRate = Math.max(8000, Number(frame.sampleRate) || 48000);
    const fftSize = Math.max(binCount * 2, Number(frame.fftSize) || binCount * 2);
    const spectrumRms = Math.sqrt(bandPower(
      spectrumPower,
      [30, Math.min(16000, sampleRate * 0.48)],
      sampleRate,
      fftSize,
    ));
    // waveformRms respects frame.rms override; noise-floor's applyNoiseFloor
    // cleans both spectral bins and waveform RMS so this path is noise-gated.
    const rms = waveformRms(frame) ?? spectrumRms;
    const rmsDb = 20 * Math.log10(Math.max(rms, EPSILON));

    // Normalize ordinary microphones, interfaces and line inputs toward the
    // same working level. Gain falls quickly to avoid clipping but rises slowly
    // so quiet passages retain their dynamics instead of visibly pumping.
    if (rmsDb > -72) {
      const targetGainDb = clamp(-20 - rmsDb, -12, 30);
      if (!gainInitialized) {
        autoGainDb = targetGainDb;
        gainInitialized = true;
      } else {
        const gainTime = targetGainDb < autoGainDb ? 0.4 : 2.4;
        autoGainDb += (targetGainDb - autoGainDb) * timeAlpha(gainTime, dt);
      }
    }

    const silenceGate = smoothstep(-72, -48, rmsDb);
    const rawLevels = {};
    // Band ranges follow the live band-split crossovers (defaults match
    // MUSICAL_BANDS). Kick/snare/hat transient detectors keep their fixed
    // musical ranges — only the sustained Bass/Mid/High levels retune.
    const split = getBandSplit();
    const splitRanges = {
      sub: [MUSICAL_BANDS.sub[0], split.low],
      mid: [split.low, split.high],
      high: [split.high, MUSICAL_BANDS.high[1]],
    };
    for (const name of ['sub', 'mid', 'high']) {
      const db = powerToDb(bandPower(spectrumPower, splitRanges[name], sampleRate, fftSize));
      const [quietDb, loudDb] = LEVEL_WINDOWS[name];
      rawLevels[name] = smoothstep(quietDb, loudDb, db + autoGainDb) * silenceGate;
    }

    levels.sub = follow(levels.sub, rawLevels.sub, 0.022, 0.17, dt);
    levels.mid = follow(levels.mid, rawLevels.mid, 0.03, 0.2, dt);
    levels.high = follow(levels.high, rawLevels.high, 0.012, 0.1, dt);

    const loudness = smoothstep(-58, -14, rmsDb + autoGainDb) * silenceGate;
    const energyTarget = (
      rawLevels.sub * 0.42
      + rawLevels.mid * 0.36
      + rawLevels.high * 0.14
      + loudness * 0.08
    );
    levels.energy = follow(levels.energy, energyTarget, 0.028, 0.22, dt);

    let kickOnset = 0;
    let snareOnset = 0;
    let hatOnset = 0;
    if (previousDb && frameCount > 2) {
      const kickFlux = bandFlux(currentDb, previousDb, MUSICAL_BANDS.kick, sampleRate, fftSize, autoGainDb);
      const snareFlux = bandFlux(currentDb, previousDb, MUSICAL_BANDS.snare, sampleRate, fftSize, autoGainDb);
      const hatFlux = bandFlux(currentDb, previousDb, MUSICAL_BANDS.hat, sampleRate, fftSize, autoGainDb);
      kickOnset = onsetFromFlux(fluxStats.kick, kickFlux, dt, silenceGate * (0.3 + rawLevels.sub * 0.7));
      snareOnset = onsetFromFlux(fluxStats.snare, snareFlux, dt, silenceGate * (0.25 + rawLevels.mid * 0.75));
      hatOnset = onsetFromFlux(fluxStats.hat, hatFlux, dt, silenceGate * (0.2 + rawLevels.high * 0.8));
    } else {
      // Prime adaptive thresholds without treating the first live frame as a hit.
      for (const name of ['kick', 'snare', 'hat']) {
        const flux = previousDb
          ? bandFlux(currentDb, previousDb, MUSICAL_BANDS[name], sampleRate, fftSize, autoGainDb)
          : 0;
        onsetFromFlux(fluxStats[name], flux, dt, 0);
      }
    }

    envelopes.kick = Math.max(kickOnset, envelopes.kick * Math.exp(-dt / 0.16));
    envelopes.snare = Math.max(snareOnset, envelopes.snare * Math.exp(-dt / 0.12));
    envelopes.hat = Math.max(hatOnset, envelopes.hat * Math.exp(-dt / 0.075));

    // A short refractory period prevents one kick tail from generating several
    // scene-wide beat pulses while remaining fast enough for 1/16-note doubles.
    if (kickOnset > 0.42 && elapsed - lastBeatAt > 0.115) {
      envelopes.beat = 1;
      lastBeatAt = elapsed;
    } else {
      envelopes.beat *= Math.exp(-dt / 0.21);
    }

    if (!previousDb || previousDb.length !== binCount) previousDb = new Float32Array(binCount);
    previousDb.set(currentDb);
    frameCount += 1;

    const bassGain = Math.max(0, Number(params.bass ?? 1));
    const midGain = Math.max(0, Number(params.mid ?? 1));
    const highGain = Math.max(0, Number(params.high ?? 1));
    const punch = Math.max(0, Number(params.punch ?? 1));
    const sub = clamp(levels.sub * bassGain, 0, 1.6);
    const mid = clamp(levels.mid * midGain, 0, 1.6);
    const high = clamp(levels.high * highGain, 0, 1.6);
    const kick = clamp(envelopes.kick * bassGain * punch, 0, 1.4);
    const snare = clamp(envelopes.snare * midGain * punch, 0, 1.4);
    const hat = clamp(envelopes.hat * highGain * punch, 0, 1.4);
    const beat = clamp(envelopes.beat * bassGain * punch, 0, 1.4);
    const energy = clamp(
      levels.energy * (bassGain * 0.42 + midGain * 0.38 + highGain * 0.2),
      0,
      1.6,
    );

    const out = {
      sub,
      mid,
      high,
      energy,
      kick,
      snare,
      hat,
      beat,
      impact: Math.max(kick, snare * 0.72, hat * 0.42),
      inputLevel: clamp(smoothstep(-60, -10, rmsDb + autoGainDb), 0, 1),
    };
    lastFrame = frame;
    lastDt = dt;
    lastKey = key;
    lastOut = out;
    return { ...out };
  };
}
