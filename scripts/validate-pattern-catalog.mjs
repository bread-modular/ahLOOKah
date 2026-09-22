// Build gate: regenerate the built-in pattern catalog, then validate it in a
// fresh Node process before the production bundle is accepted. Any invalid
// descriptor (duplicate id, bad params, missing export) fails the build with
// an actionable origin/field diagnostic instead of shipping a smaller library.
import { generatePatternCatalog } from './generate-pattern-catalog.mjs';

const root = new URL('../', import.meta.url).pathname;
await generatePatternCatalog(root);
const { BUILTIN_PATTERNS } = await import('../src/patterns/builtins.js');
const ids = BUILTIN_PATTERNS.map((pattern) => pattern.id);
if (new Set(ids).size !== ids.length) {
  throw new Error('Built-in catalog validation failed: duplicate pattern ids.');
}
console.log(`pattern catalog OK (${ids.length} built-ins)`);
