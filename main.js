import p5 from 'p5';
import './style.css';
import { ConfigPanel } from './config-panel.js';
import { AudioManager } from './audio-manager.js';

// Import available sketches
import circles from './sketches/circles.js';
import circlesCh1 from './sketches/circles_ch1.js';
import bars from './sketches/bars.js';

// Sketch Registry (up to 10)
const sketches = [
  circles,    // 1 (Ch1 + Ch2 Glitch)
  circlesCh1, // 2 (Ch1 only)
  bars,       // 3
  // Add more here (up to 10)
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
  // Listen for '1' (code 49) through '9' (code 57) and '0' (code 48)
  const key = e.key;

  if (key >= '1' && key <= '9') {
    const nextIndex = parseInt(key) - 1;
    loadSketch(nextIndex);
  } else if (key === '0') {
    loadSketch(9); // 0 maps to 10th sketch
  }
});
