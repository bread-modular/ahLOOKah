import { parse } from 'acorn';
import { isPlainObject, validateControlsForSlot } from '../pattern-audio-protocol.js';

export const SCRIPT_SUFFIX = '.viz.js';
const idRE = /^custom-[a-z0-9][a-z0-9-]{0,55}$/;
const keyRE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const fail = (message) => { throw new Error(message); };
const object = (v, label) => { if (!isPlainObject(v)) fail(`${label} must be a plain object`); };
const keys = (v, allowed, label) => {
  object(v, label);
  for (const key of Object.keys(v)) if (!allowed.includes(key)) fail(`${label}: unknown field "${key}"`);
};
const fn = (v, label, required = false, asyncAllowed = false) => {
  if (v === undefined && !required) return;
  if (typeof v !== 'function' || (asyncAllowed ? ['GeneratorFunction', 'AsyncGeneratorFunction'] : ['AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction']).includes(v.constructor.name)) fail(`${label} must be a ${asyncAllowed ? "function" : "synchronous function"}`);
};
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000;
function range(v, label, neutral = false) {
  object(v, label);
  if (!finite(v.min) || !finite(v.max) || v.min > v.max) fail(`${label}: finite min <= max required`);
  if (neutral && (!finite(v.neutral) || v.neutral < v.min || v.neutral > v.max)) fail(`${label}: neutral must be within range`);
}
function validateSchema(schema) {
  keys(schema, ['continuous', 'arrays', 'events', 'neutral'], 'audio.schema');
  for (const kind of ['continuous', 'arrays', 'events']) {
    const entries = schema[kind] === undefined ? {} : schema[kind];
    object(entries, `audio.schema.${kind}`);
    if (Object.keys(entries).length > 64) fail(`${kind}: maximum 64 controls`);
    for (const [key, v] of Object.entries(entries)) {
      if (!keyRE.test(key)) fail(`Invalid audio key: ${key}`);
      if (kind === 'events') {
        keys(v, ['fields'], `event ${key}`);
        const fields = v.fields === undefined ? {} : v.fields;
        object(fields, `event ${key}.fields`);
        for (const [field, spec] of Object.entries(fields)) {
          if (!keyRE.test(field) || ['id', 'type'].includes(field)) fail(`Invalid event field: ${field}`);
          keys(spec, ['min', 'max', 'integer', 'required'], field);
          range(spec, field);
          for (const flag of ['integer', 'required']) if (spec[flag] !== undefined && typeof spec[flag] !== 'boolean') fail(`${field}.${flag} must be boolean`);
        }
      } else {
        keys(v, kind === 'arrays' ? ['min', 'max', 'maxLength', 'minLength'] : ['min', 'max', 'neutral', 'integer'], key);
        range(v, key, kind === 'continuous');
        if (v.integer !== undefined && typeof v.integer !== 'boolean') fail(`${key}.integer must be boolean`);
        if (kind === 'arrays' && (v.minLength ?? 0) > (v.maxLength ?? 512)) fail(`${key}: minLength must not exceed maxLength`);
        if (kind === 'arrays') for (const n of ['minLength', 'maxLength']) {
          if (v[n] !== undefined && (!Number.isInteger(v[n]) || v[n] < 0 || v[n] > 512)) fail(`${key}.${n}: use 0..512`);
        }
      }
    }
  }
  if (schema.neutral !== undefined) {
    keys(schema.neutral, ['continuous', 'arrays'], 'audio.schema.neutral');
    for (const kind of ['continuous', 'arrays']) if (schema.neutral[kind] !== undefined) object(schema.neutral[kind], `audio.schema.neutral.${kind}`);
    if (!validateControlsForSlot({ ...schema.neutral, events: [], runtimeId: 'neutral', paramsRevision: 0 }, { audioControlSchema: schema, runtimeId: 'neutral', paramsRevision: 0 })) fail('Invalid audio.schema.neutral values');
  }
}
export function validateDefinition(d) {
  keys(d, ['id', 'name', 'renderer', 'camera', 'params', 'preload', 'setup', 'draw', 'resize', 'dispose', 'audio'], 'pattern');
  if (!idRE.test(d.id)) fail('id must be custom- followed by lowercase letters, digits or hyphens (max 63 characters)');
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 80) fail(`${d.id}: name must contain 1..80 characters`);
  if (d.renderer !== undefined && !['2d', 'webgl'].includes(d.renderer)) fail(`${d.id}: renderer must be 2d or webgl`);
  if (d.camera !== undefined && typeof d.camera !== 'boolean') fail(`${d.id}: camera must be boolean`);
  for (const hook of ['preload', 'setup', 'draw', 'resize', 'dispose']) fn(d[hook], `${d.id}.${hook}`, hook === 'draw', ['preload', 'setup'].includes(hook));
  if (d.params !== undefined && (!Array.isArray(d.params) || d.params.length > 16)) fail(`${d.id}: params must be an array of at most 16 sliders`);
  const seen = new Set();
  for (const p of d.params || []) {
    keys(p, ['key', 'label', 'min', 'max', 'step', 'default'], 'param');
    if (!keyRE.test(p.key) || ['constructor', 'prototype', '__proto__'].includes(p.key) || seen.has(p.key)) fail(`Invalid or duplicate parameter key: ${p.key}`);
    seen.add(p.key);
    if (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 80) fail(`${p.key}: label required (max 80)`);
    range(p, p.key);
    if (!finite(p.step) || p.step <= 0 || !finite(p.default) || p.default < p.min || p.default > p.max) fail(`${p.key}: positive step and default within range required`);
  }
  if (d.audio !== undefined) {
    keys(d.audio, ['schema', 'update', 'dispose'], 'audio');
    validateSchema(d.audio.schema);
    fn(d.audio.update, 'audio.update', true);
    fn(d.audio.dispose, 'audio.dispose');
  }
  return d;
}
function freezeCopy(v) {
  if (Array.isArray(v)) return Object.freeze(v.map(freezeCopy));
  if (isPlainObject(v)) return Object.freeze(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, freezeCopy(x)])));
  return v;
}

// Parse EVERY file before executing ANY registration code. Not a sandbox:
// globals remain available. Imports are deliberately unsupported in API v1.
export function compileSources(sources) {
  if (!Array.isArray(sources) || sources.length > 100) fail('Folder: maximum 100 .viz.js files');
  const names = new Set();
  return sources.map(({ name, text }) => {
    try {
      if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.viz\.js$/.test(name) || names.has(name)) fail('Invalid or duplicate .viz.js filename');
      names.add(name);
      if (typeof text !== 'string' || text.length > 1_000_000) fail('Script exceeds 1 MB character limit');
      const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ImportExpression') fail(`line ${node.loc.start.line}: imports are unsupported; bundle dependencies into this file`);
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(walk);
          else if (value?.type) walk(value);
        }
      };
      walk(ast);
      return { name, run: new Function('api', `"use strict";\n${text}\n//# sourceURL=custom-scripts/${name}`) };
    } catch (e) { throw new Error(`${name}: syntax/import check: ${e.message}`); }
  });
}
export function stageSources(sources, protectedIds = []) {
  const compiled = compileSources(sources);
  const staged = new Map();
  const reserved = new Set(protectedIds);
  for (const { name, run } of compiled) {
    let open = true;
    let version = false;
    const check = () => { if (!open) fail('Registration API is only available during synchronous file evaluation'); if (!version) fail('Call api.requireVersion(1) first'); };
    const owned = (id) => {
      check();
      if (reserved.has(id)) fail(`Protected built-in/media/projection ID: ${id}`);
      if (!staged.has(id) || staged.get(id).file !== name) fail(`Cannot modify ${id}: not created by this file`);
      return staged.get(id).definition;
    };
    const api = Object.freeze({
      version: 1,
      requireVersion(v) { if (!open || v !== 1) fail('Only scripting API version 1 is supported'); version = true; },
      create(d) {
        check();
        if (reserved.has(d?.id) || staged.has(d?.id)) fail(`ID collision: ${d?.id} (protected or already registered)`);
        staged.set(validateDefinition(d).id, { file: name, definition: freezeCopy(d) });
        return d.id;
      },
      update(id, patch) {
        const prev = owned(id);
        object(patch, 'update patch');
        if (patch.id !== undefined && patch.id !== id) fail('update cannot change ID');
        staged.set(id, { file: name, definition: freezeCopy(validateDefinition({ ...prev, ...patch, id })) });
      },
      delete(id) { owned(id); staged.delete(id); },
      get(id) { return owned(id); },
      list() { check(); return [...staged.values()].filter((v) => v.file === name).map((v) => v.definition); },
    });
    try { run(api); if (!version) fail('Missing api.requireVersion(1)'); }
    catch (e) { throw new Error(`${name}: registration: ${e.message}`); }
    finally { open = false; }
  }
  if (staged.size > 256) fail('Folder: maximum 256 custom patterns');
  return [...staged.values()];
}
