import { GRAPHIC_PATTERNS } from './graphic.js';
import { SPATIAL_PATTERNS } from './spatial.js';
import { FIELD_PATTERNS } from './fields.js';
import { VIDEO_PATTERNS } from './video.js';
import { RESTORED_CAMERA_PATTERNS } from './restored-camera.js';

// Exactly two additions per existing visual category — 9 researched VJ/VFX
// patterns. No Media/Projection entries. Registry order within the expansion
// wave.
const order = [
  'voxel-cascade', 'gyro-lattice',
  'godray-forge',
  'video-datamosh', 'video-rolling-shutter', 'vhs-head-switch', 'dct-blocks',
  'test-card', 'blinder-matrix',
];
const entries = [...GRAPHIC_PATTERNS, ...SPATIAL_PATTERNS, ...FIELD_PATTERNS, ...VIDEO_PATTERNS];
export const EXPANSION_PATTERNS = order.map((id) => entries.find((s) => s.id === id));

// Legacy camera looks restored from git history (exact prior ids/names):
// video-thermal and video-edge-glow, subtly audio-reactive by design.
export { RESTORED_CAMERA_PATTERNS };
