// End-of-chain output mapping (software keystone). The operator drags four
// normalized corners until the trapezoid matches what the projector paints on
// the physical screen; the output stage is then pre-warped with the matching
// homography so the projected picture reads as a true rectangle.
//
// Pure module: no DOM, no store access. Both windows share it so the message
// payload, the persisted form and the CSS output stay one contract.

import { STORAGE } from './platform/constants.js';

export const IDENTITY_QUAD = Object.freeze([
  Object.freeze({ x: 0, y: 0 }), // top-left
  Object.freeze({ x: 1, y: 0 }), // top-right
  Object.freeze({ x: 1, y: 1 }), // bottom-right
  Object.freeze({ x: 0, y: 1 }), // bottom-left
]);

export const SCREEN_MAPPING_CORNER_LABELS = Object.freeze(['TL', 'TR', 'BR', 'BL']);

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Smallest normalized quad area we still accept — anything smaller projects as
// a near-degenerate sliver that can no longer be adjusted meaningfully.
const MIN_QUAD_AREA = 0.02;

function isPlainPoint(pt) {
  return Boolean(pt)
    && typeof pt === 'object'
    && !Array.isArray(pt)
    && Number.isFinite(pt.x)
    && Number.isFinite(pt.y);
}

// A quad is renderable only when STRICTLY convex (keystone domain): all four
// turns must be non-zero and share one sign. This rejects crossed, concave,
// duplicate-corner and three-collinear-point quads, plus near-zero slivers, so
// the runtime can retain the last valid mapping instead of garbling output.
export function isRenderableQuad(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) return false;
  if (!quad.every(isPlainPoint)) return false;
  const pts = quad.map((pt) => ({ x: clamp01(pt.x), y: clamp01(pt.y) }));
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const p = pts[i];
    const q = pts[(i + 1) % 4];
    const r = pts[(i + 2) % 4];
    const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
    if (Math.abs(cross) <= 1e-9) return false; // duplicate or collinear vertices
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false; // concave or crossed
  }
  const area2 = Math.abs(
    pts[0].x * (pts[1].y - pts[3].y)
    + pts[1].x * (pts[2].y - pts[0].y)
    + pts[2].x * (pts[3].y - pts[1].y)
    + pts[3].x * (pts[0].y - pts[2].y),
  );
  return area2 > MIN_QUAD_AREA;
}

export function isIdentityQuad(quad) {
  return Array.isArray(quad)
    && quad.length === 4
    && quad.every((pt, i) => isPlainPoint(pt)
      && Math.abs(pt.x - IDENTITY_QUAD[i].x) < 1e-6
      && Math.abs(pt.y - IDENTITY_QUAD[i].y) < 1e-6);
}

// Accepts any raw payload (broadcast message, localStorage JSON, editor state)
// and returns:
//   { valid: true, quad: null }          -> reset to the full frame
//   { valid: true, quad: [...] }         -> clamped, renderable mapping
//   { valid: false }                     -> malformed / unrenderable: caller
//                                           retains its previous mapping
export function parseMappingQuad(raw) {
  if (raw === null || raw === undefined) return { valid: true, quad: null };
  if (!Array.isArray(raw) || raw.length !== 4) return { valid: false };
  if (!raw.every(isPlainPoint)) return { valid: false };
  const quad = raw.map((pt) => ({ x: clamp01(pt.x), y: clamp01(pt.y) }));
  if (!isRenderableQuad(quad)) return { valid: false };
  return { valid: true, quad };
}

export function cloneQuad(quad) {
  return Array.isArray(quad) ? quad.map((pt) => ({ x: pt.x, y: pt.y })) : null;
}

export function quadToPointsString(quad, scale = 100) {
  const pts = Array.isArray(quad) && quad.length === 4 ? quad : IDENTITY_QUAD;
  return pts.map((pt) => `${(pt.x * scale).toFixed(2)},${(pt.y * scale).toFixed(2)}`).join(' ');
}

// Heckbert's unit-square -> quad projective map, re-based into the stage's
// pixel coordinate space and emitted as a CSS matrix3d() (column-major). The
// stage's local coordinates are window CSS pixels, so the unit-square mapping
// is composed as pixel -> unit (S) -> normalized quad (H) -> pixel (T):
//   m11 = a        m12 = W*b/H     m14 = W*c
//   m21 = H*d/W    m22 = e         m24 = H*f
//   m41 = g/W      m42 = h/H       m44 = 1
// With transform-origin: 0 0 the full-frame canvas is warped exactly into the
// operator's quad. Returns null for identity/absent quads (caller clears the
// transform) and for quads that fail renderability.
export function quadToMatrix3d(quad, width, height) {
  if (!quad || !isRenderableQuad(quad)) return null;
  if (isIdentityQuad(quad)) return null;
  const W = Math.max(1, Number(width) || 1);
  const H = Math.max(1, Number(height) || 1);
  const [tl, tr, br, bl] = quad.map((pt) => ({ x: clamp01(pt.x), y: clamp01(pt.y) }));

  const dx1 = tr.x - br.x;
  const dy1 = tr.y - br.y;
  const dx2 = bl.x - br.x;
  const dy2 = bl.y - br.y;
  const sx = tl.x - tr.x + br.x - bl.x;
  const sy = tl.y - tr.y + br.y - bl.y;
  const den = dx1 * dy2 - dx2 * dy1;
  if (!Number.isFinite(den) || Math.abs(den) < 1e-9) return null;

  const g = (sx * dy2 - sy * dx2) / den;
  const hc = (dx1 * sy - dy1 * sx) / den;
  const a = tr.x - tl.x + g * tr.x;
  const b = bl.x - tl.x + hc * bl.x;
  const c = tl.x;
  const d = tr.y - tl.y + g * tr.y;
  const e = bl.y - tl.y + hc * bl.y;
  const f = tl.y;

  // 12 decimal places keeps full double precision in the string itself. All 16
  // arguments are then scaled by a constant K (a power of two: exact binary
  // scaling) — homogeneous matrices are invariant under this, but it lifts the
  // small perspective terms (g/W, hc/H ~1e-5) into the range where browser CSS
  // serializers (which keep ~7 decimal places) retain 6+ significant digits.
  // Without it, Chrome rounds hc/H to -7.71e-05 and corner error grows to a
  // noticeable fraction of a pixel at 1440p+; painted-output and hit-test
  // specs verify the actual rendered result at 4K.
  const K = 4096;
  const n = (v) => (v * K).toFixed(12);
  return `matrix3d(${n(a)}, ${n(H * d / W)}, 0, ${n(g / W)}, ${n(W * b / H)}, ${n(e)}, 0, ${n(hc / H)}, 0, 0, ${n(1)}, 0, ${n(W * c)}, ${n(H * f)}, 0, ${n(1)})`;
}

// ---------------------------------------------------------------------------
// localStorage persistence (independent of the cueable parameter banks — the
// mapping is projection-hardware state, not show state). The warp is opt-in:
// without the enabled flag (or with it off) the output renders the full frame.
// ---------------------------------------------------------------------------
export function loadStoredMappingEnabled() {
  try {
    return localStorage.getItem(STORAGE.screenMappingEnabled) === '1';
  } catch {
    return false;
  }
}

export function storeMappingEnabled(enabled) {
  try {
    localStorage.setItem(STORAGE.screenMappingEnabled, enabled ? '1' : '0');
  } catch {
    // Storage may be unavailable (private mode); the session keeps working.
  }
}

export function loadStoredMappingQuad() {
  try {
    const raw = localStorage.getItem(STORAGE.screenMapping);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const payload = parsed && typeof parsed === 'object' && parsed.v === 1 ? parsed.quad : parsed;
    const result = parseMappingQuad(payload);
    return result.valid ? cloneQuad(result.quad) : null;
  } catch {
    return null;
  }
}

export function storeMappingQuad(quad) {
  try {
    if (quad) localStorage.setItem(STORAGE.screenMapping, JSON.stringify({ v: 1, quad: cloneQuad(quad) }));
    else localStorage.removeItem(STORAGE.screenMapping);
  } catch {
    // Storage may be unavailable (private mode); the session keeps working.
  }
}
