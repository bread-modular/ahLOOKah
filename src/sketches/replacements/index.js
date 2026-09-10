import { GRAPHIC_PATTERNS } from './graphic.js';
import { SPATIAL_PATTERNS } from './spatial.js';
import { FIELD_PATTERNS } from './fields.js';
import { VIDEO_PATTERNS } from './video.js';

// Exactly two additions per existing visual category. No Media/Projection entries.
const order = [
  'truchet-relay', 'counterweight', 'membrane-modes', 'ratchet-wheel',
  'pin-relief', 'folded-spire', 'schlieren-flow', 'tidal-glass',
  'vector-knot', 'prism-scanner', 'video-slit-scan', 'video-facet-fold',
  'bitplane-rewire', 'riso-misprint', 'barn-doors', 'stair-wipe',
  'iris-diaphragm', 'cellular-gate',
];
const entries = [...GRAPHIC_PATTERNS, ...SPATIAL_PATTERNS, ...FIELD_PATTERNS, ...VIDEO_PATTERNS];
export const REPLACEMENT_PATTERNS = order.map(id => entries.find(s => s.id === id));
