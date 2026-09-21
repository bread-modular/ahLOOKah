// Review/approval for disk-loaded Script sources.
//
// Approval is bound to the EXACT source text (stored verbatim, bounded to the
// parser's 256-character limit) and lives in browser storage only, never inside
// the exported .nodes.json: an imported file cannot carry a trust flag with it,
// and editing a single character invalidates the previous approval. Comparison
// is exact — no hash, so two different sources can never share an approval.
const KEY = 'viz2_nodes_script_approvals';
const MAX_APPROVALS = 64;
const MAX_LENGTH = 256;
export const SCRIPT_APPROVAL_MESSAGE = 'Script not approved in this browser. Review the exact expression in the inspector, then Apply to run it.';

// Short display/debug identifier only; approval decisions never use it.
export function expressionHash(text) {
  const source = typeof text === 'string' ? text : '';
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return `${source.length}:${(hash >>> 0).toString(16)}`;
}
function read() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter(entry => typeof entry === 'string' && entry.length <= MAX_LENGTH).slice(-MAX_APPROVALS) : [];
  } catch { return []; }
}
function write(list) {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(list.slice(-MAX_APPROVALS))); } catch { /* Approvals fall back to this session only. */ }
}
// In-memory mirror so approval still works when storage is unavailable/disabled.
// Bounded exactly like the persisted copy.
const session = new Set();
const remember = source => {
  session.delete(source); session.add(source);
  while (session.size > MAX_APPROVALS) session.delete(session.values().next().value);
};
export function isExpressionApproved(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_LENGTH) return false;
  return session.has(text) || read().includes(text);
}
export function approveExpression(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source.trim() || source.length > MAX_LENGTH) throw new Error(`Approvals require an expression of 1–${MAX_LENGTH} characters`);
  remember(source);
  const list = read().filter(entry => entry !== source);
  list.push(source);
  write(list);
  return expressionHash(source);
}
export function revokeExpression(text) {
  session.delete(text);
  write(read().filter(entry => entry !== text));
}
export function clearApprovals() { session.clear(); write([]); }
