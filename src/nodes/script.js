// Restricted, stateless expression language for Script nodes.
//
// This is deliberately NOT the custom-script compiler: that one hands the file
// text to `new Function` and is explicitly not a sandbox. Here the source is
// parsed with Acorn, every AST node must pass an allowlist, and evaluation is
// performed by this file's own interpreter — no eval, no Function, no property
// access, no assignment, no statements, no loops, no imports, no globals.
import { parse } from 'acorn';

export const MAX_EXPRESSION = 256;
export const MAX_NODES = 64;
export const MAX_DEPTH = 12;
export const MAX_ARGS = 3;
export const SCRIPT_CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E, tau: Math.PI * 2 });
export const SCRIPT_FUNCTIONS = Object.freeze({
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sqrt: Math.sqrt, pow: Math.pow, exp: Math.exp, log: Math.log, sign: Math.sign, hypot: Math.hypot,
  clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
  lerp: (a, b, t) => a + (b - a) * t,
});
// Available in every expression (inputs x/y are the node's own ports).
export const SCRIPT_VARIABLES = Object.freeze(['x', 'y', 'time']);
export const SCRIPT_HELP = 'Restricted expression: numbers, x, y, time, pi, e, + − × ÷ %, parentheses and the listed math functions.';
const ALLOWED_BINARY = ['+', '-', '*', '/', '%'];
const ALLOWED_UNARY = ['-', '+'];

function validateAst(ast) {
  const body = ast.body;
  if (body.length !== 1 || body[0].type !== 'ExpressionStatement') throw new Error('Only a single expression is allowed (no statements, variables, assignments or loops)');
  const uses = { x: false, y: false, time: false };
  let count = 0;
  const walk = (node, depth) => {
    if (!node || typeof node.type !== 'string') throw new Error('Unsupported expression');
    if (++count > MAX_NODES) throw new Error(`Expression is too complex (max ${MAX_NODES} operations)`);
    if (depth > MAX_DEPTH) throw new Error(`Expression nesting is too deep (max ${MAX_DEPTH})`);
    switch (node.type) {
      case 'BinaryExpression':
        if (!ALLOWED_BINARY.includes(node.operator)) throw new Error(`Operator "${node.operator}" is not allowed`);
        walk(node.left, depth + 1); walk(node.right, depth + 1); return;
      case 'UnaryExpression':
        if (!ALLOWED_UNARY.includes(node.operator)) throw new Error(`Unary operator "${node.operator}" is not allowed`);
        walk(node.argument, depth + 1); return;
      case 'Literal':
        if (typeof node.value !== 'number' || !Number.isFinite(node.value)) throw new Error('Only finite numeric literals are allowed');
        return;
      case 'Identifier':
        if (Object.hasOwn(uses, node.name)) { uses[node.name] = true; return; }
        if (Object.hasOwn(SCRIPT_CONSTANTS, node.name)) return;
        throw new Error(`Unknown name "${node.name}"; use x, y, time, pi, e or the listed math functions`);
      case 'CallExpression':
        if (node.callee.type !== 'Identifier' || !Object.hasOwn(SCRIPT_FUNCTIONS, node.callee.name)) throw new Error('Only the listed math functions can be called');
        if (node.arguments.length > MAX_ARGS) throw new Error(`Functions take at most ${MAX_ARGS} arguments`);
        for (const arg of node.arguments) {
          if (arg.type === 'SpreadElement') throw new Error('Spread arguments are not allowed');
          walk(arg, depth + 1);
        }
        return;
      case 'MemberExpression':
      case 'OptionalMemberExpression':
      case 'ChainExpression':
        throw new Error('Property access is not allowed');
      case 'AssignmentExpression':
      case 'UpdateExpression':
        throw new Error('Assignments are not allowed');
      default:
        throw new Error(`"${node.type}" is not allowed; ${SCRIPT_HELP}`);
    }
  };
  walk(body[0].expression, 1);
  return uses;
}
// Pure function of the source text; the small cache only avoids re-parsing the
// same expression every frame. It never caches across different sources.
const compiled = new Map();
export function compileExpression(text) {
  const source = typeof text === 'string' ? text : '';
  const key = source.length > MAX_EXPRESSION ? source.slice(0, MAX_EXPRESSION + 1) : source;
  if (compiled.has(key)) return compiled.get(key);
  let result;
  try {
    const trimmed = source.trim();
    if (!trimmed) result = { ok: false, error: 'Expression is empty' };
    else if (source.length > MAX_EXPRESSION) result = { ok: false, error: `Expression exceeds ${MAX_EXPRESSION} characters` };
    else {
      let ast;
      try { ast = parse(trimmed, { ecmaVersion: 'latest', sourceType: 'script' }); }
      catch (error) { throw new Error(`Syntax error: ${error.message}`); }
      result = { ok: true, ast: ast.body[0].expression, uses: validateAst(ast) };
    }
  } catch (error) { result = { ok: false, error: error.message }; }
  if (compiled.size >= 64) compiled.clear();
  compiled.set(key, result);
  return result;
}
export const validateExpression = compileExpression;
// Interpreter. Only node kinds accepted by validateAst are handled; anything
// else throws instead of silently falling through. Recoverable arithmetic
// issues (division/modulo by zero) are pushed to `issues` and still return the
// documented 0 fallback, so callers can surface a diagnostic.
export function evaluateExpression(ast, vars = {}, issues = []) {
  const run = (node, depth) => {
    if (depth > MAX_DEPTH + 2) throw new Error('Expression is too deep to evaluate');
    switch (node.type) {
      case 'Literal': return node.value;
      case 'Identifier': {
        const name = node.name;
        if (Object.hasOwn(vars, name)) {
          const value = vars[name];
          if (!Number.isFinite(value)) throw new Error(`${name} is not a finite number`);
          return value;
        }
        if (Object.hasOwn(SCRIPT_CONSTANTS, name)) return SCRIPT_CONSTANTS[name];
        throw new Error(`Unknown name "${name}"`);
      }
      case 'UnaryExpression': {
        const value = run(node.argument, depth + 1);
        return node.operator === '-' ? -value : value;
      }
      case 'BinaryExpression': {
        const a = run(node.left, depth + 1), b = run(node.right, depth + 1);
        if (node.operator === '+') return a + b;
        if (node.operator === '-') return a - b;
        if (node.operator === '*') return a * b;
        // Division/modulo by zero is a recoverable safe fallback, never NaN,
        // and it is reported so a nested expression cannot hide it.
        if (node.operator === '/') { if (b === 0) { issues.push('division by zero → 0'); return 0; } return a / b; }
        if (node.operator === '%') { if (b === 0) { issues.push('modulo by zero → 0'); return 0; } return a % b; }
        throw new Error(`Operator "${node.operator}" cannot be evaluated`);
      }
      case 'CallExpression': {
        const args = node.arguments.map(arg => run(arg, depth + 1));
        return SCRIPT_FUNCTIONS[node.callee.name](...args);
      }
      default: throw new Error(`"${node.type}" cannot be evaluated`);
    }
  };
  const value = run(ast, 1);
  if (!Number.isFinite(value)) throw new Error('Expression produced a non-finite result');
  return value;
}
