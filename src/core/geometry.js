// Mesh builders for the WebGL core, matching the geometry conventions measured
// from p5 2.3.x (see docs/core-rendering.md):
//   * The default camera sits at +Z 800 and the projection flips Y, so a larger
//     world Y appears LOWER on screen and the viewport shows exactly
//     `height` world units at z = 0 (1 world unit == 1 logical px).
//   * box()/sphere() are centred on the origin; plane() spans the XY plane.
//   * cone() has its base ring at y = -height/2 and its apex at y = +height/2.

/** Screen-space unit quad used by the fullscreen user-shader path. */
export function unitQuadGeometry() {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    texCoords: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    edges: new Uint16Array([0, 1, 1, 2, 2, 3, 3, 0]),
  };
}

/** Axis-aligned world-space quad (used by rect()/text/image in WebGL). */
export function quadGeometry(x, y, w, h) {
  const x1 = x + w;
  const y1 = y + h;
  return {
    positions: new Float32Array([x, y, 0, x1, y, 0, x1, y1, 0, x, y1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    // v = 0 at the quad's top edge to match the texture upload orientation.
    texCoords: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    edges: new Uint16Array([0, 1, 1, 2, 2, 3, 3, 0]),
  };
}

/** Plane in the XY plane, centred on the origin, subdivided detailX × detailY. */
export function planeGeometry(width, height, detailX = 1, detailY = 1) {
  const cols = Math.max(1, Math.round(detailX));
  const rows = Math.max(1, Math.round(detailY));
  const positions = [];
  const normals = [];
  const texCoords = [];
  const indices = [];
  const edges = [];
  for (let j = 0; j <= rows; j += 1) {
    const v = j / rows;
    for (let i = 0; i <= cols; i += 1) {
      const u = i / cols;
      positions.push((u - 0.5) * width, (v - 0.5) * height, 0);
      normals.push(0, 0, 1);
      texCoords.push(u, v);
    }
  }
  const stride = cols + 1;
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const a = j * stride + i;
      indices.push(a, a + 1, a + stride, a + stride, a + 1, a + stride + 1);
      edges.push(a + 1, a + stride);
    }
  }
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const a = j * stride + i;
      edges.push(a, a + 1);
    }
  }
  for (let i = 0; i <= cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      const a = j * stride + i;
      edges.push(a, a + stride);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    texCoords: new Float32Array(texCoords),
    indices: new Uint16Array(indices),
    edges: new Uint16Array(edges),
  };
}

/** Centred box with per-face normals. */
export function boxGeometry(width = 50, height = width, depth = height) {
  const hw = width / 2;
  const hh = height / 2;
  const hd = depth / 2;
  const faces = [
    { n: [0, 0, 1], v: [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]] },
    { n: [0, 0, -1], v: [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]] },
    { n: [1, 0, 0], v: [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]] },
    { n: [-1, 0, 0], v: [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]] },
    { n: [0, 1, 0], v: [[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd]] },
    { n: [0, -1, 0], v: [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]] },
  ];
  const positions = [];
  const normals = [];
  const texCoords = [];
  const indices = [];
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  faces.forEach((face, f) => {
    face.v.forEach((vertex, i) => {
      positions.push(vertex[0], vertex[1], vertex[2]);
      normals.push(face.n[0], face.n[1], face.n[2]);
      texCoords.push(uvs[i][0], uvs[i][1]);
    });
    const base = f * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  // The 12 cube edges, expressed once.
  const corners = [
    [-hw, -hh, -hd], [hw, -hh, -hd], [hw, hh, -hd], [-hw, hh, -hd],
    [-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd],
  ];
  const edgesRaw = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const extraPositions = corners.flat();
  const edgeBase = positions.length / 3;
  extraPositions.forEach((value) => positions.push(value));
  corners.forEach(() => { normals.push(0, 0, 1); texCoords.push(0, 0); });
  const edges = new Uint16Array(edgesRaw.flatMap(([a, b]) => [edgeBase + a, edgeBase + b]));
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    texCoords: new Float32Array(texCoords),
    indices: new Uint16Array(indices),
    edges,
  };
}

/** UV sphere: detailX meridians, detailY rings. */
export function sphereGeometry(radius = 50, detailX = 24, detailY = 16) {
  const segX = Math.max(3, Math.round(detailX));
  const segY = Math.max(2, Math.round(detailY));
  const positions = [];
  const normals = [];
  const texCoords = [];
  const indices = [];
  const edges = [];
  const stride = segX + 1;
  for (let j = 0; j <= segY; j += 1) {
    const v = j / segY;
    // p5 walks latitude from -PI/2 to PI/2; the world Y flip happens in the
    // projection so the sphere keeps the same silhouette either way.
    const theta = -Math.PI / 2 + v * Math.PI;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    for (let i = 0; i <= segX; i += 1) {
      const u = i / segX;
      const phi = u * Math.PI * 2;
      const x = Math.sin(phi) * cosT;
      const y = sinT;
      const z = Math.cos(phi) * cosT;
      positions.push(x * radius, y * radius, z * radius);
      normals.push(x, y, z);
      texCoords.push(u, v);
    }
  }
  for (let j = 0; j < segY; j += 1) {
    for (let i = 0; i < segX; i += 1) {
      const a = j * stride + i;
      indices.push(a, a + 1, a + stride, a + stride, a + 1, a + stride + 1);
      edges.push(a + 1, a + stride);
    }
  }
  // Retain every triangle edge, including shared-edge overdraw. p5 does not
  // deduplicate these: translucent Techno3D wires depend on that compositing.
  edges.length = 0;
  if (detailX <= 24 && detailY <= 24) {
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = indices.slice(i, i + 3);
      edges.push(a, b, b, c, c, a);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    texCoords: new Float32Array(texCoords),
    indices: new Uint16Array(indices),
    edges: new Uint16Array(edges),
  };
}

/** Cone: base ring at y = -height/2, apex at y = +height/2 (p5 2.x layout). */
export function coneGeometry(radius = 50, height = 50, detailX = 24, detailY = 1) {
  const segX = Math.max(3, Math.round(detailX));
  const baseY = -height / 2;
  const apexY = height / 2;
  const positions = [];
  const normals = [];
  const texCoords = [];
  const indices = [];
  const edges = [];
  const slope = Math.atan2(radius, height);
  const sinSlope = Math.sin(slope);
  const cosSlope = Math.cos(slope);
  for (let i = 0; i < segX; i += 1) {
    const u = i / segX;
    const phi = u * Math.PI * 2;
    const x = Math.cos(phi);
    const z = Math.sin(phi);
    // Side quad: base vertex pair + apex (duplicated per segment for normals).
    const sideBase = positions.length / 3;
    for (const [px, pz, ny] of [[x * radius, z * radius, -cosSlope], [x * radius, z * radius, -cosSlope]]) {
      positions.push(px, baseY, pz);
      normals.push(x * sinSlope, ny, z * sinSlope);
      texCoords.push(u, 1);
    }
    positions.push(0, apexY, 0);
    normals.push(x * sinSlope, -cosSlope, z * sinSlope);
    texCoords.push(u, 0);
    const nextU = (i + 1) / segX;
    positions.push(Math.cos(nextU * Math.PI * 2) * radius, baseY, Math.sin(nextU * Math.PI * 2) * radius);
    normals.push(Math.cos(nextU * Math.PI * 2) * sinSlope, -cosSlope, Math.sin(nextU * Math.PI * 2) * sinSlope);
    texCoords.push(nextU, 1);
    indices.push(sideBase, sideBase + 3, sideBase + 2, sideBase, sideBase + 1, sideBase + 3);
    // Base cap (normal -Y, matching the base ring at y = -height/2).
    const capBase = positions.length / 3;
    positions.push(x * radius, baseY, z * radius);
    normals.push(0, 1, 0);
    texCoords.push(0.5 + x * 0.5, 0.5 + z * 0.5);
    positions.push(Math.cos(nextU * Math.PI * 2) * radius, baseY, Math.sin(nextU * Math.PI * 2) * radius);
    normals.push(0, 1, 0);
    texCoords.push(0.5 + Math.cos(nextU * Math.PI * 2) * 0.5, 0.5 + Math.sin(nextU * Math.PI * 2) * 0.5);
    positions.push(0, baseY, 0);
    normals.push(0, 1, 0);
    texCoords.push(0.5, 0.5);
    indices.push(capBase, capBase + 1, capBase + 2);
    edges.push(sideBase, sideBase + 2, sideBase + 2, sideBase + 3, capBase, capBase + 1);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    texCoords: new Float32Array(texCoords),
    indices: new Uint16Array(indices),
    edges: new Uint16Array(edges),
  };
}
