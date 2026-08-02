export class AudioManager {
  constructor() {
    this.audioContext = null;
    this.source = null;
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;
    this.dataArrayL = null;
    this.dataArrayR = null;
    this.freqDataL = null;
    this.freqDataR = null;
    this.isStarted = false;
    this.fftSize = 2048;
  }

  async startStream(deviceId) {
    if (this.audioContext) {
      await this.audioContext.close();
    }

    const constraints = {
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        channelCount: 2
      }
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.source = this.audioContext.createMediaStreamSource(stream);

      this.splitter = this.audioContext.createChannelSplitter(2);
      this.analyserL = this.audioContext.createAnalyser();
      this.analyserR = this.audioContext.createAnalyser();

      this.analyserL.fftSize = this.fftSize;
      this.analyserR.fftSize = this.fftSize;

      this.source.connect(this.splitter);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);

      const bufferLength = this.analyserL.frequencyBinCount;
      this.dataArrayL = new Uint8Array(bufferLength);
      this.dataArrayR = new Uint8Array(bufferLength);
      this.freqDataL = new Uint8Array(bufferLength);
      this.freqDataR = new Uint8Array(bufferLength);

      this.isStarted = true;
      return true;
    } catch (err) {
      console.error('Error starting audio stream:', err);
      return false;
    }
  }

  stop() {
    this.isStarted = false;
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.source = null;
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;
  }

  resume() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  getState() {
    return this.audioContext ? this.audioContext.state : 'closed';
  }

  getWaveforms() {
    if (!this.isStarted) return null;
    this.analyserL.getByteTimeDomainData(this.dataArrayL);
    this.analyserR.getByteTimeDomainData(this.dataArrayR);
    return { left: this.dataArrayL, right: this.dataArrayR };
  }

  getFrequencies() {
    if (!this.isStarted) return null;
    this.analyserL.getByteFrequencyData(this.freqDataL);
    this.analyserR.getByteFrequencyData(this.freqDataR);
    return { left: this.freqDataL, right: this.freqDataR };
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
      right: Math.sqrt(sumR / len)
    };
  }
}
