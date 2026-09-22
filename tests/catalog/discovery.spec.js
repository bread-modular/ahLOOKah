import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverPatternFiles,
  generatePatternCatalog,
  renderDiscoveredModule,
} from '../../scripts/generate-pattern-catalog.mjs';

const DESCRIPTOR = (id) => `export const pattern = ${JSON.stringify({
  id,
  name: id,
  group: 'Simple',
  description: 'discovery fixture',
})};"\n`;

async function fixtureRoot(files) {
  const root = await mkdtemp(join(tmpdir(), 'pattern-catalog-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test.describe('pattern discovery', { tag: '@core' }, () => {
  test('finds nested pattern modules exactly once and excludes helpers/specs', async () => {
    const root = await fixtureRoot({
      'src/sketches/a.pattern.js': DESCRIPTOR('a'),
      'src/sketches/nested/b.pattern.js': DESCRIPTOR('b'),
      'src/sketches/helper.js': 'export const x = 1;',
      'src/sketches/multi.js': 'export const A = 1; export const B = 2;',
      'src/sketches/a.spec.js': 'test();',
      'src/sketches/.hidden/c.pattern.js': DESCRIPTOR('c'),
      'src/sketches/node_modules/d.pattern.js': DESCRIPTOR('d'),
    });
    try {
      expect(await discoverPatternFiles(root)).toEqual([
        'src/sketches/a.pattern.js',
        'src/sketches/nested/b.pattern.js',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('renders deterministic sorted imports and rewrites only on change', async () => {
    const root = await fixtureRoot({ 'src/sketches/b.pattern.js': DESCRIPTOR('b') });
    try {
      const first = await generatePatternCatalog(root);
      expect(first.paths).toEqual(['src/sketches/b.pattern.js']);
      expect(first.changed).toBe(true);
      const again = await generatePatternCatalog(root);
      expect(again.changed).toBe(false);

      await writeFile(join(root, 'src/sketches/a.pattern.js'), DESCRIPTOR('a'));
      const added = await generatePatternCatalog(root);
      expect(added.changed).toBe(true);
      expect(added.paths).toEqual(['src/sketches/a.pattern.js', 'src/sketches/b.pattern.js']);

      await rm(join(root, 'src/sketches/b.pattern.js'));
      const removed = await generatePatternCatalog(root);
      expect(removed.changed).toBe(true);
      expect(removed.paths).toEqual(['src/sketches/a.pattern.js']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('generated module specifiers resolve relative to the generated dir', () => {
    const source = renderDiscoveredModule(['src/sketches/nested/deep-x.pattern.js']);
    expect(source).toContain("from '../../sketches/nested/deep-x.pattern.js'");
    expect(source).toContain('"src/sketches/nested/deep-x.pattern.js"');
  });

  test('every source module reaches the real catalog exactly once (no silent omissions)', async () => {
    const { discoverPatternFiles: discoverReal } = await import('../../scripts/generate-pattern-catalog.mjs');
    const files = await discoverReal();
    const { BUILTIN_PATTERNS } = await import('../../src/patterns/builtins.js');
    const { DISCOVERED_PATTERNS } = await import('../../src/patterns/.generated/discovered.js');
    expect(DISCOVERED_PATTERNS.map((r) => r.path).sort()).toEqual([...files].sort());
    const byId = new Map(BUILTIN_PATTERNS.map((p) => [p.id, p]));
    expect(byId.size).toBe(BUILTIN_PATTERNS.length);
    for (const record of DISCOVERED_PATTERNS) {
      const basename = record.path.split('/').pop();
      expect(basename, record.path).toBe(`${record.pattern.id}.pattern.js`);
      expect(byId.get(record.pattern.id), record.path).toBe(record.pattern);
      // The descriptor's factory/controller bindings are the module's own —
      // not a serialization, not a differently-bound copy.
      const module = await import(`../../${record.path}`);
      expect(record.pattern.factory, record.path).toBe(module.default ?? module.factory);
      expect(record.pattern.createAudioController, record.path).toBe(module.createAudioController);
      expect(record.pattern.audioControlSchema, record.path).toBe(module.AUDIO_CONTROL_SCHEMA);
    }
  });

  test('every new-style module has a matching focused spec (authoring contract)', async () => {
    const files = await discoverPatternFiles();
    expect(files.length).toBeGreaterThan(0);
    const { readdir } = await import('node:fs/promises');
    const specs = new Set(await readdir('tests/patterns'));
    for (const file of files) {
      const id = file.split('/').pop().replace(/\.pattern\.js$/, '');
      expect(specs.has(`${id}.spec.js`), `tests/patterns/${id}.spec.js`).toBe(true);
    }
  });
});
