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
// Ordering: SKETCHES is the canonical declaration order (and the order used
// inside the pattern library). The control panel's FIXED pattern pad holds 10
// slots (keys 1-9/0); the assigned sketch ids are persisted in localStorage
// (viz2_slot_order) and read via getOrderedSketches(), which returns exactly
// the 10 pad sketches. Older builds persisted a full order (viz2_effect_order);
// it is migrated once — its first 10 valid ids become the pad, gaps filled
// from declaration order.
//
// Group taxonomy (every entry carries a `group` field, used by the library):
//   Rhythmic            — beat/band-driven 2D visuals (spectrum/pulse/waveform)
//   3D                  — perspective / depth-driven looks
//   Cinematic / Shaders — GPU-first cinematic looks
//   Neon / Lasers       — synthwave, neon & laser aesthetics
//   Video FX            — live camera-input effects
//   Glitch / Effects    — glitch / digital-artifact effects
//   Basics              — simple building-block patterns
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
// Additional cinematic FX from the patterns drop.
import ionTempest from './sketches/ion_tempest.js';
import crystalReliquary from './sketches/crystal_reliquary.js';
import neuralCascade from './sketches/neural_cascade.js';
import auroraReactor from './sketches/aurora_reactor.js';
import warpLoom from './sketches/warp_loom.js';
// Next-gen cinematic shader effects
import fractalNebula from './sketches/fractal_nebula.js';
import auroraStorm from './sketches/aurora_storm.js';
import wormholeTransit from './sketches/wormhole_transit.js';
import crystalCavern from './sketches/crystal_cavern.js';
import neonMetropolis from './sketches/neon_metropolis.js';
// Basics: simple building-block patterns (flat color, washes, bars, noise,
// grain, checkerboard) for the grouped pattern library.
import solidColor from './sketches/solid_color.js';
import gradientWash from './sketches/gradient_wash.js';
import colorBars from './sketches/color_bars.js';
import noiseStatic from './sketches/noise_static.js';
import filmGrain from './sketches/film_grain.js';
import checkerboard from './sketches/checkerboard.js';
// Camera-input FX (chroma keyer, kaleidoscope, pixelate, motion trails) and a
// second wave of glitch looks for the grouped pattern library.
import videoChroma from './sketches/video_chroma.js';
import videoKaleido from './sketches/video_kaleido.js';
import videoPixelate from './sketches/video_pixelate.js';
import videoTrails from './sketches/video_trails.js';
import glitchRgbSplit from './sketches/glitch_rgb_split.js';
import glitchScanlines from './sketches/glitch_scanlines.js';
import glitchSlices from './sketches/glitch_slices.js';
import glitchCrt from './sketches/glitch_crt.js';
// Legacy camera-input sketches surfaced into the library (registered now so
// they appear under Video FX with live params; each tolerates a missing camera
// by drawing a fallback/black frame until capture is ready).
import webcamDotsGpu from './sketches/webcam_dots_gpu.js';
import webcamHighContrast from './sketches/webcam_high_contrast.js';

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
    group: 'Rhythmic',
  }, // 1
  {
    id: 'circles-ch1',
    name: 'Circles CH1',
    factory: circlesCh1,
    params: BAND_RESPONSIVENESS,
    group: 'Rhythmic',
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
    group: 'Rhythmic',
  }, // 3
  {
    id: 'techno3d',
    name: 'Techno 3D',
    factory: techno3d,
    params: [
      { key: 'spin', label: 'Spin Speed', min: 0, max: 3, step: 0.05, default: 1 },
      ...BAND_RESPONSIVENESS,
    ],
    group: '3D',
  }, // 4
  {
    id: 'character3d',
    name: 'Character 3D',
    factory: character3d,
    params: [
      { key: 'groove', label: 'Groove Speed', min: 0, max: 3, step: 0.05, default: 1 },
      ...BAND_RESPONSIVENESS,
    ],
    group: '3D',
  }, // 5
  {
    id: 'neon-spectrum',
    name: 'Neon Spectrum',
    factory: neonSpectrum,
    params: [
      ...BAND_RESPONSIVENESS,
      { key: 'bars', label: 'Bar Count', min: 24, max: 144, step: 1, default: 72 },
    ],
    group: 'Rhythmic',
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
    group: 'Rhythmic',
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
    group: 'Rhythmic',
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
    group: 'Rhythmic',
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
    group: 'Rhythmic',
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
    group: '3D',
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
    group: 'Rhythmic',
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
    group: 'Neon / Lasers',
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
    group: 'Rhythmic',
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
    group: 'Rhythmic',
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
    group: '3D',
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
    group: 'Glitch / Effects',
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
    group: '3D',
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
    group: 'Rhythmic',
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
    group: 'Neon / Lasers',
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
    group: 'Neon / Lasers',
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
    group: 'Rhythmic',
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
    group: 'Cinematic / Shaders',
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
    group: 'Cinematic / Shaders',
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
    group: 'Neon / Lasers',
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
    group: 'Cinematic / Shaders',
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
    group: 'Cinematic / Shaders',
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
    group: 'Cinematic / Shaders',
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
    group: '3D',
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
    group: 'Cinematic / Shaders',
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
    group: 'Cinematic / Shaders',
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
    group: '3D',
  }, // 32
  {
    id: 'ion-tempest',
    name: 'Ion Tempest',
    factory: ionTempest,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'storm', label: 'Storm Density', min: 0.3, max: 2, step: 0.05, default: 1 },
      { key: 'branch', label: 'Bolt Branching', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'Storm Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
      { key: 'glow', label: 'Plasma Glow', min: 0.3, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Cinematic / Shaders',
  }, // 33
  {
    id: 'crystal-reliquary',
    name: 'Crystal Reliquary',
    factory: crystalReliquary,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'scale', label: 'Crystal Scale', min: 0.45, max: 1.8, step: 0.05, default: 1 },
      { key: 'facet', label: 'Facet Detail', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'spin', label: 'Orbit Spin', min: 0, max: 2.5, step: 0.05, default: 1 },
      { key: 'caustic', label: 'Spectral Caustics', min: 0.2, max: 2, step: 0.05, default: 1 },
    ],
    group: '3D',
  }, // 34
  {
    id: 'neural-cascade',
    name: 'Neural Cascade',
    factory: neuralCascade,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'nodes', label: 'Synapse Density', min: 0.35, max: 2, step: 0.05, default: 1 },
      { key: 'links', label: 'Axon Strength', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'pulse', label: 'Activation Pulse', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'Cascade Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
    ],
    group: 'Cinematic / Shaders',
  }, // 35
  {
    id: 'aurora-reactor',
    name: 'Aurora Reactor',
    factory: auroraReactor,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'field', label: 'Magnetic Field', min: 0.25, max: 2, step: 0.05, default: 1 },
      { key: 'curtain', label: 'Aurora Curtains', min: 0.25, max: 2, step: 0.05, default: 1 },
      { key: 'core', label: 'Reactor Core', min: 0.35, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'Field Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
    ],
    group: 'Cinematic / Shaders',
  }, // 36
  {
    id: 'warp-loom',
    name: 'Warp Loom',
    factory: warpLoom,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'threads', label: 'Thread Count', min: 0.35, max: 2, step: 0.05, default: 1 },
      { key: 'twist', label: 'Spacetime Twist', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'Warp Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
      { key: 'bloom', label: 'Fiber Bloom', min: 0.3, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Cinematic / Shaders',
  }, // 37
  {
    id: 'fractal-nebula',
    name: 'Fractal Nebula',
    factory: fractalNebula,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'power', label: 'Fractal Power', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'detail', label: 'Iteration Detail', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'glow', label: 'Nebula Glow', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'Orbit Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
    ],
    group: 'Cinematic / Shaders',
  }, // 38
  {
    id: 'aurora-storm',
    name: 'Aurora Storm',
    factory: auroraStorm,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'curtains', label: 'Curtain Layers', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'palette', label: 'Color Palette', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'shimmer', label: 'Particle Shimmer', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'Wind Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
    ],
    group: 'Cinematic / Shaders',
  }, // 39
  {
    id: 'wormhole-transit',
    name: 'Wormhole Transit',
    factory: wormholeTransit,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'twist', label: 'Spacetime Twist', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'throat', label: 'Throat Radius', min: 0.3, max: 2, step: 0.05, default: 1 },
      { key: 'doppler', label: 'Doppler Shift', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'Transit Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
    ],
    group: '3D',
  }, // 40
  {
    id: 'crystal-cavern',
    name: 'Crystal Cavern',
    factory: crystalCavern,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'crystalSize', label: 'Crystal Scale', min: 0.4, max: 2, step: 0.05, default: 1 },
      { key: 'refraction', label: 'Prismatic Refraction', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'caustics', label: 'Caustic Intensity', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'Growth Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
    ],
    group: '3D',
  }, // 41
  {
    id: 'neon-metropolis',
    name: 'Neon Metropolis',
    factory: neonMetropolis,
    params: [
      ...PREMIUM_AUDIO_RESPONSIVENESS,
      { key: 'skyline', label: 'Skyline Density', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'neon', label: 'Neon Intensity', min: 0.2, max: 2, step: 0.05, default: 1 },
      { key: 'traffic', label: 'Traffic Density', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'City Speed', min: 0, max: 2.5, step: 0.05, default: 1 },
    ],
    group: 'Neon / Lasers',
  }, // 42
  {
    id: 'solid-color',
    name: 'Solid Color',
    factory: solidColor,
    params: [
      { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: 'saturation', label: 'Saturation', min: 0, max: 1, step: 0.01, default: 0.7 },
      { key: 'brightness', label: 'Brightness', min: 0, max: 1, step: 0.01, default: 0.9 },
      { key: 'pulse', label: 'Audio Pulse', min: 0, max: 1, step: 0.01, default: 0 },
    ],
    group: 'Basics',
  }, // 43
  {
    id: 'gradient-wash',
    name: 'Color Wash',
    factory: gradientWash,
    params: [
      { key: 'hueA', label: 'Hue A', min: 0, max: 1, step: 0.01, default: 0.55 },
      { key: 'hueB', label: 'Hue B', min: 0, max: 1, step: 0.01, default: 0.92 },
      { key: 'speed', label: 'Drift Speed', min: 0, max: 3, step: 0.05, default: 0.6 },
      { key: 'pulse', label: 'Audio Pulse', min: 0, max: 2, step: 0.05, default: 0.8 },
    ],
    group: 'Basics',
  }, // 44
  {
    id: 'color-bars',
    name: 'Color Bars',
    factory: colorBars,
    params: [
      { key: 'bars', label: 'Bar Count', min: 2, max: 24, step: 1, default: 8 },
      { key: 'saturation', label: 'Saturation', min: 0, max: 1, step: 0.01, default: 0.85 },
      { key: 'brightness', label: 'Brightness', min: 0, max: 1, step: 0.01, default: 0.95 },
      { key: 'wobble', label: 'Wobble', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Basics',
  }, // 45
  {
    id: 'noise-static',
    name: 'Noise Static',
    factory: noiseStatic,
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01, default: 0.7 },
      { key: 'density', label: 'Density (Block Size)', min: 1, max: 12, step: 1, default: 3 },
      { key: 'color', label: 'Color Mode', min: 0, max: 1, step: 1, default: 0 },
      { key: 'pulse', label: 'Audio Intensity', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Basics',
  }, // 46
  {
    id: 'film-grain',
    name: 'Film Grain',
    factory: filmGrain,
    params: [
      { key: 'amount', label: 'Grain Amount', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'size', label: 'Grain Size', min: 1, max: 8, step: 1, default: 2 },
      { key: 'tint', label: 'Tint Hue', min: 0, max: 1, step: 0.01, default: 0.08 },
      { key: 'bgBrightness', label: 'Background Brightness', min: 0, max: 1, step: 0.01, default: 0.25 },
      { key: 'speed', label: 'Grain Speed', min: 0, max: 3, step: 0.05, default: 1 },
    ],
    group: 'Basics',
  }, // 47
  {
    id: 'checkerboard',
    name: 'Checkerboard',
    factory: checkerboard,
    params: [
      { key: 'cell', label: 'Cell Size', min: 12, max: 160, step: 2, default: 48 },
      { key: 'hueA', label: 'Hue A', min: 0, max: 1, step: 0.01, default: 0.58 },
      { key: 'hueB', label: 'Hue B', min: 0, max: 1, step: 0.01, default: 0.08 },
      { key: 'speed', label: 'Drift Speed', min: 0, max: 3, step: 0.05, default: 0.5 },
      { key: 'pulse', label: 'Audio Scale Pulse', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Basics',
  }, // 48
  {
    id: 'video-chroma',
    name: 'Video Chroma Key',
    factory: videoChroma,
    params: [
      { key: 'keyHue', label: 'Key Hue', min: 0, max: 360, step: 1, default: 120 },
      { key: 'tolerance', label: 'Key Tolerance', min: 0.02, max: 0.5, step: 0.01, default: 0.16 },
      { key: 'softness', label: 'Edge Softness', min: 0, max: 0.4, step: 0.01, default: 0.12 },
      { key: 'bgMode', label: 'BG Gradient', min: 0, max: 1, step: 1, default: 1 },
      { key: 'bgHue', label: 'BG Hue', min: 0, max: 360, step: 1, default: 275 },
      { key: 'bgSat', label: 'BG Saturation', min: 0, max: 1, step: 0.01, default: 0.7 },
      { key: 'bgBright', label: 'BG Brightness', min: 0, max: 1, step: 0.01, default: 0.55 },
      { key: 'audioReact', label: 'Audio Key Widen', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Video FX',
    camera: true,
  }, // 49
  {
    id: 'video-kaleido',
    name: 'Video Kaleidoscope',
    factory: videoKaleido,
    params: [
      { key: 'segments', label: 'Segments', min: 3, max: 12, step: 1, default: 6 },
      { key: 'speed', label: 'Rotation Speed', min: 0, max: 3, step: 0.05, default: 0.6 },
      { key: 'zoom', label: 'Zoom', min: 0.4, max: 3, step: 0.05, default: 1 },
      { key: 'cx', label: 'Center X', min: -1, max: 1, step: 0.05, default: 0 },
      { key: 'cy', label: 'Center Y', min: -1, max: 1, step: 0.05, default: 0 },
      { key: 'audioZoom', label: 'Audio Zoom Pump', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Video FX',
    camera: true,
  }, // 50
  {
    id: 'video-pixelate',
    name: 'Video Pixelate',
    factory: videoPixelate,
    params: [
      { key: 'block', label: 'Block Size', min: 2, max: 64, step: 1, default: 14 },
      { key: 'audioBlocks', label: 'Audio Block Swell', min: 0, max: 2, step: 0.05, default: 0.8 },
      { key: 'levels', label: 'Quantize Levels', min: 0, max: 16, step: 1, default: 8 },
      { key: 'tint', label: 'Hue Tint', min: 0, max: 1, step: 0.01, default: 0 },
      { key: 'bright', label: 'Brightness', min: 0.3, max: 1.8, step: 0.05, default: 1 },
    ],
    group: 'Video FX',
    camera: true,
  }, // 51
  {
    id: 'video-trails',
    name: 'Video Trails',
    factory: videoTrails,
    params: [
      { key: 'decay', label: 'Trail Decay', min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: 'tintHue', label: 'Tint Hue', min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: 'blend', label: 'Blend Mode', min: 0, max: 2, step: 1, default: 0 },
      { key: 'audioDecay', label: 'Audio Trail Stretch', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Video FX',
    camera: true,
  }, // 52
  {
    id: 'glitch-rgb-split',
    name: 'RGB Split',
    factory: glitchRgbSplit,
    params: [
      { key: 'intensity', label: 'Base Offset', min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: 'burst', label: 'Burst Strength', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'speed', label: 'Pattern Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'pulse', label: 'Audio Reactivity', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Glitch / Effects',
  }, // 53
  {
    id: 'glitch-scanlines',
    name: 'Scanline Roll',
    factory: glitchScanlines,
    params: [
      { key: 'speed', label: 'Roll Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'intensity', label: 'Jitter Intensity', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'bands', label: 'Scan Bands', min: 1, max: 8, step: 1, default: 3 },
      { key: 'pulse', label: 'Audio Reactivity', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Glitch / Effects',
  }, // 54
  {
    id: 'glitch-slices',
    name: 'Slice Glitch',
    factory: glitchSlices,
    params: [
      { key: 'slices', label: 'Slice Count', min: 0, max: 24, step: 1, default: 10 },
      { key: 'shift', label: 'Max Shift', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'blocks', label: 'Block Artifacts', min: 0, max: 20, step: 1, default: 8 },
      { key: 'speed', label: 'Pattern Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'pulse', label: 'Audio Reactivity', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Glitch / Effects',
  }, // 55
  {
    id: 'glitch-crt',
    name: 'CRT Glitch',
    factory: glitchCrt,
    params: [
      { key: 'curvature', label: 'Tube Curvature', min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: 'scanlines', label: 'Scanlines', min: 0, max: 1, step: 0.01, default: 0.7 },
      { key: 'flicker', label: 'Flicker', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'roll', label: 'Roll Bar', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'ghost', label: 'Ghosting', min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: 'speed', label: 'Roll Speed', min: 0, max: 3, step: 0.05, default: 1 },
      { key: 'pulse', label: 'Audio Distortion', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Glitch / Effects',
  }, // 56
  // 57
  {
    id: 'video-dots-gpu',
    name: 'Video Dots GPU',
    factory: webcamDotsGpu,
    params: [
      { key: 'spacing', label: 'Dot Spacing', min: 4, max: 24, step: 0.5, default: 12 },
      { key: 'glitch', label: 'Glitch Amount', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'react', label: 'Audio Reactivity', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Video FX',
    camera: true,
  }, // 58
  {
    id: 'video-high-contrast',
    name: 'Video High Contrast',
    factory: webcamHighContrast,
    params: [
      { key: 'threshold', label: 'Threshold', min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: 'contrast', label: 'Contrast', min: 0, max: 2, step: 0.05, default: 1 },
      { key: 'react', label: 'Audio Reactivity', min: 0, max: 2, step: 0.05, default: 1 },
    ],
    group: 'Video FX',
    camera: true,
  }, // 59
];

// Reserved id for the global dual-effect blend params (shown in merge mode).
// It intentionally cannot collide with a sketch id, so it is safe to store in
// the same param store (viz2_params) as per-effect params.
export const BLEND_ID = '__merge';

// Blend params replace the individual effect sliders while two effects are
// merged. One level slider drives either `mix` (crossfade base -> overlay) or
// `add` (additive screen-blend layering) depending on `mode` (0 = Blend,
// 1 = Additive — the default is Blend @ 0.5). The panel renders the toggle
// and a single slider; `mode` is stored here so it persists and syncs.
export const BLEND_PARAMS = [
  { key: 'mix', label: 'Blend', min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: 'add', label: 'Additive', min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: 'mode', label: 'Mode', min: 0, max: 1, step: 1, default: 0 },
];

export function defaultBlendValues() {
  const out = {};
  for (const def of BLEND_PARAMS) out[def.key] = def.default;
  return out;
}

// Reserved id for the global band-split crossovers (bass|mid and mid|high in
// Hz). Like BLEND_ID it rides the shared param store + broadcast pipeline, so
// the EQ separators persist and sync across windows for free. Edited by the
// control panel's band-split EQ; applied by the screen to the feature
// extractor (see sketches/audio-features.js setBandSplit).
export const BANDS_ID = '__bands';

// Defaults mirror MUSICAL_BANDS so nothing changes until a handle moves.
export const BAND_SPLIT_DEFAULTS = Object.freeze({ low: 180, high: 2800 });

// Reserved id for the global post-processing trim (brightness / contrast /
// saturation). Same reserved-id trick as BLEND_ID/BANDS_ID: rides the shared
// param store + broadcast pipeline, so the sliders persist and sync across
// windows for free. Applied by the screen as a CSS filter on the stage
// wrapper (see applyPostFx in main.js). Every slider is an OFFSET around the
// natural level: 0 = untouched output, -100 = fully reduced, +100 = doubled.
export const POSTFX_ID = '__postfx';

export const POSTFX_PARAMS = [
  { key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1, default: 0 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, default: 0 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, default: 0 },
];

export function defaultPostFxValues() {
  const out = {};
  for (const def of POSTFX_PARAMS) out[def.key] = def.default;
  return out;
}

// Number of pad slots / effects that get keyboard shortcuts (1-9, 0 = 10th)
export const SHORTCUT_COUNT = 10;

// localStorage key that stores the pattern pad assignment
// (array of exactly SHORTCUT_COUNT sketch ids, positions 0-9 = keys 1-0)
export const SLOT_ORDER_KEY = 'viz2_slot_order';

// Legacy key (pre-pad builds): the full reorderable effect list. Its first 10
// valid ids seed the pad on first boot after an upgrade (see loadSlotOrder).
export const EFFECT_ORDER_KEY = 'viz2_effect_order';

// Group display order for the pattern library. Any group not listed here
// (e.g. one added by a future sketch) is appended after these.
export const GROUP_ORDER = [
  'Rhythmic',
  '3D',
  'Cinematic / Shaders',
  'Neon / Lasers',
  'Video FX',
  'Glitch / Effects',
  'Basics',
];

// Group names present in SKETCHES, in GROUP_ORDER (unknown groups appended).
export function getGroups() {
  const present = [];
  const seen = new Set();
  for (const s of SKETCHES) {
    if (s.group && !seen.has(s.group)) {
      seen.add(s.group);
      present.push(s.group);
    }
  }
  const ordered = GROUP_ORDER.filter((g) => seen.has(g));
  for (const g of present) if (!ordered.includes(g)) ordered.push(g);
  return ordered;
}

// Sketches in a group, in declaration order. Camera-input effects are included
// (Video FX renders in the library like every other group).
export function getSketchesByGroup(group) {
  return SKETCHES.filter((s) => s.group === group);
}

// Load the legacy full order (viz2_effect_order), dropping unknown ids.
function loadLegacyEffectOrder() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(EFFECT_ORDER_KEY));
  } catch {
    saved = [];
  }
  if (!Array.isArray(saved)) saved = [];
  const known = new Set(SKETCHES.map((s) => s.id));
  return saved.filter((id) => known.has(id));
}

// The pattern pad assignment (array of SHORTCUT_COUNT unique sketch ids).
// Resolution order:
//   1. viz2_slot_order if present -> keep its valid ids (in order, capped).
//   2. Otherwise migrate legacy viz2_effect_order -> its first 10 valid ids.
//   3. Fill any remaining gaps from declaration order so the pad is always full.
// Nothing is written back here — the pad only persists once the user edits it.
export function loadSlotOrder() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(SLOT_ORDER_KEY));
  } catch {
    saved = [];
  }
  if (!Array.isArray(saved)) saved = [];

  const known = new Set(SKETCHES.map((s) => s.id));
  const valid = [];
  const seen = new Set();
  for (const id of saved) {
    if (valid.length >= SHORTCUT_COUNT) break;
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      valid.push(id);
    }
  }

  // First boot on an upgraded build: seed the pad from the old full order.
  if (valid.length === 0 && !localStorage.getItem(SLOT_ORDER_KEY)) {
    for (const id of loadLegacyEffectOrder()) {
      if (valid.length >= SHORTCUT_COUNT) break;
      if (!seen.has(id)) {
        seen.add(id);
        valid.push(id);
      }
    }
  }

  for (const s of SKETCHES) {
    if (valid.length >= SHORTCUT_COUNT) break;
    if (!seen.has(s.id)) {
      seen.add(s.id);
      valid.push(s.id);
    }
  }
  return valid.slice(0, SHORTCUT_COUNT);
}

export function saveSlotOrder(order) {
  localStorage.setItem(SLOT_ORDER_KEY, JSON.stringify(order));
}

// The 10 pad sketches in pad order (falls back to declaration order).
// All existing callers (screen loading, keyboard shortcuts, merge blending)
// index into this list, so they keep working unchanged.
export function getOrderedSketches() {
  const order = loadSlotOrder();
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
  if (id === BLEND_ID) return defaultBlendValues();
  if (id === BANDS_ID) return { ...BAND_SPLIT_DEFAULTS };
  if (id === POSTFX_ID) return defaultPostFxValues();
  const out = {};
  const sketch = SKETCHES.find((s) => s.id === id);
  const defs = (sketch && sketch.params) || [];
  for (const def of defs) out[def.key] = def.default;
  return out;
}
