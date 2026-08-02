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
import laserGrid from './sketches/laser_grid.js';
import strobePulse from './sketches/strobe_pulse.js';
import plasmaWaves from './sketches/plasma_waves.js';
import vortexSpiral from './sketches/vortex_spiral.js';
import glitchMatrix from './sketches/glitch_matrix.js';
import orbitalRings from './sketches/orbital_rings.js';
import shockwaveBeats from './sketches/shockwave_beats.js';
import neonRibbons from './sketches/neon_ribbons.js';
import prismBurst from './sketches/prism_burst.js';
import cosmicWeb from './sketches/cosmic_web.js';
// GPU-first cinematic looks inspired by modern real-time VJ pipelines
import eventHorizon from './sketches/event_horizon.js';
import liquidChrome from './sketches/liquid_chrome.js';
import laserCathedral from './sketches/laser_cathedral.js';
import cymaticBloom from './sketches/cymatic_bloom.js';
import holoSwarm from './sketches/holo_swarm.js';
// State-of-the-art cinematic FX: volumetric aurora, 3D fractal, storm clouds,
// ink-in-water fluid, and an infinite mirrored neon room.
import auroraVeil from './sketches/aurora_veil.js';
import mandelbulbDrift from './sketches/mandelbulb_drift.js';
import stormSurge from './sketches/storm_surge.js';
import inkDispersion from './sketches/ink_dispersion.js';
import infinityMirror from './sketches/infinity_mirror.js';

// Shared "responsiveness" triple used by many effects (0..2, default 1)
const BAND_RESPONSIVENESS = [
  { key: 'bass', label: 'Bass Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'mid', label: 'Mid Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'high', label: 'High Responsiveness', min: 0, max: 2, step: 0.05, default: 1 },
];

// The cinematic shader looks also expose transient gain. Band sliders shape
// sustained movement; Punch controls kick/snare/hat impacts independently.
const PREMIUM_AUDIO_RESPONSIVENESS = [
  ...BAND_RESPONSIVENESS,
  { key: 'punch', label: 'Transient Punch', min: 0, max: 2, step: 0.05, default: 1 },
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
  {
    id: 'laser-grid',
    name: 'Laser Grid',
    factory: laserGrid,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'grid', label: 'Grid Lines', min: 8, max: 32, step: 1, default: 18 },
      { key: 'beams', label: 'Laser Beams', min: 0, max: 16, step: 1, default: 6 },
      { key: 'speed', label: 'Scroll Speed', min: 0, max: 3, step: 0.05, default: 1 },
    ],
  }, // 13
  {
    id: 'strobe-pulse',
    name: 'Strobe Pulse',
    factory: strobePulse,
    params: [
      { key: 'threshold', label: 'Kick Threshold', min: 0.15, max: 0.6, step: 0.01, default: 0.32 },
      { key: 'decay', label: 'Flash Decay', min: 0.6, max: 0.97, step: 0.01, default: 0.82 },
      { key: 'split', label: 'RGB Split', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'cycle', label: 'Color Cycle', min: 0, max: 3, step: 0.05, default: 1 },
    ],
  }, // 14
  {
    id: 'plasma-waves',
    name: 'Plasma Waves',
    factory: plasmaWaves,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'cell', label: 'Cell Size', min: 4, max: 24, step: 1, default: 10 },
      { key: 'speed', label: 'Flow Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'scale', label: 'Plasma Scale', min: 0.3, max: 3, step: 0.05, default: 1 },
    ],
  }, // 15
  {
    id: 'vortex-spiral',
    name: 'Vortex Spiral',
    factory: vortexSpiral,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'arms', label: 'Spiral Arms', min: 2, max: 12, step: 1, default: 5 },
      { key: 'density', label: 'Dot Density', min: 30, max: 200, step: 5, default: 90 },
      { key: 'twist', label: 'Twist Amount', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'sparkle', label: 'Stardust', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 16
  {
    id: 'glitch-matrix',
    name: 'Glitch Matrix',
    factory: glitchMatrix,
    params: [
      { key: 'columns', label: 'Columns', min: 15, max: 80, step: 1, default: 40 },
      { key: 'speed', label: 'Fall Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'glitch', label: 'Glitch Amount', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'trail', label: 'Trail Length', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 17
  {
    id: 'orbital-rings',
    name: 'Orbital Rings',
    factory: orbitalRings,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'rings', label: 'Ring Count', min: 2, max: 10, step: 1, default: 5 },
      { key: 'spin', label: 'Spin Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'tilt', label: 'Bass Tilt', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'satellites', label: 'Satellites', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 18
  {
    id: 'shockwave-beats',
    name: 'Shockwave Beats',
    factory: shockwaveBeats,
    params: [
      { key: 'threshold', label: 'Kick Threshold', min: 0.15, max: 0.6, step: 0.01, default: 0.3 },
      { key: 'speed', label: 'Wave Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'chroma', label: 'Chroma Split', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'max', label: 'Max Waves', min: 4, max: 48, step: 1, default: 24 },
    ],
  }, // 19
  {
    id: 'neon-ribbons',
    name: 'Neon Ribbons',
    factory: neonRibbons,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'ribbons', label: 'Ribbon Count', min: 2, max: 16, step: 1, default: 6 },
      { key: 'flow', label: 'Flow Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'width', label: 'Ribbon Width', min: 0.3, max: 3, step: 0.05, default: 1 },
      { key: 'trail', label: 'Trail Length', min: 20, max: 150, step: 5, default: 60 },
    ],
  }, // 20
  {
    id: 'prism-burst',
    name: 'Prism Burst',
    factory: prismBurst,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'rays', label: 'Ray Count', min: 12, max: 96, step: 2, default: 48 },
      { key: 'spin', label: 'Spin Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'length', label: 'Ray Length', min: 0.3, max: 2, step: 0.05, default: 1 },
      { key: 'core', label: 'Core Pulse', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 21
  {
    id: 'cosmic-web',
    name: 'Cosmic Web',
    factory: cosmicWeb,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'nodes', label: 'Node Count', min: 30, max: 200, step: 5, default: 90 },
      { key: 'link', label: 'Link Distance', min: 60, max: 260, step: 5, default: 130 },
      { key: 'scatter', label: 'Kick Scatter', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'drift', label: 'Drift Speed', min: 0, max: 3, step: 0.05, default: 1 },
    ],
  }, // 22
  {
    id: 'event-horizon',
    name: 'Event Horizon',
    factory: eventHorizon,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'gravity', label: 'Gravity Lens', min: 0.4, max: 2, step: 0.05, default: 1 },
      { key: 'disk', label: 'Accretion Disc', min: 0.35, max: 2, step: 0.05, default: 1 },
      { key: 'spin', label: 'Orbital Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
      { key: 'bloom', label: 'Photon Bloom', min: 0.3, max: 2, step: 0.05, default: 1 },
    ],
  }, // 23
  {
    id: 'liquid-chrome',
    name: 'Liquid Chrome',
    factory: liquidChrome,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'morph', label: 'Liquid Morph', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'reflect', label: 'Neon Reflection', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'Flow Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
      { key: 'iridescence', label: 'Iridescence', min: 0, max: 2, step: 0.05, default: 1 },
    ],
  }, // 24
  {
    id: 'laser-cathedral',
    name: 'Laser Cathedral',
    factory: laserCathedral,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'speed', label: 'Flight Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
      { key: 'beams', label: 'Volumetric Beams', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'depth', label: 'Perspective Depth', min: 0.4, max: 2.2, step: 0.05, default: 1 },
      { key: 'structure', label: 'Arch Density', min: 0.35, max: 2, step: 0.05, default: 1 },
    ],
  }, // 25
  {
    id: 'cymatic-bloom',
    name: 'Cymatic Bloom',
    factory: cymaticBloom,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'symmetry', label: 'Kaleido Symmetry', min: 4, max: 18, step: 1, default: 10 },
      { key: 'complexity', label: 'Pattern Complexity', min: 0.4, max: 2, step: 0.05, default: 1 },
      { key: 'flow', label: 'Liquid Flow', min: 0, max: 2.5, step: 0.05, default: 1 },
      { key: 'bloom', label: 'Caustic Bloom', min: 0.3, max: 2, step: 0.05, default: 1 },
    ],
  }, // 26
  {
    id: 'holo-swarm',
    name: 'Holo Swarm',
    factory: holoSwarm,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'morph', label: 'Shape Morph', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'density', label: 'Particle Density', min: 0.4, max: 2, step: 0.05, default: 1 },
      { key: 'scan', label: 'Hologram Scan', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'Orbit Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
    ],
  }, // 27
  {
    id: 'aurora-veil',
    name: 'Aurora Veil',
    factory: auroraVeil,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'curtain', label: 'Curtain Height', min: 0.4, max: 2, step: 0.05, default: 1 },
      { key: 'flow', label: 'Flow Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
      { key: 'shimmer', label: 'Curtain Shimmer', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'haze', label: 'Aurora Haze', min: 0.3, max: 2, step: 0.05, default: 1 },
    ],
  }, // 28
  {
    id: 'mandelbulb-drift',
    name: 'Mandelbulb Drift',
    factory: mandelbulbDrift,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'power', label: 'Fractal Power', min: 2, max: 12, step: 0.1, default: 8 },
      { key: 'detail', label: 'Iteration Detail', min: 0.4, max: 2, step: 0.05, default: 1 },
      { key: 'drift', label: 'Orbit Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
      { key: 'glow', label: 'Trap Glow', min: 0.3, max: 2, step: 0.05, default: 1 },
    ],
  }, // 29
  {
    id: 'storm-surge',
    name: 'Storm Surge',
    factory: stormSurge,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'cover', label: 'Cloud Cover', min: 0.3, max: 2, step: 0.05, default: 1 },
      { key: 'godrays', label: 'God Rays', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'drift', label: 'Wind Drift', min: 0, max: 2.5, step: 0.05, default: 1 },
      { key: 'bloom', label: 'Lightning Bloom', min: 0.3, max: 2, step: 0.05, default: 1 },
    ],
  }, // 30
  {
    id: 'ink-dispersion',
    name: 'Ink Dispersion',
    factory: inkDispersion,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'viscosity', label: 'Ink Viscosity', min: 0.3, max: 2, step: 0.05, default: 1 },
      { key: 'density', label: 'Ink Density', min: 0.4, max: 2, step: 0.05, default: 1 },
      { key: 'spread', label: 'Burst Spread', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'bloom', label: 'Ink Bloom', min: 0.3, max: 2, step: 0.05, default: 1 },
    ],
  }, // 31
  {
    id: 'infinity-mirror',
    name: 'Infinity Mirror',
    factory: infinityMirror,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'mirrors', label: 'Mirror Reflect', min: 0.2, max: 1, step: 0.05, default: 0.8 },
      { key: 'glow', label: 'Neon Glow', min: 0.3, max: 2, step: 0.05, default: 1 },
      { key: 'spin', label: 'Room Spin', min: 0, max: 2.5, step: 0.05, default: 1 },
      { key: 'depth', label: 'Reflection Depth', min: 0.4, max: 2, step: 0.05, default: 1 },
    ],
  }, // 32
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
