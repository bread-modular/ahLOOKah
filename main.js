import p5 from 'p5';
import './style.css';
import { ConfigPanel } from './config-panel.js';
import { AudioManager } from './audio-manager.js';

/**
 * SELECT SKETCH HERE
 */
// import currentSketch from './sketches/waveform.js';
import currentSketch from './sketches/circles.js';

const audio = new AudioManager();

// Orchestrate Audio & Config
new ConfigPanel({
  onDeviceChange: (deviceId) => audio.startStream(deviceId)
});

// Initialize p5 with the selected sketch and injected audio context
new p5(currentSketch(audio));
