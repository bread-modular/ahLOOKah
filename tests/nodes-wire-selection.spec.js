import { test, expect } from '@playwright/test';
import { validateGraph, connectSignal, connectSignalEdge, mapSignal, deleteNodes, connectionRef, findConnection, removeConnection } from '../src/nodes/model.js';
import { activeInputs, inputs, mathPorts, COLOR_PARAMS } from '../src/nodes/definitions.js';
import { mappedValue } from '../src/nodes/modulation.js';
import { inputAnchor, outputAnchor, signalAnchor } from '../src/nodes/geometry.js';
import { mathValue } from '../src/nodes/scalar.js';
import { parseGraph, serializeGraph, sourceDiagnostics } from '../src/nodes/portability.js';
import { SKETCHES } from '../src/sketch-registry.js';

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
  });
  // Saving over an existing pattern asks for confirmation.
  context.on('page', page => page.on('dialog', dialog => dialog.accept()));
});

// One graph that exercises all three wire kinds: two mappings land on the same
// Color node (multi-input Color), one scalar wire feeds a Script port and the
// image wires carry a two-input Blend.
const wireGraph = () => ({ version: 1, name: 'Wire geometry', nodes: [
  { id: 'red', type: 'pattern', patternId: 'solid-color', x: 40, y: 60, params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 } },
  { id: 'green', type: 'pattern', patternId: 'solid-color', x: 40, y: 300, params: { hue: 1 / 3, saturation: 1, brightness: 1, pulse: 0 } },
  { id: 'mix', type: 'blend', x: 330, y: 170, mode: 'Screen', opacity: 1 },
  { id: 'tint', type: 'color', x: 330, y: 460, params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 } },
  { id: 'audio', type: 'audio', band: 'bass', x: 40, y: 560 },
  { id: 'audio2', type: 'audio', band: 'high', x: 40, y: 700 },
  { id: 'sig', type: 'script', source: 'x', x: 330, y: 840, inputX: 0, inputY: 0 },
  { id: 'out', type: 'output', x: 660, y: 170 },
], edges: [
  { from: 'red', to: 'mix', port: 'base' }, { from: 'green', to: 'mix', port: 'layer' },
  { from: 'mix', to: 'tint', port: 'image' }, { from: 'tint', to: 'out', port: 'image' },
], signalEdges: [{ from: 'audio2', to: 'sig', port: 'x' }],
modulations: [{ from: 'audio', to: 'tint', param: 'brightness', min: 0, max: 1 }, { from: 'audio', to: 'tint', param: 'saturation', min: 0, max: 1 }] });

// A graph well past the removed 24-node / 8-source budgets that still renders: ten
// Pattern sources fold through Blend nodes, plus scalar nodes for width.
function largeGraph() {
  const nodes = [], edges = [], signalEdges = [];
  const sources = 10;
  for (let i = 0; i < sources; i++) nodes.push({ id: `src${i}`, type: 'pattern', patternId: 'solid-color', x: 20 + (i % 5) * 190, y: 40 + Math.floor(i / 5) * 130, params: { hue: i / sources, saturation: 1, brightness: .6, pulse: 0 } });
  let level = Array.from({ length: sources }, (_, i) => `src${i}`), mixes = 0;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) { next.push(level[i]); continue; }
      const id = `mix${mixes++}`;
      nodes.push({ id, type: 'blend', mode: 'Screen', opacity: 1, x: 40 + mixes * 55, y: 380 + (mixes % 3) * 90 });
      edges.push({ from: level[i], to: id, port: 'base' }, { from: level[i + 1], to: id, port: 'layer' });
      next.push(id);
    }
    level = next;
  }
  nodes.push({ id: 'audio', type: 'audio', band: 'bass', x: 20, y: 700 });
  let previous = 'audio';
  for (let i = 0; i < 6; i++) {
    nodes.push({ id: `m${i}`, type: 'math', op: 'add', a: 0, b: 1, c: 1, x: 120 + i * 200, y: 700 });
    signalEdges.push({ from: previous, to: `m${i}`, port: 'a' });
    previous = `m${i}`;
  }
  nodes.push({ id: 'output', type: 'output', x: 40, y: 950 });
  edges.push({ from: level[0], to: 'output', port: 'image' });
  return { version: 1, name: 'Hardware sized', nodes, edges, signalEdges };
}

async function openFixture(page, data) {
  await page.goto('/?role=nodes');
  const id = await page.evaluate(async g => {
    const { nodePatterns } = await import('/src/nodes/repository.js');
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('wire-tests', { create: true });
    const f = await dir.getFileHandle('wire.nodes.json', { create: true });
    const w = await f.createWritable(); await w.write(serializeGraph(g, manifestFor(g, SKETCHES))); await w.close();
    window.showDirectoryPicker = async () => dir; await nodePatterns.link(); return (await nodePatterns.open('wire.nodes.json')).id;
  }, data);
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue(data.name);
  return id;
}
const diskGraph = page => page.evaluate(async () => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('wire-tests');
  return JSON.parse(await (await (await dir.getFileHandle('wire.nodes.json')).getFile()).text()).graph;
});
// Disclose one mapped parameter's controls by clicking the overlay on a spot that
// is empty track (never the box or a handle, which are range gestures).
const openMapping = async (page, key) => {
  const overlay = page.locator(`[data-param-target=${key}] .nodes-mapping-overlay`);
  const rect = await overlay.boundingBox();
  await page.mouse.click(rect.x + rect.width - 3, rect.y + rect.height / 2);
};

// Every wire endpoint is compared against the socket the DOM actually draws, so a
// hand-written node-height offset can never drift back in unnoticed.
const measureWires = page => page.evaluate(() => {
  const plane = document.querySelector('.nodes-plane');
  const zoom = new DOMMatrix(getComputedStyle(plane).transform).a;
  const planeRect = plane.getBoundingClientRect();
  const box = el => { const b = el.getBoundingClientRect(); return { left: (b.left - planeRect.left) / zoom, right: (b.right - planeRect.left) / zoom, top: (b.top - planeRect.top) / zoom, bottom: (b.bottom - planeRect.top) / zoom, centerX: (b.left + b.width / 2 - planeRect.left) / zoom, centerY: (b.top + b.height / 2 - planeRect.top) / zoom }; };
  return [...document.querySelectorAll('.nodes-wires path')].map(path => {
    const parts = path.getAttribute('data-connection').split(':');
    const [kind] = parts;
    const target = kind === 'modulation' ? parts[2] : parts[1];
    const port = kind === 'modulation' ? null : parts[2];
    const source = path.getAttribute('data-connection-from');
    const nodeEl = document.querySelector(`[data-node-id="${target}"]`);
    const socketEl = port ? [...nodeEl.querySelectorAll('.nodes-input')].find(b => b.textContent.trim() === `● ${port}`) : nodeEl.querySelector('.nodes-signal-endpoint');
    const outputEl = document.querySelector(`[data-node-id="${source}"] .nodes-output`);
    const nums = path.getAttribute('d').match(/-?[\d.]+/g).map(Number);
    return {
      connection: path.getAttribute('data-connection'), kind,
      start: { x: nums[0], y: nums[1] }, endpoint: { x: nums.at(-2), y: nums.at(-1) },
      socket: socketEl ? box(socketEl) : null, output: outputEl ? box(outputEl) : null,
      source, sourceAnchor: outputEl ? box(outputEl) : null, missing: [!socketEl && `socket for ${target}/${port || 'signal endpoint'}`, !outputEl && `output of ${source}`].filter(Boolean),
      selected: path.getAttribute('aria-pressed') === 'true',
      strokeWidth: getComputedStyle(path).strokeWidth,
    };
  });
});
const expectEndpointsOnSockets = wires => {
  expect(wires.length).toBeGreaterThan(4);
  for (const wire of wires) {
    expect(wire.missing, `${wire.connection} is missing DOM counterparts`).toEqual([]);
    expect(Math.abs(wire.endpoint.y - wire.socket.centerY), `${wire.connection} endpoint y`).toBeLessThanOrEqual(1);
    expect(wire.endpoint.x, `${wire.connection} endpoint x on socket`).toBeGreaterThanOrEqual(wire.socket.left - 2);
    expect(wire.endpoint.x, `${wire.connection} endpoint x on socket`).toBeLessThanOrEqual(wire.socket.left + 20);
    expect(wire.start.x, `${wire.connection} source x`).toBeGreaterThanOrEqual(wire.output.left);
    expect(wire.start.x, `${wire.connection} source x`).toBeLessThanOrEqual(wire.output.right + 1);
    expect(Math.abs(wire.start.y - wire.output.centerY), `${wire.connection} source y`).toBeLessThanOrEqual(1);
  }
};

test('one connection is addressed by kind and key, and removing it never touches its endpoint nodes', () => {
  const graph = validateGraph(wireGraph());
  const targets = [
    ['image', graph.edges.find(e => e.port === 'layer')],
    ['signal', graph.signalEdges.find(e => e.port === 'x')],
    ['modulation', graph.modulations.find(m => m.param === 'brightness')],
  ];
  for (const [kind, link] of targets) {
    const ref = connectionRef(kind, link);
    expect(findConnection(graph, ref)).toEqual(link);
    const next = removeConnection(graph, ref);
    expect(next.nodes).toEqual(graph.nodes);
    const remaining = { image: next.edges, signal: next.signalEdges || [], modulation: next.modulations || [] };
    const expected = { image: graph.edges, signal: graph.signalEdges, modulation: graph.modulations };
    // Exactly one link of that kind is gone; the other kinds and nodes are intact.
    expect(remaining[kind].length).toBe(expected[kind].length - 1);
    for (const other of ['image', 'signal', 'modulation'].filter(k => k !== kind)) expect(remaining[other]).toEqual(expected[other]);
  }
  // A stale reference is a no-op, never a guess.
  expect(removeConnection(graph, connectionRef('modulation', { from: 'audio', to: 'tint', param: 'contrast' }))).toEqual(graph);
  expect(findConnection(graph, null)).toBe(null);
});

test('Math Value C is a real port only for clamp, and inactive C wires are dropped instead of breaking old graphs', () => {
  expect(inputs({ type: 'math' })).toEqual(['a', 'b', 'c']); // stored contract unchanged
  expect(mathPorts('clamp')).toEqual(['a', 'b', 'c']);
  expect(activeInputs({ type: 'math', op: 'add' })).toEqual(['a', 'b']);
  expect(activeInputs({ type: 'math', op: 'clamp' })).toEqual(['a', 'b', 'c']);
  expect(activeInputs({ type: 'color' })).toEqual(['image']);

  const legacy = { version: 1, name: 'legacy C', nodes: [
    { id: 'src', type: 'audio', band: 'bass', x: 0, y: 0 },
    { id: 'scale', type: 'math', op: 'add', a: 1, b: 2, c: 7, x: 200, y: 0 },
    { id: 'out', type: 'output', x: 400, y: 0 },
  ], edges: [], signalEdges: [{ from: 'src', to: 'scale', port: 'c' }] };
  // Saved by a build that always showed C: it still opens, the wire is dropped and
  // the stored literal is preserved.
  expect(validateGraph(structuredClone(legacy)).signalEdges).toBeUndefined();
  expect(validateGraph(structuredClone(legacy)).nodes.find(n => n.id === 'scale').c).toBe(7);
  const imported = parseGraph(JSON.stringify({ format: 'viz2-nodes', version: 1, graph: legacy, dependencies: [] }));
  expect(imported.graph.signalEdges).toBeUndefined();
  expect(imported.graph.nodes.find(n => n.id === 'scale')).toMatchObject({ op: 'add', a: 1, b: 2, c: 7 });
  const clamped = { ...legacy, nodes: legacy.nodes.map(n => n.id === 'scale' ? { ...n, op: 'clamp' } : n) };
  expect(validateGraph(clamped).signalEdges).toEqual([{ from: 'src', to: 'scale', port: 'c' }]);
  expect(() => validateGraph({ ...clamped, signalEdges: [{ from: 'src', to: 'scale', port: 'z' }] })).toThrow(/signal/);
  // Changing the operation prunes the now-inactive wire atomically.
  expect(connectSignalEdge(clamped, 'src', 'scale', 'c')).toBeTruthy();
  expect(validateGraph({ ...clamped, nodes: clamped.nodes.map(n => n.id === 'scale' ? { ...n, op: 'abs' } : n) }).signalEdges).toBeUndefined();

  // The runtime never reads or traverses an inactive port.
  const clampReads = [];
  expect(mathValue({ type: 'math', op: 'clamp', a: 1, b: 2, c: 3 }, port => { clampReads.push(port); return null; })).toBe(2);
  expect(clampReads).toEqual(['a', 'b', 'c']);
  const addReads = [];
  expect(mathValue({ type: 'math', op: 'add', a: 1, b: 2, c: 3 }, port => { addReads.push(port); if (port === 'c') throw new Error('inactive c read'); return null; })).toBe(3);
  expect(addReads).toEqual(['a', 'b']);
});

test('wire endpoints match the sockets the DOM draws, for image, scalar and modulation wires at 100% and 25% zoom', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  await openFixture(page, wireGraph());
  // Shared geometry model: Color with one input and Blend with two inputs.
  expect(signalAnchor({ type: 'color', x: 330, y: 460 })).toEqual({ x: 342, y: 561 });
  expect(signalAnchor({ type: 'blend', x: 330, y: 170 })).toEqual({ x: 342, y: 303 });
  expect(inputAnchor({ type: 'blend', x: 330, y: 170 }, 'layer')).toEqual({ x: 342, y: 251 });
  expect(outputAnchor({ type: 'pattern', x: 40, y: 60 })).toEqual({ x: 208, y: 109 });
  expect(await page.evaluate(() => document.querySelector('.nodes-node-detail') && getComputedStyle(document.querySelector('.nodes-node-detail')).height)).toBe('20px');

  const wires = await measureWires(page);
  expect(wires.filter(w => w.kind === 'modulation')).toHaveLength(2); // multi-input Color
  expectEndpointsOnSockets(wires);

  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reset canvas view' })).toHaveText('25%');
  const area = await page.locator('.nodes-workspace').boundingBox();
  await page.mouse.move(area.x + 700, area.y + 600); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(area.x + 760, area.y + 645); await page.mouse.up({ button: 'middle' });
  const zoomed = await measureWires(page);
  expect(zoomed.map(w => w.connection)).toEqual(wires.map(w => w.connection));
  expectEndpointsOnSockets(zoomed);
  // A 30px endpoint error is impossible to hide at 25%: the paired modulation
  // endpoints still land on the same socket.
  const colorEndpoints = zoomed.filter(w => w.connection.startsWith('modulation:audio:tint')).map(w => w.endpoint.y);
  expect(new Set(colorEndpoints).size).toBe(1);
});

test('clicking a wire or its ◇ endpoint selects only that connection, and Delete removes only it', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  await openFixture(page, wireGraph());
  const selectedIds = () => page.locator('.nodes-node.is-selected').evaluateAll(nodes => nodes.map(n => n.dataset.nodeId));
  const connections = () => page.locator('.nodes-wires path').evaluateAll(paths => paths.map(p => p.getAttribute('data-connection')));
  const nodeCount = page.locator('.nodes-node');
  await expect(nodeCount).toHaveCount(8);

  // Selected node before touching a wire: the Color node, the way the reported bug
  // reached Delete.
  await page.locator('[data-node-id=tint] .nodes-node-title').click();
  expect(await selectedIds()).toEqual(['tint']);

  // Dashed wires have unpainted gaps, so click a point that really hits the
  // stroke instead of the path's bounding-box centre.
  const clickWire = async connection => {
    const point = await page.locator(`[data-connection="${connection}"]`).evaluate(path => {
      const length = path.getTotalLength();
      for (let t = .5, step = 0; step < 20; step++, t = .5 + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * .04) {
        const onCurve = path.getPointAtLength(length * t);
        const screen = new DOMPoint(onCurve.x, onCurve.y).matrixTransform(path.getScreenCTM());
        if (document.elementFromPoint(screen.x, screen.y) === path) return { x: screen.x, y: screen.y };
      }
      return null;
    });
    expect(point, `${connection} has a clickable point`).not.toBe(null);
    await page.mouse.click(point.x, point.y);
  };
  const brightness = page.locator('[data-connection="modulation:audio:tint:brightness"]');
  await clickWire('modulation:audio:tint:brightness');
  expect(await selectedIds()).toEqual([]); // exclusive of node selection
  await expect(brightness).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('selected-connection')).toHaveText('Audio · bass → Color brightness (modulation)');
  await expect(page.locator('.nodes-node[data-node-id=tint]')).not.toHaveClass(/is-selected/);
  await expect(page.getByRole('heading', { name: 'Connection', exact: true })).toBeVisible();

  await page.keyboard.press('Delete');
  await expect(nodeCount).toHaveCount(8); // both endpoint nodes survive
  expect(await selectedIds()).toEqual([]);
  expect(await connections()).toEqual([
    'image:mix:base', 'image:mix:layer', 'image:tint:image', 'image:out:image', 'signal:sig:x', 'modulation:audio:tint:saturation',
  ]);
  await expect(page.getByTestId('selected-connection')).toHaveCount(0);

  // The ◇ endpoint of a still-mapped Color node selects the connection, not the node.
  await page.getByLabel('tint signal endpoint', { exact: true }).click();
  expect(await selectedIds()).toEqual([]);
  await expect(page.getByTestId('selected-connection')).toHaveText('Audio · bass → Color saturation (modulation)');
  await page.keyboard.press('Backspace');
  await expect(nodeCount).toHaveCount(8);
  expect(await connections()).toEqual(['image:mix:base', 'image:mix:layer', 'image:tint:image', 'image:out:image', 'signal:sig:x']);

  // Image and scalar wires behave the same way.
  await clickWire('image:mix:layer');
  await expect(page.locator('.nodes-node[data-node-id=mix]')).not.toHaveClass(/is-selected/);
  await page.keyboard.press('Delete');
  await expect(nodeCount).toHaveCount(8);
  expect(await connections()).toEqual(['image:mix:base', 'image:tint:image', 'image:out:image', 'signal:sig:x']);
  await clickWire('signal:sig:x');
  await page.keyboard.press('Delete');
  await expect(nodeCount).toHaveCount(8);
  expect(await connections()).toEqual(['image:mix:base', 'image:tint:image', 'image:out:image']);

  // A node selection still deletes the whole selected group with its links.
  await page.locator('[data-node-id=red] .nodes-node-title').click();
  await page.locator('[data-node-id=green] .nodes-node-title').click({ modifiers: ['Control'] });
  expect(await selectedIds()).toEqual(['red', 'green']);
  await page.getByLabel('Graph workspace').focus(); await page.keyboard.press('Delete');
  await expect(nodeCount).toHaveCount(6);
  expect(await connections()).toEqual(['image:tint:image', 'image:out:image']);
});

test('Math Value C hides with its wire outside clamp and its stored literal survives save and reload', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  const graph = { version: 1, name: 'Clamp C', nodes: [
    { id: 'base', type: 'pattern', patternId: 'solid-color', x: 40, y: 60, params: { hue: .5, saturation: 1, brightness: .5, pulse: 0 } },
    { id: 'tint', type: 'color', x: 330, y: 60, params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 } },
    { id: 'audio', type: 'audio', band: 'bass', x: 40, y: 360 },
    { id: 'audio2', type: 'audio', band: 'high', x: 40, y: 500 },
    { id: 'scale', type: 'math', op: 'clamp', a: 1, b: 2, c: 5, x: 330, y: 360 },
    { id: 'out', type: 'output', x: 660, y: 60 },
  ], edges: [{ from: 'base', to: 'tint', port: 'image' }, { from: 'tint', to: 'out', port: 'image' }],
  signalEdges: [{ from: 'audio', to: 'scale', port: 'c' }, { from: 'audio2', to: 'scale', port: 'a' }],
  modulations: [{ from: 'scale', to: 'tint', param: 'brightness', min: .2, max: .8 }] };
  await openFixture(page, graph);
  const cPort = page.locator('[data-node-id=scale] .nodes-input', { hasText: 'c' });
  const cLiteral = page.getByLabel('Math c literal');
  const mathNode = page.locator('[data-node-id=scale]');
  const portCount = () => page.locator('[data-node-id=scale] .nodes-input').count();
  const wireCount = () => page.locator('.nodes-signal-wire').count();
  // The surviving A wire must follow the C row in and out of the layout.
  const expectAligned = async () => {
    const wires = await measureWires(page);
    const d = await page.locator('[data-connection="signal:scale:a"]').getAttribute('d');
    const endpoint = Number(d.match(/-?[\d.]+/g).at(-1));
    expect(Math.abs(endpoint - wires.find(w => w.connection === 'signal:scale:a').socket.centerY)).toBeLessThanOrEqual(1);
  };

  await mathNode.locator('.nodes-node-title').click();
  await expect(cPort).toBeVisible();
  await expect(cLiteral).toBeVisible(); await expect(cLiteral).toBeEnabled();
  expect(await portCount()).toBe(3);
  expect(await wireCount()).toBe(3); // two scalar wires plus the terminal mapping
  await expectAligned();
  const tall = (await mathNode.boundingBox()).height;

  await page.getByLabel('Math operation').selectOption('add');
  await expect(page.locator('.nodes-workspace')).toHaveAttribute('data-status', /Value C is unused by this operation/);
  await expect(cPort).toHaveCount(0);
  await expect(cLiteral).toBeHidden();
  await expect(cLiteral).toBeDisabled();
  expect(await portCount()).toBe(2);
  expect(await wireCount()).toBe(2); // the inactive C wire was removed; the A wire and the mapping stay
  await expectAligned();
  expect((await mathNode.boundingBox()).height).toBe(tall - 32); // the row really left the layout
  await expect(page.locator('[data-node-id=scale] .nodes-node-detail')).toHaveText('add · scalar out');

  await page.getByLabel('Math operation').selectOption('clamp');
  await expect(cPort).toBeVisible();
  await expect(cLiteral).toBeVisible(); await expect(cLiteral).toHaveValue('5'); // stored literal preserved
  expect(await portCount()).toBe(3);
  expect(await wireCount()).toBe(2); // the removed C wire does not come back by itself
  await expectAligned();
  expect((await mathNode.boundingBox()).height).toBe(tall);

  await page.getByLabel('Math operation').selectOption('abs');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // Wait for the disk write itself, not just for an empty status line.
  await expect.poll(async () => (await diskGraph(page)).nodes.find(n => n.id === 'scale').op).toBe('abs');
  const saved = await diskGraph(page);
  expect(saved.nodes.find(n => n.id === 'scale')).toEqual({ id: 'scale', type: 'math', x: 330, y: 360, op: 'abs', a: 1, b: 2, c: 5 });
  expect(saved.signalEdges).toEqual([{ from: 'audio2', to: 'scale', port: 'a' }]);
  expect(await page.locator('.nodes-workspace').getAttribute('data-status')).toBe(null);
  await page.reload();
  await mathNode.locator('.nodes-node-title').click();
  await expect(page.getByLabel('Math operation')).toHaveValue('abs');
  await expect(cLiteral).toBeHidden(); await expect(cLiteral).toBeDisabled();
  await expect(cPort).toHaveCount(0);
  await page.getByLabel('Math operation').selectOption('clamp');
  await expect(cLiteral).toHaveValue('5');
  expect(await portCount()).toBe(3);
});

test('mapping controls belong to the overlay: no Mapping settings button, click/Enter/Space disclosure, collapse on drag, live source badge', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  await openFixture(page, mapSignal(wireGraph(), 'audio', 'tint', 'brightness', .2, .8));
  await page.locator('[data-node-id=tint] .nodes-node-title').click();
  const fields = page.getByLabel('Brightness Mapping min', { exact: true });
  const box = page.getByTestId('mapping-box-brightness');
  const overlay = page.locator('[data-param-target=brightness] .nodes-mapping-overlay');
  const toggle = page.getByRole('button', { name: 'Brightness mapping settings' });
  await expect(fields).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // The LIVE caption is part of the disclosed details: collapsed mapping shows
  // only the overlay box/handles/marker on the track, no caption underneath.
  await expect(page.getByLabel('Brightness LIVE mapped value')).toHaveCount(0);
  // The old named heading/button is gone: the overlay is the only affordance and
  // no visible "Mapping settings" text remains anywhere.
  await expect(toggle).toHaveClass(/nodes-mapping-overlay/);
  await expect(toggle).toHaveCount(1);
  expect(await page.getByText(/Mapping settings/i).count()).toBe(0);

  // Keyboard disclosure from the overlay itself.
  await overlay.focus();
  await page.keyboard.press('Enter');
  await expect(fields).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(fields).toHaveValue('0.2');
  await expect(page.getByLabel('Brightness LIVE mapped value')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(fields).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Brightness LIVE mapped value')).toHaveCount(0);

  // Empty track of the overlay: a real click target that toggles too.
  const track = await overlay.boundingBox();
  await page.mouse.click(track.x + 4, track.y + track.height / 2);
  await expect(fields).toBeVisible();
  await expect(overlay).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Brightness LIVE mapped value')).toBeVisible();

  // Dragging the box rescales the range, collapses the controls and never
  // reopens them on release.
  const rect = await box.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 - 24, rect.y + rect.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(fields).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // A handle resize behaves the same way.
  const handle = page.locator('[data-param-target=brightness] .nodes-mapping-handle').last();
  const grip = await handle.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 18, grip.y + grip.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(fields).toHaveCount(0);
});

test('each mapped parameter names its connected signal next to its title, live', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  // Three parameters on one node, each driven by a different signal source.
  const sources = wireGraph();
  sources.modulations = [
    { from: 'audio', to: 'tint', param: 'brightness', min: .2, max: .8 },
    { from: 'audio2', to: 'tint', param: 'contrast', min: .5, max: 1.5 },
    { from: 'sig', to: 'tint', param: 'saturation', min: .5, max: 1.5 },
  ];
  await openFixture(page, sources);
  await page.locator('[data-node-id=tint] .nodes-node-title').click();
  const badge = key => page.getByTestId(`mapping-source-${key}`);

  await openMapping(page, 'brightness');
  await expect(badge('brightness')).toHaveText('Audio · bass');
  await openMapping(page, 'contrast');
  await expect(badge('contrast')).toHaveText('Audio · high');
  await openMapping(page, 'saturation');
  await expect(badge('saturation')).toHaveText('Script');
  // Each badge stays bound to its own parameter's source.
  await expect(badge('brightness')).toHaveText('Audio · bass');
  await expect(badge('contrast')).toHaveText('Audio · high');

  // The badge rides the parameter's title row, so collapsing the controls keeps it.
  await openMapping(page, 'brightness');
  await expect(badge('brightness')).toHaveText('Audio · bass');

  // A remap updates the badge: dropping the connected Script chip on the
  // Brightness mapping box replaces its source.
  await page.getByRole('button', { name: 'Script', exact: true }).dragTo(page.getByTestId('mapping-box-brightness'));
  await openMapping(page, 'brightness');
  await expect(badge('brightness')).toHaveText('Script');

  // A band change on the source node updates the badge without touching the graph.
  await page.locator('[data-node-id=audio2] .nodes-node-title').click();
  await page.getByLabel('Audio band').selectOption('mid');
  await expect(page.getByRole('button', { name: 'Select Audio · mid', exact: true })).toHaveCount(1);
  await page.locator('[data-node-id=tint] .nodes-node-title').click();
  await openMapping(page, 'contrast');
  await expect(badge('contrast')).toHaveText('Audio · mid');
});

test('mapping endpoints accept values below the parameter domain: negatives persist through save/reload while the effective value stays in the domain', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  const def = COLOR_PARAMS.find(p => p.key === 'brightness');
  // Unit level: the stored endpoint shifts the sweep, and only the value the
  // target consumes is clamped into the target's own domain.
  expect(mappedValue({ min: -.5, max: .8 }, 0, def)).toBe(0);
  expect(mappedValue({ min: -.5, max: .8 }, .5, def)).toBe(.15);
  expect(mappedValue({ min: -.5, max: .8 }, 1, def)).toBe(.8);
  expect(mappedValue({ min: .8, max: -.5 }, 0, def)).toBe(.8);
  expect(mappedValue({ min: -.5, max: -.2 }, 1, def)).toBe(0);

  const id = await openFixture(page, mapSignal(wireGraph(), 'audio', 'tint', 'brightness', .2, .8));
  await page.locator('[data-node-id=tint] .nodes-node-title').click();
  const fields = page.getByLabel('Brightness Mapping min', { exact: true });
  const maxField = page.getByLabel('Brightness Mapping max', { exact: true });
  const inMin = page.getByLabel('Brightness Signal in min', { exact: true });
  const inMax = page.getByLabel('Brightness Signal in max', { exact: true });
  await openMapping(page, 'brightness');
  await expect(fields).toHaveValue('0.2');
  await expect(fields).not.toHaveAttribute('min', /.+/);
  // A minimum below zero is accepted, kept as typed, and the LIVE value the
  // parameter actually consumes is still clamped into the 0…2 brightness domain.
  await fields.fill('-0.5');
  await expect(fields).toHaveValue('-0.5');
  await expect(page.getByLabel('Brightness LIVE mapped value')).toHaveText('LIVE 0');
  await maxField.fill('1');
  await expect(maxField).toHaveValue('1');

  // A fully negative signal input range is valid as long as max > min.
  await inMin.fill('-2');
  await inMax.fill('-0.5');
  await expect(inMin).toHaveValue('-2');
  await expect(inMax).toHaveValue('-0.5');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await diskGraph(page)).modulations.find(m => m.param === 'brightness').min).toBe(-.5);
  const saved = await diskGraph(page);
  expect(saved.modulations.find(m => m.param === 'brightness')).toEqual({ from: 'audio', to: 'tint', param: 'brightness', min: -.5, max: 1, inputMin: -2, inputMax: -.5 });
  expect(saved.nodes.find(n => n.id === 'tint').params.brightness).toBe(1);

  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await page.locator('[data-node-id=tint] .nodes-node-title').click();
  await openMapping(page, 'brightness');
  await expect(fields).toHaveValue('-0.5');
  await expect(maxField).toHaveValue('1');
  await expect(inMin).toHaveValue('-2');
  await expect(inMax).toHaveValue('-0.5');
  // Negative endpoints stay editable in the overlay: the pinning is display only.
  await expect(page.getByTestId('mapping-box-brightness')).toBeVisible();
});

test('a disclosure click and a sub-threshold drag leave an out-of-domain range alone, and translating it stays continuous', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  // min below the 0…1 Opacity floor, so the old domain clamp would have snapped it.
  await openFixture(page, mapSignal(wireGraph(), 'audio', 'mix', 'opacity', -.5, .8, true));
  await page.locator('[data-node-id=mix] .nodes-node-title').click();
  const overlay = page.locator('[data-param-target=opacity] .nodes-mapping-overlay');
  const box = page.getByTestId('mapping-box-opacity');
  const min = page.getByLabel('Opacity Mapping min', { exact: true });
  const max = page.getByLabel('Opacity Mapping max', { exact: true });
  const expanded = () => overlay.getAttribute('aria-expanded');
  const ensureOpen = async () => { if (await expanded() === 'false') await openMapping(page, 'opacity'); };
  const dragBox = async dx => {
    const rect = await box.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2, { steps: 2 });
    await page.mouse.up();
  };

  // The negative endpoint is stored exactly as saved and is not snapped.
  await openMapping(page, 'opacity');
  await expect(min).toHaveValue('-0.5');
  await expect(max).toHaveValue('0.8');

  // Disclosure clicks toggle; they never rewrite the range.
  await openMapping(page, 'opacity');
  await expect(min).toHaveCount(0);
  await openMapping(page, 'opacity');
  await expect(min).toHaveValue('-0.5');
  await expect(max).toHaveValue('0.8');

  // A drag shorter than the gesture threshold is still a click.
  await dragBox(2);
  await ensureOpen();
  await expect(min).toHaveValue('-0.5');
  await expect(max).toHaveValue('0.8');

  // A real drag translates the whole range continuously, outside the domain too,
  // keeping its width instead of jumping to the domain edge.
  await dragBox(-20);
  await ensureOpen();
  const moved = await min.inputValue();
  expect(Number(moved)).toBeLessThan(-.5);
  expect(Number(await max.inputValue()) - Number(moved)).toBeCloseTo(1.3, 6);
});

test('a keyboard-focused wire drops the rectangular focus box, keeps a stroke cue, and still owns exclusive deletion', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  await openFixture(page, wireGraph());
  const wire = page.locator('[data-connection="modulation:audio:tint:brightness"]');
  const connection = 'modulation:audio:tint:brightness';
  const selectedIds = () => page.locator('.nodes-node.is-selected').evaluateAll(nodes => nodes.map(n => n.dataset.nodeId));
  await expect(page.locator('.nodes-node')).toHaveCount(8);

  await page.locator('[data-node-id=tint] .nodes-node-title').click();
  await wire.focus();
  // No outline rectangle around the curve: the stroke itself is the focus cue.
  const style = await wire.evaluate(path => { const s = getComputedStyle(path); return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, stroke: s.stroke, strokeWidth: s.strokeWidth }; });
  expect(style.outlineStyle).toBe('none'); // nothing is painted around the curve
  expect(style.strokeWidth).toBe('7px');
  expect(style.stroke).not.toBe('rgb(77, 163, 255)'); // the wire's own colour changed on focus

  await page.keyboard.press('Enter');
  await expect(wire).toHaveAttribute('aria-pressed', 'true');
  expect(await selectedIds()).toEqual([]); // exclusive of node selection
  await expect(page.getByTestId('selected-connection')).toHaveText('Audio · bass → Color brightness (modulation)');
  await page.keyboard.press('Delete');
  await expect(page.locator('.nodes-node')).toHaveCount(8); // both endpoint nodes survive
  await expect(page.locator(`[data-connection="${connection}"]`)).toHaveCount(0);
  expect(await page.locator('.nodes-wires path').evaluateAll(paths => paths.map(p => p.getAttribute('data-connection')))).toEqual([
    'image:mix:base', 'image:mix:layer', 'image:tint:image', 'image:out:image', 'signal:sig:x', 'modulation:audio:tint:saturation',
  ]);
});

test('node-editor text fields take a soft white focus border with no outline, and sliders keep a non-accent ring', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  const unmapped = wireGraph();
  delete unmapped.modulations; // unbounded sliders must be really focusable
  await openFixture(page, unmapped);
  const name = page.getByLabel('Graph name');
  await name.click();
  await expect(name).toHaveCSS('outline-style', 'none');
  await expect(name).toHaveCSS('border-color', 'rgb(230, 236, 245)');

  const palette = page.getByRole('button', { name: '+ Blend', exact: true });
  // Reach the button with real keyboard navigation: its own focus style must
  // survive, because the soft-white change is scoped to text/number fields.
  let landed = false;
  for (let i = 0; i < 8 && !landed; i += 1) {
    await page.keyboard.press('Tab');
    landed = await page.evaluate(() => document.activeElement?.textContent.trim() === '+ Blend');
  }
  expect(landed).toBe(true);
  await expect(palette).toHaveCSS('outline-style', 'none'); // .btn keeps its own focus border
  await expect(palette).toHaveCSS('border-color', 'rgb(136, 136, 136)');

  await page.locator('[data-node-id=tint] .nodes-node-title').click();
  const slider = page.getByRole('slider', { name: 'Brightness', exact: true });
  // Real keyboard focus: tab from the preceding slider, so :focus-visible applies.
  await page.getByRole('slider', { name: 'Saturation', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(slider).toBeFocused();
  await expect(slider).toHaveCSS('outline-style', 'solid');
  await expect(slider).toHaveCSS('outline-color', 'rgb(230, 236, 245)');
});

test('Math is no longer created, while an existing Math graph still loads, renders its wired clamp input and saves unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  // A legacy graph saved by an older build: clamp with a *wired* third input that
  // comes from another Math node, so the rendered pixels depend on that wire.
  const legacy = { version: 1, name: 'Legacy clamp', nodes: [
    { id: 'base', type: 'pattern', patternId: 'solid-color', x: 30, y: 40, params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 } },
    { id: 'tint', type: 'color', x: 330, y: 40, params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 } },
    { id: 'zero', type: 'math', op: 'add', a: 0, b: 0, c: 1, x: 30, y: 250 },
    { id: 'scale', type: 'math', op: 'clamp', a: .5, b: .2, c: .9, x: 330, y: 250 },
    { id: 'out', type: 'output', x: 660, y: 40 },
  ], edges: [{ from: 'base', to: 'tint', port: 'image' }, { from: 'tint', to: 'out', port: 'image' }],
  signalEdges: [{ from: 'zero', to: 'scale', port: 'c' }],
  modulations: [{ from: 'scale', to: 'tint', param: 'brightness', min: 0, max: 1 }] };
  const id = await openFixture(page, legacy);
  // No creation action exists for Math; the other four node kinds stay.
  await expect(page.getByRole('button', { name: '+ Math', exact: true })).toHaveCount(0);
  for (const name of ['+ Blend', '+ Color', '+ Script', '+ Audio']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);

  // The legacy node loads with its port, its wire and its stored literals.
  await expect(page.locator('[data-node-id=scale] .nodes-node-detail')).toHaveText('clamp · scalar out');
  await expect(page.locator('[data-node-id=scale] .nodes-input', { hasText: 'c' })).toBeVisible();
  await expect(page.locator('[data-connection="signal:scale:c"]')).toHaveCount(1);
  // The wired third input really drives the rendered pixels: clamp(.5, .2, 0)=.2.
  const previewRed = () => page.getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(10, 10, 1, 1).data[0]);
  await page.locator('[data-node-id=out] .nodes-node-title').click();
  await expect.poll(previewRed).toBe(51);
  await page.locator('[data-node-id=scale] .nodes-node-title').click();
  await expect(page.getByLabel('Math operation')).toHaveValue('clamp');
  await expect(page.getByLabel('Math c literal')).toHaveValue('0.9');
  await expect(page.getByTestId('node-signal-readout')).toContainText('Output 0.200');
  // Dropping that wire falls back to the stored literal c=.9 → clamp=.5 → 127,
  // so the connection (not just the literal) is what the render follows.
  await page.locator('[data-connection="signal:scale:c"]').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-connection="signal:scale:c"]')).toHaveCount(0);
  await expect.poll(previewRed).toBeGreaterThan(100);

  // Saving and reloading a legacy graph keeps the node, its literals and its wire.
  await page.reload();
  await page.locator('[data-node-id=scale] .nodes-node-title').click();
  await expect(page.getByLabel('Math operation')).toHaveValue('clamp');
  await expect(page.getByLabel('Math b literal')).toHaveValue('0.2');
  await expect(page.locator('[data-connection="signal:scale:c"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await diskGraph(page)).nodes.find(n => n.id === 'scale').op).toBe('clamp');
  const saved = await diskGraph(page);
  expect(saved.nodes.find(n => n.id === 'scale')).toEqual({ id: 'scale', type: 'math', x: 330, y: 250, op: 'clamp', a: .5, b: .2, c: .9 });
  expect(saved.signalEdges).toEqual([{ from: 'zero', to: 'scale', port: 'c' }]);
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.locator('[data-connection="signal:scale:c"]')).toHaveCount(1);
  await expect(page.locator('[data-node-id=scale] .nodes-node-detail')).toHaveText('clamp · scalar out');
  await page.locator('[data-node-id=out] .nodes-node-title').click();
  await expect.poll(previewRed).toBe(51);
});

test('graphs beyond the removed 24-node and 8-source budgets stay editable, renderable and saveable', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  const graph = largeGraph();
  expect(graph.nodes.length).toBeGreaterThan(24);
  expect(graph.nodes.filter(n => n.type === 'pattern').length).toBeGreaterThan(8);
  expect(validateGraph(graph).nodes).toHaveLength(graph.nodes.length);
  expect(sourceDiagnostics(validateGraph(graph), SKETCHES, [])).toEqual([]);

  await openFixture(page, graph);
  await expect(page.locator('.nodes-node')).toHaveCount(graph.nodes.length);
  await expect(page.locator('.nodes-wires path')).toHaveCount(graph.edges.length + graph.signalEdges.length);
  // It really renders: the editor preview shows the blended sources, not a blank frame.
  await expect.poll(() => page.getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(240, 135, 1, 1).data[0])).toBeGreaterThan(10);
  // Delete one node (still 26 > 24) so only this draft can produce the saved file.
  await page.locator('[data-node-id=m0] .nodes-node-title').click();
  await page.getByLabel('Graph workspace').focus(); await page.keyboard.press('Delete');
  await expect(page.locator('.nodes-node')).toHaveCount(graph.nodes.length - 1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await diskGraph(page)).nodes.length).toBe(graph.nodes.length - 1);
  const saved = await diskGraph(page);
  expect(saved.nodes.filter(n => n.type === 'pattern')).toHaveLength(10);
  const status = await page.locator('.nodes-workspace').getAttribute('data-status') || '';
  expect(status).toBe('');
  await page.reload();
  await expect(page.locator('.nodes-node')).toHaveCount(graph.nodes.length - 1);
  const round = parseGraph(JSON.stringify({ format: 'viz2-nodes', version: 1, graph: saved,
    dependencies: [{ id: 'solid-color', name: 'Solid Color', kind: 'built-in', signature: null }] }));
  expect(round.graph.nodes).toHaveLength(graph.nodes.length - 1);
});
