// Shared WebGL2 compositor for node-graph image nodes.
//
// The graph has always composited on 2D canvases, which covers every blend mode
// Chromium implements natively and costs nothing extra. Two image operations need
// a GPU instead, and both are synchronous and stateless:
//
//   * extended blend modes (Subtract, Divide, Average, the light/quadratic
//     families …) have no `globalCompositeOperation` equivalent;
//   * the Transform node needs real perspective — a 4x4 matrix the GPU clips at
//     the camera plane and interpolates with correct perspective.
//
// One context is shared by the whole window (a context per node would exhaust the
// browser's context budget). Every call renders and returns the same intermediate
// canvas, so a caller must copy it before the next call — the runtime does that
// with a synchronous drawImage. Nothing is preserved across calls: there is no
// framebuffer state to reset, no readback and no GPU timer.
//
// If WebGL2 is unavailable, lost, or unable to allocate the requested size, the
// entry points return null. Callers keep their Canvas2D fallback and report a
// per-node diagnostic, so a broken GPU can degrade a mode but never silently
// render different pixels or break the graph.

import { blendFragmentSource, blendModeIndex, isExtendedMode } from './blend-modes.js';
import { transformMatrix } from './transform.js';

const BLEND_VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const TRANSFORM_VERTEX = `#version 300 es
layout(location = 0) in vec3 aPosition;
uniform mat4 uMatrix;
out vec2 vUv;
void main() {
  // The plane spans [-1, 1]² with y up; texture v runs top-down.
  vUv = vec2((aPosition.x + 1.0) * 0.5, (1.0 - aPosition.y) * 0.5);
  gl_Position = uMatrix * vec4(aPosition, 1.0);
}`;

const TRANSFORM_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
out vec4 outColor;
void main() { outColor = texture(uSource, vUv); }`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || 'Node compositor shader failed to compile');
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const shaders = [];
  const program = gl.createProgram();
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
      const shader = compile(gl, type, source);
      shaders.push(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Node compositor program failed to link');
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    shaders.forEach(shader => gl.deleteShader(shader));
  }
}

class GlCompositor {
  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    // alpha + premultipliedAlpha pair with the shaders' premultiplied output, so
    // the 2D canvas that copies this canvas composites it like any other layer.
    this.gl = canvas.getContext('webgl2', {
      alpha: true, antialias: true, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!this.gl) throw new Error('WebGL2 is unavailable for node blending and transforms.');
    this.canvas = canvas;
    this.programs = null;
    this.textures = [];
    this.maxSize = 0;
    this.failed = false;
    // A lost context invalidates every GL object; the next call rebuilds them and
    // an unrecoverable loss simply keeps returning null to the Canvas2D fallback.
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.failed = true;
      this.programs = null;
      this.textures = [];
      this.emptyTexture = null;
      this.maxSize = 0;
    });
    canvas.addEventListener('webglcontextrestored', () => { this.failed = false; });
  }

  texture(index) {
    const gl = this.gl;
    if (!this.textures[index]) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures[index] = texture;
    }
    return this.textures[index];
  }

  // A missing input is a 1x1 transparent texture: every documented blend formula
  // already yields "the other layer unchanged" for a transparent operand, so the
  // shader needs no separate presence flag.
  empty() {
    const gl = this.gl;
    if (!this.emptyTexture) {
      this.emptyTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.emptyTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
    return this.emptyTexture;
  }

  ensurePrograms() {
    if (this.programs) return this.programs;
    const gl = this.gl;
    const blend = createProgram(gl, BLEND_VERTEX, blendFragmentSource());
    const transform = createProgram(gl, TRANSFORM_VERTEX, TRANSFORM_FRAGMENT);
    const strip = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, strip);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, 0, 1, 1, 0, -1, -1, 0, 1, -1, 0]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.programs = {
      transform: { program: transform, vao, uMatrix: gl.getUniformLocation(transform, 'uMatrix'), uSource: gl.getUniformLocation(transform, 'uSource') },
      blend: { program: blend, uSize: gl.getUniformLocation(blend, 'uSize'), uOriginY: gl.getUniformLocation(blend, 'uOriginY'), uOpacity: gl.getUniformLocation(blend, 'uOpacity'), uMode: gl.getUniformLocation(blend, 'uMode'), uBase: gl.getUniformLocation(blend, 'uBase'), uLayer: gl.getUniformLocation(blend, 'uLayer') },
    };
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    return this.programs;
  }

  // Grow-only intermediate canvas: two graphs of different sizes can render in one
  // window (control preview and a live preview), and reallocating per frame would
  // cost more than the render. The viewport is placed at the canvas top so the
  // caller can copy the region with drawImage(..., 0, 0, width, height, ...).
  prepare(width, height) {
    if (this.failed) return false;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return false;
    let programs;
    try { programs = this.ensurePrograms(); } catch { this.failed = true; return false; }
    if (width > this.maxSize || height > this.maxSize) return false;
    const gl = this.gl;
    if (this.canvas.width < width) this.canvas.width = width;
    if (this.canvas.height < height) this.canvas.height = height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, this.canvas.height - height, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    // The shaders emit premultiplied color; the canvas is created premultiplied.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.programs = programs;
    return true;
  }

  // `premultiplied` selects the storage the shader expects: the blend formulas are
  // defined on straight colors, the transform is a pure resample that must not
  // round-trip through un-premultiplying.
  upload(texture, source, premultiplied) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiplied);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (premultiplied) {
      // Mipmaps keep a picture that is scaled far down from shimmering.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
  }

  blend(base, layer, mode, opacity, width, height) {
    if (!isExtendedMode(mode)) return null;
    if (!this.prepare(width, height)) return null;
    const gl = this.gl, { program, uSize, uOriginY, uOpacity, uMode, uBase, uLayer } = this.programs.blend;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    if (base && base.width && base.height) this.upload(this.texture(0), base, false);
    else gl.bindTexture(gl.TEXTURE_2D, this.empty());
    gl.activeTexture(gl.TEXTURE1);
    if (layer && layer.width && layer.height) this.upload(this.texture(1), layer, false);
    else gl.bindTexture(gl.TEXTURE_2D, this.empty());
    gl.uniform1i(uBase, 0);
    gl.uniform1i(uLayer, 1);
    gl.uniform2f(uSize, width, height);
    // The viewport sits at the top of a canvas that may have grown for a bigger
    // graph, so the shader needs that origin to normalise gl_FragCoord.
    gl.uniform1f(uOriginY, this.canvas.height - height);
    gl.uniform1f(uOpacity, Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1);
    gl.uniform1i(uMode, blendModeIndex(mode));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }

  transform(source, params, width, height) {
    if (!source || !source.width || !source.height) return null;
    if (!this.prepare(width, height)) return null;
    const gl = this.gl, { program, vao, uMatrix, uSource } = this.programs.transform;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    this.upload(this.texture(0), source, true);
    gl.uniform1i(uSource, 0);
    gl.uniformMatrix4fv(uMatrix, false, transformMatrix(params));
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    return this.canvas;
  }

  dispose() {
    const gl = this.gl;
    if (this.programs) {
      gl.deleteProgram(this.programs.blend.program);
      gl.deleteProgram(this.programs.transform.program);
      gl.deleteVertexArray(this.programs.transform.vao);
      this.programs = null;
    }
    for (const texture of [...this.textures, this.emptyTexture]) if (texture) gl.deleteTexture(texture);
    this.textures = [];
    this.emptyTexture = null;
    this.failed = true;
  }
}

// One lazy context per window. `false` records a permanent failure so a browser
// without WebGL2 never pays a failed context-creation attempt per frame.
let shared = null;
function compositor() {
  if (shared === null) {
    try { shared = new GlCompositor(); } catch { shared = false; }
  }
  return shared || null;
}

export function glCompositorAvailable() {
  const instance = compositor();
  return !!instance && !instance.failed;
}

// Both entry points return the shared intermediate canvas (null = fall back) and
// stay valid only until the next call.
export function glBlend(base, layer, mode, opacity, width, height) {
  const instance = compositor();
  if (!instance) return null;
  try { return instance.blend(base, layer, mode, opacity, width, height); }
  catch { instance.failed = true; return null; }
}

export function glTransform(source, params, width, height) {
  const instance = compositor();
  if (!instance) return null;
  try { return instance.transform(source, params, width, height); }
  catch { instance.failed = true; return null; }
}

export function releaseGlCompositor() {
  shared?.dispose();
  shared = null;
}
