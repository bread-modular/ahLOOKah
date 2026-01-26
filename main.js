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

    // Initialize Config Panel
    new ConfigPanel({
      onDeviceChange: (deviceId) => startStream(deviceId)
    });
  };

  const startStream = async (deviceId) => {
    // If we have an existing context, close it before starting a new one
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
      splitter.connect(analyserL, 0); // Connect channel 0 to analyserL
      splitter.connect(analyserR, 1); // Connect channel 1 to analyserR

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

    // Calculate RMS for amplitude
    let sumL = 0;
    let sumR = 0;
    const len = dataArrayL.length;

    for (let i = 0; i < len; i++) {
      // Transform 0..255 to -1..1 range
      const valL = (dataArrayL[i] - 128) / 128.0;
      const valR = (dataArrayR[i] - 128) / 128.0;
      sumL += valL * valL;
      sumR += valR * valR;
    }

    const rmsL = Math.sqrt(sumL / len);
    const rmsR = Math.sqrt(sumR / len);

    return { left: rmsL, right: rmsR };
  };

  p.mousePressed = () => {
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume();
    }
  };

  p.draw = () => {
    p.background(10, 10, 15); // Dark background

    if (!isAudioStarted) {
      p.textAlign(p.CENTER, p.CENTER);
      p.fill(100);
      p.text("Waiting for audio configuration...", p.width / 2, p.height / 2);
      return;
    }

    // Autoplay policy check
    if (audioContext && audioContext.state === 'suspended') {
      p.textAlign(p.CENTER, p.CENTER);
      p.fill(255, 100, 100);
      p.textSize(24);
      p.text("Click anywhere to start audio", p.width / 2, p.height / 2);
      return;
    }

    const amps = getAmplitudes();

    // --- Visualization ---

    // 1. Channel Indicators (Bars on the sides reacting to amplitude)
    const barWidth = 40;

    // Left Channel Bar
    // Map RMS (usually low, pure sine ~0.707) to height
    const hL = p.map(amps.left, 0, 0.5, 0, p.height);
    p.noStroke();
    p.fill(0, 255, 255, 100); // Transparent cyan
    p.rect(0, p.height - hL, barWidth, hL);

    // Right Channel Bar
    const hR = p.map(amps.right, 0, 0.5, 0, p.height);
    p.fill(255, 0, 255, 100); // Transparent magenta
    p.rect(p.width - barWidth, p.height - hR, barWidth, hR);


    // 2. Waveforms
    p.noFill();
    p.strokeWeight(2);

    // Left Waveform (Cyan)
    p.stroke(0, 255, 255);
    p.beginShape();
    for (let i = 0; i < dataArrayL.length; i += 8) { // Optimize drawing points
      const x = p.map(i, 0, dataArrayL.length, barWidth + 10, p.width - barWidth - 10);
      const y_mapped = p.map(dataArrayL[i], 0, 255, 0, p.height / 2);
      p.vertex(x, y_mapped);
    }
    p.endShape();

    // Right Waveform (Magenta)
    p.stroke(255, 0, 255);
    p.beginShape();
    for (let i = 0; i < dataArrayR.length; i += 8) {
      const x = p.map(i, 0, dataArrayR.length, barWidth + 10, p.width - barWidth - 10);
      const y_mapped = p.map(dataArrayR[i], 0, 255, p.height / 2, p.height);
      p.vertex(x, y_mapped);
    }
    p.endShape();

    // Labels
    p.noStroke();
    p.textSize(14);

    p.fill(0, 255, 255);
    p.textAlign(p.LEFT, p.TOP);
    p.text(`Left Ch Amplitude: ${amps.left.toFixed(3)}`, 60, 20);

    p.fill(255, 0, 255);
    p.text(`Right Ch Amplitude: ${amps.right.toFixed(3)}`, 60, p.height / 2 + 20);

    // Divider
    p.stroke(50);
    p.strokeWeight(1);
    p.line(0, p.height / 2, p.width, p.height / 2);
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };
};

new p5(sketch);
