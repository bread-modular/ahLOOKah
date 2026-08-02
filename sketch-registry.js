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
//
// Ordering: SKETCHES is the canonical declaration order. The user can reorder
// effects in the control panel (drag & drop); the current order is persisted
// as an array of sketch `id`s in localStorage (viz2_effect_order) and read via
// getOrderedSketches(). Only the first 10 positions get number shortcuts.
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
import starfieldRush from './sketches/starfield_rush.js';
import echoRipples from './sketches/echo_ripples.js';

// Shared "responsiveness" triple used by many effects (0..2, default 1)
const BAND_RESPONSIVENESS = [
  { key: 'bass', label: 'Bass Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'mid', label: 'Mid Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'high', label: 'High Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
];

export const SKETCHES = [
  {
    id: 'circles',
    name: 'Circles',
    factory: circles,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'glitch', label: 'Glitch Amount', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 1
  {
    id: 'circles-ch1',
    name: 'Circles CH1',
    factory: circlesCh1,
    params: BAND_RESPONSIVENESS,
  }, // 2
  {
    id: 'bars',
    name: 'Bars',
    factory: bars,
    params: [
      { key: 'gain', label: 'Amplitude Gain', min: 0.2, max: 3, step: 0.05, default: 1 },
      { key: 'barWidth', label: 'Bar Width', min: 2, max: 16, step: 1, default: 4 },
      { key: 'flash', label: 'Peak Flash', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 3
  {
    id: 'techno3d',
    name: 'Techno 3D',
    factory: techno3d,
    params: [
      { key: 'spin', label: 'Spin Speed', min: 0, max: 3, step: 0.05, default: 1 },
      ...BAND_RESPONSIVENESS,
    ],
  }, // 4
  {
    id: 'character3d',
    name: 'Character 3D',
    factory: character3d,
    params: [
      { key: 'groove', label: 'Groove Speed', min: 0, max: 3, step: 0.05, default: 1 },
      ...BAND_RESPONSIVENESS,
    ],
  }, // 5
  {
    id: 'neon-spectrum',
    name: 'Neon Spectrum',
    factory: neonSpectrum,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'bars', label: 'Bar Count', min: 24, max: 144, step: 1, default: 72 },
    ],
  }, // 6
  {
    id: 'pulse-rings',
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
    id: 'particle-storm',
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
    id: 'waveform-tunnel',
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
    id: 'chroma-mandala',
    name: 'Chroma Mandala',
    factory: chromaMandala,
    params: [
      { key: 'petals', label: 'Petals', min: 6, max: 24, step: 1, default: 12 },
      { key: 'spin', label: 'Spin Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'bloom', label: 'Mid Bloom', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'sub', label: 'Sub Ring', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 0 (10)
  {
    id: 'starfield-rush',
    name: 'Starfield Rush',
    factory: starfieldRush,
    params: [
      { key: 'count', label: 'Star Count', min: 50, max: 600, step: 10, default: 240 },
      { key: 'warp', label: 'Warp Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'hue', label: 'Hue Drift', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'sparkle', label: 'High Sparkle', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 11
  {
    id: 'echo-ripples',
    name: 'Echo Ripples',
    factory: echoRipples,
    params: [
      { key: 'speed', label: 'Ripple Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'ripples', label: 'Max Ripples', min: 4, max: 32, step: 1, default: 20 },
      { key: 'thick', label: 'Ring Thickness', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'sparkle', label: 'High Sparkle', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 12
];

// Number of effects that get keyboard shortcuts (1-9, 0 = 10th)
export const SHORTCUT_COUNT = 10;

// localStorage key that stores the user's effect order (array of sketch ids)
export const EFFECT_ORDER_KEY = 'viz2_effect_order';

// Load the persisted order. Invalid/unknown ids are dropped and any missing
// sketches are appended in declaration order, so upgrades never lose effects.
export function loadEffectOrder() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(EFFECT_ORDER_KEY));
  } catch {
    saved = [];
  }
  if (!Array.isArray(saved)) saved = [];

  const known = new Set(SKETCHES.map((s) => s.id));
  const valid = saved.filter((id) => known.has(id));
  for (const s of SKETCHES) {
    if (!valid.includes(s.id)) valid.push(s.id);
  }
  return valid;
}

export function saveEffectOrder(order) {
  localStorage.setItem(EFFECT_ORDER_KEY, JSON.stringify(order));
}

// SKETCHES in the user's current display order (falls back to declaration order)
export function getOrderedSketches() {
  const order = loadEffectOrder();
  const byId = new Map(SKETCHES.map((s) => [s.id, s]));
  return order.map((id) => byId.get(id)).filter(Boolean);
}

// Keyboard keys that select a pattern (1-9, 0 = 10th)
export function indexFromKey(key) {
  if (key >= '1' && key <= '9') return parseInt(key, 10) - 1;
  if (key === '0') return 9;
  return -1;
}

// Build a fresh { key: value } object from a sketch's param defaults
export function defaultParamValues(id) {
  const out = {};
  const sketch = SKETCHES.find((s) => s.id === id);
  const defs = (sketch && sketch.params) || [];
  for (const def of defs) out[def.key] = def.default;
  return out;
}
