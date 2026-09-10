import { GRAPHIC_PATTERNS } from './graphic.js';
import { SPATIAL_PATTERNS } from './spatial.js';
import { FIELD_PATTERNS } from './fields.js';
import { VIDEO_PATTERNS } from './video.js';
import { RESTORED_CAMERA_PATTERNS } from './restored-camera.js';

// Exactly two additions per existing visual category plus three Techno 3D
// descendants in 3D — 21 new researched VJ/VFX patterns. No Media/Projection
// entries. Registry order within the expansion wave.
const order = [
  'lissajous-scope', 'pendulum-wave', 'step-sequencer', 'stutter-buffer',
  'voxel-cascade', 'gyro-lattice', 'techno-torus', 'techno-helix', 'techno-array',
  'godray-forge', 'feedback-bloom', 'galvo-sweep', 'neon-sign',
  'video-datamosh', 'video-rolling-shutter', 'vhs-head-switch', 'dct-blocks',
  'waveform-monitor', 'test-card', 'gobo-wheel', 'blinder-matrix',
];
const entries = [...GRAPHIC_PATTERNS, ...SPATIAL_PATTERNS, ...FIELD_PATTERNS, ...VIDEO_PATTERNS];
export const EXPANSION_PATTERNS = order.map((id) => entries.find((s) => s.id === id));

// Legacy camera looks restored from git history (exact prior ids/names):
// video-thermal and video-edge-glow, subtly audio-reactive by design.
export { RESTORED_CAMERA_PATTERNS };
