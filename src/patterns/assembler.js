// Pure built-in catalog assembler: validation + ordering shared by Node
// contracts and browser initialization.
//
// `assembleBuiltinCatalog(legacyRecords, discoveredRecords)` merges the legacy
// adapter descriptors with auto-discovered `*.pattern.js` descriptors into one
// validated, deterministically ordered array. It never touches storage, the DOM,
// or the network, and it never catches a broken built-in to boot a smaller
// library: every rejection throws with the offending id, source path, and field.
//
// Ordering policy (see docs/built-in-pattern-extensibility.md §4.4):
// - IDs in the closed COMPATIBILITY_ORDER keep their verified baseline relative
//   order (this list never grows for ordinary additions).
// - IDs absent from that list follow it in locale-independent byte order, so
//   new patterns land deterministically regardless of filesystem traversal or
//   import completion order.
import { COMPATIBILITY_ORDER } from './compatibility-order.js';

export const RESERVED_ID_PREFIX = '__';
export const RUNTIME_ID_PREFIXES = ['media-', 'projection-', 'custom-', 'nodes-'];
export const DYNAMIC_ONLY_FIELDS = ['media', 'projection', 'customScript', 'nodesGraph'];

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(record, field, message) {
  const where = record?.path ? ` (${record.path})` : '';
  const id = record?.pattern?.id ?? record?.id ?? '<unknown>';
  throw new Error(`Invalid built-in pattern "${id}"${where}: ${field} ${message}`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateParams(record, params) {
  if (!Array.isArray(params)) fail(record, 'params', 'must be an array (empty is allowed).');
  const seen = new Set();
  params.forEach((param, index) => {
    const field = `params[${index}]`;
    if (!isRecord(param)) fail(record, field, 'must be an object.');
    if (typeof param.key !== 'string' || !param.key.length) fail(record, `${field}.key`, 'must be a non-empty string.');
    if (seen.has(param.key)) fail(record, `${field}.key`, `duplicate key "${param.key}".`);
    seen.add(param.key);
    if (typeof param.label !== 'string' || !param.label.length) fail(record, `${field}.label`, 'must be a non-empty string.');
    for (const bound of ['min', 'max', 'step', 'default']) {
      if (typeof param[bound] !== 'number' || !Number.isFinite(param[bound])) {
        fail(record, `${field}.${bound}`, 'must be a finite number.');
      }
    }
    if (!(param.min < param.max)) fail(record, field, `requires min < max (got ${param.min} / ${param.max}).`);
    if (!(param.step > 0)) fail(record, `${field}.step`, 'must be positive.');
    if (param.default < param.min || param.default > param.max) {
      fail(record, `${field}.default`, `must lie within [${param.min}, ${param.max}] (got ${param.default}).`);
    }
  });
}

function validateDescriptor(record, { discovered }) {
  const { pattern } = record;
  if (!isRecord(pattern)) fail(record, 'pattern', 'must be a descriptor object.');
  const { id, name, group, factory } = pattern;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    fail(record, 'id', 'must match /^[a-z0-9]+(-[a-z0-9]+)*$/.');
  }
  if (id.startsWith(RESERVED_ID_PREFIX)) fail(record, 'id', `must not use the reserved "${RESERVED_ID_PREFIX}" prefix.`);
  for (const prefix of RUNTIME_ID_PREFIXES) {
    if (id.startsWith(prefix)) fail(record, 'id', `must not use the runtime namespace "${prefix}".`);
  }
  if (discovered) {
    const basename = String(record.path || '').split('/').pop();
    if (basename !== `${id}.pattern.js`) {
      fail(record, 'id', `must match its filename (expected "${id}.pattern.js", found "${basename}").`);
    }
  }
  if (typeof name !== 'string' || !name.length) fail(record, 'name', 'must be a non-empty string.');
  if (typeof group !== 'string' || !group.length) fail(record, 'group', 'must be a non-empty string.');
  if (typeof factory !== 'function') fail(record, 'factory', 'must be a function.');
  if (pattern.audioReactive !== undefined && typeof pattern.audioReactive !== 'boolean') {
    fail(record, 'audioReactive', 'must be a boolean when present.');
  }
  if (pattern.camera !== undefined && typeof pattern.camera !== 'boolean') {
    fail(record, 'camera', 'must be a boolean when present.');
  }
  if (discovered && (typeof pattern.description !== 'string' || !pattern.description.length)) {
    fail(record, 'description', 'is required for new-style patterns and must be non-empty.');
  }
  if (pattern.description !== undefined && typeof pattern.description !== 'string') {
    fail(record, 'description', 'must be a string when present.');
  }
  for (const field of DYNAMIC_ONLY_FIELDS) {
    if (pattern[field] !== undefined && pattern[field] !== false && pattern[field] !== null) {
      fail(record, field, 'is reserved for dynamic runtime entries; built-ins must not claim it.');
    }
  }
  if (pattern.audioTransport !== 'pattern-controls') fail(record, 'audioTransport', 'must be "pattern-controls".');
  if (typeof pattern.createAudioController !== 'function') {
    fail(record, 'createAudioController', 'must be a function.');
  }
  if (!isRecord(pattern.audioControlSchema)) fail(record, 'audioControlSchema', 'must be an object.');
  validateParams(record, pattern.params);
  return pattern;
}

function byteCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Merge + validate + order built-in catalog records.
 *
 * @param {Array<{path?: string, pattern: object}>} legacyRecords
 * @param {Array<{path: string, pattern: object}>} discoveredRecords
 * @returns {object[]} validated descriptors in catalog order.
 */
export function assembleBuiltinCatalog(legacyRecords = [], discoveredRecords = []) {
  const rank = new Map(COMPATIBILITY_ORDER.map((id, index) => [id, index]));
  const seen = new Map(); // id -> origin description
  const validated = [];

  const accept = (record, discovered) => {
    const pattern = validateDescriptor(record, { discovered });
    const origin = record?.path ? `${record.path}` : '<legacy adapter>';
    if (seen.has(pattern.id)) {
      throw new Error(
        `Duplicate built-in pattern id "${pattern.id}": first seen at ${seen.get(pattern.id)}, again at ${origin}.`,
      );
    }
    seen.set(pattern.id, origin);
    validated.push(pattern);
  };

  for (const record of legacyRecords) accept(record, false);
  for (const record of discoveredRecords) accept(record, true);

  // Stable: compatibility IDs keep baseline order; everything else follows in
  // locale-independent ID order (never filesystem/import order).
  return validated
    .map((pattern, index) => ({ pattern, index }))
    .sort((a, b) => {
      const ra = rank.has(a.pattern.id) ? rank.get(a.pattern.id) : Infinity;
      const rb = rank.has(b.pattern.id) ? rank.get(b.pattern.id) : Infinity;
      if (ra !== rb) return ra - rb;
      if (ra === Infinity) {
        const byId = byteCompare(a.pattern.id, b.pattern.id);
        if (byId !== 0) return byId;
      }
      return a.index - b.index;
    })
    .map(({ pattern }) => pattern);
}
