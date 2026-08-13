import { feedNoiseCapture, applyNoiseFloor } from './noise-floor.js';

export class AudioManager {
  constructor() {
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;
    this.dataArrayL = null;
    this.dataArrayR = null;
    this.freqDataL = null;
    this.freqDataR = null;
    this.floatWaveDataL = null;
    this.floatWaveDataR = null;
    this.floatFreqDataL = null;
    this.floatFreqDataR = null;
    this.isStarted = false;
    this.fftSize = 2048;
    this.requestToken = 0;
    this.resumePromise = null;
    this.requestedDeviceId = null;
    this.activeDeviceId = null;
    this.usedFallback = false;
    this.lastError = null;
    this.onStatusChange = null;
    this.lastStatus = {
      status: 'idle',
      state: 'closed',
      deviceId: null,
      activeDeviceId: null,
      fallback: false,
    };
  }

  setStatusListener(listener) {
    this.onStatusChange = typeof listener === 'function' ? listener : null;
    if (this.onStatusChange) this.onStatusChange(this.getStatus());
  }

  getStatus() {
    return { ...this.lastStatus };
  }

  reportStatus(status, extra = {}) {
    const previous = this.lastStatus;
    const next = {
      status,
      state: this.getState(),
      deviceId: this.requestedDeviceId,
      activeDeviceId: this.activeDeviceId,
      fallback: this.usedFallback,
      ...extra,
    };
    this.lastStatus = next;

    // getAnalysisFrame may retry resume() every frame while autoplay is blocked.
    // Do not flood BroadcastChannel with an unchanged "suspended" status.
    const changed = !previous
      || previous.status !== next.status
      || previous.state !== next.state
      || previous.deviceId !== next.deviceId
      || previous.activeDeviceId !== next.activeDeviceId
      || previous.fallback !== next.fallback
      || previous.error?.name !== next.error?.name
      || previous.error?.message !== next.error?.message;
    if (changed && this.onStatusChange) this.onStatusChange(this.getStatus());
  }

  reportContextStatus(extra = {}) {
    const state = this.getState();
    const status = state === 'running'
      ? 'running'
      : (state === 'suspended' || state === 'interrupted' ? 'suspended' : 'stopped');
    this.reportStatus(status, extra);
  }

  _disconnectGraph() {
    try { this.source?.disconnect(); } catch {}
    try { this.splitter?.disconnect(); } catch {}
    try { this.analyserL?.disconnect(); } catch {}
    try { this.analyserR?.disconnect(); } catch {}
    // fft is the analyser in this graph; disconnecting analyser covers it
  }

  async releaseCurrentStream() {
    this.isStarted = false;
    this._disconnectGraph();
    if (this.stream) {
      const stream = this.stream;
      this.stream = null;
      stream.getTracks().forEach((track) => track.stop());
    }
    if (this.audioContext) {
      const context = this.audioContext;
      this.audioContext = null;
      context.onstatechange = null;
      await context.close().catch(() => {});
    }
    this.resumePromise = null;
    this.source = null;
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;
    this.activeDeviceId = null;
  }

  configureAnalyser(analyser) {
    analyser.fftSize = this.fftSize;
    // The browser default (0.8) plus each sketch's own envelope caused almost
    // a second of visible lag. Keep only light anti-jitter smoothing here; the
    // musical feature extractor owns attack/release timing.
    analyser.smoothingTimeConstant = 0.12;
    // Preserve the browser's traditional byte-spectrum scale for the legacy
    // sketches; the new feature path reads unclipped float dB values.
    analyser.minDecibels = -100;
    analyser.maxDecibels = -30;
  }

  allocateBuffers() {
    const frequencyBins = this.analyserL.frequencyBinCount;
    // Keep the legacy waveform length stable while the analysis path receives
    // the full FFT window in its dedicated float buffers.
    this.dataArrayL = new Uint8Array(frequencyBins);
    this.dataArrayR = new Uint8Array(frequencyBins);
    this.freqDataL = new Uint8Array(frequencyBins);
    this.freqDataR = new Uint8Array(frequencyBins);
    this.floatWaveDataL = new Float32Array(this.fftSize);
    this.floatWaveDataR = new Float32Array(this.fftSize);
    this.floatFreqDataL = new Float32Array(frequencyBins);
    this.floatFreqDataR = new Float32Array(frequencyBins);
  }

  audioConstraints(deviceId, exact = true) {
    const audio = {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
      channelCount: { ideal: 2 },
    };
    if (exact && deviceId) audio.deviceId = { exact: deviceId };
    return { audio };
  }

  async startStream(deviceId) {
    const token = ++this.requestToken;
    this.requestedDeviceId = deviceId || null;
    this.usedFallback = false;
    this.lastError = null;
    this.reportStatus('starting');
    await this.releaseCurrentStream();

    let stream = null;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia(this.audioConstraints(deviceId));
      } catch (err) {
        // Persisted device ids can become stale after an interface is unplugged,
        // the browser restarts, or permissions are reset. Recover with the
        // default input rather than leaving the EQ silently stuck forever.
        const canFallback = deviceId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError');
        if (!canFallback) throw err;
        // If a newer start/stop has superseded this request, do not attempt fallback
        if (token !== this.requestToken) throw err;
        this.usedFallback = true;
        stream = await navigator.mediaDevices.getUserMedia(this.audioConstraints(null, false));
      }

      if (token !== this.requestToken) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Web Audio is not supported by this browser.');

      const context = new AudioContextClass({ latencyHint: 'interactive' });
      const source = context.createMediaStreamSource(stream);
      const splitter = context.createChannelSplitter(2);
      const analyserL = context.createAnalyser();
      const analyserR = context.createAnalyser();
      this.configureAnalyser(analyserL);
      this.configureAnalyser(analyserR);

      source.connect(splitter);
      splitter.connect(analyserL, 0);

      // Many DJ interfaces advertise one channel even when stereo was
      // requested. Mirror channel 1 in that case instead of feeding every
      // right-channel-aware effect a silent spectrum.
      const audioTrack = stream.getAudioTracks()[0];
      const settings = audioTrack?.getSettings?.() || {};
      const channelCount = settings.channelCount || 1;
      const activeDeviceId = settings.deviceId || null;
      splitter.connect(analyserR, channelCount > 1 ? 1 : 0);

      // Wire to instance only after confirming token is still current, to avoid
      // a stale async start replacing the current input. If we lost the race,
      // destroy the losing acquisition fully before returning.
      if (token !== this.requestToken) {
        try { source.disconnect(); } catch {}
        try { splitter.disconnect(); } catch {}
        try { analyserL.disconnect(); } catch {}
        try { analyserR.disconnect(); } catch {}
        stream.getTracks().forEach((track) => track.stop());
        await context.close().catch(() => {});
        return false;
      }

      this.audioContext = context;
      this.stream = stream;
      this.source = source;
      this.splitter = splitter;
      this.analyserL = analyserL;
      this.analyserR = analyserR;
      this.activeDeviceId = activeDeviceId;
      this.allocateBuffers();

      // Final token check after wiring: a concurrent stop/start may have
      // incremented the token while we were wiring. Destroy the stale graph
      // before it leaks the microphone.
      if (token !== this.requestToken) {
        this._disconnectGraph();
        const staleStream = this.stream;
        const staleContext = this.audioContext;
        this.stream = null;
        this.audioContext = null;
        this.source = null;
        this.splitter = null;
        this.analyserL = null;
        this.analyserR = null;
        this.isStarted = false;
        this.activeDeviceId = null;
        if (staleStream) staleStream.getTracks().forEach((t) => t.stop());
        if (staleContext) {
          staleContext.onstatechange = null;
          await staleContext.close().catch(() => {});
        }
        return false;
      }

      this.audioContext.onstatechange = () => {
        if (token === this.requestToken && this.audioContext) this.reportContextStatus();
      };
      if (audioTrack) {
        audioTrack.addEventListener('ended', () => {
          if (token !== this.requestToken || this.stream !== stream) return;
          this.isStarted = false;
          this.reportStatus('error', {
            error: { name: 'DeviceEndedError', message: 'The selected audio input disconnected.' },
          });
        }, { once: true });
      }

      this.isStarted = true;
      this.reportContextStatus();
      // getUserMedia often permits this immediately. If autoplay policy keeps
      // it suspended, a trusted click/key in the owning control calls resume(true).
      this.resume();
      return token === this.requestToken && this.isStarted;
    } catch (err) {
      if (stream && stream !== this.stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      // A superseded request must not tear down a newer stream that has
      // already finished connecting.
      if (token === this.requestToken) {
        await this.releaseCurrentStream();
        this.lastError = {
          name: err?.name || 'AudioError',
          message: err?.message || 'Unable to start the selected audio input.',
          constraint: err?.constraint || null,
        };
        this.reportStatus('error', { error: this.lastError });
        console.error('Error starting audio stream:', err);
      }
      return false;
    }
  }

  stop() {
    this.requestToken += 1;
    this.isStarted = false;
    this._disconnectGraph();
    if (this.stream) {
      const stream = this.stream;
      this.stream = null;
      stream.getTracks().forEach((track) => track.stop());
    }
    if (this.audioContext) {
      const context = this.audioContext;
      this.audioContext = null;
      context.onstatechange = null;
      context.close().catch(() => {});
    }
    this.resumePromise = null;
    this.source = null;
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;
    this.activeDeviceId = null;
    this.reportStatus('stopped');
  }

  resume(force = false) {
    const state = this.audioContext?.state;
    if (this.audioContext && (state === 'suspended' || state === 'interrupted')) {
      // A genuine screen interaction gets a fresh resume call even if an earlier
      // autoplay-blocked promise is still pending.
      if (force || navigator.userActivation?.isActive) this.resumePromise = null;
      if (!this.resumePromise) {
        const context = this.audioContext;
        this.resumePromise = context.resume()
          .catch(() => {})
          .finally(() => {
            if (this.audioContext === context) {
              this.resumePromise = null;
              this.reportContextStatus();
            }
          });
      }
      return this.resumePromise;
    }
    if (this.audioContext) this.reportContextStatus();
    return Promise.resolve();
  }

  getState() {
    return this.audioContext ? this.audioContext.state : 'closed';
  }

  getWaveforms() {
    if (!this.isStarted || !this.analyserL || !this.analyserR) return null;
    this.analyserL.getByteTimeDomainData(this.dataArrayL);
    this.analyserR.getByteTimeDomainData(this.dataArrayR);
    return { left: this.dataArrayL, right: this.dataArrayR };
  }

  getFrequencies() {
    if (!this.isStarted || !this.analyserL || !this.analyserR) return null;
    this.analyserL.getByteFrequencyData(this.freqDataL);
    this.analyserR.getByteFrequencyData(this.freqDataR);
    return { left: this.freqDataL, right: this.freqDataR };
  }

  // High-resolution snapshot used by the newer shader effects. Float dB data
  // preserves low-level detail needed for adaptive gain and spectral-flux hit
  // detection; waveform data supplies a reliable silence gate and input RMS.
  getAnalysisFrame() {
    if (!this.isStarted || !this.audioContext || !this.analyserL || !this.analyserR) return null;
    if (this.audioContext.state !== 'running') {
      this.resume();
      return null;
    }

    this.analyserL.getFloatFrequencyData(this.floatFreqDataL);
    this.analyserR.getFloatFrequencyData(this.floatFreqDataR);
    this.analyserL.getFloatTimeDomainData(this.floatWaveDataL);
    this.analyserR.getFloatTimeDomainData(this.floatWaveDataR);

    const frame = {
      left: this.floatFreqDataL,
      right: this.floatFreqDataR,
      waveformLeft: this.floatWaveDataL,
      waveformRight: this.floatWaveDataR,
      sampleRate: this.audioContext.sampleRate,
      fftSize: this.fftSize,
      time: this.audioContext.currentTime,
      deviceId: this.activeDeviceId,
      channels: this.stream?.getAudioTracks?.()[0]?.getSettings?.().channelCount || 1,
    };

    // Noise floor: sample the RAW signature while a capture is running, then
    // subtract the stored profile in place so every consumer (musical feature
    // extractor, band-split EQ broadcast) sees the cleaned spectrum.
    feedNoiseCapture(frame);
    applyNoiseFloor(frame);

    return frame;
  }

  getAmplitudes() {
    if (!this.isStarted) return { left: 0, right: 0 };

    this.analyserL.getByteTimeDomainData(this.dataArrayL);
    this.analyserR.getByteTimeDomainData(this.dataArrayR);

    let sumL = 0;
    let sumR = 0;
    const len = this.dataArrayL.length;

    for (let i = 0; i < len; i++) {
      const valL = (this.dataArrayL[i] - 128) / 128.0;
      const valR = (this.dataArrayR[i] - 128) / 128.0;
      sumL += valL * valL;
      sumR += valR * valR;
    }

    return {
      left: Math.sqrt(sumL / len),
      right: Math.sqrt(sumR / len),
    };
  }
}
