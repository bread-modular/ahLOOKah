import p5 from 'p5';
import './style.css';
import { ConfigPanel } from './config-panel.js';
import { AudioManager } from './audio-manager.js';

// Import available sketches
import circles from './sketches/circles.js';
import circlesCh1 from './sketches/circles_ch1.js';
import bars from './sketches/bars.js';
import techno3d from './sketches/techno3d.js';
import character3d from './sketches/character3d.js';
import webcam from './sketches/webcam.js';

// Sketch Registry
const sketches = [
  circles,      // 1
  circlesCh1,   // 2
  bars,         // 3
  techno3d,     // 4
  character3d,  // 5
  webcam,       // 6
];

const audio = new AudioManager();
let currentP5 = null;
let currentIndex = 0;
let currentVideoDeviceId = null;

function loadSketch(index) {
  if (index < 0 || index >= sketches.length) return;

  if (currentP5) {
    currentP5.remove();
  }

  currentIndex = index;
  const sketchFactory = sketches[index];

  // Inject both audio and current video device ID
  currentP5 = new p5(sketchFactory(audio, currentVideoDeviceId));

  console.log(`Loaded sketch ${index + 1}`);
}

// Orchestrate Audio, Config & Video
new ConfigPanel({
  onAudioChange: (deviceId) => audio.startStream(deviceId),
  onVideoChange: (deviceId) => {
    currentVideoDeviceId = deviceId;
    // Reload current sketch if it's the webcam one
    if (currentIndex === 5) {
      loadSketch(5);
    }
  }
});

// Initial Load
loadSketch(0);

// Global Key Commands
window.addEventListener('keydown', (e) => {
  const key = e.key;
  if (key >= '1' && key <= '9') {
    const nextIndex = parseInt(key) - 1;
    loadSketch(nextIndex);
  } else if (key === '0') {
    loadSketch(9);
  }
});
