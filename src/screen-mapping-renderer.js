// Final-output resampling. CSS transforms position the corners correctly, but
// minifying a canvas with a single bilinear lookup leaves stair-stepped lines.
// Integrate a 4x4 grid across each *physical output pixel*, after merge/post-FX.
// This does not increase sketch resolution or blur the whole source image.
import { normalizeMappingEdgeBlur, quadToInverseMatrix3 } from './screen-mapping.js';

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uBase;
uniform sampler2D uOverlay;
uniform mat3 uInverse;
uniform vec2 uResolution;
uniform float uOpacity;
uniform bool uScreenBlend;
uniform vec3 uPostFx;
uniform bool uApplyPostFx;
uniform float uEdgeBlur;
uniform bool uSurface;
out vec4 outColor;

vec2 sourcePoint(vec2 pixel) {
  vec3 p = uInverse * vec3(pixel / uResolution, 1.0);
  return p.xy / p.z;
}

float edgeCoverage(vec2 uv) {
  if (uEdgeBlur <= 0.0) return 1.0;
  vec2 distanceToEdge = min(uv, 1.0 - uv);
  vec2 fade = smoothstep(vec2(0.0), vec2(uEdgeBlur), distanceToEdge);
  return fade.x * fade.y;
}

vec3 sampleProgram(vec2 uv, vec2 dx, vec2 dy) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
  // Mipmaps handle very strong minification; gradients describe a subpixel,
  // not the whole pixel (which would low-pass the image a second time).
  vec4 base = textureGrad(uBase, uv, dx, dy);
  vec4 overlay = vec4(0.0);
  if (uOpacity > 0.0) overlay = textureGrad(uOverlay, uv, dx, dy) * uOpacity;
  vec3 color = uScreenBlend
    ? base.rgb + overlay.rgb - base.rgb * overlay.rgb
    : overlay.rgb + base.rgb * (1.0 - overlay.a);
  if (!uApplyPostFx) return color * edgeCoverage(uv);
  float alpha = overlay.a + base.a * (1.0 - overlay.a);
  color /= max(alpha, 0.00001);
  color = clamp(color * uPostFx.x, 0.0, 1.0);
  color = clamp((color - 0.5) * uPostFx.y + 0.5, 0.0, 1.0);
  float luma = dot(color, vec3(0.213, 0.715, 0.072));
  color = clamp(mix(vec3(luma), color, uPostFx.z), 0.0, 1.0);
  return color * alpha * edgeCoverage(uv);
}

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 dx = (sourcePoint(pixel + vec2(0.5, 0.0)) - sourcePoint(pixel - vec2(0.5, 0.0))) / 4.0;
  vec2 dy = (sourcePoint(pixel + vec2(0.0, 0.5)) - sourcePoint(pixel - vec2(0.0, 0.5))) / 4.0;
  vec3 color = vec3(0.0);
  float coverage = 0.0;
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) {
      vec2 offset = (vec2(float(x), float(y)) + 0.5) / 4.0 - 0.5;
      vec2 uv = sourcePoint(pixel + offset);
      color += sampleProgram(uv, dx, dy);
      coverage += all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))) ? edgeCoverage(uv) : 0.0;
    }
  }
  outColor = vec4(color / 16.0, uSurface ? coverage / 16.0 : 1.0);
}`;

function createProgram(gl) {
  const shaders = [];
  const program = gl.createProgram();
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    shaders.forEach((shader) => gl.deleteShader(shader));
  }
}

export class ScreenMappingRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.textures = new Map();
    this.gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error('WebGL2 is unavailable for screen-mapping antialiasing.');
    const gl = this.gl;
    try {
      this.program = createProgram(gl);
      this.uniforms = Object.fromEntries([
        'uBase', 'uOverlay', 'uInverse', 'uResolution', 'uOpacity', 'uScreenBlend', 'uPostFx', 'uApplyPostFx', 'uEdgeBlur', 'uSurface',
      ].map((name) => [name, gl.getUniformLocation(this.program, name)]));
      this.empty = this.createTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      gl.generateMipmap(gl.TEXTURE_2D);
      this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  createTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  configure(quad, width, height, dpr = 1) {
    const inverse = quadToInverseMatrix3(quad);
    if (!inverse) throw new Error('Invalid screen-mapping quad.');
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    // Do not silently downscale a high-DPI output; leave the CSS fallback active
    // if the device cannot allocate its native resolution.
    if (Math.max(pixelWidth, pixelHeight) > this.maxSize) throw new Error('Mapped output exceeds GPU limits.');
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.inverse = inverse;
  }

  // Call synchronously after p5 draw(). A WebGL canvas with an unpreserved
  // drawing buffer may already be cleared if copied in a later animation frame.
  capture(source) {
    if (!source?.width || !source?.height) return;
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('Screen-mapping context was lost.');
    if (Math.max(source.width, source.height) > this.maxSize) throw new Error('Mapping source exceeds GPU limits.');
    let entry = this.textures.get(source);
    if (!entry) {
      entry = { texture: this.createTexture(), width: 0, height: 0 };
      this.textures.set(source, entry);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    if (entry.width !== source.width || entry.height !== source.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      entry.width = source.width;
      entry.height = source.height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  render({ canvases, blend = {}, postFx = {}, edgeBlur = 0, surface = false }) {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('Screen-mapping context was lost.');
    if (!this.inverse || !canvases?.length || canvases.some((source) => !this.textures.has(source))) return false;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    for (let i = 0; i < 2; i += 1) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.get(canvases[i])?.texture || this.empty);
    }
    const u = this.uniforms;
    gl.uniform1f(u.uEdgeBlur, normalizeMappingEdgeBlur(edgeBlur) / 100);
    gl.uniform1i(u.uSurface, surface);
    gl.uniform1i(u.uBase, 0);
    gl.uniform1i(u.uOverlay, 1);
    gl.uniformMatrix3fv(u.uInverse, false, this.inverse);
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uOpacity, canvases.length < 2 ? 0 : (blend.mode === 1 ? blend.add ?? 0.5 : blend.mix ?? 0.5));
    gl.uniform1i(u.uScreenBlend, blend.mode === 1);
    gl.uniform1i(u.uApplyPostFx, Boolean(postFx.brightness || postFx.contrast || postFx.saturation));
    gl.uniform3f(u.uPostFx,
      1 + (Number(postFx.brightness) || 0) / 100,
      1 + (Number(postFx.contrast) || 0) / 100,
      1 + (Number(postFx.saturation) || 0) / 100);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  // Ordered, opaque surfaces over black; outside each quad is transparent.
  // Reuse one context/texture cache and the same subpixel integration as the
  // global mapper. Later surfaces cover earlier ones, with feathered edges
  // revealing underlying surfaces. RGB and coverage remain premultiplied.
  renderSurfaces(surfaces) {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('Projection-mapping context was lost.');
    if (surfaces.some(({ canvas }) => !this.textures.has(canvas))) return false;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    try {
      for (const { canvas, quad, edgeBlur = 0 } of surfaces) {
        this.inverse = quadToInverseMatrix3(quad);
        this.render({ canvases: [canvas], surface: true, edgeBlur });
      }
    } finally { gl.disable(gl.BLEND); }
    return true;
  }

  release(source) {
    const entry = this.textures.get(source);
    if (!entry) return;
    this.gl.deleteTexture(entry.texture);
    this.textures.delete(source);
  }

  dispose() {
    for (const source of this.textures.keys()) this.release(source);
    this.gl.deleteTexture(this.empty);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
