// Final-output resampling. CSS transforms position the corners correctly, but
// minifying a canvas with a single bilinear lookup leaves stair-stepped lines.
// Integrate a 4x4 grid across each *physical output pixel*, after merge/post-FX.
// This does not increase sketch resolution or blur the whole source image.
import { IDENTITY_QUAD, normalizeMappingEdgeBlur, quadToInverseMatrix3 } from './screen-mapping.js';

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
uniform bool uSourceAlpha;
uniform bool uSingleSample;
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

vec4 sampleProgram(vec2 uv, vec2 dx, vec2 dy) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  // Mipmaps handle very strong minification; gradients describe a subpixel,
  // not the whole pixel (which would low-pass the image a second time).
  vec4 base = textureGrad(uBase, uv, dx, dy);
  vec4 overlay = vec4(0.0);
  if (uOpacity > 0.0) overlay = textureGrad(uOverlay, uv, dx, dy) * uOpacity;
  vec3 color = uScreenBlend
    ? base.rgb + overlay.rgb - base.rgb * overlay.rgb
    : overlay.rgb + base.rgb * (1.0 - overlay.a);
  float coverage = uSourceAlpha ? base.a : 1.0;
  if (!uApplyPostFx) return vec4(color, coverage);
  float alpha = overlay.a + base.a * (1.0 - overlay.a);
  color /= max(alpha, 0.00001);
  color = clamp(color * uPostFx.x, 0.0, 1.0);
  color = clamp((color - 0.5) * uPostFx.y + 0.5, 0.0, 1.0);
  float luma = dot(color, vec3(0.213, 0.715, 0.072));
  color = clamp(mix(vec3(luma), color, uPostFx.z), 0.0, 1.0);
  return vec4(color * alpha, coverage);
}

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  // A full-frame, non-minified source needs no 16-tap resampling just to
  // feather its edges. Warped/minified sources retain the original 4x4 AA.
  if (uSingleSample) {
    vec2 uv = pixel / uResolution;
    float fade = edgeCoverage(uv);
    vec4 color = sampleProgram(uv, vec2(0.0), vec2(0.0)) * fade;
    outColor = vec4(color.rgb, (uSurface || uSourceAlpha) ? color.a : 1.0);
    return;
  }
  vec2 dx = (sourcePoint(pixel + vec2(0.5, 0.0)) - sourcePoint(pixel - vec2(0.5, 0.0))) / 4.0;
  vec2 dy = (sourcePoint(pixel + vec2(0.0, 0.5)) - sourcePoint(pixel - vec2(0.0, 0.5))) / 4.0;
  vec4 color = vec4(0.0);
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) {
      vec2 offset = (vec2(float(x), float(y)) + 0.5) / 4.0 - 0.5;
      vec2 uv = sourcePoint(pixel + offset);
      float fade = edgeCoverage(uv);
      color += sampleProgram(uv, dx, dy) * fade;
    }
  }
  outColor = vec4(color.rgb / 16.0, (uSurface || uSourceAlpha) ? color.a / 16.0 : 1.0);
}`;

// Remove black *before* bilinear/mipmap filtering. Keying a filtered sample
// would turn minified black/colored detail opaque and create dark fringes.
const ALPHA_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uSource;
out vec4 outColor;
void main() {
  vec4 color = texelFetch(uSource, ivec2(gl_FragCoord.xy), 0);
  vec3 straight = color.rgb / max(color.a, 0.00001);
  float mask = clamp(dot(straight, vec3(255.0)), 0.0, 1.0);
  outColor = color * mask;
}`;

function createProgram(gl, fragment = FRAGMENT) {
  const shaders = [];
  const program = gl.createProgram();
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]]) {
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
  constructor(canvas, { alpha = false } = {}) {
    this.canvas = canvas;
    this.textures = new Map();
    this.geometryCache = new WeakMap();
    this.gl = canvas.getContext('webgl2', {
      alpha, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error('WebGL2 is unavailable for screen-mapping antialiasing.');
    const gl = this.gl;
    try {
      this.program = createProgram(gl);
      this.uniforms = Object.fromEntries([
        'uBase', 'uOverlay', 'uInverse', 'uResolution', 'uOpacity', 'uScreenBlend', 'uPostFx', 'uApplyPostFx', 'uEdgeBlur', 'uSurface', 'uSourceAlpha', 'uSingleSample',
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
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
    this.fullFrame = this.isFullFrame(quad);
  }

  isFullFrame(quad = IDENTITY_QUAD) {
    return !quad || quad.every((point, i) => point.x === IDENTITY_QUAD[i].x && point.y === IDENTITY_QUAD[i].y);
  }

  geometryFor(quad = IDENTITY_QUAD) {
    const { width, height } = this.canvas;
    let geometry = this.geometryCache.get(quad);
    // Keep a numeric snapshot too: callers may edit a quad in place.
    const key = quad.flatMap(({ x, y }) => [x, y]).join(',');
    if (geometry?.key === key && geometry.width === width && geometry.height === height) return geometry;
    const xs = quad.map((p) => p.x * width);
    const ys = quad.map((p) => p.y * height);
    const left = Math.max(0, Math.floor(Math.min(...xs)));
    const right = Math.min(width, Math.ceil(Math.max(...xs)));
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(height, Math.ceil(Math.max(...ys)));
    geometry = { key, width, height, inverse: quadToInverseMatrix3(quad), fullFrame: this.isFullFrame(quad),
      scissor: [left, height - bottom, Math.max(0, right - left), Math.max(0, bottom - top)] };
    this.geometryCache.set(quad, geometry);
    return geometry;
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
    // Only build mipmaps if a later draw actually needs minification. Several
    // source draws before presentation should not rebuild unused mip chains.
    entry.mipDirty = true;
    entry.alphaDirty = true;
  }

  prepareAlphaTexture(entry) {
    if (entry.alphaTexture && !entry.alphaDirty) return;
    const gl = this.gl;
    if (!this.alphaProgram) {
      this.alphaProgram = createProgram(gl, ALPHA_FRAGMENT);
      this.alphaSource = gl.getUniformLocation(this.alphaProgram, 'uSource');
      this.alphaFramebuffer = gl.createFramebuffer();
    }
    gl.activeTexture(gl.TEXTURE0);
    entry.alphaTexture ||= this.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, entry.alphaTexture);
    if (entry.alphaWidth !== entry.width || entry.alphaHeight !== entry.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, entry.width, entry.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      entry.alphaWidth = entry.width;
      entry.alphaHeight = entry.height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.alphaFramebuffer);
    try {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, entry.alphaTexture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('Projection alpha mask framebuffer is unavailable.');
      }
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, entry.width, entry.height);
      gl.useProgram(this.alphaProgram);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      // texelFetch only uses the base level. A resized source may still have an
      // incomplete old mip chain, so don't require it for the black-key prepass.
      if (entry.filter !== gl.LINEAR) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        entry.filter = gl.LINEAR;
      }
      gl.uniform1i(this.alphaSource, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      entry.alphaMipDirty = true;
      entry.alphaDirty = false;
    } finally { gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
  }

  render({ canvases, blend = {}, postFx = {}, edgeBlur = 0, surface = false, sourceAlpha = false, alphaBlend = false }) {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('Screen-mapping context was lost.');
    if (!this.inverse || !canvases?.length || canvases.some((source) => !this.textures.has(source))) return false;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    const singleSample = this.fullFrame && canvases.every((source) =>
      source.width <= this.canvas.width && source.height <= this.canvas.height);
    for (let i = 0; i < 2; i += 1) {
      gl.activeTexture(gl.TEXTURE0 + i);
      const entry = this.textures.get(canvases[i]);
      gl.bindTexture(gl.TEXTURE_2D, (alphaBlend ? entry?.alphaTexture : entry?.texture) || this.empty);
      if (entry) {
        // Raw and black-keyed textures have independent mip chains and filters.
        const dirtyKey = alphaBlend ? 'alphaMipDirty' : 'mipDirty';
        const filterKey = alphaBlend ? 'alphaFilter' : 'filter';
        if (!singleSample && entry[dirtyKey]) {
          gl.generateMipmap(gl.TEXTURE_2D);
          entry[dirtyKey] = false;
        }
        const filter = singleSample ? gl.LINEAR : gl.LINEAR_MIPMAP_LINEAR;
        if (entry[filterKey] !== filter) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
          entry[filterKey] = filter;
        }
      }
    }
    const u = this.uniforms;
    gl.uniform1f(u.uEdgeBlur, normalizeMappingEdgeBlur(edgeBlur) / 100);
    gl.uniform1i(u.uSurface, surface);
    // Preserve source alpha independently of black-key texture selection.
    gl.uniform1i(u.uSourceAlpha, sourceAlpha || alphaBlend);
    gl.uniform1i(u.uSingleSample, singleSample);
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

  // Ordered surfaces over black, or a transparent clear for Alpha Blend.
  // Reuse one context/texture cache and the same subpixel integration as the
  // global mapper. Later surfaces cover earlier ones, with feathered edges
  // revealing underlying surfaces. RGB and coverage remain premultiplied.
  renderSurfaces(surfaces, { alphaBlend = false } = {}) {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('Projection-mapping context was lost.');
    if (surfaces.some(({ canvas }) => !this.textures.has(canvas))) return false;
    gl.disable(gl.SCISSOR_TEST);
    if (alphaBlend) {
      for (const { canvas } of surfaces) this.prepareAlphaTexture(this.textures.get(canvas));
    }
    gl.clearColor(0, 0, 0, alphaBlend ? 0 : 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const inverse = this.inverse;
    const fullFrame = this.fullFrame;
    gl.enable(gl.SCISSOR_TEST);
    try {
      for (const { canvas, quad, edgeBlur = 0 } of surfaces) {
        const geometry = this.geometryFor(quad);
        this.inverse = geometry.inverse;
        this.fullFrame = geometry.fullFrame;
        gl.scissor(...geometry.scissor);
        this.render({ canvases: [canvas], surface: true, edgeBlur, alphaBlend });
      }
    } finally {
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      this.inverse = inverse;
      this.fullFrame = fullFrame;
    }
    return true;
  }

  release(source) {
    const entry = this.textures.get(source);
    if (!entry) return;
    this.gl.deleteTexture(entry.texture);
    if (entry.alphaTexture) this.gl.deleteTexture(entry.alphaTexture);
    this.textures.delete(source);
  }

  dispose() {
    for (const source of this.textures.keys()) this.release(source);
    this.gl.deleteTexture(this.empty);
    this.gl.deleteProgram(this.program);
    if (this.alphaProgram) this.gl.deleteProgram(this.alphaProgram);
    if (this.alphaFramebuffer) this.gl.deleteFramebuffer(this.alphaFramebuffer);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
