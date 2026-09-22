// Scalar (signal) node semantics: Math arithmetic and both Script languages
// (legacy restricted expression and the body language). All of them are total
// functions with safe fallbacks — they return finite numbers and report a
// message instead of producing NaN/Infinity.
import { MATH_OPS, MATH_LITERALS, SCRIPT_LITERALS, SCRIPT_LITERAL_FIELDS, DEFAULT_EXPRESSION, DEFAULT_BODY, mathPorts } from './definitions.js';
import { compileScript, evaluateScript, scriptLanguageOf as languageOf } from './script.js';

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
// The node's language: only an explicit 'body' opts in; a graph saved before the
// body language existed is an expression.
export const scriptLanguageOf = node => languageOf(node?.language);
// Unwired/empty sources fall back to the language's default, so a repaired node
// keeps producing a defined value.
export function scriptSource(node) {
  const fallback = scriptLanguageOf(node) === 'body' ? DEFAULT_BODY : DEFAULT_EXPRESSION;
  return typeof node?.source === 'string' && node.source.trim() ? node.source : fallback;
}
// Compilation is retained per language + exact source. A runtime keeps one cache
// for its whole life and one retained program per node id, so an eviction can
// never force a recompilation inside a frame: the cache is bounded by the number
// of distinct sources in the graph (which the 200 KB file size already caps).
export function scriptProgram(node, cache = new Map()) {
  const language = scriptLanguageOf(node);
  const source = scriptSource(node);
  const key = `${language}\u0000${source}`;
  let compiled = cache.get(key);
  if (!compiled) { compiled = compileScript(source, language); cache.set(key, compiled); }
  return { language, source, compiled };
}
export function scriptValue(node, { time = 0, readInput = null, program = null } = {}, cache = new Map()) {
  const entry = program || scriptProgram(node, cache);
  const { language, compiled } = entry;
  if (!compiled.ok) return { value: 0, error: `Script: ${compiled.error}`, uses: null, language };
  const vars = { ...scriptInputs(node, readInput), time: finiteOr(time) };
  const issues = [];
  try {
    const value = evaluateScript(compiled, vars, issues);
    if (!Number.isFinite(value)) return { value: 0, error: 'Script: result is not a finite number → 0.', uses: compiled.uses, language };
    // The whole node output falls back to 0 whenever arithmetic failed, so a
    // nested zero divisor can never leak a partial result downstream.
    if (issues.length) return { value: 0, error: `Script: ${[...new Set(issues)].join(', ')}.`, uses: compiled.uses, language };
    return { value, error: null, uses: compiled.uses, language };
  } catch (error) {
    return { value: 0, error: `Script: ${error.message} → 0.`, uses: compiled.uses, language };
  }
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
