import p5 from 'p5';
import './style.css';
import { ConfigPanel } from './config-panel.js';

const sketch = (p) => {
  let audioContext;
  let source;
  let splitter;
  let analyserL, analyserR;
  let dataArrayL, dataArrayR;
  let isAudioStarted = false;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);

    new ConfigPanel({
      onDeviceChange: (deviceId) => startStream(deviceId)
    });
  };

  const startStream = async (deviceId) => {
    if (audioContext) {
      await audioContext.close();
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
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      source = audioContext.createMediaStreamSource(stream);

      splitter = audioContext.createChannelSplitter(2);
      analyserL = audioContext.createAnalyser();
      analyserR = audioContext.createAnalyser();

      analyserL.fftSize = 2048;
      analyserR.fftSize = 2048;

      source.connect(splitter);
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);

      const bufferLength = analyserL.frequencyBinCount;
      dataArrayL = new Uint8Array(bufferLength);
      dataArrayR = new Uint8Array(bufferLength);

      isAudioStarted = true;
    } catch (err) {
      console.error('Error starting audio stream:', err);
    }
  };

  const getAmplitudes = () => {
    if (!isAudioStarted) return { left: 0, right: 0 };

    analyserL.getByteTimeDomainData(dataArrayL);
    analyserR.getByteTimeDomainData(dataArrayR);

    let sumL = 0;
    let sumR = 0;
    const len = dataArrayL.length;

    for (let i = 0; i < len; i++) {
      const valL = (dataArrayL[i] - 128) / 128.0;
      const valR = (dataArrayR[i] - 128) / 128.0;
      sumL += valL * valL;
      sumR += valR * valR;
    }

    return {
      left: Math.sqrt(sumL / len),
      right: Math.sqrt(sumR / len)
    };
  };

  p.mousePressed = () => {
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume();
    }
  };

  p.draw = () => {
    p.background(0);

    if (!isAudioStarted) {
      return;
    }

    if (audioContext && audioContext.state === 'suspended') {
      p.textAlign(p.CENTER, p.CENTER);
      p.fill(255);
      p.noStroke();
      p.text("CLICK TO START AUDIO", p.width / 2, p.height / 2);
      return;
    }

    const amps = getAmplitudes();

    // Minimal Gray Visualization
    const barWidth = 2;

    // Amplitudes
    p.noStroke();
    p.fill(255, 30);
    const hL = p.map(amps.left, 0, 0.5, 0, p.height);
    p.rect(0, p.height - hL, barWidth, hL);

    const hR = p.map(amps.right, 0, 0.5, 0, p.height);
    p.rect(p.width - barWidth, p.height - hR, barWidth, hR);

    // Waveforms
    p.noFill();
    p.stroke(255, 100);
    p.strokeWeight(1);

    // Left
    p.beginShape();
    for (let i = 0; i < dataArrayL.length; i += 8) {
      const x = p.map(i, 0, dataArrayL.length, 0, p.width);
      const y = p.map(dataArrayL[i], 0, 255, 0, p.height / 2);
      p.vertex(x, y);
    }
    p.endShape();

    // Right
    p.beginShape();
    for (let i = 0; i < dataArrayR.length; i += 8) {
      const x = p.map(i, 0, dataArrayR.length, 0, p.width);
      const y = p.map(dataArrayR[i], 0, 255, p.height / 2, p.height);
      p.vertex(x, y);
    }
    p.endShape();

    // Divider
    p.stroke(40);
    p.line(0, p.height / 2, p.width, p.height / 2);
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };
};

new p5(sketch);
