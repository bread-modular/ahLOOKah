// Pure built-in pattern catalog: shipped patterns only.
//
// - No storage/DOM access at module evaluation; immutable membership.
// - Dependency graph must not pull in runtime registration services
//   (media/projection/node/custom-script registries).
// - The generated `./.generated/discovered.js` module is recreated
//   automatically by Vite/Playwright config hooks (and `npm run dev` /
//   `npm run build` through them), including from a clean checkout.
import { assembleBuiltinCatalog } from './assembler.js';
import { LEGACY_BUILTINS } from './legacy-builtins.js';
import { DISCOVERED_PATTERNS } from './.generated/discovered.js';

const legacyRecords = LEGACY_BUILTINS.map((pattern) => ({
  path: 'src/patterns/legacy-builtins.js',
  pattern,
}));

/** Validated, deterministically ordered built-in descriptors. */
export const BUILTIN_PATTERNS = Object.freeze(
  assembleBuiltinCatalog(legacyRecords, DISCOVERED_PATTERNS),
);
