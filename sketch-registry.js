// Shared registry of all visualization sketches.
// Used by the screen window (to load sketches) and the control panel (to render buttons).
import circles from './sketches/circles.js';
import circlesCh1 from './sketches/circles_ch1.js';
import bars from './sketches/bars.js';
import techno3d from './sketches/techno3d.js';
import character3d from './sketches/character3d.js';
// Colorful audio-reactive visuals for live techno/noise shows
// (camera-input sketches still live in ./sketches/ but are not registered)
import neonSpectrum from './sketches/neon_spectrum.js';
import pulseRings from './sketches/pulse_rings.js';
import particleStorm from './sketches/particle_storm.js';
import waveformTunnel from './sketches/waveform_tunnel.js';
import chromaMandala from './sketches/chroma_mandala.js';

export const SKETCHES = [
  { name: 'Circles', factory: circles },            // 1
  { name: 'Circles CH1', factory: circlesCh1 },     // 2
  { name: 'Bars', factory: bars },                  // 3
  { name: 'Techno 3D', factory: techno3d },         // 4
  { name: 'Character 3D', factory: character3d },   // 5
  { name: 'Neon Spectrum', factory: neonSpectrum }, // 6
  { name: 'Pulse Rings', factory: pulseRings },     // 7
  { name: 'Particle Storm', factory: particleStorm }, // 8
  { name: 'Waveform Tunnel', factory: waveformTunnel }, // 9
  { name: 'Chroma Mandala', factory: chromaMandala }, // 0 (10)
];

// Keyboard keys that select a pattern (1-9, 0 = 10th)
export function indexFromKey(key) {
  if (key >= '1' && key <= '9') return parseInt(key, 10) - 1;
  if (key === '0') return 9;
  return -1;
}
