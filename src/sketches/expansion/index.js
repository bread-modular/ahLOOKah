import { GRAPHIC_PATTERNS } from './graphic.js';
import { SPATIAL_PATTERNS } from './spatial.js';
import { FIELD_PATTERNS } from './fields.js';
import { RESTORED_CAMERA_PATTERNS } from './restored-camera.js';

// Retained expansion entries in their original relative catalog order.
// No Media/Projection entries.
const order = [
  'voxel-cascade', 'gyro-lattice',
  'godray-forge',
  'vhs-head-switch', 'dct-blocks',
  'test-card', 'blinder-matrix',
];
const entries = [...GRAPHIC_PATTERNS, ...SPATIAL_PATTERNS, ...FIELD_PATTERNS];
export const EXPANSION_PATTERNS = order.map((id) => entries.find((s) => s.id === id));

// Legacy camera looks restored from git history (exact prior ids/names):
// video-thermal and video-edge-glow, subtly audio-reactive by design.
export { RESTORED_CAMERA_PATTERNS };
