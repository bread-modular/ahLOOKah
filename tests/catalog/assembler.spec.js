import { test, expect } from '@playwright/test';
import { assembleBuiltinCatalog } from '../../src/patterns/assembler.js';
import { COMPATIBILITY_ORDER } from '../../src/patterns/compatibility-order.js';

const factory = () => () => {};
const schema = Object.freeze({ continuous: {}, arrays: {}, events: {} });

function descriptor(overrides = {}) {
  return {
    id: 'probe-pattern',
    name: 'Probe Pattern',
    group: 'Simple',
    description: 'Synthetic assembler fixture.',
    factory,
    audioTransport: 'pattern-controls',
    createAudioController: () => ({ update: () => ({}), dispose: () => {} }),
    audioControlSchema: schema,
    params: [{ key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.5 }],
    ...overrides,
  };
}

const legacy = (pattern) => ({ path: 'src/patterns/legacy-builtins.js', pattern });
const discovered = (pattern) => ({ path: `src/sketches/${pattern.id}.pattern.js`, pattern });

test.describe('builtin catalog assembler', { tag: '@core' }, () => {
  test('accepts a valid descriptor from either source', () => {
    const [onlyLegacy] = assembleBuiltinCatalog([legacy(descriptor({ id: 'legacy-ok' }))], []);
    expect(onlyLegacy.id).toBe('legacy-ok');
    const [onlyDiscovered] = assembleBuiltinCatalog([], [discovered(descriptor({ id: 'discovered-ok' }))]);
    expect(onlyDiscovered.id).toBe('discovered-ok');
  });

  test('validates optional image FX capability on both descriptor paths without changing camera', () => {
    for (const origin of [legacy, discovered]) {
      const assemble = (overrides) => origin === legacy
        ? assembleBuiltinCatalog([origin(descriptor(overrides))], [])
        : assembleBuiltinCatalog([], [origin(descriptor(overrides))]);
      const sourceOnly = assemble({ camera: true })[0];
      expect(sourceOnly.camera).toBe(true);
      expect(sourceOnly.fx).toBeUndefined();
      const fx = { input: 'image' };
      const adapted = assemble({ camera: true, fx })[0];
      expect(adapted.fx).toBe(fx);
      expect(adapted.camera).toBe(true);

      for (const invalid of [null, false, 'image', [], {}, { input: 'video' },
        { input: 'image', output: 'image' }]) {
        expect(() => assemble({ fx: invalid }), JSON.stringify(invalid))
          .toThrow(/Invalid built-in pattern.*fx/);
      }
      expect(() => assemble({ fx: { input: 'video' } }))
        .toThrow(/fx\.input must be "image"/);
      expect(() => assemble({ fx: { input: 'image', extra: true } }))
        .toThrow(/fx\.extra is not supported/);
    }
  });

  test('rejects duplicate ids across sources and reports both origins', () => {
    const dupe = () => assembleBuiltinCatalog(
      [legacy(descriptor({ id: 'same-id' }))],
      [discovered(descriptor({ id: 'same-id', name: 'Other' }))],
    );
    expect(dupe).toThrow(/Duplicate built-in pattern id "same-id"/);
    expect(dupe).toThrow(/legacy-builtins\.js/);
    expect(dupe).toThrow(/same-id\.pattern\.js/);
  });

  test('rejects malformed, reserved, and runtime-namespace ids', () => {
    for (const id of ['Bad_Id', 'UPPER', '', 'trailing-', 'media-x', 'projection-x', 'custom-x', 'nodes-x', '__merge']) {
      expect(() => assembleBuiltinCatalog([], [discovered({ ...descriptor(), id })]), id).toThrow(/Invalid built-in pattern/);
    }
  });

  test('rejects filename/id mismatch and missing new-style description', () => {
    const mismatched = { path: 'src/sketches/other.pattern.js', pattern: descriptor({ id: 'probe-pattern' }) };
    expect(() => assembleBuiltinCatalog([], [mismatched])).toThrow(/must match its filename/);
    const nodesc = descriptor({ id: 'nodesc' });
    delete nodesc.description;
    expect(() => assembleBuiltinCatalog([], [discovered(nodesc)])).toThrow(/description/);
  });

  test('rejects invalid params and missing transport/controller/schema', () => {
    const badParams = [
      [{ key: 'a', label: 'A', min: 0, max: 1, step: 0, default: 0.5 }],
      [{ key: 'a', label: 'A', min: 1, max: 1, step: 0.1, default: 1 }],
      [{ key: 'a', label: 'A', min: 0, max: 1, step: 0.1, default: 2 }],
      [
        { key: 'a', label: 'A', min: 0, max: 1, step: 0.1, default: 0.5 },
        { key: 'a', label: 'A2', min: 0, max: 1, step: 0.1, default: 0.5 },
      ],
    ];
    for (const params of badParams) {
      expect(() => assembleBuiltinCatalog([], [discovered(descriptor({ params }))])).toThrow(/Invalid built-in pattern/);
    }
    const noTransport = descriptor();
    delete noTransport.audioTransport;
    expect(() => assembleBuiltinCatalog([], [discovered(noTransport)])).toThrow(/audioTransport/);
    const dynamic = descriptor({ media: true });
    expect(() => assembleBuiltinCatalog([], [discovered(dynamic)])).toThrow(/reserved for dynamic/);
  });

  test('keeps compatibility order and sorts new ids in stable byte order', () => {
    const a = discovered(descriptor({ id: 'zzz-new' }));
    const b = discovered(descriptor({ id: 'aaa-new' }));
    const first = COMPATIBILITY_ORDER[0];
    const catalog = assembleBuiltinCatalog([legacy(descriptor({ id: first }))], [a, b]);
    expect(catalog.map((p) => p.id)).toEqual([first, 'aaa-new', 'zzz-new']);
    // Input order must not matter.
    const flipped = assembleBuiltinCatalog([legacy(descriptor({ id: first }))], [b, a]);
    expect(flipped.map((p) => p.id)).toEqual([first, 'aaa-new', 'zzz-new']);
  });
});
