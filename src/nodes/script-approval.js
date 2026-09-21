// Review/approval for disk-loaded Script sources.
//
// Approval is bound to the EXACT source text AND its language, and lives in
// browser storage only, never inside the exported .nodes.json: an imported file
// cannot carry a trust flag with it (unknown keys are dropped by the graph
// model), and editing a single character — or switching the source between the
// expression and body languages — invalidates the previous approval. Comparison
// is exact, no hash, so two different sources can never share an approval.
import { MAX_BODY, MAX_EXPRESSION, compileKey, scriptLanguageOf } from './script-core.js';

const KEY = 'viz2_nodes_script_approvals';
const MAX_APPROVALS = 64;
export const SCRIPT_APPROVAL_MESSAGE = 'Script not approved in this browser. Review the exact source in the inspector, then Apply to run it.';

// Short display/debug identifier only; approval decisions never use it.
export function scriptHash(language, text) {
  const source = typeof text === 'string' ? text : '';
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return `${scriptLanguageOf(language)}:${source.length}:${(hash >>> 0).toString(16)}`;
}
export function expressionHash(text) { return scriptHash('expression', text); }

// Stored entries are { language, source } records; entries written by builds
// that only had the expression language are plain strings and keep working.
const isRecord = entry => entry && typeof entry === 'object' && typeof entry.source === 'string';
function normalize(entry) {
  if (typeof entry === 'string') return { language: 'expression', source: entry };
  if (!isRecord(entry)) return null;
  const language = scriptLanguageOf(entry.language);
  const limit = language === 'body' ? MAX_BODY : MAX_EXPRESSION;
  if (!entry.source.trim() || entry.source.length > limit) return null;
  return { language, source: entry.source };
}
function parse(raw) {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.map(normalize).filter(Boolean).slice(-MAX_APPROVALS) : [];
  } catch { return []; }
}
function read() {
  try { return parse(globalThis.localStorage?.getItem(KEY)); } catch { return []; }
}
function write(entries) {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(entries.slice(-MAX_APPROVALS))); } catch { /* Approvals fall back to this session only. */ }
}
// In-memory mirror so approval still works when storage is unavailable/disabled.
// Bounded exactly like the persisted copy. `raw` also short-circuits the common
// case: reading approval every frame must not re-parse unchanged storage.
const session = new Set();
let rawCache = null, listCache = [];
function remembered() {
  const raw = globalThis.localStorage?.getItem(KEY) ?? '';
  if (raw !== rawCache) { rawCache = raw; listCache = parse(raw); }
  return listCache;
}
const remember = key => {
  session.delete(key); session.add(key);
  while (session.size > MAX_APPROVALS) session.delete(session.values().next().value);
};
function limitsFor(language) {
  const mode = scriptLanguageOf(language);
  const limit = mode === 'body' ? MAX_BODY : MAX_EXPRESSION;
  return { mode, limit, description: mode === 'body' ? `a script body of 1–${limit} characters` : `an expression of 1–${limit} characters` };
}
export function isScriptApproved(language, text) {
  const source = typeof text === 'string' ? text : '';
  const { mode, limit } = limitsFor(language);
  if (!source.trim() || source.length > limit) return false;
  const full = compileKey(mode, source);
  return session.has(full) || remembered().some(entry => compileKey(entry.language, entry.source) === full);
}
export function approveScript(language, text) {
  const source = typeof text === 'string' ? text : '';
  const { mode, limit, description } = limitsFor(language);
  if (!source.trim() || source.length > limit) throw new Error(`Approvals require ${description}`);
  const full = compileKey(mode, source);
  remember(full);
  const entries = read().filter(entry => compileKey(entry.language, entry.source) !== full);
  entries.push({ language: mode, source });
  write(entries);
  return scriptHash(mode, source);
}
export function revokeScript(language, text) {
  const source = typeof text === 'string' ? text : '';
  const full = compileKey(scriptLanguageOf(language), source);
  session.delete(full);
  write(read().filter(entry => compileKey(entry.language, entry.source) !== full));
}
export function clearApprovals() { session.clear(); rawCache = null; listCache = []; write([]); }

// Legacy expression-language aliases: same store, expression mode.
export const isExpressionApproved = text => isScriptApproved('expression', text);
export const approveExpression = text => approveScript('expression', text);
export const revokeExpression = text => revokeScript('expression', text);
