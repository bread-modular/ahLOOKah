// Shared registry of all visualization sketches.
// Used by the screen window (to load sketches) and the control panel (to render buttons).
import circles from './sketches/circles.js';
import circlesCh1 from './sketches/circles_ch1.js';
import bars from './sketches/bars.js';
import techno3d from './sketches/techno3d.js';
import character3d from './sketches/character3d.js';
import webcamDotsGpu from './sketches/webcam_dots_gpu.js';
import webcamShader from './sketches/webcam_shader.js';
import webcamHighContrast from './sketches/webcam_high_contrast.js';
import video3d from './sketches/video3d.js';
import characterTv from './sketches/character_tv.js';

export const SKETCHES = [
  { name: 'Circles', factory: circles },            // 1
  { name: 'Circles CH1', factory: circlesCh1 },     // 2
  { name: 'Bars', factory: bars },                  // 3
  { name: 'Techno 3D', factory: techno3d },         // 4
  { name: 'Character 3D', factory: character3d },   // 5
  { name: 'Webcam Dots', factory: webcamDotsGpu },  // 6
  { name: 'Webcam Shader', factory: webcamShader }, // 7
  { name: 'Webcam Hi-Contrast', factory: webcamHighContrast }, // 8
  { name: 'Video 3D', factory: video3d },           // 9
  { name: 'Character TV', factory: characterTv },   // 0 (10)
];

// Keyboard keys that select a pattern (1-9, 0 = 10th)
export function indexFromKey(key) {
  if (key >= '1' && key <= '9') return parseInt(key, 10) - 1;
  if (key === '0') return 9;
  return -1;
}
