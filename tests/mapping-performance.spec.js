import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({ launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

test('mapping limits raster work to surface bounds, caches geometry and lazily builds mipmaps', async ({ page }) => {
  await page.goto('/docs/');
  const result = await page.evaluate(async () => {
    const { ScreenMappingRenderer } = await import('/src/screen-mapping-renderer.js');
    const { IDENTITY_QUAD } = await import('/src/screen-mapping.js');
    const output = document.createElement('canvas');
    const renderer = new ScreenMappingRenderer(output);
    renderer.configure(IDENTITY_QUAD, 256, 128);
    const gl = renderer.gl;
    const source = document.createElement('canvas');
    source.width = 256; source.height = 128;
    const ctx = source.getContext('2d');
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 256, 128);
    const calls = { mipmaps: 0, bounds: [] };
    const mipmap = gl.generateMipmap.bind(gl);
    gl.generateMipmap = (...args) => { calls.mipmaps++; return mipmap(...args); };
    const draw = gl.drawArrays.bind(gl);
    gl.drawArrays = (...args) => { calls.bounds.push([...gl.getParameter(gl.SCISSOR_BOX)]); return draw(...args); };
    renderer.capture(source);
    renderer.capture(source);
    const afterCapture = calls.mipmaps;
    renderer.render({ canvases: [source], edgeBlur: 10 });
    const fullFrame = { mipmaps: calls.mipmaps, fast: gl.getUniform(renderer.program, renderer.uniforms.uSingleSample) };
    const surfaces = Array.from({ length: 8 }, (_, i) => {
      const x = (i % 4) / 4, y = Math.floor(i / 4) / 2;
      return { canvas: source, quad: [{ x, y }, { x: x + .25, y }, { x: x + .25, y: y + .5 }, { x, y: y + .5 }], edgeBlur: 10 };
    });
    calls.bounds = [];
    renderer.renderSurfaces(surfaces);
    const bounds = [...calls.bounds];
    const afterMapped = calls.mipmaps;
    renderer.renderSurfaces(surfaces);
    const afterRepeated = calls.mipmaps;
    const first = renderer.geometryFor(surfaces[0].quad);
    const cached = renderer.geometryFor(surfaces[0].quad) === first;
    surfaces[0].quad[0].x += .05;
    const invalidated = renderer.geometryFor(surfaces[0].quad) !== first;
    renderer.configure(IDENTITY_QUAD, 256, 128, 2);
    const resized = renderer.geometryFor(surfaces[1].quad).scissor;
    renderer.configure(IDENTITY_QUAD, 256, 128);
    renderer.renderSurfaces([surfaces[1]]);
    const outside = new Uint8Array(4);
    gl.readPixels(200, 100, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, outside);
    const scissorOff = !gl.isEnabled(gl.SCISSOR_TEST);
    const error = gl.getError();
    renderer.dispose();
    return { afterCapture, fullFrame, bounds, afterMapped, afterRepeated, cached, invalidated, resized, outside: [...outside], scissorOff, error };
  });
  expect(result.afterCapture).toBe(0);
  expect(result.fullFrame).toEqual({ mipmaps: 0, fast: true });
  expect(result.bounds).toHaveLength(8);
  expect(result.bounds.every((bounds) => bounds[2] === 64 && bounds[3] === 64)).toBe(true);
  expect(result.afterMapped).toBe(1);
  expect(result.afterRepeated).toBe(1);
  expect(result.cached).toBe(true);
  expect(result.invalidated).toBe(true);
  expect(result.resized).toEqual([128, 128, 128, 128]);
  expect(result.outside).toEqual([0, 0, 0, 255]);
  expect(result.scissorOff).toBe(true);
  expect(result.error).toBe(0);
});

for (const kind of ['image', 'gif', 'video', 'video-fallback']) {
  test(`${kind === 'gif' ? 'animated GIFs keep playing' : `unchanged ${kind} frames skip painting`}, while controls, edits and resize remain live`, async ({ page }) => {
    await page.route('**/src/media/media-store.js', (route) => route.fulfill({ contentType: 'application/javascript', body: `
      export async function getMediaRecord() { return {}; }
      export async function loadMediaUrl() { return { status: 'ready', url: 'blob:test' }; }
    ` }));
    await page.goto('/docs/');
    const result = await page.evaluate(async (kind) => {
      const { default: factory } = await import('/src/sketches/media_pattern.js');
      let paints = 0, reads = 0, callback, cleanup, hooks, paused = false, cancelled = null;
      const listeners = {};
      const video = {
        videoWidth: 64, videoHeight: 64, playbackRate: 1, currentTime: 0, frames: 0,
        addEventListener: (name, handler) => { listeners[name] = handler; },
        load: () => listeners.loadeddata(),
        play: () => { paused = false; return Promise.resolve(); }, pause: () => { paused = true; },
        removeAttribute() {},
        getVideoPlaybackQuality() { return { totalVideoFrames: this.frames }; },
        ...(kind !== 'video-fallback' ? {
          requestVideoFrameCallback: (handler) => { callback = handler; return 42; },
          cancelVideoFrameCallback: (id) => { cancelled = id; },
        } : {}),
      };
      const p = {
        width: 320, height: 180, windowWidth: 320, windowHeight: 180,
        createCanvas() {}, colorMode() {}, background() {}, noStroke() {}, blendMode() {},
        createVideo: () => ({ elt: video, hide() {} }),
        loadImage: (_, ready) => ready({ width: 64, height: 64, ...(kind === 'gif' ? { gifProperties: { playing: true } } : {}) }),
        image: () => { paints++; }, drawingContext: { drawImage: () => { paints++; } },
        resizeCanvas: (w, h) => { p.width = w; p.height = h; },
      };
      const params = { zoom: 1, scaleMode: 2, panX: 0, panY: 0, speed: 1 };
      factory({ id: 'test', name: 'test', kind: ['image', 'gif'].includes(kind) ? 'image' : 'video' })(null, null, params, {
        audioControls: { read: () => { reads++; } }, addCleanup: (fn) => { cleanup = fn; },
        addPlaybackLifecycle: (value) => { hooks = value; }, isPaused: () => false,
      })(p);
      p.setup();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const first = p.draw();
      const repeated = Array.from({ length: 60 }, () => p.draw()).every((value) => value === false);
      const initialPaints = paints;
      if (kind === 'video') callback();
      if (kind === 'video-fallback') video.frames++;
      const newFrame = p.draw();
      params.zoom = 2;
      const edited = p.draw();
      params.speed = 2;
      p.draw();
      p.windowResized();
      const resized = p.draw();
      const changedPaints = paints;
      hooks.pause(); const didPause = paused;
      hooks.resume(); const didResume = !paused;
      cleanup();
      return { first, repeated, initialPaints, newFrame, edited, resized, changedPaints, reads, didPause, didResume, cancelled, speed: video.playbackRate };
    }, kind);
    expect(result.first).toBe(true);
    expect(result.repeated).toBe(kind !== 'gif');
    expect(result.initialPaints).toBe(kind === 'gif' ? 61 : 1);
    expect(result.newFrame).toBe(kind !== 'image');
    expect(result.edited).toBe(true);
    expect(result.resized).toBe(true);
    expect(result.changedPaints).toBe(kind === 'gif' ? 65 : kind === 'image' ? 4 : 5);
    expect(result.reads).toBe(65);
    if (kind.startsWith('video')) {
      expect(result.speed).toBe(2);
      expect(result.didPause).toBe(true);
      expect(result.didResume).toBe(true);
      if (kind === 'video') expect(result.cancelled).toBe(42);
    }
  });
}

for (const [kind, mixed] of [['image', false], ['video', false], ['image', true], ['video', true]]) {
  test(`real ${kind} ${mixed ? 'mixed-mapping input' : 'projection'} retains fresh-frame readiness without redundant static uploads`, async ({ page }) => {
    await page.goto('/docs/');
    const result = await page.evaluate(async ({ kind, mixed, videoBase64 }) => {
      const { default: VizCore } = await import('/src/core/index.js');
      const { ProgramRuntime } = await import('/src/program-runtime.js');
      const { putMediaRecord } = await import('/src/media/media-store.js');
      const { buildMediaSketchEntry } = await import('/src/media/media-registry.js');
      const { registerProjectionSketches } = await import('/src/projection/projection-registry.js');
      const file = kind === 'image'
        ? new File(['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'], 'red.svg', { type: 'image/svg+xml' })
        : new File([Uint8Array.from(atob(videoBase64), (c) => c.charCodeAt(0))], 'green.webm', { type: 'video/webm' });
      const meta = { id: 'perf', name: 'Media perf', kind };
      await putMediaRecord({ ...meta, file });
      const sketches = [buildMediaSketchEntry(meta)];
      registerProjectionSketches(sketches, [{ id: 'projection-perf', name: 'Media wall', surfaces: [
        { id: 'smedia', name: 'Media', patternId: 'media-perf' },
      ] }]);
      const host = document.createElement('div'); document.body.append(host);
      const params = {};
      const mapping = { enabled: true, quad: null, edgeBlur: 10 };
      const costs = [];
      const runtime = new ProgramRuntime({ coreConstructor: VizCore, sketches,
        selection: { ids: mixed ? ['projection-perf', 'media-perf'] : ['projection-perf'], merge: mixed },
        getParams: () => params, getSize: () => [200, 120], layer: host,
        getScreenMapping: () => mapping, onRenderCost: (...entry) => costs.push(entry) });
      await runtime.prepare();
      const composed = mixed ? runtime.screenMappingLayers[0] : runtime.projectionLayers[0];
      const mapper = composed.renderer;
      // Both independently loaded media sources must have settled before measuring idle work.
      await new Promise((resolve) => setTimeout(resolve, 160));
      let uploads = 0, renders = 0;
      const renderMethod = mixed ? 'render' : 'renderSurfaces';
      const capture = mapper.capture.bind(mapper), render = mapper[renderMethod].bind(mapper);
      mapper.capture = (...args) => { uploads++; return capture(...args); };
      mapper[renderMethod] = (...args) => { renders++; return render(...args); };
      const wait = () => new Promise((resolve) => setTimeout(resolve, 160));
      const before = runtime.drawCounts[0];
      await wait();
      const idleUploads = uploads, idleRenders = renders;
      const drawing = runtime.drawCounts[0] > before;
      await runtime.requestFreshFrame();
      const fresh = runtime.ready;
      if (mixed) { mapping.edgeBlur = 20; runtime.updateScreenMapping(); }
      else { params['smedia:0x'] = .1; runtime.applyBlendStyles(); }
      await runtime.requestFreshFrame();
      const geometryPresented = composed.presentedRevision >= composed.captureRevision;
      params[mixed ? 'zoom' : 'smedia:zoom'] = .5;
      runtime.applyBlendStyles();
      await runtime.requestFreshFrame();
      const editUploads = uploads;
      composed.onRenderCost(12.5);
      const compositionCost = costs.at(-1);
      const videos = [...document.querySelectorAll('video')];
      runtime.pause();
      const paused = videos.every((video) => video.paused);
      await runtime.requestFreshFrame(4000, { parkAfter: true });
      const parked = runtime.paused && (videos.every((video) => video.paused));
      runtime.resume();
      await wait();
      const resumed = videos.every((video) => !video.paused);
      runtime.dispose();
      const disposed = mapper.textures.size === 0 && (videos.every((video) => video.paused));
      return { idleUploads, idleRenders, drawing, fresh, geometryPresented, editUploads, paused, parked, resumed, disposed, compositionCost };
    }, { kind, mixed, videoBase64: readFileSync(new URL('./fixtures/green.webm', import.meta.url)).toString('base64') });
    expect(result.compositionCost).toEqual([mixed ? 'media-perf' : 'projection-perf', null, 12.5]);
    expect(result.drawing).toBe(true);
    if (kind === 'image') {
      expect(result.idleUploads).toBe(0);
      expect(result.idleRenders).toBe(0);
    } else expect(result.idleUploads).toBeGreaterThan(0);
    expect(result.editUploads).toBeGreaterThan(result.idleUploads);
    for (const flag of ['fresh', 'geometryPresented', 'paused', 'parked', 'resumed', 'disposed']) expect(result[flag], flag).toBe(true);
  });
}


test('Alpha Blend retains the fast path and independently invalidates raw and keyed mipmaps', async ({ page }) => {
  await page.goto('/docs/');
  const result = await page.evaluate(async () => {
    const { ScreenMappingRenderer } = await import('/src/screen-mapping-renderer.js');
    const { IDENTITY_QUAD } = await import('/src/screen-mapping.js');
    const renderer = new ScreenMappingRenderer(document.createElement('canvas'), { alpha: true });
    renderer.configure(IDENTITY_QUAD, 128, 128);
    const source = document.createElement('canvas'); source.width = source.height = 128;
    const ctx = source.getContext('2d');
    const paint = (color) => {
      ctx.clearRect(0, 0, source.width, source.height);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, source.width / 2, source.height);
      ctx.fillStyle = color; ctx.fillRect(source.width / 2, 0, source.width / 2, source.height);
      renderer.capture(source);
    };
    const gl = renderer.gl;
    let mipmaps = 0, masks = 0, clippedMasks = 0;
    const mipmap = gl.generateMipmap.bind(gl), draw = gl.drawArrays.bind(gl);
    gl.generateMipmap = (...args) => { mipmaps++; return mipmap(...args); };
    gl.drawArrays = (...args) => {
      if (renderer.alphaProgram && gl.getParameter(gl.CURRENT_PROGRAM) === renderer.alphaProgram) {
        masks++;
        if (gl.isEnabled(gl.SCISSOR_TEST)) clippedMasks++;
      }
      return draw(...args);
    };
    const warped = [{ x: .25, y: .25 }, { x: .75, y: .25 }, { x: .75, y: .75 }, { x: .25, y: .75 }];
    const render = (quad, alphaBlend) => {
      renderer.renderSurfaces([{ canvas: source, quad, edgeBlur: 10 }], { alphaBlend });
      const pixel = new Uint8Array(4);
      gl.readPixels(80, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return { mipmaps, masks, pixel: [...pixel], fast: gl.getUniform(renderer.program, renderer.uniforms.uSingleSample) };
    };
    paint('rgba(0,255,0,0.5)');
    const full = render(IDENTITY_QUAD, true);
    const keyed = render(warped, true);
    const repeated = render(warped, true);
    const raw = render(warped, false);
    const switched = render(warped, true);
    paint('rgba(255,0,0,0.5)');
    const updated = render(warped, true);
    const updatedRaw = render(warped, false);
    // Resize after both textures used mip filtering. The keying prepass must
    // still read the new base level, not an incomplete/stale old mip chain.
    source.width = source.height = 64;
    paint('#0000ff');
    const resized = render(IDENTITY_QUAD, true);
    const error = gl.getError();
    renderer.dispose();
    return { full, keyed, repeated, raw, switched, updated, updatedRaw, resized, clippedMasks, error };
  });
  expect(result.full).toEqual({ mipmaps: 0, masks: 1, pixel: [0, 128, 0, 128], fast: true });
  expect(result.keyed).toEqual({ mipmaps: 1, masks: 1, pixel: [0, 128, 0, 128], fast: false });
  expect(result.repeated).toEqual(result.keyed);
  expect(result.raw).toEqual({ mipmaps: 2, masks: 1, pixel: [0, 128, 0, 255], fast: false });
  expect(result.switched).toEqual({ ...result.keyed, mipmaps: 2 });
  expect(result.updated).toEqual({ mipmaps: 3, masks: 2, pixel: [128, 0, 0, 128], fast: false });
  expect(result.updatedRaw).toEqual({ mipmaps: 4, masks: 2, pixel: [128, 0, 0, 255], fast: false });
  expect(result.resized).toEqual({ mipmaps: 4, masks: 3, pixel: [0, 0, 255, 255], fast: true });
  expect(result.clippedMasks).toBe(0);
  expect(result.error).toBe(0);
});
