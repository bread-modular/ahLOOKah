// Scalar (signal) node semantics: Math arithmetic and restricted Script
// evaluation. Both are total functions with safe fallbacks — they return finite
// numbers and report a message instead of producing NaN/Infinity.
import { MATH_OPS, MATH_LITERALS, SCRIPT_LITERALS, SCRIPT_LITERAL_FIELDS, DEFAULT_EXPRESSION, mathPorts } from './definitions.js';
import { compileExpression, evaluateExpression } from './script.js';

export const finiteOr = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
export const mathOperation = (node) => MATH_OPS.includes(node?.op) ? node.op : 'add';
const literal = (node, port) => Number.isFinite(node?.[port]) ? node[port] : finiteOr(MATH_LITERALS[port], 0);
// A disconnected input falls back to the node's own literal (signed floats are
// preserved; nothing is normalized here — only terminal mappings normalize).
// Ports the selected operation does not consume are never read: an inactive
// input is not a runtime dependency, so it cannot be traversed or reported.
export function mathInputs(node, readInput = null) {
  const active = mathPorts(node?.op);
  const read = port => {
    if (!active.includes(port)) return literal(node, port);
    const wired = readInput ? readInput(port) : null;
    return Number.isFinite(wired) ? wired : literal(node, port);
  };
  return { a: read('a'), b: read('b'), c: read('c') };
}
export function mathValue(node, readInput = null) {
  const { a, b, c } = mathInputs(node, readInput);
  switch (mathOperation(node)) {
    case 'add': return a + b;
    case 'subtract': return a - b;
    case 'multiply': return a * b;
    case 'divide': return b === 0 ? 0 : a / b;
    case 'min': return Math.min(a, b);
    case 'max': return Math.max(a, b);
    case 'clamp': return Math.min(Math.max(a, Math.min(b, c)), Math.max(b, c));
    case 'abs': return Math.abs(a);
    default: return 0;
  }
}
export function mathIssue(node, readInput = null) {
  const { b } = mathInputs(node, readInput);
  if (mathOperation(node) === 'divide' && b === 0) return 'Math: division by zero → 0.';
  return null;
}
export function scriptSource(node) {
  return typeof node?.source === 'string' && node.source.trim() ? node.source : DEFAULT_EXPRESSION;
}
export function scriptInputs(node, readInput = null) {
  const read = port => {
    const wired = readInput ? readInput(port) : null;
    if (Number.isFinite(wired)) return wired;
    const field = SCRIPT_LITERAL_FIELDS[port];
    return Number.isFinite(node?.[field]) ? node[field] : finiteOr(SCRIPT_LITERALS[field], 0);
  };
  return { x: read('x'), y: read('y') };
}
// Compilation is cached per runtime and keyed by the exact source text, so an
// edited expression is re-validated and can never reuse a stale approval path.
export function scriptValue(node, { time = 0, readInput = null } = {}, cache = new Map()) {
  const source = scriptSource(node);
  let compiled = cache.get(source);
  if (!compiled) {
    compiled = compileExpression(source);
    if (!compiled.ok) return { value: 0, error: `Script: ${compiled.error}`, uses: null };
    if (cache.size >= 32) cache.clear();
    cache.set(source, compiled);
  }
  const vars = { ...scriptInputs(node, readInput), time: finiteOr(time) };
  const issues = [];
  try {
    const value = evaluateExpression(compiled.ast, vars, issues);
    if (!Number.isFinite(value)) return { value: 0, error: 'Script: result is not a finite number → 0.', uses: compiled.uses };
    // The whole node output falls back to 0 whenever arithmetic failed, so a
    // nested zero divisor can never leak a partial result downstream.
    if (issues.length) return { value: 0, error: `Script: ${[...new Set(issues)].join(', ')}.`, uses: compiled.uses };
    return { value, error: null, uses: compiled.uses };
  } catch (error) {
    return { value: 0, error: `Script: ${error.message} → 0.`, uses: compiled.uses };
  }
}
