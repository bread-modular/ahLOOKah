import p5 from 'p5';
import './style.css';
import { ConfigPanel } from './config-panel.js';
import { AudioManager } from './audio-manager.js';

const sketch = (p) => {
  let audio;

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);

    audio = new AudioManager();

    new ConfigPanel({
      onDeviceChange: (deviceId) => audio.startStream(deviceId)
    });
  };

  p.mousePressed = () => {
    if (audio) audio.resume();
  };

  p.draw = () => {
    p.background(0);

    if (!audio || !audio.isStarted) {
      return;
    }

    if (audio.getState() === 'suspended') {
      p.textAlign(p.CENTER, p.CENTER);
      p.fill(255);
      p.noStroke();
      p.text("CLICK TO START AUDIO", p.width / 2, p.height / 2);
      return;
    }

    const waveforms = audio.getWaveforms();
    const amps = audio.getAmplitudes();

    if (!waveforms) return;

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
    const dataL = waveforms.left;
    p.beginShape();
    for (let i = 0; i < dataL.length; i += 8) {
      const x = p.map(i, 0, dataL.length, 0, p.width);
      const y = p.map(dataL[i], 0, 255, 0, p.height / 2);
      p.vertex(x, y);
    }
    p.endShape();

    // Right
    const dataR = waveforms.right;
    p.beginShape();
    for (let i = 0; i < dataR.length; i += 8) {
      const x = p.map(i, 0, dataR.length, 0, p.width);
      const y = p.map(dataR[i], 0, 255, p.height / 2, p.height);
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
