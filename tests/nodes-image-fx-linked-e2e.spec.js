import { test, expect } from '@playwright/test';

// One browser journey: edit a linked graph, save v2, play on the screen's real
// camera owner, then replace its input with a procedural → 2D FX → GPU FX →
// custom-script FX chain. No graph is synthesized after the editor has opened.
test('linked editor v2 camera and image-FX chain play through the screen', async ({ page, context }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  await page.setViewportSize({ width: 1900, height: 980 });
  await context.addInitScript(() => {
    if (!globalThis.FileSystemHandle) return;
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
    localStorage.setItem('viz2_video_device_id', 'cam-A');
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'cam-A', label: 'Red Camera' },
      { kind: 'videoinput', deviceId: 'cam-B', label: 'Blue Camera' },
    ];
    window.captureCalls = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.captureCalls.push(constraints);
      if (new URLSearchParams(location.search).get('role') !== 'screen') throw Error('Camera acquired outside the screen');
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
      const c = canvas.getContext('2d');
      c.fillStyle = constraints.video?.deviceId?.exact === 'cam-B' ? 'blue' : 'red';
      c.fillRect(0, 0, 64, 64);
      return canvas.captureStream(30);
    };
  });
  await page.goto('/');
  const screen = await context.newPage();
  await screen.goto('/?role=screen');
  await expect.poll(() => page.evaluate(() => window.__viz?.screenOnline)).toBe(true);

  // The only seeded graph is a source-only v1 draft on a real linked OPFS file.
  const id = await page.evaluate(async () => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const graph = { version: 1, name: 'Linked image pipeline', nodes: [
      { id: 'source', type: 'pattern', patternId: 'solid-color', x: 30, y: 55,
        params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 } },
      { id: 'output', type: 'output', x: 1050, y: 155 },
    ], edges: [] };
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('image-fx-linked', { create: true });
    const file = await dir.getFileHandle('pipeline.nodes.json', { create: true });
    const writer = await file.createWritable();
    await writer.write(serializeGraph(graph, manifestFor(graph, SKETCHES))); await writer.close();
    window.showDirectoryPicker = async () => dir;
    await nodePatterns.link();
    return (await nodePatterns.open('pipeline.nodes.json')).id;
  });
  const diskGraph = () => page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('image-fx-linked');
    const file = await dir.getFileHandle('pipeline.nodes.json');
    return JSON.parse(await (await file.getFile()).text()).graph;
  });
  const library = page.locator(`.library-btn[data-id="${id}"]`);
  await expect(library).toBeVisible();
  await library.click();
  await page.getByRole('button', { name: 'Edit Pattern', exact: true }).click();
  await expect(page.getByLabel('Graph name')).toHaveValue('Linked image pipeline');
  const workspace = page.getByLabel('Graph workspace');
  await page.getByRole('button', { name: '+ Camera' }).dragTo(workspace, { targetPosition: { x: 110, y: 450 } });
  const camera = page.locator('.nodes-node').filter({ has: page.getByRole('button', { name: 'Select Camera', exact: true }) });
  const cameraId = await camera.getAttribute('data-node-id');
  await expect(page.getByLabel('Camera input device')).toHaveValue('');
  await camera.locator('.nodes-output').click();
  await page.locator('[data-node-id="output"] .nodes-input').click();
  await expect(page.getByTestId('node-preview')).toBeVisible();
  await page.locator(`[data-node-id="${cameraId}"] .nodes-node-title`).click();
  await expect(page.getByTestId('node-camera-status')).toContainText('generated sample clip, not your real camera');
  expect(await page.evaluate(() => window.captureCalls)).toEqual([]);
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await diskGraph()).version).toBe(2);
  await page.getByRole('button', { name: 'Back to Main', exact: true }).click();
  await expect.poll(() => screen.evaluate(id => window.__viz?.liveSelection.ids, id)).toEqual([id]);
  await expect.poll(() => screen.evaluate(() => window.captureCalls.map(c => c.video.deviceId?.exact))).toContain('cam-A');
  await expect.poll(() => screen.evaluate(() => window.__viz.runtimeCounts.camera.consumers)).toBe(1);
  const livePixel = () => screen.locator(`.program-layer-live[data-program-ids="${id}"] > canvas`).evaluate(c =>
    [...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data]);
  await expect.poll(async () => (await livePixel())[0], { timeout: 15_000 }).toBeGreaterThan(200);
  const firstGeneration = await screen.evaluate(() => window.__viz.programs.live.generation);

  // The real Settings action must recreate a LIVE graph with a Global Camera,
  // even though the registry descriptor of the graph itself isn't camera:true.
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Setup' }).click();
  await page.getByLabel('Camera Input').selectOption('cam-B');
  await expect.poll(() => screen.evaluate(() => window.captureCalls.map(c => c.video.deviceId?.exact))).toContain('cam-B');
  await expect.poll(() => screen.evaluate(() => window.__viz.programs.live.generation)).toBeGreaterThan(firstGeneration);
  await expect.poll(async () => (await livePixel())[2], { timeout: 15_000 }).toBeGreaterThan(200);
  const cameraCalls = await screen.evaluate(() => window.captureCalls.length);
  await page.locator('#device-setup-modal-close').click();

  // Register real custom-script source, not a hand-made registry descriptor.
  await page.evaluate(async () => {
    const { CustomScripts } = await import('/src/custom-scripts/service.js');
    const scripts = new CustomScripts({ role: 'control' });
    await scripts.start(); // establish the revision channel for the screen window
    await scripts.commit([{ name: 'linked-fx.viz.js', text: `api.requireVersion(1);api.create({
      id:'custom-linked-fx',name:'Linked Image FX',fx:{input:'image'},
      draw({p,inputMode,imageInput}) {
        if (inputMode !== 'fx') throw Error('Wrong mode');
        p.clear(); if (imageInput) p.image(imageInput.source,0,0,p.width,p.height);
      }
    });` }]);
    scripts.close();
  });
  await expect.poll(() => screen.evaluate(async () =>
    (await import('/src/sketch-registry.js')).SKETCHES.some(s => s.id === 'custom-linked-fx' && s.fx?.input === 'image'))).toBe(true);

  await page.getByRole('button', { name: 'Edit Pattern', exact: true }).click();
  const addFx = async (search, name, x) => {
    await page.locator('.nodes-palette').getByLabel('Search patterns').fill(search);
    await page.locator('.nodes-pattern-row').filter({ hasText: name }).locator('.nodes-pattern-source')
      .dragTo(workspace, { targetPosition: { x, y: 165 } });
    const card = page.locator('.nodes-node[data-primary=true]');
    const nodeId = await card.getAttribute('data-node-id');
    await expect(card.getByRole('button', { name: `${nodeId} input image` })).toBeVisible();
    await expect(page.getByTestId('node-image-input-status')).toHaveText('Image input: not connected (camera default)');
    return nodeId;
  };
  const chroma = await addFx('video chroma', 'Video Chroma Key', 350);
  const dots = await addFx('video dots', 'Video Dots GPU', 600);
  const script = await addFx('linked image', 'Linked Image FX', 850);
  const connect = async (from, to) => {
    await page.locator(`[data-node-id="${from}"] .nodes-output`).click();
    await page.locator(`[data-node-id="${to}"] .nodes-input`).click();
  };
  await connect('source', chroma);
  await connect(chroma, dots);
  await connect(dots, script);
  await connect(script, 'output'); // replaces the Camera → Output edge
  await expect(page.locator('.nodes-wires [data-connection="image:output:image"]')).toHaveCount(1);
  await expect.poll(() => page.getByTestId('node-preview').evaluate(c => {
    const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let visible = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) visible++;
    return visible;
  }), { timeout: 20_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.captureCalls)).toEqual([]);
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await diskGraph()).nodes.filter(n => n.inputMode === 'fx').length).toBe(3);
  const disk = await diskGraph();
  expect(disk.nodes.find(n => n.id === cameraId)).toMatchObject({ type: 'camera', deviceId: null });
  expect(disk.nodes.filter(n => n.inputMode === 'fx').map(n => n.patternId).sort()).toEqual(['custom-linked-fx', 'video-chroma', 'video-dots-gpu']);
  expect(disk.edges).toEqual(expect.arrayContaining([
    { from: 'source', to: chroma, port: 'image' }, { from: chroma, to: dots, port: 'image' },
    { from: dots, to: script, port: 'image' }, { from: script, to: 'output', port: 'image' },
  ]));
  await page.getByRole('button', { name: 'Back to Main', exact: true }).click();
  await expect.poll(() => screen.evaluate(() => window.__viz.runtimeCounts.camera.consumers), { timeout: 20_000 }).toBe(0);
  await expect.poll(() => screen.evaluate(() => window.__viz.programs.live?.ready), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => screen.locator(`.program-layer-live[data-program-ids="${id}"] > canvas`).evaluate(c => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d'); ctx.drawImage(c, 0, 0, 32, 32);
    const bytes = ctx.getImageData(0, 0, 32, 32).data;
    let red = 0; for (let i = 0; i < bytes.length; i += 4) if (bytes[i] > 20 && bytes[i + 3] > 0) red++;
    return red;
  }), { timeout: 20_000 }).toBeGreaterThan(0);
  expect(await screen.evaluate(() => window.captureCalls.length)).toBe(cameraCalls); // FX made no capture
});
