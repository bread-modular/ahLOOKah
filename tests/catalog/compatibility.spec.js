import { test, expect } from '@playwright/test';
import { BUILTIN_PATTERNS } from '../../src/patterns/builtins.js';
import { COMPATIBILITY_ORDER } from '../../src/patterns/compatibility-order.js';
import { DEFAULT_PAD_IDS, GROUP_ORDER, SHORTCUT_COUNT, SKETCHES } from '../../src/sketch-registry.js';
import { manifestFor, graphDiagnostics, parseGraph, serializeGraph } from '../../src/nodes/portability.js';

const REMOVED_VIDEO_IDS = ['video-slit-scan', 'video-facet-fold', 'video-datamosh', 'video-rolling-shutter'];

test.describe('builtin catalog compatibility', { tag: '@core' }, () => {
  test('every compatibility id still resolves; extra ids are allowed, missing ids fail', () => {
    const byId = new Map(BUILTIN_PATTERNS.map((p) => [p.id, p]));
    for (const id of COMPATIBILITY_ORDER) {
      expect(byId.has(id), `compatibility id "${id}" must remain resolvable`).toBe(true);
    }
    // New ids beyond the closed list are ordinary additions, not failures.
    expect(BUILTIN_PATTERNS.length).toBeGreaterThanOrEqual(COMPATIBILITY_ORDER.length);
  });

  test('retired video IDs are absent from catalog, UI registry, and compatibility order', () => {
    const builtins = new Set(BUILTIN_PATTERNS.map((pattern) => pattern.id));
    const available = new Set(SKETCHES.map((pattern) => pattern.id));
    for (const id of REMOVED_VIDEO_IDS) {
      expect(builtins.has(id), id).toBe(false);
      expect(available.has(id), id).toBe(false);
      expect(COMPATIBILITY_ORDER, id).not.toContain(id);
    }
  });

  test('serialized graphs retain retired IDs and report missing dependencies for repair', () => {
    for (const id of REMOVED_VIDEO_IDS) {
      const graph = {
        version: 1, name: 'Retired source',
        nodes: [
          { id: 'source', type: 'pattern', patternId: id, x: 0, y: 0, params: {} },
          { id: 'out', type: 'output', x: 200, y: 0 },
        ],
        edges: [{ from: 'source', to: 'out', port: 'image' }],
      };
      const saved = serializeGraph(graph, manifestFor(graph, BUILTIN_PATTERNS));
      const parsed = parseGraph(saved);
      expect(parsed.graph.nodes[0].patternId).toBe(id);
      const diagnostics = graphDiagnostics(parsed.graph, BUILTIN_PATTERNS, parsed.dependencies);
      expect(diagnostics.byNode.get('source'), id).toContain(`Missing pattern: ${id}`);
      expect(diagnostics.byNode.get('source'), id).toContain(`Missing dependency: ${id}`);
    }
  });

  test('compatibility ids keep their relative order; new ids follow in byte order', () => {
    const rank = new Map(COMPATIBILITY_ORDER.map((id, index) => [id, index]));
    const ids = BUILTIN_PATTERNS.map((p) => p.id);
    const compat = ids.filter((id) => rank.has(id));
    expect(compat).toEqual([...COMPATIBILITY_ORDER].filter((id) => ids.includes(id)));
    const extra = ids.filter((id) => !rank.has(id));
    expect([...extra].sort()).toEqual(extra);
    if (compat.length && extra.length) {
      expect(ids.indexOf(extra[0])).toBeGreaterThan(ids.indexOf(compat[compat.length - 1]));
    }
  });

  test('default pad is ten explicit stable shortcuts resolving to built-ins', () => {
    expect(DEFAULT_PAD_IDS).toHaveLength(SHORTCUT_COUNT);
    expect(new Set(DEFAULT_PAD_IDS).size).toBe(SHORTCUT_COUNT);
    expect([...DEFAULT_PAD_IDS]).toEqual([
      'circles', 'bars', 'techno3d', 'character3d', 'pulse-rings',
      'particle-storm', 'chroma-mandala', 'starfield-rush', 'echo-ripples', 'laser-grid',
    ]);
    const byId = new Map(BUILTIN_PATTERNS.map((p) => [p.id, p]));
    for (const id of DEFAULT_PAD_IDS) expect(byId.has(id), id).toBe(true);
  });

  test('group order policy: built-in groups first, dynamic utility groups last', () => {
    expect(GROUP_ORDER.slice(0, 9)).toEqual([
      'Simple', 'Rhythmic', '3D', 'Cinematic / Shaders', 'Neon / Lasers',
      'Video FX', 'Glitch / Effects', 'Basics', 'Alphas',
    ]);
    expect(GROUP_ORDER.slice(9)).toEqual(['Media', 'Custom Scripts', 'Node Patterns', 'Projection Mapping']);
    const groups = new Set(BUILTIN_PATTERNS.map((p) => p.group));
    for (const group of groups) {
      expect(GROUP_ORDER.slice(0, 9).includes(group) || group === 'Media', group).toBe(true);
    }
  });

  test('persisted contracts: stable ids, param keys/defaults, non-reactive flags', async () => {
    const { readFileSync } = await import('node:fs');
    const baseline = JSON.parse(readFileSync(new URL('../fixtures/builtin-compat.json', import.meta.url)));
    const byId = new Map(BUILTIN_PATTERNS.map((p) => [p.id, p]));
    for (const saved of baseline) {
      const current = byId.get(saved.id);
      expect(current, `pattern "${saved.id}" must remain resolvable`).toBeTruthy();
      expect(current.name, saved.id).toBe(saved.name);
      expect(current.group, saved.id).toBe(saved.group);
      expect(current.audioReactive ?? null, saved.id).toBe(saved.audioReactive ?? null);
      expect(current.camera ?? null, saved.id).toBe(saved.camera ?? null);
      expect(current.params.map((p) => [p.key, p.default]), saved.id).toEqual(saved.params);
    }
  });
});
