// A lightweight compatibility audio facade retained for sketch APIs and status.
//
// Control-panel previews use the default musical idle signal when no input is
// available. Output screens construct the same facade with `idleSignal: false`,
// then mark it active when compact pattern controls arrive.

const SAMPLE_RATE = 48_000;
const FFT_SIZE = 2_048;
const FREQ_BINS = FFT_SIZE / 2;
// AudioManager's legacy byte-waveform API uses analyser.frequencyBinCount,
// while high-resolution analysis frames retain the full FFT window.
const WAVE_SAMPLES = FFT_SIZE / 2;
const MIN_DB = -100;
const MAX_DB = -30;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const dbToByte = (db) => Math.round(clamp(((Number.isFinite(db) ? db : MIN_DB) - MIN_DB) / (MAX_DB - MIN_DB), 0, 1) * 255);
const waveToByte = (sample) => Math.round(clamp((Number.isFinite(sample) ? sample : 0) * 128 + 128, 0, 255));

export class PreviewAudio {
  constructor({ idleSignal = true, staleAfterMs = 1_500 } = {}) {
    this.idleSignal = Boolean(idleSignal);
    this.staleAfterMs = Math.max(100, Number(staleAfterMs) || 1_500);
    // Legacy sketch branches gate their draw loops on this flag. Panel previews
    // remain active with the idle signal; output screens become active when a
    // matching controls packet confirms active capture.
    this.isStarted = this.idleSignal;
    this.liveFrame = null;
    this.liveFrameAt = 0;
    this.lastFrequencyFrame = null;
    this.lastWaveformFrame = null;
    // Owner/sequence validation to reject stale/out-of-order frames
    this._seq = -1;
    this._owner = null;

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
    // This neutral sentinel keeps the compatibility facade observably alive for
    // status and diagnostics after capture is active, without exposing FFT data
    // to renderers (which consume their pattern-controls bindings instead).
    this.controlFrame = {
      left: new Float32Array(FREQ_BINS),
      right: new Float32Array(FREQ_BINS),
      waveformLeft: new Float32Array(WAVE_SAMPLES),
      waveformRight: new Float32Array(WAVE_SAMPLES),
      sampleRate: SAMPLE_RATE,
      fftSize: FFT_SIZE,
      time: 0,
      patternControlsOnly: true,
    };
    this.idleAmplitude = { left: 0, right: 0 };
  }

  // Retained for direct compatibility callers; the application no longer feeds
  // complete analysis frames into this facade over BroadcastChannel.
  setFrame(frame, sequence, ownerId) {
    if (!frame || (!frame.left?.length && !frame.right?.length)) return;

    // Resolve sequence/owner from explicit args or frame metadata
    let seq = null;
    let owner = null;
    if (Number.isFinite(sequence)) seq = Number(sequence);
    else if (Number.isFinite(frame.sequence)) seq = Number(frame.sequence);
    else if (Number.isFinite(frame.seq)) seq = Number(frame.seq);
    else if (Number.isFinite(frame.time) && Number.isFinite(this.liveFrame?.time) && !this._isFrameStale()) {
      // Use time as monotonic sequence when no explicit sequence.
      // Only apply when the previous frame is still fresh; after a stale
      // expiry (e.g. owning control reloads and currentTime resets near 0),
      // accept the first fresh frame regardless of its time value.
      if (frame.time < this.liveFrame.time) return;
    }

    if (ownerId) owner = String(ownerId);
    else if (frame.ownerId) owner = String(frame.ownerId);
    else if (frame.deviceId) owner = String(frame.deviceId);

    // Validate sequence monotonicity
    if (seq !== null) {
      if (seq <= this._seq) return;
      this._seq = seq;
    }

    if (owner !== null) this._owner = owner;

    this.liveFrame = {
      left: frame.left,
      right: frame.right,
      waveformLeft: frame.waveformLeft,
      waveformRight: frame.waveformRight,
      sampleRate: Number(frame.sampleRate) || SAMPLE_RATE,
      fftSize: Number(frame.fftSize) || FFT_SIZE,
      time: Number(frame.time) || performance.now() / 1000,
      rms: Number.isFinite(frame.rms) ? frame.rms : undefined,
      sequence: seq,
      ownerId: owner,
    };
    this.liveFrameAt = performance.now();
    this.lastFrequencyFrame = null;
    this.lastWaveformFrame = null;
    this.isStarted = true;
  }

  // Mark a receiver as connected to an active capture stream when compact
  // controls arrive. The neutral sentinel supports compatibility status without
  // exposing capture data to a renderer.
  setControlActive() {
    const now = performance.now();
    if (this.liveFrame && this.liveFrame !== this.controlFrame && !this._isFrameStale()) {
      this.isStarted = true;
      return;
    }
    this.controlFrame.time = now / 1000;
    this.liveFrame = this.controlFrame;
    this.liveFrameAt = now;
    this.lastFrequencyFrame = null;
    this.lastWaveformFrame = null;
    this.isStarted = true;
  }

  clearFrame() {
    this.liveFrame = null;
    this.liveFrameAt = 0;
    this.lastFrequencyFrame = null;
    this.lastWaveformFrame = null;
    this.isStarted = this.idleSignal;
    this._seq = -1;
    this._owner = null;
  }

  hasLiveFrame() {
    // Allow a short grace period so an occasional dropped message does not make
    // previews jump to idle or output screens briefly stop reacting.
    const live = !!this.liveFrame && performance.now() - this.liveFrameAt < this.staleAfterMs;
    if (!live) {
      if (!this.idleSignal) this.isStarted = false;
      // Expire stale frame so getters fall back to neutral values instead of hot data
      if (this.liveFrame && performance.now() - this.liveFrameAt >= this.staleAfterMs) {
        this.lastFrequencyFrame = null;
        this.lastWaveformFrame = null;
      }
    }
    return live;
  }

  _isFrameStale() {
    return !this.liveFrame || performance.now() - this.liveFrameAt >= this.staleAfterMs;
  }

  getAnalysisFrame() {
    if (this.hasLiveFrame()) return this.liveFrame;
    if (!this.idleSignal) return null;
    this.updateIdleFrame();
    return this.idleFrame;
  }

  getFrequencies() {
    const frame = this.getAnalysisFrame();
    if (!frame) return null;
    // When stale, hasLiveFrame already expired; for idleSignal true we return idle, for false we returned null above.
    // Additional TTL guard: if liveFrame is stale, ensure we don't return hot cached bytes
    if (frame !== this.idleFrame && this._isFrameStale()) {
      // Fall back to neutral zeros rather than hot stale data
      this.frequencyLeft.fill(0);
      this.frequencyRight.fill(0);
      return { left: this.frequencyLeft, right: this.frequencyRight };
    }
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
    if (!frame) return null;
    if (frame !== this.idleFrame && this._isFrameStale()) {
      this.waveformLeft.fill(128);
      this.waveformRight.fill(128);
      return { left: this.waveformLeft, right: this.waveformRight };
    }
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
    if (!frame || frame === this.idleFrame) return this.idleAmplitude;
    if (this._isFrameStale()) {
      // Fall back to neutral zeros when stale, not hot amplitude
      return { left: 0, right: 0 };
    }
    return {
      left: this.waveformAmplitude(frame.waveformLeft),
      right: this.waveformAmplitude(frame.waveformRight || frame.waveformLeft),
    };
  }

  // Sketch canvases may ask their audio provider to resume. Real Web Audio lives
  // in the capture-owning control window, so a frame receiver is always a no-op.
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
    // TTL: if underlying live frame is stale, return neutral 0 instead of stale hot value
    if (this._isFrameStale() && this.liveFrame && source === this.liveFrame.waveformLeft) return 0;
    if (this._isFrameStale() && this.liveFrame && source === this.liveFrame.waveformRight) return 0;
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
