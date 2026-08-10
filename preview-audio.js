// A lightweight audio facade for the in-panel preview stage.
//
// The actual screen window owns microphone capture. It broadcasts cleaned
// analysis frames to control windows, which are consumed here. Before a screen
// (or audio input) is available, this class supplies a deterministic musical
// idle signal so every legacy and WebGL visual can be previewed instead of
// rendering a blank canvas.

const SAMPLE_RATE = 48_000;
const FFT_SIZE = 2_048;
const FREQ_BINS = FFT_SIZE / 2;
const WAVE_SAMPLES = FFT_SIZE;
const MIN_DB = -100;
const MAX_DB = -30;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const dbToByte = (db) => Math.round(clamp(((Number.isFinite(db) ? db : MIN_DB) - MIN_DB) / (MAX_DB - MIN_DB), 0, 1) * 255);
const waveToByte = (sample) => Math.round(clamp((Number.isFinite(sample) ? sample : 0) * 128 + 128, 0, 255));

export class PreviewAudio {
  constructor() {
    // Legacy sketches gate their draw loops on this flag. Keep it true so the
    // preview stays active with the musical idle signal while no screen exists.
    this.isStarted = true;
    this.liveFrame = null;
    this.liveFrameAt = 0;
    this.lastFrequencyFrame = null;
    this.lastWaveformFrame = null;

    this.frequencyLeft = new Uint8Array(FREQ_BINS);
    this.frequencyRight = new Uint8Array(FREQ_BINS);
    this.waveformLeft = new Uint8Array(WAVE_SAMPLES);
    this.waveformRight = new Uint8Array(WAVE_SAMPLES);

    this.idleFrame = {
      left: new Float32Array(FREQ_BINS),
      right: new Float32Array(FREQ_BINS),
      waveformLeft: new Float32Array(WAVE_SAMPLES),
      waveformRight: new Float32Array(WAVE_SAMPLES),
      sampleRate: SAMPLE_RATE,
      fftSize: FFT_SIZE,
      time: 0,
    };
    this.idleAmplitude = { left: 0, right: 0 };
  }

  // BroadcastChannel clones the typed arrays for us, so retaining this frame is
  // safe and keeps the preview tied to the screen's cleaned analysis data.
  setFrame(frame) {
    if (!frame || (!frame.left?.length && !frame.right?.length)) return;

    this.liveFrame = {
      left: frame.left,
      right: frame.right,
      waveformLeft: frame.waveformLeft,
      waveformRight: frame.waveformRight,
      sampleRate: Number(frame.sampleRate) || SAMPLE_RATE,
      fftSize: Number(frame.fftSize) || FFT_SIZE,
      time: Number(frame.time) || performance.now() / 1000,
    };
    this.liveFrameAt = performance.now();
    this.lastFrequencyFrame = null;
    this.lastWaveformFrame = null;
  }

  hasLiveFrame() {
    // A screen broadcasts about 15 analysis frames per second. Give the stream
    // a short grace period so an occasional dropped message does not make the
    // preview visibly jump back to its idle choreography.
    return !!this.liveFrame && performance.now() - this.liveFrameAt < 1_500;
  }

  getAnalysisFrame() {
    if (this.hasLiveFrame()) return this.liveFrame;
    this.updateIdleFrame();
    return this.idleFrame;
  }

  getFrequencies() {
    const frame = this.getAnalysisFrame();
    if (frame === this.idleFrame) {
      // updateIdleFrame already filled the byte-domain buffers.
      return { left: this.frequencyLeft, right: this.frequencyRight };
    }

    if (this.lastFrequencyFrame !== frame) {
      this.copyFrequencyChannel(frame.left, this.frequencyLeft);
      this.copyFrequencyChannel(frame.right || frame.left, this.frequencyRight);
      this.lastFrequencyFrame = frame;
    }
    return { left: this.frequencyLeft, right: this.frequencyRight };
  }

  getWaveforms() {
    const frame = this.getAnalysisFrame();
    if (frame === this.idleFrame) {
      return { left: this.waveformLeft, right: this.waveformRight };
    }

    if (this.lastWaveformFrame !== frame) {
      this.copyWaveformChannel(frame.waveformLeft, this.waveformLeft);
      this.copyWaveformChannel(frame.waveformRight || frame.waveformLeft, this.waveformRight);
      this.lastWaveformFrame = frame;
    }
    return { left: this.waveformLeft, right: this.waveformRight };
  }

  getAmplitudes() {
    const frame = this.getAnalysisFrame();
    if (frame === this.idleFrame) return this.idleAmplitude;
    return {
      left: this.waveformAmplitude(frame.waveformLeft),
      right: this.waveformAmplitude(frame.waveformRight || frame.waveformLeft),
    };
  }

  // Preview canvases call p.mousePressed(), which asks their audio provider to
  // resume. The screen owns real capture, so this intentionally stays a no-op.
  resume() {
    return Promise.resolve();
  }

  copyFrequencyChannel(source, target) {
    if (!source?.length) {
      target.fill(0);
      return;
    }
    for (let i = 0; i < target.length; i++) {
      target[i] = dbToByte(source[Math.min(i, source.length - 1)]);
    }
  }

  copyWaveformChannel(source, target) {
    if (!source?.length) {
      target.fill(128);
      return;
    }
    for (let i = 0; i < target.length; i++) {
      target[i] = waveToByte(source[Math.min(i, source.length - 1)]);
    }
  }

  waveformAmplitude(source) {
    if (!source?.length) return 0;
    let sum = 0;
    for (let i = 0; i < source.length; i++) {
      const sample = Number.isFinite(source[i]) ? source[i] : 0;
      sum += sample * sample;
    }
    return Math.sqrt(sum / source.length);
  }

  updateIdleFrame() {
    const time = performance.now() / 1000;
    const kick = Math.pow(Math.max(0, Math.sin(time * Math.PI * 2 * 1.9)), 8);
    const snare = Math.pow(Math.max(0, Math.sin(time * Math.PI * 2 * 0.95 + 2.4)), 10);
    const hat = Math.pow(Math.max(0, Math.sin(time * Math.PI * 2 * 3.8 + 0.8)), 14);
    const sweep = 0.5 + 0.5 * Math.sin(time * 0.91);

    const frame = this.idleFrame;
    frame.time = time;

    for (let i = 0; i < FREQ_BINS; i++) {
      const normalized = i / Math.max(1, FREQ_BINS - 1);
      const low = Math.exp(-normalized * 18) * (12 + kick * 56);
      const mids = Math.exp(-Math.pow((normalized - 0.09 - sweep * 0.09) * 12, 2)) * (8 + snare * 38);
      const highs = Math.exp(-Math.pow((normalized - 0.44) * 4.2, 2)) * (3 + hat * 29);
      const shimmer = (0.5 + 0.5 * Math.sin(i * 0.17 + time * 8)) * (2 + hat * 8);
      const db = clamp(-92 + low + mids + highs + shimmer, MIN_DB, -12);
      const rightDb = clamp(db + Math.sin(i * 0.045 + time * 1.7) * 3.5, MIN_DB, -12);
      frame.left[i] = db;
      frame.right[i] = rightDb;
      this.frequencyLeft[i] = dbToByte(db);
      this.frequencyRight[i] = dbToByte(rightDb);
    }

    let sumLeft = 0;
    let sumRight = 0;
    for (let i = 0; i < WAVE_SAMPLES; i++) {
      const phase = i / WAVE_SAMPLES;
      const left = (
        Math.sin((phase * 2 + time * 1.9) * Math.PI * 2) * (0.1 + kick * 0.58)
        + Math.sin((phase * 7 + time * 3.8) * Math.PI * 2) * (0.025 + snare * 0.16)
        + Math.sin((phase * 33 + time * 7.6) * Math.PI * 2) * hat * 0.05
      );
      const right = (
        Math.sin((phase * 2 + time * 1.9 + 0.15) * Math.PI * 2) * (0.1 + kick * 0.52)
        + Math.sin((phase * 9 + time * 3.3) * Math.PI * 2) * (0.025 + snare * 0.14)
        + Math.sin((phase * 27 + time * 8.2) * Math.PI * 2) * hat * 0.06
      );
      frame.waveformLeft[i] = clamp(left, -1, 1);
      frame.waveformRight[i] = clamp(right, -1, 1);
      this.waveformLeft[i] = waveToByte(left);
      this.waveformRight[i] = waveToByte(right);
      sumLeft += left * left;
      sumRight += right * right;
    }

    this.idleAmplitude.left = Math.sqrt(sumLeft / WAVE_SAMPLES);
    this.idleAmplitude.right = Math.sqrt(sumRight / WAVE_SAMPLES);
  }
}
