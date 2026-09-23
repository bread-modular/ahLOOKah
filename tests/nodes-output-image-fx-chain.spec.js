import { test, expect } from '@playwright/test';

test('output Camera → implicit FX → implicit FX → Output uses current pixels and only one camera lease', async ({ page }) => {
  await page.goto('/?role=screen');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const graph = { version: 2, name: 'real output chain', nodes: [
      { id: 'cam', type: 'camera', deviceId: null, x: 0, y: 0 },
      { id: 'one', type: 'pattern', patternId: 'fx', params: {}, x: 0, y: 0 },
      { id: 'two', type: 'pattern', patternId: 'fx', params: {}, x: 0, y: 0 },
      { id: 'out', type: 'output', x: 0, y: 0 },
    ], edges: [
      { from: 'cam', to: 'one', port: 'image' },
      { from: 'one', to: 'two', port: 'image' },
      { from: 'two', to: 'out', port: 'image' },
    ] };
    const camera = document.createElement('canvas'); camera.width = camera.height = 2;
    const paint = red => {
      const ctx = camera.getContext('2d'); ctx.fillStyle = `rgb(${red}, 0, 0)`; ctx.fillRect(0, 0, 2, 2);
    };
    paint(30);
    Object.defineProperties(camera, { videoWidth: { value: 2 }, videoHeight: { value: 2 }, readyState: { value: 2 } });
    let acquired = 0, released = 0;
    const cameraSource = { acquire({ onReady }) {
      acquired++;
      queueMicrotask(onReady);
      return { capture: { elt: camera, hide() {} }, release() { released++; } };
    } };
    const modes = [], frameIds = [];
    const fx = { id: 'fx', name: 'FX', camera: true, fx: { input: 'image' }, params: [], factory: (_a, _v, _p, ctx) => p => {
      modes.push(ctx.inputMode);
      p.setup = () => p.createCanvas(32, 24);
      p.draw = () => {
        const frame = ctx.getImageInput(); frameIds.push(frame.frameId);
        const red = frame.source.getContext('2d').getImageData(0, 0, 1, 1).data[0];
        p.background(red + 10, 0, 0);
      };
    } };
    const runtime = new GraphRuntime({ graph, sketches: [fx], preview: false, context: { cameraSource }, width: 32, height: 24 });
    const red = canvas => canvas.getContext('2d').getImageData(0, 0, 1, 1).data[0];
    let outcome;
    try {
      await runtime.ready;
      runtime.sources.get('cam').pause();
      const first = red(await runtime.renderFrame());
      paint(90);
      await runtime.sources.get('cam').primary.redraw();
      const next = red(await runtime.renderFrame());
      outcome = { first, next, modes, frameIds, hasFx: runtime.hasFx, acquired, diagnostics: runtime.getDiagnostics() };
    } finally { runtime.dispose(); }
    return { ...outcome, released };
  });
  expect(result).toEqual({ first: 50, next: 110, modes: ['fx', 'fx'], frameIds: [1, 1, 2, 2], hasFx: true, acquired: 1, released: 1, diagnostics: [] });
});
