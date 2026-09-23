import { GRAPHIC_PATTERNS } from './graphic.js';
import { SPATIAL_PATTERNS } from './spatial.js';
import { FIELD_PATTERNS } from './fields.js';

// Retained replacement entries in their original relative catalog order.
const order = [
  'truchet-relay', 'membrane-modes',
  'schlieren-flow', 'tidal-glass',
  'bitplane-rewire', 'riso-misprint',
  'iris-diaphragm', 'cellular-gate',
];
const entries = [...GRAPHIC_PATTERNS, ...SPATIAL_PATTERNS, ...FIELD_PATTERNS];
export const REPLACEMENT_PATTERNS = order.map(id => entries.find(s => s.id === id));
