// Projection topology is library metadata; geometry and child controls live in
// the parent's numeric param bank, so CUE copies/TAKE promotes them atomically.
import { IDENTITY_QUAD, cloneQuad, parseMappingQuad, normalizeMappingEdgeBlur, SCREEN_MAPPING_EDGE_BLUR_MAX } from '../screen-mapping.js';

export const PROJECTION_GROUP = 'Projection Mapping';
export const PROJECTION_STORAGE_KEY = 'viz2_projection_patterns';
export const MAX_SURFACES = 8;
export const MAX_PROJECTIONS = 32;
export const MAX_PROJECTION_PARAMS = 256;
export const projectionKey = (surfaceId, key) => `${surfaceId}:${key}`;
export const newProjectionId = () => `projection-${crypto.randomUUID()}`;
export const newSurfaceId = () => `s${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
export const cleanProjectionName = (name) => typeof name === 'string' ? name.trim().slice(0, 80) : '';

export function sanitizeProjection(raw) {
  if (!raw || !/^projection-[a-zA-Z0-9-]{1,48}$/.test(raw.id) || !cleanProjectionName(raw.name)
    || !Array.isArray(raw.surfaces) || raw.surfaces.length > MAX_SURFACES) return null;
  const ids = new Set();
  const surfaces = [];
  for (const surface of raw.surfaces) {
    if (!surface || !/^s[a-zA-Z0-9-]{1,16}$/.test(surface.id) || ids.has(surface.id)
      || !cleanProjectionName(surface.name)) return null;
    // Reject nesting even if the referenced entry has not been registered yet.
    if (typeof surface.patternId !== 'string' || surface.patternId.length > 80
      || surface.patternId.startsWith('projection-')) return null;
    ids.add(surface.id);
    surfaces.push({ id: surface.id, name: cleanProjectionName(surface.name), patternId: surface.patternId });
  }
  return { id: raw.id, name: cleanProjectionName(raw.name), surfaces };
}

export function loadProjectionMeta() {
  try {
    const text = localStorage.getItem(PROJECTION_STORAGE_KEY);
    if (!text || text.length > 100000) return [];
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    return raw.slice(0, MAX_PROJECTIONS).map(sanitizeProjection).filter((item) => {
      if (!item || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  } catch { return []; }
}

export function saveProjectionMeta(list) {
  localStorage.setItem(PROJECTION_STORAGE_KEY, JSON.stringify(list));
}

export function surfaceQuad(surface, values = {}) {
  const quad = IDENTITY_QUAD.map((point, i) => Object.fromEntries(['x', 'y'].map((axis) => [
    axis, values[projectionKey(surface.id, `${i}${axis}`)] ?? point[axis],
  ])));
  const parsed = parseMappingQuad(quad);
  return parsed.valid ? cloneQuad(parsed.quad || IDENTITY_QUAD) : cloneQuad(IDENTITY_QUAD);
}

export function surfaceQuadValues(surfaceId, quad) {
  const parsed = parseMappingQuad(quad);
  if (!parsed.valid) return null;
  return Object.fromEntries((parsed.quad || IDENTITY_QUAD).flatMap((point, i) =>
    ['x', 'y'].map((axis) => [projectionKey(surfaceId, `${i}${axis}`), point[axis]])));
}

// Mapping-owned values share the geometry channel, independent of source params.
export function surfaceEdgeBlur(surface, values = {}) {
  return normalizeMappingEdgeBlur(values[projectionKey(surface.id, 'mappingEdgeBlur')]);
}

export function surfaceMappingValues(surfaceId, quad, edgeBlur) {
  const geometry = surfaceQuadValues(surfaceId, quad);
  return geometry && { ...geometry, [projectionKey(surfaceId, 'mappingEdgeBlur')]: normalizeMappingEdgeBlur(edgeBlur) };
}

export function surfaceParamView(surface, sketch, resolveParent) {
  // Getter-backed view retains its identity while LIVE/CUE banks are adopted.
  return Object.defineProperties({}, Object.fromEntries((sketch.params || []).map((def) => [def.key, {
    enumerable: true,
    get: () => resolveParent()[projectionKey(surface.id, def.key)] ?? def.default,
  }])));
}

export function registerProjectionSketches(sketches, snapshot = undefined) {
  const metas = Array.isArray(snapshot)
    ? snapshot.slice(0, MAX_PROJECTIONS).map(sanitizeProjection).filter(Boolean)
    : loadProjectionMeta();
  const wanted = new Set(metas.map((meta) => meta.id));
  for (let i = sketches.length - 1; i >= 0; i--) {
    if (sketches[i].projection && !wanted.has(sketches[i].id)) sketches.splice(i, 1);
  }
  for (const meta of metas) {
    const params = meta.surfaces.flatMap((surface) => {
      const child = sketches.find((sketch) => sketch.id === surface.patternId && !sketch.projection);
      return [
        ...IDENTITY_QUAD.flatMap((point, i) => ['x', 'y'].map((axis) => ({
          key: projectionKey(surface.id, `${i}${axis}`), label: `${i}${axis}`,
          min: 0, max: 1, step: 0.001, default: point[axis], geometry: true,
        }))),
        { key: projectionKey(surface.id, 'mappingEdgeBlur'), label: 'Edge smoothing',
          min: 0, max: SCREEN_MAPPING_EDGE_BLUR_MAX, step: 0.5, default: 0, geometry: true },
        ...(child?.params || []).map((def) => ({ ...def, key: projectionKey(surface.id, def.key) })),
      ];
    });
    params.unshift({ key: 'alphaBlend', label: 'Alpha Blend', min: 0, max: 1, step: 1, default: 0 });
    const entry = { ...meta, projection: true, group: PROJECTION_GROUP, params };
    const index = sketches.findIndex((sketch) => sketch.id === meta.id);
    if (index < 0) sketches.push(entry);
    else sketches[index] = entry;
  }
}

// Validate whole geometry after applying a partial numeric patch. Invalid
// quadrilaterals never enter LIVE/CUE or persisted state.
export function validProjectionPatch(sketch, current, patch) {
  if (!sketch?.projection) return true;
  const defs = new Map(sketch.params.map((def) => [def.key, def]));
  if (!patch || Object.keys(patch).length > MAX_PROJECTION_PARAMS) return false;
  if (!Object.entries(patch).every(([key, value]) => {
    const def = defs.get(key);
    return def && Number.isFinite(value) && value >= def.min && value <= def.max
      && (key !== 'alphaBlend' || value === 0 || value === 1);
  })) return false;
  const next = { ...current, ...patch };
  return sketch.surfaces.every((surface) => parseMappingQuad(IDENTITY_QUAD.map((point, i) => ({
    x: next[projectionKey(surface.id, `${i}x`)] ?? point.x,
    y: next[projectionKey(surface.id, `${i}y`)] ?? point.y,
  }))).valid);
}
