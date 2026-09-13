// Column-major 4x4 matrix helpers used by the WebGL renderer (model-view stack,
// perspective projection, normal matrices). Deliberately tiny: only the
// operations the two mesh patterns (techno-3d, character-3d) plus the fullscreen
// shader quad need.

export function mat4Create() {
  const out = new Float32Array(16);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

export function mat4Identity(out) {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

export function mat4Copy(out, a) {
  out.set(a);
  return out;
}

/** out = a * b (column-major, matches gl-matrix semantics). */
export function mat4Multiply(out, a, b) {
  const a00 = a[0]; const a01 = a[1]; const a02 = a[2]; const a03 = a[3];
  const a10 = a[4]; const a11 = a[5]; const a12 = a[6]; const a13 = a[7];
  const a20 = a[8]; const a21 = a[9]; const a22 = a[10]; const a23 = a[11];
  const a30 = a[12]; const a31 = a[13]; const a32 = a[14]; const a33 = a[15];

  const b0 = b[0]; const b1 = b[1]; const b2 = b[2]; const b3 = b[3];
  out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  const b4 = b[4]; const b5 = b[5]; const b6 = b[6]; const b7 = b[7];
  out[4] = b4 * a00 + b5 * a10 + b6 * a20 + b7 * a30;
  out[5] = b4 * a01 + b5 * a11 + b6 * a21 + b7 * a31;
  out[6] = b4 * a02 + b5 * a12 + b6 * a22 + b7 * a32;
  out[7] = b4 * a03 + b5 * a13 + b6 * a23 + b7 * a33;

  const b8 = b[8]; const b9 = b[9]; const b10 = b[10]; const b11 = b[11];
  out[8] = b8 * a00 + b9 * a10 + b10 * a20 + b11 * a30;
  out[9] = b8 * a01 + b9 * a11 + b10 * a21 + b11 * a31;
  out[10] = b8 * a02 + b9 * a12 + b10 * a22 + b11 * a32;
  out[11] = b8 * a03 + b9 * a13 + b10 * a23 + b11 * a33;

  const b12 = b[12]; const b13 = b[13]; const b14 = b[14]; const b15 = b[15];
  out[12] = b12 * a00 + b13 * a10 + b14 * a20 + b15 * a30;
  out[13] = b12 * a01 + b13 * a11 + b14 * a21 + b15 * a31;
  out[14] = b12 * a02 + b13 * a12 + b14 * a22 + b15 * a32;
  out[15] = b12 * a03 + b13 * a13 + b14 * a23 + b15 * a33;
  return out;
}

export function mat4Translate(out, a, x, y, z) {
  if (out !== a) mat4Copy(out, a);
  out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
  out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
  out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
  out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
  return out;
}

export function mat4Scale(out, a, x, y, z) {
  out[0] = a[0] * x; out[1] = a[1] * x; out[2] = a[2] * x; out[3] = a[3] * x;
  out[4] = a[4] * y; out[5] = a[5] * y; out[6] = a[6] * y; out[7] = a[7] * y;
  out[8] = a[8] * z; out[9] = a[9] * z; out[10] = a[10] * z; out[11] = a[11] * z;
  out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
  return out;
}

function rotate(out, a, rad, axis) {
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const [x, y, z] = axis;
  const len = Math.hypot(x, y, z) || 1;
  const nx = x / len; const ny = y / len; const nz = z / len;
  const t = 1 - c;

  // Rotation matrix in ROW-MAJOR math notation: rIJ = R(row I, col J).
  const r00 = t * nx * nx + c; const r01 = t * nx * ny - s * nz; const r02 = t * nx * nz + s * ny;
  const r10 = t * nx * ny + s * nz; const r11 = t * ny * ny + c; const r12 = t * ny * nz - s * nx;
  const r20 = t * nx * nz - s * ny; const r21 = t * ny * nz + s * nx; const r22 = t * nz * nz + c;

  // Store it column-major (m[col * 4 + row]) with an identity 4th row/column.
  const rotation = [
    r00, r10, r20, 0,
    r01, r11, r21, 0,
    r02, r12, r22, 0,
    0, 0, 0, 1,
  ];

  // Column-major POST-multiplication: out = a * rotation. With column vectors
  // (the p5 / gl-matrix convention) a * rotation applies `rotation` to a point
  // FIRST, then the previously accumulated matrix `a`; the rotation is therefore
  // applied in the current local frame, which is what the p5 translate/rotate
  // stack expects. Copy when out aliases a because the product is written
  // column by column.
  const source = out === a ? Float32Array.from(a) : a;
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += rotation[col * 4 + k] * source[k * 4 + row];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export const mat4RotateX = (out, a, rad) => rotate(out, a, rad, [1, 0, 0]);
export const mat4RotateY = (out, a, rad) => rotate(out, a, rad, [0, 1, 0]);
export const mat4RotateZ = (out, a, rad) => rotate(out, a, rad, [0, 0, 1]);

export function mat4Perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / (aspect || 1);
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function mat4Invert(out, a) {
  const a00 = a[0]; const a01 = a[1]; const a02 = a[2]; const a03 = a[3];
  const a10 = a[4]; const a11 = a[5]; const a12 = a[6]; const a13 = a[7];
  const a20 = a[8]; const a21 = a[9]; const a22 = a[10]; const a23 = a[11];
  const a30 = a[12]; const a31 = a[13]; const a32 = a[14]; const a33 = a[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) { mat4Identity(out); return out; }
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/**
 * Normal matrix for a 4x4 model-view: transpose(inverse(upper-left 3x3)),
 * written into a 9-element column-major mat3.
 */
export function mat3NormalFromMat4(out, m) {
  const a00 = m[0]; const a01 = m[1]; const a02 = m[2];
  const a10 = m[4]; const a11 = m[5]; const a12 = m[6];
  const a20 = m[8]; const a21 = m[9]; const a22 = m[10];

  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  let det = a00 * b01 + a01 * b11 + a02 * b21;
  if (!det) { out.set([1, 0, 0, 0, 1, 0, 0, 0, 1]); return out; }
  det = 1.0 / det;

  // Column-major elements of inverse(M).
  const i0 = b01 * det;
  const i1 = (-a22 * a01 + a02 * a21) * det;
  const i2 = (a12 * a01 - a02 * a11) * det;
  const i3 = b11 * det;
  const i4 = (a22 * a00 - a02 * a20) * det;
  const i5 = (-a12 * a00 + a02 * a10) * det;
  const i6 = b21 * det;
  const i7 = (-a21 * a00 + a01 * a20) * det;
  const i8 = (a11 * a00 - a01 * a10) * det;

  out[0] = i0; out[1] = i3; out[2] = i6;
  out[3] = i1; out[4] = i4; out[5] = i7;
  out[6] = i2; out[7] = i5; out[8] = i8;
  return out;
}
