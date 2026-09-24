// Script-node languages. Two front ends share one approval/cache contract:
//
//   expression — the original restricted single expression, parsed with Acorn,
//                every AST node allowlisted and evaluated by this file's own
//                interpreter (no eval, no Function, no property access, no
//                assignment, no statements, no loops, no imports, no globals).
//   body       — a restricted JavaScript *function body* with `return`, parsed
//                and compiled once into bounded bytecode by script-body.js and
//                run by its instruction interpreter.
//
// Neither language is the custom-script compiler: that one hands the file text
// to `new Function` and is explicitly not a sandbox.
import { parse } from 'acorn';
import {
  MAX_ARGS, MAX_BODY, MAX_DEPTH, MAX_EXPRESSION, MAX_NODES, SCRIPT_CONSTANTS, SCRIPT_FUNCTIONS, SCRIPT_HELP, SCRIPT_STATE_NAME,
  compileKey, scriptCompileStats, scriptLanguageOf,
} from './script-core.js';
import { compileBody, evaluateBody } from './script-body.js';

export {
  LANGUAGES, MAX_ARGS, MAX_BODY, MAX_BODY_DEPTH, MAX_BODY_INSTRUCTIONS, MAX_BODY_LOCALS, MAX_BODY_STATEMENTS, MAX_BODY_STEPS,
  MAX_DEPTH, MAX_EXPRESSION, MAX_NODES, MAX_SOURCE, MAX_STATE_SLOTS, MAX_STATE_STEP, SCRIPT_BODY_HELP, SCRIPT_CONSTANTS,
  SCRIPT_FUNCTIONS, SCRIPT_HELP, SCRIPT_INPUT_NAMES, SCRIPT_STATE_HELP, SCRIPT_STATE_NAME, SCRIPT_VARIABLES, helpForLanguage,
  isScriptConstant, isScriptFunction, limitForLanguage, scriptCompileStats, scriptLanguageLabel, scriptLanguageOf,
} from './script-core.js';

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
        // Persistent state and the frame delta are body-language features: a
        // legacy expression stays a pure function of x, y and time.
        if (node.name === SCRIPT_STATE_NAME || node.name === 'dt') throw new Error(`"${node.name}" is available in the body language only`);
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
        if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && node.object.name === SCRIPT_STATE_NAME)
          throw new Error(`"${SCRIPT_STATE_NAME}" is available in the body language only`);
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

// The legacy expression front end. Pure function of the source text; the small
// cache only avoids re-parsing the same expression, and it never caches across
// different sources or languages.
function compileExpressionSource(source) {
  try {
    const trimmed = source.trim();
    if (!trimmed) return { ok: false, language: 'expression', error: 'Expression is empty' };
    if (source.length > MAX_EXPRESSION) return { ok: false, language: 'expression', error: `Expression exceeds ${MAX_EXPRESSION} characters` };
    let ast;
    try { ast = parse(trimmed, { ecmaVersion: 'latest', sourceType: 'script' }); }
    catch (error) { throw new Error(`Syntax error: ${error.message}`); }
    return { ok: true, language: 'expression', ast: ast.body[0].expression, uses: validateAst(ast) };
  } catch (error) { return { ok: false, language: 'expression', error: error.message }; }
}

// Language-aware compile entry point. The key is language + exact source, so an
// edited character or a switch between languages always re-validates. Callers
// that evaluate per frame (GraphRuntime) retain the returned object instead of
// recompiling, which is what keeps steady-state frames free of parsing.
const compiled = new Map();
const CACHE_LIMIT = 64;
export function compileScript(text, language = 'expression') {
  const mode = scriptLanguageOf(language);
  const source = typeof text === 'string' ? text : '';
  const limit = mode === 'body' ? MAX_BODY : MAX_EXPRESSION;
  const key = compileKey(mode, source.length > limit ? source.slice(0, limit + 1) : source);
  const cached = compiled.get(key);
  if (cached) { scriptCompileStats.hits++; return cached; }
  scriptCompileStats.parses++;
  const result = mode === 'body' ? compileBody(source) : compileExpressionSource(source);
  if (compiled.size >= CACHE_LIMIT) compiled.clear();
  compiled.set(key, result);
  return result;
}
export const validateScript = compileScript;
export const compileExpression = text => compileScript(text, 'expression');
export const validateExpression = compileExpression;

// Interpreter entry point for a compiled result of either language. `state` is
// the persistent store's Float64Array for a body program that declares state
// slots (the body language only); it is ignored by the expression language.
export function evaluateScript(result, vars = {}, issues = [], state = null) {
  if (result.language === 'body') return evaluateBody(result.program, vars, issues, state);
  return evaluateExpression(result.ast, vars, issues);
}

// Expression interpreter. Only node kinds accepted by validateAst are handled;
// anything else throws instead of silently falling through. Recoverable
// arithmetic issues (division/modulo by zero) are pushed to `issues` and still
// return the documented 0 fallback, so callers can surface a diagnostic.
export function evaluateExpression(ast, vars = {}, issues = []) {
  scriptCompileStats.evaluations++;
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
