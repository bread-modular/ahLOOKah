// WebGL renderer for the focused core.
//
// Scope: exactly what the 42 fullscreen-GLSL patterns and the two mesh patterns
// (techno-3d, character-3d) use — user shader programs with uniform/texture
// bindings, an internal mesh program for box/sphere/plane/cone/lines, a matrix
// stack, ambient/point lights and clear/background.
//
// Measured p5 2.3.x conventions this renderer reproduces (see
// tests/core-shader-contract.spec.js and docs/core-rendering.md):
//   * With a user shader active, `rect()` draws a SCREEN-space unit quad that
//     ignores its arguments: aPosition == aTexCoord, u = 0 left → 1 right,
//     v = 0 bottom → 1 top.
//   * Textures upload without a Y flip, so texel row 0 (the source's top row)
//     is sampled at v = 0.
//   * Default camera: eye (0,0,800), near = 80, far = 8000, and the projection
//     flips Y (m[5] < 0) so +Y is DOWN on screen. The focal scale is derived
//     from the canvas height, so 1 world unit == 1 logical px at z = 0.
//   * box()/sphere() are centred; cone() spans base at y = -h/2 → apex +h/2.

import { ADD, BLEND, DARKEST, LIGHTEST, MULTIPLY } from './constants.js';
import { VizColor } from './color.js';
import {
  boxGeometry, coneGeometry, planeGeometry, quadGeometry, sphereGeometry, unitQuadGeometry,
} from './geometry.js';
import {
  mat3NormalFromMat4, mat4Create, mat4Identity, mat4Multiply, mat4Perspective, mat4RotateX,
  mat4RotateY, mat4RotateZ, mat4Scale, mat4Translate,
} from './matrix.js';
import { resolveSource } from './media.js';

const MESH_VERT = `
  precision highp float;
  attribute vec3 aPosition;
  attribute vec3 aNormal;
  attribute vec2 aTexCoord;
  uniform mat4 uModelViewMatrix;
  uniform mat4 uProjectionMatrix;
  uniform mat3 uNormalMatrix;
  varying vec2 vTexCoord;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vTexCoord = aTexCoord;
    vNormal = uNormalMatrix * aNormal;
    vec4 viewPosition = uModelViewMatrix * vec4(aPosition, 1.0);
    vViewPosition = viewPosition.xyz;
    gl_Position = uProjectionMatrix * viewPosition;
  }
`;

const MESH_FRAG = `
  precision highp float;
  uniform vec4 uTint;
  uniform float uUseLighting;
  uniform float uUseTexture;
  uniform sampler2D uTex;
  uniform vec3 uAmbientColor;
  uniform vec3 uPointLightColor[4];
  uniform vec3 uPointLightPosition[4];
  uniform int uPointLightCount;
  varying vec2 vTexCoord;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vec4 base = uUseTexture > 0.5 ? texture2D(uTex, vTexCoord) : vec4(1.0);
    base *= uTint;
    if (base.a <= 0.0) discard;
    if (uUseLighting > 0.5) {
      vec3 lighting = uAmbientColor;
      for (int i = 0; i < 4; i++) {
        if (i >= uPointLightCount) { break; }
        vec3 toLight = uPointLightPosition[i] - vViewPosition;
        float distance = max(length(toLight), 0.0001);
        float diffuse = max(dot(normalize(vNormal), toLight / distance), 0.0);
        lighting += uPointLightColor[i] * diffuse * 0.73;
      }
      base.rgb *= lighting;
    }
    gl_FragColor = base;
  }
`;

// Expand edges into triangles; native GL_LINES silently clamps thick strokes.
// Weight is in world units with the default perspective projection, as in p5.
const STROKE_VERT = `
precision highp float;
attribute vec3 aPosition;
attribute vec3 aOther;
attribute vec2 aCorner;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
uniform vec2 uViewport;
uniform float uWeight;
varying vec2 vCap;
void main() {
  vec4 p = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
  vec4 q = uProjectionMatrix * uModelViewMatrix * vec4(aOther, 1.0);
  vec2 direction = (q.xy * p.w - p.xy * q.w) * uViewport;
  float len = length(direction);
  vec2 tangent = len > 0.00001 ? direction / len : vec2(1., 0.);
  vec2 normal = vec2(-tangent.y, tangent.x);
  vec2 offset = (normal * aCorner.x - tangent * aCorner.y) * uWeight * 0.5;
  p.xy += offset * vec2(uProjectionMatrix[0][0], abs(uProjectionMatrix[1][1]));
  // A small depth bias keeps coplanar edges visible on filled faces.
  p.z -= 0.00001 * p.w;
  gl_Position = p;
  vCap = vec2(aCorner.x, aCorner.y);
}
`;
const STROKE_FRAG = `
precision highp float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }
`;

const MAX_POINT_LIGHTS = 4;
const CAMERA_Z = 800;
const NEAR_PLANE = CAMERA_Z / 10;
const FAR_PLANE = CAMERA_Z * 10;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log || 'unknown error'}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Shader link error: ${log || 'unknown error'}`);
  }
  return program;
}

/** A user-supplied vertex/fragment program plus p5-style setUniform(). */
export class VizShader {
  constructor(renderer, vertexSource, fragmentSource) {
    this._renderer = renderer;
    const gl = renderer.gl;
    this.program = createProgram(gl, vertexSource, fragmentSource);
    this.uniforms = new Map();
    const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i += 1) {
      const info = gl.getActiveUniform(this.program, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      this.uniforms.set(name, {
        location: gl.getUniformLocation(this.program, info.name),
        type: info.type,
        size: info.size,
      });
    }
  }

  setUniform(name, value) {
    this._renderer._setShaderUniform(this, name, value);
    return this;
  }

  dispose() {
    try { this._renderer.gl.deleteProgram(this.program); } catch { /* context gone */ }
    this.program = null;
  }
}

export class RendererGL {
  constructor({ pInst, canvas = null, width = 100, height = 100, density = null }) {
    this._pInst = pInst;
    this._isMainCanvas = true;
    this.isP3D = true;
    this.canvas = canvas || document.createElement('canvas');
    this._pixelDensity = density ?? (pInst?._pixelDensity || 1);
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.canvas.width = Math.max(1, Math.floor(this.width * this._pixelDensity));
    this.canvas.height = Math.max(1, Math.floor(this.height * this._pixelDensity));

    // Measured p5 2.3.2 context defaults (p5.RendererGL._setAttributeDefaults):
    // alpha/depth/stencil on, antialias only on Safari, premultipliedAlpha on and
    // preserveDrawingBuffer ON. The p5-only keys (perPixelLighting, version) are
    // ignored by getContext, so the exact object p5 passes is reproduced here.
    const applyAA = typeof navigator !== 'undefined'
      && navigator.userAgent.toLowerCase().includes('safari');
    const attributes = {
      alpha: true,
      depth: true,
      stencil: true,
      antialias: applyAA,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    };
    const gl = this.canvas.getContext('webgl2', attributes)
      || this.canvas.getContext('webgl', attributes)
      || this.canvas.getContext('experimental-webgl', attributes);
    if (!gl) throw new Error('WebGL is unavailable in this browser.');
    this.gl = gl;
    this.GL = gl;
    this.drawingContext = gl;
    this.glVersion = gl.getParameter(gl.VERSION);

    this._mesh = createProgram(gl, MESH_VERT, MESH_FRAG);
    this._meshLocations = {
      aPosition: gl.getAttribLocation(this._mesh, 'aPosition'),
      aNormal: gl.getAttribLocation(this._mesh, 'aNormal'),
      aTexCoord: gl.getAttribLocation(this._mesh, 'aTexCoord'),
      uModelViewMatrix: gl.getUniformLocation(this._mesh, 'uModelViewMatrix'),
      uProjectionMatrix: gl.getUniformLocation(this._mesh, 'uProjectionMatrix'),
      uNormalMatrix: gl.getUniformLocation(this._mesh, 'uNormalMatrix'),
      uTint: gl.getUniformLocation(this._mesh, 'uTint'),
      uUseLighting: gl.getUniformLocation(this._mesh, 'uUseLighting'),
      uUseTexture: gl.getUniformLocation(this._mesh, 'uUseTexture'),
      uTex: gl.getUniformLocation(this._mesh, 'uTex'),
      uAmbientColor: gl.getUniformLocation(this._mesh, 'uAmbientColor'),
      uPointLightColor: gl.getUniformLocation(this._mesh, 'uPointLightColor'),
      uPointLightPosition: gl.getUniformLocation(this._mesh, 'uPointLightPosition'),
      uPointLightCount: gl.getUniformLocation(this._mesh, 'uPointLightCount'),
    };

    // Style state (persists between frames, like p5).
    this._doFill = true;
    this._doStroke = false;
    this._fillColor = new VizColor(255, 255, 255, 255);
    this._strokeColor = new VizColor(0, 0, 0, 255);
    this._strokeWeight = 1;
    this._tint = null;
    this._blendMode = BLEND;
    this._textAlignH = 'left';
    this._textAlignV = 'top';
    this._textSize = 12;
    this._textFont = 'sans-serif';
    this._textStyle = 'normal';

    this._modelMatrix = mat4Create();
    this._modelStack = [];
    this._viewMatrix = mat4Create();
    this._projectionMatrix = mat4Create();
    this._modelViewMatrix = mat4Create();
    this._normalMatrix = new Float32Array(9);
    this._currentShader = null;
    this._boundProgram = null;
    this._geometryCache = new Map();
    this._textures = new Map();
    this._textureUnitsUsed = 0;
    this._lights = { ambient: [0, 0, 0], points: [], enabled: false };
    this._textCanvas = null;
    this.pixels = new Uint8Array(0);

    this._updateViewMatrix();
    this.resize(this.width, this.height);
  }

  // ---------------------------------------------------------------- lifecycle
  resize(width, height) {
    const w = Math.max(1, Math.round(Number(width) || 1));
    const h = Math.max(1, Math.round(Number(height) || 1));
    this.width = w;
    this.height = h;
    this.canvas.width = Math.max(1, Math.floor(w * this._pixelDensity));
    this.canvas.height = Math.max(1, Math.floor(h * this._pixelDensity));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this._updateProjection();
    this.resetMatrix();
    return this;
  }

  pixelDensity(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      if (value !== this._pixelDensity) {
        this._pixelDensity = value;
        this.resize(this.width, this.height);
      }
      return this;
    }
    return this._pixelDensity;
  }

  resetFrame() {
    this._modelStack.length = 0;
    mat4Identity(this._modelMatrix);
    this._currentShader = null;
    this._textureUnitsUsed = 0;
    this._lights.ambient = [0, 0, 0];
    this._lights.enabled = false;
    this._lights.points = [];
  }

  finishDraw() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return Promise.resolve();
  }

  _updateViewMatrix() {
    mat4Identity(this._viewMatrix);
    mat4Translate(this._viewMatrix, this._viewMatrix, 0, 0, -CAMERA_Z);
  }

  _updateProjection() {
    // p5 derives the focal scale from the canvas height: the default camera
    // shows exactly `height` world units at z = 0, and the Y axis is flipped.
    const focal = (2 * CAMERA_Z) / this.height;
    const aspect = this.width / this.height;
    mat4Perspective(this._projectionMatrix, 2 * Math.atan(1 / focal), aspect, NEAR_PLANE, FAR_PLANE);
    // Explicit values (equivalent and cheaper to reason about than the generic
    // perspective call above): m[0] = focal/aspect, m[5] = -focal.
    this._projectionMatrix[0] = focal / aspect;
    this._projectionMatrix[5] = -focal;
    this._projectionMatrix[10] = (FAR_PLANE + NEAR_PLANE) / (NEAR_PLANE - FAR_PLANE);
    this._projectionMatrix[11] = -1;
    this._projectionMatrix[14] = (2 * FAR_PLANE * NEAR_PLANE) / (NEAR_PLANE - FAR_PLANE);
    this._projectionMatrix[15] = 0;
  }

  remove() {
    this.dispose();
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    this._geometryCache.forEach((entry) => {
      try { gl.deleteBuffer(entry.positionBuffer); } catch { /* noop */ }
      try { gl.deleteBuffer(entry.normalBuffer); } catch { /* noop */ }
      try { gl.deleteBuffer(entry.texCoordBuffer); } catch { /* noop */ }
      try { gl.deleteBuffer(entry.indexBuffer); } catch { /* noop */ }
      try { gl.deleteBuffer(entry.edgeBuffer); } catch { /* noop */ }
    });
    this._geometryCache.clear();
    this._textures.forEach((entry) => {
      try { gl.deleteTexture(entry.texture); } catch { /* noop */ }
    });
    this._textures.clear();
    try { gl.deleteProgram(this._mesh); } catch { /* noop */ }
    this._mesh = null;
    gl.deleteProgram(this._strokeProgram);
    gl.deleteBuffer(this._strokeBuffer);
    this._strokeProgram = null;
    this._strokeBuffer = null;
  }

  /** Release the GPU context so rapid LIVE/CUE swaps cannot exhaust the limit. */
  loseContext() {
    try {
      const extension = this.gl?.getExtension('WEBGL_lose_context');
      extension?.loseContext?.();
    } catch { /* context already lost */ }
  }

  // ------------------------------------------------------------------ styles
  fill(color) { this._doFill = true; this._fillColor = color; return this; }

  noFill() { this._doFill = false; return this; }

  stroke(color) { this._doStroke = true; this._strokeColor = color; return this; }

  noStroke() { this._doStroke = false; return this; }

  strokeWeight(weight) { this._strokeWeight = Number(weight) || 0; return this; }

  blendMode(mode) { this._blendMode = mode || BLEND; return this; }

  tint(color) { this._tint = color || null; return this; }

  noTint() { this._tint = null; return this; }

  textAlign(horizontal, vertical) {
    if (horizontal) this._textAlignH = horizontal;
    if (vertical) this._textAlignV = vertical;
    return this;
  }

  textSize(size) { this._textSize = Number(size) || 0; return this; }

  textFont(font, size) {
    if (typeof font === 'string') this._textFont = font;
    else if (font) this._textFont = font.family || String(font);
    if (size !== undefined) this._textSize = Number(size) || 0;
    return this;
  }

  imageMode() { return this; }

  rectMode() { return this; }

  ellipseMode() { return this; }

  // -------------------------------------------------------------- transforms
  resetMatrix() {
    mat4Identity(this._modelMatrix);
    return this;
  }

  push() {
    this._modelStack.push({ matrix: Float32Array.from(this._modelMatrix),
      style: Object.fromEntries(['_doFill', '_doStroke', '_fillColor', '_strokeColor', '_strokeWeight', '_tint', '_blendMode', '_currentShader'].map(key => [key, this[key]])),
      lights: { ambient: [...this._lights.ambient], points: [...this._lights.points], enabled: this._lights.enabled } });
    return this;
  }

  pop() {
    const previous = this._modelStack.pop();
    if (previous) {
      this._modelMatrix.set(previous.matrix);
      Object.assign(this, previous.style);
      this._lights = previous.lights;
    }
    return this;
  }

  translate(x, y = 0, z = 0) {
    mat4Translate(this._modelMatrix, this._modelMatrix, x, y, z);
    return this;
  }

  scale(x, y = x, z = x) {
    mat4Scale(this._modelMatrix, this._modelMatrix, x, y, z);
    return this;
  }

  rotateX(angle) { mat4RotateX(this._modelMatrix, this._modelMatrix, angle); return this; }

  rotateY(angle) { mat4RotateY(this._modelMatrix, this._modelMatrix, angle); return this; }

  rotateZ(angle) { mat4RotateZ(this._modelMatrix, this._modelMatrix, angle); return this; }

  rotate(angle) { return this.rotateZ(angle); }

  // ------------------------------------------------------------------ output
  clear() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    return this;
  }

  background(color) {
    const gl = this.gl;
    const [r, g, b, a] = (color || new VizColor(0, 0, 0, 255)).unit();
    // p5 premultiplies the clear color by alpha (background(0) is opaque black
    // because the default alpha maximum is 255 → a = 1).
    gl.clearColor(r * a, g * a, b * a, a);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    return this;
  }

  // -------------------------------------------------------------- geometry io
  _useBlendMode() {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    switch (this._blendMode) {
      case ADD:
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
        break;
      case LIGHTEST:
        gl.blendEquation(gl.MAX);
        gl.blendFunc(gl.ONE, gl.ONE);
        break;
      case DARKEST:
        gl.blendEquation(gl.MIN);
        gl.blendFunc(gl.ONE, gl.ONE);
        break;
      case MULTIPLY:
        gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      default:
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
    }
  }

  _bufferGeometry(key, factory) {
    let entry = this._geometryCache.get(key);
    if (entry) return entry;
    const geometry = factory();
    const gl = this.gl;
    const upload = (data) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return buffer;
    };
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
    const edgeBuffer = geometry.edges && geometry.edges.length ? gl.createBuffer() : null;
    if (edgeBuffer) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edgeBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.edges, gl.STATIC_DRAW);
    }
    entry = {
      edgePositions: geometry.edges ? Array.from(geometry.edges).flatMap(i => Array.from(geometry.positions.slice(i * 3, i * 3 + 3))) : [],
      positionBuffer: upload(geometry.positions),
      normalBuffer: upload(geometry.normals),
      texCoordBuffer: upload(geometry.texCoords),
      indexBuffer,
      edgeBuffer,
      indexCount: geometry.indices.length,
      edgeCount: geometry.edges ? geometry.edges.length : 0,
    };
    if (this._geometryCache.size > 64) {
      const oldest = this._geometryCache.keys().next().value;
      const expired = this._geometryCache.get(oldest);
      for (const name of ['positionBuffer', 'normalBuffer', 'texCoordBuffer', 'indexBuffer', 'edgeBuffer']) gl.deleteBuffer(expired[name]);
      this._geometryCache.delete(oldest);
      this._geometryCache.set(key, entry);
    } else {
      this._geometryCache.set(key, entry);
    }
    return entry;
  }

  _bindMeshAttributes(entry, dynamic = null) {
    const gl = this.gl;
    const loc = this._meshLocations;
    const bind = (location, buffer, size) => {
      if (location < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    bind(loc.aPosition, entry.positionBuffer, 3);
    bind(loc.aNormal, entry.normalBuffer, 3);
    bind(loc.aTexCoord, entry.texCoordBuffer, 2);
    return dynamic;
  }

  _meshUniforms({ tint, useLighting = null, textureUnit = null }) {
    const gl = this.gl;
    const loc = this._meshLocations;
    const color = tint || this._fillColor || new VizColor(255, 255, 255, 255);
    const [r, g, b, a] = color.unit();
    mat4Multiply(this._modelViewMatrix, this._viewMatrix, this._modelMatrix);
    mat3NormalFromMat4(this._normalMatrix, this._modelViewMatrix);
    gl.uniformMatrix4fv(loc.uModelViewMatrix, false, this._modelViewMatrix);
    gl.uniformMatrix4fv(loc.uProjectionMatrix, false, this._projectionMatrix);
    gl.uniformMatrix3fv(loc.uNormalMatrix, false, this._normalMatrix);
    gl.uniform4f(loc.uTint, r, g, b, a);
    const lighting = useLighting === null
      ? this._lights.enabled
      : useLighting;
    gl.uniform1f(loc.uUseLighting, lighting ? 1 : 0);
    const ambient = this._lights.ambient;
    gl.uniform3f(loc.uAmbientColor, ambient[0], ambient[1], ambient[2]);
    const points = this._lights.points.slice(0, MAX_POINT_LIGHTS);
    const colors = new Float32Array(MAX_POINT_LIGHTS * 3);
    const positions = new Float32Array(MAX_POINT_LIGHTS * 3);
    points.forEach((light, i) => {
      colors.set(light.color, i * 3);
      // Light positions are transformed by the view matrix only (p5 semantics).
      positions[i * 3] = light.position[0];
      positions[i * 3 + 1] = light.position[1];
      positions[i * 3 + 2] = light.position[2] - CAMERA_Z;
    });
    gl.uniform3fv(loc.uPointLightColor, colors);
    gl.uniform3fv(loc.uPointLightPosition, positions);
    gl.uniform1i(loc.uPointLightCount, points.length);
    if (textureUnit === null) {
      gl.uniform1f(loc.uUseTexture, 0);
    } else {
      gl.uniform1f(loc.uUseTexture, 1);
      gl.uniform1i(loc.uTex, textureUnit);
    }
  }

  _drawMesh(entry, { tint, wireframe = false, useLighting = null, textureUnit = null, drawFill = null, drawStroke = null } = {}) {
    const gl = this.gl;
    gl.useProgram(this._mesh);
    this._boundProgram = this._mesh;
    this._useBlendMode();
    const fill = drawFill === null ? this._doFill && !wireframe : drawFill;
    const stroke = drawStroke === null ? this._doStroke : drawStroke;
    this._bindMeshAttributes(entry);
    this._meshUniforms({ tint, useLighting, textureUnit });
    if (fill && entry.indexCount) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.indexBuffer);
      gl.drawElements(gl.TRIANGLES, entry.indexCount, gl.UNSIGNED_SHORT, 0);
    }
    if (stroke && entry.edgeBuffer && entry.edgeCount) {
      this._drawImmediateLines(entry.edgePositions, { tint: this._strokeColor });
    }
    return this;
  }

  _drawImmediateLines(positionsFlat, { tint = null, width = null } = {}) {
    const gl = this.gl;
    const weight = width ?? this._strokeWeight;
    if (positionsFlat.length < 6 || weight <= 0 || !(this._doStroke || tint)) return this;
    if (!this._strokeProgram) {
      this._strokeProgram = createProgram(gl, STROKE_VERT, STROKE_FRAG);
      this._strokeBuffer = gl.createBuffer();
    }
    const program = this._strokeProgram;
    gl.useProgram(program);
    this._boundProgram = program;
    this._useBlendMode();
    const vertices = [];
    for (let i = 0; i + 5 < positionsFlat.length; i += 6) {
      const a = positionsFlat.slice(i, i + 3), b = positionsFlat.slice(i + 3, i + 6);
      // Butt-ended segment quads. Joins/caps remain a separately tested parity
      // surface; unlike native lines, thickness works on every WebGL driver.
      for (const [end, side] of [[0,-1],[0,1],[1,-1],[1,-1],[0,1],[1,1]]) {
        vertices.push(...(end ? b : a), ...(end ? a : b), end ? -side : side, 0);
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._strokeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STREAM_DRAW);
    for (const [name, size, offset] of [['aPosition',3,0],['aOther',3,12],['aCorner',2,24]]) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset);
    }
    mat4Multiply(this._modelViewMatrix, this._viewMatrix, this._modelMatrix);
    gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uModelViewMatrix'), false, this._modelViewMatrix);
    gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uProjectionMatrix'), false, this._projectionMatrix);
    gl.uniform2f(gl.getUniformLocation(program, 'uViewport'), this.width, this.height);
    gl.uniform1f(gl.getUniformLocation(program, 'uWeight'), weight);
    gl.uniform4fv(gl.getUniformLocation(program, 'uColor'), (tint || this._strokeColor).unit());
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 8);
    return this;
  }

  // ------------------------------------------------------------------ shapes
  rect(x, y, w, h) {
    if (this._currentShader) return this._drawFullscreenShaderQuad();
    const entry = this._bufferGeometry(`quad:${x}:${y}:${w}:${h}`, () => quadGeometry(x, y, w, h));
    return this._drawMesh(entry, { tint: this._fillColor });
  }

  /**
   * p5 draws an argument-independent fullscreen quad whenever a user shader is
   * active (measured on 2.3.x): the vertex shader maps aPosition.xy from [0,1]
   * to clip space, so aPosition is the screen-space UV with v = 0 at the bottom.
   */
  _drawFullscreenShaderQuad() {
    const gl = this.gl;
    const entry = this._bufferGeometry('unit-quad', unitQuadGeometry);
    const shader = this._currentShader;
    gl.useProgram(shader.program);
    this._boundProgram = shader.program;
    this._useBlendMode();
    gl.disable(gl.DEPTH_TEST);
    const positionLocation = gl.getAttribLocation(shader.program, 'aPosition');
    const texCoordLocation = gl.getAttribLocation(shader.program, 'aTexCoord');
    if (positionLocation >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.positionBuffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
    }
    if (texCoordLocation >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.texCoordBuffer);
      gl.enableVertexAttribArray(texCoordLocation);
      gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);
    }
    const normalLocation = gl.getAttribLocation(shader.program, 'aNormal');
    if (normalLocation >= 0) {
      gl.disableVertexAttribArray(normalLocation);
      gl.vertexAttrib3f(normalLocation, 0, 0, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.indexBuffer);
    gl.drawElements(gl.TRIANGLES, entry.indexCount, gl.UNSIGNED_SHORT, 0);
    return this;
  }

  line(...args) {
    if (args.length >= 6) {
      return this._drawImmediateLines([args[0], args[1], args[2], args[3], args[4], args[5]]);
    }
    return this._drawImmediateLines([args[0], args[1], 0, args[2], args[3], 0]);
  }

  circle(x, y, d) {
    return this.ellipse(x, y, d, d);
  }

  /** Flat circle in the XY plane (p5 draws 2D shapes at z = 0). */
  ellipse(x, y, w, h = w) {
    const entry = this._bufferGeometry(`circle:${x}:${y}:${w}:${h}`, () => {
      const segments = 48;
      const positions = [];
      const normals = [];
      const texCoords = [];
      const indices = [];
      const edges = [];
      positions.push(x, y, 0);
      normals.push(0, 0, 1);
      texCoords.push(0.5, 0.5);
      for (let i = 0; i <= segments; i += 1) {
        const angle = (i / segments) * Math.PI * 2;
        const px = x + Math.cos(angle) * (w / 2);
        const py = y + Math.sin(angle) * (h / 2);
        positions.push(px, py, 0);
        normals.push(0, 0, 1);
        texCoords.push(0.5 + Math.cos(angle) / 2, 0.5 + Math.sin(angle) / 2);
        if (i > 0) indices.push(0, i, i + 1);
        if (i > 0) edges.push(i, i + 1);
      }
      return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        texCoords: new Float32Array(texCoords),
        indices: new Uint16Array(indices),
        edges: new Uint16Array(edges),
      };
    });
    return this._drawMesh(entry, { tint: this._fillColor });
  }

  triangle(x1, y1, x2, y2, x3, y3) {
    const entry = this._bufferGeometry(`tri:${x1}:${y1}:${x2}:${y2}:${x3}:${y3}`, () => ({
      positions: new Float32Array([x1, y1, 0, x2, y2, 0, x3, y3, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      texCoords: new Float32Array([0, 0, 1, 0, 0.5, 1]),
      indices: new Uint16Array([0, 1, 2]),
      edges: new Uint16Array([0, 1, 1, 2, 2, 0]),
    }));
    return this._drawMesh(entry, { tint: this._fillColor });
  }

  box(width = 50, height = width, depth = height) {
    const entry = this._bufferGeometry(`box:${width}:${height}:${depth}`, () => boxGeometry(width, height, depth));
    return this._drawMesh(entry, { tint: this._fillColor });
  }

  sphere(radius = 50, detailX = 24, detailY = 16) {
    const entry = this._bufferGeometry(`sphere:${radius}:${detailX}:${detailY}`, () => sphereGeometry(radius, detailX, detailY));
    return this._drawMesh(entry, { tint: this._fillColor });
  }

  plane(width = 50, height = width, detailX = 1, detailY = 1) {
    const entry = this._bufferGeometry(`plane:${width}:${height}:${detailX}:${detailY}`, () => planeGeometry(width, height, detailX, detailY));
    // p5 intentionally omits strokes on subdivided planes. Techno3D asks
    // for 8x8: drawing those edges would introduce a grid absent on main.
    return this._drawMesh(entry, { tint: this._fillColor, drawStroke: this._doStroke && detailX <= 1 && detailY <= 1 });
  }

  cone(radius = 50, height = 50, detailX = 24, detailY = 1) {
    const entry = this._bufferGeometry(`cone:${radius}:${height}:${detailX}:${detailY}`, () => coneGeometry(radius, height, detailX, detailY));
    return this._drawMesh(entry, { tint: this._fillColor });
  }

  beginShape() { this._immediateVertices = []; return this; }

  vertex(x, y, z = 0) {
    if (!this._immediateVertices) this._immediateVertices = [];
    this._immediateVertices.push([x, y, z]);
    return this;
  }

  endShape(mode) {
    const vertices = this._immediateVertices || [];
    this._immediateVertices = null;
    if (vertices.length < 2) return this;
    const flat = [];
    vertices.forEach(([x, y, z]) => flat.push(x, y, z));
    if (mode === 'close') flat.push(vertices[0][0], vertices[0][1], vertices[0][2], vertices[1]?.[0] ?? 0, vertices[1]?.[1] ?? 0, vertices[1]?.[2] ?? 0);
    return this._drawImmediateLines(flat);
  }

  // -------------------------------------------------------------------- text
  text(value, x, y) {
    const str = value === undefined || value === null ? '' : String(value);
    if (!str) return this;
    const size = this._textSize || 12;
    const font = `${this._textStyle} ${size}px ${this._textFont}`;
    if (!this._textCanvas) this._textCanvas = document.createElement('canvas');
    const canvas = this._textCanvas;
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    const metrics = ctx.measureText(str);
    const width = Math.max(2, Math.ceil(metrics.width));
    const height = Math.max(2, Math.ceil(size * 1.4));
    canvas.width = width;
    canvas.height = height;
    const drawCtx = canvas.getContext('2d');
    drawCtx.clearRect(0, 0, width, height);
    drawCtx.font = font;
    drawCtx.textAlign = 'left';
    drawCtx.textBaseline = 'top';
    drawCtx.fillStyle = '#ffffff';
    drawCtx.fillText(str, 0, 0);
    // Text uploads unpremultiplied, matching p5 (_beforeDrawText).
    const textureUnit = this._bindTextureSource(canvas, { dynamic: true, premultiply: false });
    const alignX = this._textAlignH === 'center' ? -width / 2
      : this._textAlignH === 'right' ? -width : 0;
    const alignY = this._textAlignV === 'top' ? 0
      : this._textAlignV === 'bottom' ? -height : -height / 2;
    const entry = this._bufferGeometry(`text:${width}:${height}`, () => quadGeometry(alignX, alignY, width, height));
    return this._drawMesh(entry, { tint: this._fillColor, textureUnit });
  }

  image(img, x, y, w, h) {
    const source = resolveSource(img);
    if (!source) return this;
    const dw = w === undefined ? (img.width ?? source.width) : w;
    const dh = h === undefined ? (img.height ?? source.height) : h;
    if (!dw || !dh) return this;
    const textureUnit = this._bindTextureSource(source, { dynamic: isDynamicSource(source) });
    const entry = this._bufferGeometry(`img:${x}:${y}:${dw}:${dh}`, () => quadGeometry(x, y, dw, dh));
    return this._drawMesh(entry, { tint: this._fillColor, textureUnit });
  }

  get() { return null; }

  copy() { return this; }

  // ------------------------------------------------------------------ lights
  ambientLight(v1, v2, v3) {
    const color = lightColor(v1, v2, v3, this._pInst);
    this._lights.enabled = true;
    const rgb = color.unit();
    this._lights.ambient = this._lights.ambient.map((v, i) => v + rgb[i]);
    return this;
  }

  pointLight(v1, v2, v3, x, y, z) {
    const color = lightColor(v1, v2, v3, this._pInst);
    const position = [x, y, z].map((value) => (Number.isFinite(value) ? Number(value) : 0));
    this._lights.enabled = true;
    this._lights.points.push({ color: color.unit().slice(0, 3), position });
    return this;
  }

  noLights() {
    this._lights.ambient = [0, 0, 0];
    this._lights.enabled = false;
    this._lights.points = [];
    return this;
  }

  directionalLight() { return this; }

  // ----------------------------------------------------------------- shaders
  createShader(vertexSource, fragmentSource) {
    return new VizShader(this, vertexSource, fragmentSource);
  }

  shader(shaderProgram) {
    this._currentShader = shaderProgram || null;
    if (shaderProgram?.program && this._boundProgram !== shaderProgram.program) {
      this.gl.useProgram(shaderProgram.program);
      this._boundProgram = shaderProgram.program;
    }
    return this;
  }

  // ----------------------------------------------------------------- texture
  // `premultiply` mirrors p5's UNPACK_PREMULTIPLY_ALPHA_WEBGL convention:
  // images/videos/textures are uploaded premultiplied (set once in
  // p5.RendererGL._initContext), while text uploads unpremultiplied
  // (_beforeDrawText/_afterDrawText). Opaque sources are unaffected.
  _bindTextureSource(source, { dynamic = false, premultiply = true } = {}) {
    const gl = this.gl;
    let entry = this._textures.get(source);
    if (!entry) {
      entry = { texture: gl.createTexture(), width: 0, height: 0 };
      this._textures.set(source, entry);
    }
    const gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    gl.activeTexture(gl.TEXTURE0 + this._textureUnitsUsed);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    const width = source.videoWidth || source.naturalWidth || source.width || 1;
    const height = source.videoHeight || source.naturalHeight || source.height || 1;
    const needsUpload = dynamic || entry.width !== width || entry.height !== height || entry.uploaded !== true;
    if (needsUpload) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      } catch {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      entry.width = width;
      entry.height = height;
      entry.uploaded = true;
    }
    const unit = this._textureUnitsUsed;
    this._textureUnitsUsed += 1;
    void gl2;
    return unit;
  }

  _nextTextureUnit() { return this._textureUnitsUsed; }

  _setShaderUniform(shader, name, value) {
    const gl = this.gl;
    const info = shader.uniforms.get(name);
    if (!info || info.location === null) return; // inactive/optimized-out uniform
    // Uniform values always belong to the shader's own program: binding the
    // mesh program between setUniform() calls must not redirect them.
    if (this._boundProgram !== shader.program) {
      gl.useProgram(shader.program);
      this._boundProgram = shader.program;
    }
    const { type, size } = info;

    const isTexture = typeof value === 'object' && value !== null
      && !Array.isArray(value) && !ArrayBuffer.isView(value)
      && resolveSource(value) !== null;
    if (isTexture || type === gl.SAMPLER_2D || type === gl.SAMPLER_CUBE) {
      const source = resolveSource(value);
      if (!source) return;
      const unit = this._bindTextureSource(source, { dynamic: isDynamicSource(source) });
      gl.uniform1i(info.location, unit);
      return;
    }

    if (ArrayBuffer.isView(value) || Array.isArray(value)) {
      const array = value;
      switch (type) {
        case gl.FLOAT:
          if (size > 1) gl.uniform1fv(info.location, array);
          else gl.uniform1f(info.location, Number(array[0]) || 0);
          return;
        case gl.FLOAT_VEC2: gl.uniform2fv(info.location, array); return;
        case gl.FLOAT_VEC3: gl.uniform3fv(info.location, array); return;
        case gl.FLOAT_VEC4: gl.uniform4fv(info.location, array); return;
        case gl.INT: case gl.BOOL:
          if (size > 1) gl.uniform1iv(info.location, array);
          else gl.uniform1i(info.location, Number(array[0]) || 0);
          return;
        case gl.FLOAT_MAT2: gl.uniformMatrix2fv(info.location, false, array); return;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(info.location, false, array); return;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(info.location, false, array); return;
        default: return;
      }
    }

    const numeric = Number(value) || 0;
    switch (type) {
      case gl.FLOAT:
        gl.uniform1f(info.location, numeric);
        return;
      case gl.FLOAT_VEC2: gl.uniform2f(info.location, numeric, numeric); return;
      case gl.FLOAT_VEC3: gl.uniform3f(info.location, numeric, numeric, numeric); return;
      case gl.FLOAT_VEC4: gl.uniform4f(info.location, numeric, numeric, numeric, numeric); return;
      case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: case gl.SAMPLER_CUBE:
        gl.uniform1i(info.location, numeric);
        return;
      default:
        break;
    }
  }
}

function isDynamicSource(source) {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return true;
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return true;
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return true;
  return false;
}

function lightColor(v1, v2, v3, pInst) {
  if (pInst?._colorFromArgs) return pInst._colorFromArgs([v1, v2, v3].filter((v) => v !== undefined));
  return new VizColor(v1 ?? 255, v2 ?? v1 ?? 255, v3 ?? v1 ?? 255, 255);
}
