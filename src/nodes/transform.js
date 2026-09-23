// Geometry for the graph's Transform node — the image node that moves, scales
// and rotates an upstream picture in X, Y and Z.
//
// Space and units (all nine sliders default to a pixel-exact identity):
//   * the image is a unit plane in normalized frame space, x ∈ [-1, 1] left→right
//     and y ∈ [-1, 1] bottom→top, exactly covering the output frame at rest;
//   * Move X/Y are offsets in half-frame units: 1.0 shifts the picture by half
//     the frame, ±2 clears the frame completely;
//   * Move Z is a distance along the view axis in the same half-frame units, with
//     the camera parked CAMERA_Z = 1 plane-widths away. At z = 0 the plane fills
//     the frame exactly; +0.5 doubles the picture, -1 halves it;
//   * Scale X/Y scale the plane (negative mirrors), Scale Z squashes the depth
//     axis *after* rotation, so it only bends the perspective of a rotated
//     picture and is a no-op on an unrotated flat image — documented, not a bug;
//   * Rotate X/Y/Z are degrees applied Z·Y·X, and being true 3D rotations they
//     produce real perspective foreshortening (a tilted picture is a trapezoid,
//     not a squashed rectangle).
//
// The matrix is what gl-compositor.js uploads; nothing here touches the DOM, so
// the geometry is unit-testable in Node.

export const CAMERA_Z = 1;
// moveZ stops just short of the camera plane; at CAMERA_Z the projection has no
// finite result at all.
export const MOVE_Z_MAX = 0.9;

export const TRANSFORM_PARAMS = Object.freeze([
  { key: 'moveX', label: 'Move X', min: -2, max: 2, step: .01, default: 0 },
  { key: 'moveY', label: 'Move Y', min: -2, max: 2, step: .01, default: 0 },
  { key: 'moveZ', label: 'Move Z', min: -1, max: MOVE_Z_MAX, step: .01, default: 0 },
  { key: 'scaleX', label: 'Scale X', min: -4, max: 4, step: .01, default: 1 },
  { key: 'scaleY', label: 'Scale Y', min: -4, max: 4, step: .01, default: 1 },
  { key: 'scaleZ', label: 'Scale Z', min: -4, max: 4, step: .01, default: 1 },
  { key: 'rotateX', label: 'Rotate X', min: -180, max: 180, step: 1, default: 0 },
  { key: 'rotateY', label: 'Rotate Y', min: -180, max: 180, step: 1, default: 0 },
  { key: 'rotateZ', label: 'Rotate Z', min: -180, max: 180, step: 1, default: 0 },
]);

export const transformDefaults = () => Object.fromEntries(TRANSFORM_PARAMS.map(p => [p.key, p.default]));

// Scale Z cannot affect a flat plane before rotation, so it is deliberately
// ignored here: the fast identity path stays available for a picture that is
// only depth-scaled (and would look identical through the shader anyway).
const IDENTITY_KEYS = Object.freeze(['moveX', 'moveY', 'moveZ', 'scaleX', 'scaleY', 'rotateX', 'rotateY', 'rotateZ']);
export function isIdentityTransform(params = {}) {
  return TRANSFORM_PARAMS.filter(p => IDENTITY_KEYS.includes(p.key))
    .every(p => (Number.isFinite(params?.[p.key]) ? params[p.key] : p.default) === p.default);
}

// Column-major 4x4 helpers (element (row r, col c) lives at [c * 4 + r]), the
// same layout WebGL's uniformMatrix4fv expects.
export const identityMatrix = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function multiplyMatrix(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    const cb = column * 4;
    for (let row = 0; row < 4; row++) {
      out[cb + row] = a[row] * b[cb] + a[4 + row] * b[cb + 1] + a[8 + row] * b[cb + 2] + a[12 + row] * b[cb + 3];
    }
  }
  return out;
}

export function scaleMatrix(x, y, z) {
  const out = identityMatrix();
  out[0] = x; out[5] = y; out[10] = z;
  return out;
}

export function translationMatrix(x, y, z) {
  const out = identityMatrix();
  out[12] = x; out[13] = y; out[14] = z;
  return out;
}

export function rotationXMatrix(degrees) {
  const out = identityMatrix(), [c, s] = [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)];
  out[5] = c; out[9] = -s; out[6] = s; out[10] = c;
  return out;
}

export function rotationYMatrix(degrees) {
  const out = identityMatrix(), [c, s] = [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)];
  out[0] = c; out[8] = s; out[2] = -s; out[10] = c;
  return out;
}

export function rotationZMatrix(degrees) {
  const out = identityMatrix(), [c, s] = [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)];
  out[0] = c; out[4] = -s; out[1] = s; out[5] = c;
  return out;
}

// Perspective "projection": clip.w becomes (CAMERA_Z - z) / CAMERA_Z, which is 1
// on the image plane and 0 exactly at the camera, so the GPU clips anything that
// would come through the lens. clip.z stays 0 — the graph composites in 2D and
// never depth-tests.
export function perspectiveMatrix(cameraZ = CAMERA_Z) {
  const out = new Float32Array(16);
  out[0] = 1; out[5] = 1; out[11] = -1 / cameraZ; out[15] = 1;
  return out;
}

// Raw stored/live parameters with every documented default filled in.
export function transformParams(raw = {}) {
  return Object.fromEntries(TRANSFORM_PARAMS.map(p => [p.key, Number.isFinite(raw?.[p.key]) ? raw[p.key] : p.default]));
}

// The stored parameter set as one matrix: P · T · Sz · Rz · Ry · Rx · S.
export function transformMatrix(params = {}) {
  const p = transformParams(params);
  const rotation = multiplyMatrix(rotationZMatrix(p.rotateZ), multiplyMatrix(rotationYMatrix(p.rotateY), rotationXMatrix(p.rotateX)));
  let matrix = multiplyMatrix(rotation, scaleMatrix(p.scaleX, p.scaleY, p.scaleZ));
  matrix = multiplyMatrix(scaleMatrix(1, 1, p.scaleZ), matrix);
  matrix = multiplyMatrix(translationMatrix(p.moveX, p.moveY, p.moveZ), matrix);
  return multiplyMatrix(perspectiveMatrix(), matrix);
}

// The plane's four local corners, in frame order TL, TR, BR, BL.
export const PLANE_CORNERS = Object.freeze([
  Object.freeze({ x: -1, y: 1 }), Object.freeze({ x: 1, y: 1 }),
  Object.freeze({ x: 1, y: -1 }), Object.freeze({ x: -1, y: -1 }),
]);

// Forward-projected corners for the same matrix the shader receives. Exported for
// geometry tests (and for diagnosing a degenerate, edge-on picture, where the
// homogeneous w reaches 0 and the point is not finite).
export function projectedQuad(params = {}) {
  const matrix = transformMatrix(params);
  return PLANE_CORNERS.map(({ x, y }) => {
    const clipX = matrix[0] * x + matrix[4] * y + matrix[12];
    const clipY = matrix[1] * x + matrix[5] * y + matrix[13];
    const w = matrix[3] * x + matrix[7] * y + matrix[15];
    return { x: clipX / w, y: clipY / w, w };
  });
}
