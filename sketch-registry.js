// Shared registry of all visualization sketches.
// Used by the screen window (to load sketches) and the control panel (to render buttons).
//
// Each entry may declare a `params` array. Every param gets a slider in the
// control panel; values are broadcast to the screen and injected live into the
// sketch factory as a plain object (mutated in place), so sketches can read
// `params.bass` etc. every frame.
//
// Param shape:
//   { key, label, min, max, step, default }
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

// Shared "responsiveness" triple used by many effects (0..2, default 1)
const BAND_RESPONSIVENESS = [
  { key: 'bass', label: 'Bass Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'mid', label: 'Mid Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'high', label: 'High Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
];

export const SKETCHES = [
  {
    name: 'Circles',
    factory: circles,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'glitch', label: 'Glitch Amount', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 1
  {
    name: 'Circles CH1',
    factory: circlesCh1,
    params: BAND_RESPONSIVENESS,
  }, // 2
  {
    name: 'Bars',
    factory: bars,
    params: [
      { key: 'gain', label: 'Amplitude Gain', min: 0.2, max: 3, step: 0.05, default: 1 },
      { key: 'barWidth', label: 'Bar Width', min: 2, max: 16, step: 1, default: 4 },
      { key: 'flash', label: 'Peak Flash', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 3
  {
    name: 'Techno 3D',
    factory: techno3d,
    params: [
      { key: 'spin', label: 'Spin Speed', min: 0, max: 3, step: 0.05, default: 1 },
      ...BAND_RESPONSIVENESS,
    ],
  }, // 4
  {
    name: 'Character 3D',
    factory: character3d,
    params: [
      { key: 'groove', label: 'Groove Speed', min: 0, max: 3, step: 0.05, default: 1 },
      ...BAND_RESPONSIVENESS,
    ],
  }, // 5
  {
    name: 'Neon Spectrum',
    factory: neonSpectrum,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'bars', label: 'Bar Count', min: 24, max: 144, step: 1, default: 72 },
    ],
  }, // 6
  {
    name: 'Pulse Rings',
    factory: pulseRings,
    params: [
      { key: 'kick', label: 'Kick Threshold', min: 0.2, max: 0.6, step: 0.01, default: 0.35 },
      { key: 'speed', label: 'Ring Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'rings', label: 'Max Rings', min: 10, max: 80, step: 1, default: 40 },
      { key: 'sub', label: 'Sub Pulse', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 7
  {
    name: 'Particle Storm',
    factory: particleStorm,
    params: [
      { key: 'count', label: 'Particle Count', min: 50, max: 800, step: 10, default: 320 },
      { key: 'burst', label: 'Burst Strength', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'wind', label: 'Wind Strength', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'kick', label: 'Kick Sensitivity', min: 0.2, max: 2, step: 0.05, default: 1 },
    ],
  }, // 8
  {
    name: 'Waveform Tunnel',
    factory: waveformTunnel,
    params: [
      { key: 'rings', label: 'Ring Count', min: 20, max: 80, step: 1, default: 46 },
      { key: 'twist', label: 'Twist Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'scale', label: 'Tunnel Scale', min: 0.5, max: 2, step: 0.05, default: 1 },
      { key: 'sub', label: 'Sub Push', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 9
  {
    name: 'Chroma Mandala',
    factory: chromaMandala,
    params: [
      { key: 'petals', label: 'Petals', min: 6, max: 24, step: 1, default: 12 },
      { key: 'spin', label: 'Spin Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'bloom', label: 'Mid Bloom', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'sub', label: 'Sub Ring', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 0 (10)
];

// Keyboard keys that select a pattern (1-9, 0 = 10th)
export function indexFromKey(key) {
  if (key >= '1' && key <= '9') return parseInt(key, 10) - 1;
  if (key === '0') return 9;
  return -1;
}

// Build a fresh { key: value } object from a sketch's param defaults
export function defaultParamValues(index) {
  const out = {};
  const defs = (SKETCHES[index] && SKETCHES[index].params) || [];
  for (const def of defs) out[def.key] = def.default;
  return out;
}
