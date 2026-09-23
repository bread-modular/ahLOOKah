import { test, expect } from '@playwright/test';

test('F07: scalar preview selections retire unused audio routes and never allocate scalar image buffers', async ({ page }) => {
  await page.goto('/?role=nodes');
  const result = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const { PatternAudioControlStore } = await import('/src/pattern-audio-controls.js');
    const { approveExpression } = await import('/src/nodes/script-approval.js');
    approveExpression('time + x');
    const store = new PatternAudioControlStore({ consumerSessionId: 'independent' });
    const nodes = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, type: 'audio', deviceId: `device-${i}`, channel: 'mono', band: 'bass', x: 0, y: 0 }));
    const graph = { version: 2, name: 'scalar preview', nodes: [...nodes,
      { id: 'clock', type: 'script', source: 'time + x', inputX: 0, inputY: 0, x: 0, y: 0 },
      { id: 'cam', type: 'camera', deviceId: null, x: 0, y: 0 },
      { id: 'final', type: 'output', x: 0, y: 0 }], edges: [], signalEdges: [{ from: 'a0', to: 'clock', port: 'x' }] };
    const runtime = new GraphRuntime({ graph, sketches: [], context: { audioControlStore: store }, preview: true, width: 16, height: 16 });
    const routes = () => runtime.signal?.getAudioSlotDescriptors().map(s => s.audioInput.deviceId) || [];
    try {
      await runtime.ready;
      const initially = { routes: routes(), buffers: [...runtime.buffers.keys()], sample: !!runtime.sample };
      const snapshots = [];
      for (const node of nodes) {
        const canvas = await runtime.renderFrame(node.id);
        snapshots.push({ canvas: canvas === null, routes: routes(), buffers: [...runtime.buffers.keys()] });
      }
      await runtime.renderFrame('clock');
      const firstTime = runtime.signalValue('clock');
      const firstId = runtime.signal.getAudioSlotDescriptors()[0].runtimeId;
      await runtime.renderFrame('final');
      const parked = routes();
      // Explicit frame boundary, not a sleep pretending that preparation finished.
      await new Promise(resolve => requestAnimationFrame(resolve));
      await runtime.renderFrame('clock');
      const resumed = { routes: routes(), sameId: firstId === runtime.signal.getAudioSlotDescriptors()[0].runtimeId,
        timeAdvanced: runtime.signalValue('clock') > firstTime };
      runtime.pause(); const paused = routes(); runtime.resume();
      return { initially, snapshots, parked, resumed, paused, afterResume: routes(),
        buffers: [...runtime.buffers.keys()], work: [...runtime.work.keys()], sample: !!runtime.sample };
    } finally { runtime.dispose(); }
  });
  expect(result.initially).toEqual({ routes: [], buffers: ['final'], sample: false });
  result.snapshots.forEach((s, i) => expect(s).toEqual({ canvas: true, routes: [`device-${i}`], buffers: ['final'] }));
  expect(result.parked).toEqual([]);
  expect(result.resumed).toEqual({ routes: ['device-0'], sameId: true, timeAdvanced: true });
  expect(result.paused).toEqual([]);
  expect(result.afterResume).toEqual(['device-0']);
  expect(result.buffers).toEqual(['final']);
  expect(result.work).toEqual(['final']);
  expect(result.sample).toBe(false);
});

test('F08: unapproved and invalid Scripts stay diagnosed and isolated on reachable/unreachable branches in both renderers', async ({ page }) => {
  await page.goto('/?role=nodes');
  const results = await page.evaluate(async () => {
    const { GraphRuntime } = await import('/src/nodes/runtime.js');
    const sketches = [
      { id: 'red', params: [], factory: () => p => { p.setup = () => p.createCanvas(16, 16); p.draw = () => p.background(190, 0, 0); } },
      { id: 'fx', params: [], fx: { input: 'image' }, factory: (_a, _v, _p, context) => p => {
        p.setup = () => p.createCanvas(16, 16); p.draw = () => p.image(context.getImageInput().source, 0, 0, p.width, p.height);
      } },
    ];
    const output = [];
    for (const fx of [false, true]) for (const reachable of [false, true]) for (const source of ['0.1234567', 'unknownFunction(x)']) {
      const graph = { version: 2, name: 'script isolation', nodes: [
        { id: 'good', type: 'pattern', patternId: 'red', params: {}, x: 0, y: 0 },
        ...(fx ? [{ id: 'effect', type: 'pattern', patternId: 'fx', params: {}, x: 0, y: 0 }] : []),
        { id: 'mix', type: 'blend', mode: 'Normal', opacity: 1, x: 0, y: 0 },
        { id: 'script', type: 'script', source, inputX: 0, inputY: 0, x: 0, y: 0 },
        { id: 'out', type: 'output', x: 0, y: 0 }],
        edges: [{ from: 'good', to: 'mix', port: 'base' }, { from: 'mix', to: fx ? 'effect' : 'out', port: 'image' },
          ...(fx ? [{ from: 'effect', to: 'out', port: 'image' }] : [])],
        modulations: reachable ? [{ from: 'script', to: 'mix', param: 'opacity', min: 0, max: 1 }] : [] };
      const runtime = new GraphRuntime({ graph, sketches, preview: false, width: 16, height: 16 });
      try {
        await runtime.ready;
        const canvas = await runtime.renderFrame();
        output.push({ fx, reachable, source, pixel: [...canvas.getContext('2d').getImageData(2, 2, 1, 1).data],
          diagnostics: runtime.getDiagnostics(), compiled: runtime.scriptPrograms.has('script') });
      } finally { runtime.dispose(); }
    }
    return output;
  });
  expect(results).toHaveLength(8);
  for (const result of results) {
    expect(result.pixel).toEqual([190, 0, 0, 255]);
    expect(result.compiled).toBe(result.reachable);
    expect(result.diagnostics.join(' ')).toContain('Script not approved');
  }
});
