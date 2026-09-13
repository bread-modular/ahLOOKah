import { test, expect } from '@playwright/test';

// WebGL shader-path contract for the replacement core. Pins the conventions the
// 42 fullscreen-GLSL patterns rely on (measured on p5 2.3.x before removal):
//   * a user shader + rect() draws a fullscreen quad and IGNORES the arguments,
//   * aPosition and aTexCoord are the same screen-space UV: u 0→1 left→right,
//     v 0→1 bottom→top,
//   * textures upload without a Y flip, so v = 0 samples the source's first row,
//   * uniform dispatch supports scalars, vectors, float arrays and textures,
//   * canvas/texture sources are re-uploaded so live camera frames refresh,
//   * the GL context keeps p5's default attributes (premultipliedAlpha and
//     preserveDrawingBuffer on), so another context can still sample the canvas.

const VERT = `
  precision highp float;
  attribute vec3 aPosition;
  attribute vec2 aTexCoord;
  varying vec2 vTexCoord;
  void main() {
    vTexCoord = aTexCoord;
    vec4 position = vec4(aPosition, 1.0);
    position.xy = position.xy * 2.0 - 1.0;
    gl_Position = position;
  }
`;

test('core WebGL: fullscreen shader quad mapping and ignored rect arguments', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { default: VizCore } = await import('/src/core/index.js');
    const W = 8;
    const H = 8;
    const vert = `
      precision highp float;
      attribute vec3 aPosition;
      attribute vec2 aTexCoord;
      varying vec2 vTex;
      varying vec2 vPos;
      void main() {
        vTex = aTexCoord;
        vPos = aPosition.xy;
        vec4 position = vec4(aPosition, 1.0);
        position.xy = position.xy * 2.0 - 1.0;
        gl_Position = position;
      }
    `;
    const frag = `
      precision highp float;
      varying vec2 vTex;
      varying vec2 vPos;
      void main() { gl_FragColor = vec4(vPos.x, vPos.y, vTex.x, 1.0); }
    `;
    const instance = new VizCore((p) => {
      let shader = null;
      p.setup = () => {
        p.pixelDensity(1);
        p.createCanvas(W, H, p.WEBGL);
        p.noStroke();
        shader = p.createShader(vert, frag);
      };
      p.draw = () => {
        p.clear();
        p.shader(shader);
        // Arguments deliberately smaller than the canvas: with a user shader
        // active p5 covers the whole viewport regardless of rect() arguments.
        p.rect(0, 0, 2, 2);
      };
    });
    await instance.whenReady();
    await instance.redraw();
    const gl = instance._renderer.GL;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // readPixels row 0 is the bottom of the canvas.
    const at = (x, topY) => { const i = ((H - 1 - topY) * W + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; };
    const stats = {
      bottomLeft: at(0, H - 1),
      bottomRight: at(W - 1, H - 1),
      topLeft: at(0, 0),
      topRight: at(W - 1, 0),
    };
    let transparent = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) transparent += 1;
    const canvas = [instance.canvas.width, instance.canvas.height];
    await instance.remove();
    return { stats, transparent, canvas };
  });

  expect(result.canvas).toEqual([8, 8]);
  expect(result.transparent).toBe(0);
  const { bottomLeft, bottomRight, topLeft, topRight } = result.stats;
  for (const corner of [bottomLeft, bottomRight, topLeft, topRight]) {
    // aPosition.x and aTexCoord.x (red == blue) describe the same unit quad.
    expect(Math.abs(corner[0] - corner[2])).toBeLessThanOrEqual(2);
  }
  expect(bottomRight[0]).toBeGreaterThan(200);
  expect(bottomLeft[0]).toBeLessThan(40);
  // v = 0 at the BOTTOM (green), 1 at the top.
  expect(bottomLeft[1]).toBeLessThan(40);
  expect(topLeft[1]).toBeGreaterThan(200);
  expect(Math.abs(bottomLeft[1] - bottomRight[1])).toBeLessThanOrEqual(2);
});

test('core WebGL: uniform dispatch and texture orientation', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async (VERT) => {
    const { default: VizCore } = await import('/src/core/index.js');
    const W = 8;
    const H = 8;
    const instance = new VizCore((p) => {
      p.setup = () => {
        p.pixelDensity(1);
        p.createCanvas(W, H, p.WEBGL);
        p.noStroke();
        p.noLoop();
      };
    });
    await instance.whenReady();
    const gl = instance._renderer.GL;
    const read = () => {
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    // (a) scalar / vec2 / float-array / texture-sampler dispatch.
    const uniformShader = instance.createShader(VERT, `
      precision highp float;
      uniform float uScalar;
      uniform vec2 uVec;
      uniform float uArray[3];
      uniform sampler2D uTex;
      varying vec2 vTexCoord;
      void main() {
        gl_FragColor = vec4(uScalar, uVec.y, uArray[2], texture2D(uTex, vec2(0.5, 0.5)).a);
      }
    `);
    const image = instance.createImage(2, 2);
    image.loadPixels();
    for (let i = 0; i < image.pixels.length; i += 4) {
      image.pixels[i] = 10; image.pixels[i + 1] = 20; image.pixels[i + 2] = 30; image.pixels[i + 3] = 255;
    }
    image.updatePixels();
    const drawUniforms = () => {
      instance.clear();
      instance.shader(uniformShader);
      uniformShader.setUniform('uScalar', 0.25);
      uniformShader.setUniform('uVec', [0.5, 0.75]);
      uniformShader.setUniform('uArray', new Float32Array([0, 0, 0.5]));
      uniformShader.setUniform('uTex', image);
      instance.rect(0, 0, instance.width, instance.height);
      const px = read();
      return [px[0], px[1], px[2], px[3]];
    };
    const uniforms = drawUniforms();

    // (b) texture orientation: first row red, second row blue.
    const oriented = instance.createImage(2, 2);
    oriented.loadPixels();
    const setRow = (row, r, g, b) => {
      for (let x = 0; x < 2; x += 1) {
        const i = (row * 2 + x) * 4;
        oriented.pixels[i] = r; oriented.pixels[i + 1] = g; oriented.pixels[i + 2] = b; oriented.pixels[i + 3] = 255;
      }
    };
    setRow(0, 255, 0, 0);
    setRow(1, 0, 0, 255);
    oriented.updatePixels();
    const orientShader = instance.createShader(VERT, `
      precision highp float;
      uniform sampler2D uTex;
      varying vec2 vTexCoord;
      void main() {
        float v = vTexCoord.x < 0.5 ? 0.15 : 0.85;
        gl_FragColor = vec4(texture2D(uTex, vec2(0.5, v)).rgb, 1.0);
      }
    `);
    instance.clear();
    instance.shader(orientShader);
    orientShader.setUniform('uTex', oriented);
    instance.rect(0, 0, instance.width, instance.height);
    const orientPx = read();
    const leftHalf = [orientPx[0], orientPx[1], orientPx[2]];
    const rightHalf = [orientPx[(W - 1) * 4], orientPx[(W - 1) * 4 + 1], orientPx[(W - 1) * 4 + 2]];

    // (c) canvas sources are re-uploaded, so a live frame refresh is visible.
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, 4, 4);
    const canvasShader = instance.createShader(VERT, `
      precision highp float;
      uniform sampler2D uTex;
      varying vec2 vTexCoord;
      void main() { gl_FragColor = vec4(texture2D(uTex, vec2(0.5, 0.5)).rgb, 1.0); }
    `);
    const drawCanvas = () => {
      instance.clear();
      instance.shader(canvasShader);
      canvasShader.setUniform('uTex', canvas);
      instance.rect(0, 0, instance.width, instance.height);
      const px = read();
      return [px[0], px[1], px[2]];
    };
    const canvasBefore = drawCanvas();
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(0, 0, 4, 4);
    const canvasAfter = drawCanvas();

    await instance.remove();
    return { uniforms, leftHalf, rightHalf, canvasBefore, canvasAfter };
  }, VERT);

  // uScalar 0.25 → 64, uVec.y 0.75 → 191, uArray[2] 0.5 → 128, texture alpha 255.
  expect(result.uniforms[0]).toBeGreaterThanOrEqual(62);
  expect(result.uniforms[0]).toBeLessThanOrEqual(66);
  expect(result.uniforms[1]).toBeGreaterThanOrEqual(189);
  expect(result.uniforms[1]).toBeLessThanOrEqual(193);
  expect(result.uniforms[2]).toBeGreaterThanOrEqual(126);
  expect(result.uniforms[2]).toBeLessThanOrEqual(130);
  expect(result.uniforms[3]).toBe(255);
  // v = 0 samples the image's FIRST row (red); v = 1 the last row (blue).
  expect(result.leftHalf).toEqual([255, 0, 0]);
  expect(result.rightHalf).toEqual([0, 0, 255]);
  expect(result.canvasBefore).toEqual([0, 255, 0]);
  expect(result.canvasAfter).toEqual([255, 0, 255]);
});

test('core WebGL: p5 context attributes and cross-context canvas readback', { tag: '@core' }, async ({ page }) => {
  await page.goto('/tests/fixtures/render.html');
  const result = await page.evaluate(async () => {
    const { default: VizCore } = await import('/src/core/index.js');
    const W = 64;
    const H = 36;
    const instance = new VizCore((p) => {
      p.setup = () => {
        p.pixelDensity(1);
        p.createCanvas(W, H, p.WEBGL);
        p.noStroke();
        p.noLoop();
      };
      p.draw = () => {
        // Opaque bright fill: a cleared/unpreserved buffer would read as black.
        p.background(200, 40, 10);
      };
    });
    await instance.whenReady();
    await instance.redraw();

    const gl = instance._renderer.GL;
    const attrs = gl.getContextAttributes();
    const stencilBits = gl.getParameter(gl.STENCIL_BITS);
    const ua = navigator.userAgent.toLowerCase();
    const context = {
      alpha: attrs.alpha,
      depth: attrs.depth,
      stencil: attrs.stencil,
      antialias: attrs.antialias,
      premultipliedAlpha: attrs.premultipliedAlpha,
      preserveDrawingBuffer: attrs.preserveDrawingBuffer,
      expectSafariAA: ua.includes('safari'),
      stencilBits,
      version: gl.getParameter(gl.VERSION),
    };

    // A second document context may only sample the canvas when the drawing
    // buffer survives compositing (p5's preserveDrawingBuffer: true default).
    const sample = document.createElement('canvas');
    sample.width = 16;
    sample.height = 9;
    const ctx = sample.getContext('2d', { willReadFrequently: true });
    let nonBlack = -2;
    try {
      ctx.drawImage(instance.canvas, 0, 0, sample.width, sample.height);
      const px = ctx.getImageData(0, 0, sample.width, sample.height).data;
      nonBlack = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] > 5 || px[i + 1] > 5 || px[i + 2] > 5) nonBlack += 1;
      }
    } catch (error) {
      nonBlack = -1;
    }

    const summary = { context, nonBlack, total: sample.width * sample.height };
    await instance.remove();
    return summary;
  });

  // Reproduces p5 2.3.2 RendererGL._setAttributeDefaults exactly.
  expect(result.context.alpha).toBe(true);
  expect(result.context.depth).toBe(true);
  expect(result.context.stencil).toBe(true);
  expect(result.context.premultipliedAlpha).toBe(true);
  expect(result.context.preserveDrawingBuffer).toBe(true);
  expect(result.context.stencilBits).toBeGreaterThan(0);
  // AA is enabled for Safari only (p5 issue #3850).
  expect(result.context.antialias).toBe(result.context.expectSafariAA);
  expect(result.context.version).toContain('WebGL');
  expect(result.nonBlack).toBe(result.total);
});
