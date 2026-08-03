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
  }

  async releaseCurrentStream() {
    this.isStarted = false;
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      const context = this.audioContext;
      this.audioContext = null;
      await context.close().catch(() => {});
    }
    this.resumePromise = null;
    this.source = null;
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;
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

  async startStream(deviceId) {
    const token = ++this.requestToken;
    await this.releaseCurrentStream();

    const constraints = {
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        channelCount: { ideal: 2 },
      },
    };

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (token !== this.requestToken) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextClass({ latencyHint: 'interactive' });
      this.stream = stream;
      this.source = this.audioContext.createMediaStreamSource(stream);
      this.splitter = this.audioContext.createChannelSplitter(2);
      this.analyserL = this.audioContext.createAnalyser();
      this.analyserR = this.audioContext.createAnalyser();
      this.configureAnalyser(this.analyserL);
      this.configureAnalyser(this.analyserR);

      this.source.connect(this.splitter);
      this.splitter.connect(this.analyserL, 0);

      // Many DJ interfaces advertise one channel even when stereo was
      // requested. Mirror channel 1 in that case instead of feeding every
      // right-channel-aware effect a silent spectrum.
      const channelCount = stream.getAudioTracks()[0]?.getSettings?.().channelCount || 1;
      this.splitter.connect(this.analyserR, channelCount > 1 ? 1 : 0);
      this.allocateBuffers();

      this.isStarted = true;
      // getUserMedia often permits this immediately. If autoplay policy keeps
      // it suspended, the next click/tap on the screen calls resume() again.
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
        console.error('Error starting audio stream:', err);
      }
      return false;
    }
  }

  stop() {
    this.requestToken += 1;
    this.isStarted = false;
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.resumePromise = null;
    this.source = null;
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;
  }

  resume(force = false) {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      // A genuine screen click gets a fresh resume call even if an earlier
      // autoplay-blocked promise is still pending.
      if (force || navigator.userActivation?.isActive) this.resumePromise = null;
      if (!this.resumePromise) {
        const context = this.audioContext;
        this.resumePromise = context.resume()
          .catch(() => {})
          .finally(() => {
            if (this.audioContext === context) this.resumePromise = null;
          });
      }
      return this.resumePromise;
    }
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
    };

    // Noise floor: sample the RAW signature while a capture is running, then
    // subtract the stored profile in place so every consumer (musical feature
    // extractor, band-split EQ broadcast) sees the cleaned spectrum.
    feedNoiseCapture(frame);
    applyNoiseFloor(frame.left, frame.right, frame.sampleRate, frame.fftSize);

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
