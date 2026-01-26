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

// Sketch Registry (up to 10)
const sketches = [
  circles,      // 1
  circlesCh1,   // 2
  bars,         // 3
  techno3d,     // 4
  character3d,  // 5
];

const audio = new AudioManager();
let currentP5 = null;
let currentIndex = 0;

function loadSketch(index) {
  if (index < 0 || index >= sketches.length) return;

  // Cleanup previous instance
  if (currentP5) {
    currentP5.remove();
  }

  currentIndex = index;
  const sketchFactory = sketches[index];

  // Initialize new p5 instance with injected audio manager
  currentP5 = new p5(sketchFactory(audio));

  console.log(`Loaded sketch ${index + 1}`);
}

// Orchestrate Audio & Config
new ConfigPanel({
  onDeviceChange: (deviceId) => audio.startStream(deviceId)
});

// Initial Load
loadSketch(0);

// Global Key Commands for Switching
window.addEventListener('keydown', (e) => {
  const key = e.key;

  if (key >= '1' && key <= '9') {
    const nextIndex = parseInt(key) - 1;
    loadSketch(nextIndex);
  } else if (key === '0') {
    loadSketch(9);
  }
});
