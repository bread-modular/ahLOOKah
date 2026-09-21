// The Script node's *body* language: a restricted JavaScript function body.
//
// The source is parsed with Acorn, every AST node must pass an allowlist, and the
// accepted program is compiled ONCE into a flat array of [op, a, b] instructions
// that this file interprets. Nothing here ever calls eval/Function, reads a
// property, touches a global, or compiles while a frame is being evaluated: the
// per-frame path only runs the already-compiled instructions.
//
// Supported (v1):
//   let/const <name> = <expression>;        (initializer required, one per statement)
//   <expression>;                           (the value is discarded)
//   { ... }                                 (lexical block scope)
//   if (<expression>) <statement> [else <statement>]
//   return <expression>;
//   numbers, x, y, time (read-only inputs), pi, e, tau, the listed math
//   functions, + − × ÷ %, unary − + !, comparisons == != === !== < <= > >=,
//   && || (short circuit, operand-valued like JavaScript), the ternary ?:,
//   parens, assignment (its value is the assigned value) and compound assignment.
// Rejected: loops, functions/arrows/classes, objects/arrays, property access,
// `new`, `this`, template literals, await/yield, imports, `var`, destructuring,
// spread, update expressions (++/--), comma sequences, `with`, `debugger` and
// every global (window, document, process, eval, Function, globalThis …).
//
// Scope is lexical, like JavaScript: a let/const belongs to the block it is
// declared in (an inner block may shadow an outer name, but one block cannot
// declare the same name twice), the whole block's declarations are registered
// before it is compiled, and reading or assigning a binding before its own
// declaration fails — `let a = a + 1;`, `return a; let a = 1;` and
// `let a = 1; { let a = a + 1; }` are all errors, as in JavaScript's temporal
// dead zone. Inputs, constants and function names are reserved. Locals are
// created fresh (and zero-filled) per evaluation, so a body is a pure function
// of x, y and time.
import { parse } from 'acorn';
import {
  MAX_ARGS, MAX_BODY, MAX_BODY_BLOCK_DEPTH, MAX_BODY_DEPTH, MAX_BODY_INSTRUCTIONS, MAX_BODY_LOCALS, MAX_BODY_NODES,
  MAX_BODY_STATEMENTS, MAX_BODY_STEPS, SCRIPT_BODY_HELP, SCRIPT_CONSTANTS, SCRIPT_FUNCTION_LIST, SCRIPT_FUNCTION_NAMES, SCRIPT_INPUT_NAMES,
  isScriptConstant, isScriptFunction, scriptCompileStats, scriptFunctionIndex,
} from './script-core.js';

export const OP = Object.freeze({
  PUSH_CONST: 0, PUSH_INPUT: 1, PUSH_LOCAL: 2, STORE_LOCAL: 3, POP: 4,
  ADD: 5, SUB: 6, MUL: 7, DIV: 8, MOD: 9, NEG: 10, NOT: 11,
  LT: 12, LE: 13, GT: 14, GE: 15, EQ: 16, NEQ: 17, SEQ: 18, SNEQ: 19,
  JUMP: 20, JUMP_FALSE: 21, JUMP_TRUE: 22,
  // Short-circuit operators. Both peek at the left operand: a falsy `a && b`
  // keeps it as the result, a truthy `a || b` keeps it, and otherwise the left
  // value is popped so the right operand becomes the single stack value. That
  // keeps operand semantics (`x || 0.5`) with a balanced stack.
  AND_KEEP: 23, OR_KEEP: 24,
  CALL: 25, RETURN: 26,
});
const BINARY = { '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV, '%': OP.MOD };
const COMPARE = { '<': OP.LT, '<=': OP.LE, '>': OP.GT, '>=': OP.GE, '==': OP.EQ, '!=': OP.NEQ, '===': OP.SEQ, '!==': OP.SNEQ };
// `=` is the plain assignment (null marker) and every other key is a compound
// operator, so an unknown operator is rejected rather than guessed.
const ASSIGN = { '=': null, '+=': OP.ADD, '-=': OP.SUB, '*=': OP.MUL, '/=': OP.DIV, '%=': OP.MOD };
// Inputs, constants and function names can never be shadowed by a local.
const RESERVED = new Set([...SCRIPT_INPUT_NAMES, ...Object.keys(SCRIPT_CONSTANTS), ...SCRIPT_FUNCTION_NAMES]);

const truthy = value => value !== 0 && value === value;

// Structural scan. It runs before compilation so a disallowed statement — even
// inside a branch that never executes — is reported as a statement error, counts
// every statement against the budget, bounds block nesting, and reports whether
// any return statement exists at all.
function scanStatement(node, depth, fail, stats) {
  if (!node || typeof node.type !== 'string') fail('Unsupported statement');
  switch (node.type) {
    case 'BlockStatement':
      // `depth` is the nesting of the block being entered, so the documented
      // limit is exact: 12 nested blocks are accepted, the 13th is rejected.
      if (depth >= MAX_BODY_BLOCK_DEPTH) fail(`Body blocks nest too deep (max ${MAX_BODY_BLOCK_DEPTH})`);
      for (const child of node.body) scanStatement(child, depth + 1, fail, stats);
      return;
    case 'IfStatement':
      stats.count++;
      scanStatement(node.consequent, depth, fail, stats);
      if (node.alternate) scanStatement(node.alternate, depth, fail, stats);
      return;
    case 'ExpressionStatement': case 'VariableDeclaration': case 'ReturnStatement': case 'EmptyStatement':
      stats.count++;
      if (node.type === 'ReturnStatement') stats.hasReturn = true;
      return;
    default:
      fail(`"${node.type}" is not allowed; ${SCRIPT_BODY_HELP}`);
  }
}
// Total syntax-node budget for the whole program. An explicit stack keeps the
// walk itself shallow however wide or deep the parsed AST is, and the count stops
// at the first node over the limit.
function countAstNodes(root, limit) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (const child of node) stack.push(child); continue; }
    if (typeof node.type !== 'string') continue;
    if (++count > limit) return count;
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const value = node[key];
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return count;
}
// Direct let/const declarations of one block, in order. Nested blocks are not
// scanned here: they register their own bindings when they are compiled.
function directDeclarations(statements) {
  const declarations = [];
  for (const statement of statements) {
    if (statement.type !== 'VariableDeclaration') continue;
    if (statement.kind !== 'let' && statement.kind !== 'const') continue;
    for (const declarator of statement.declarations) {
      if (declarator.id.type === 'Identifier') declarations.push([declarator.id.name, statement.kind === 'const']);
    }
  }
  return declarations;
}

class BodyCompiler {
  constructor(source) {
    this.source = source;
    this.ops = [];
    this.constants = [];
    this.uses = { x: false, y: false, time: false };
    this.scopes = [new Map()];
    this.slots = 0;
  }
  fail(message) { throw new Error(message); }
  emit(op, a = 0, b = 0) {
    if (this.ops.length >= MAX_BODY_INSTRUCTIONS) this.fail(`Body is too complex (max ${MAX_BODY_INSTRUCTIONS} instructions)`);
    this.ops.push([op, a, b]);
    return this.ops.length - 1;
  }
  // Jump targets are patched once the branch's code has been emitted.
  patch(index) { this.ops[index][1] = this.ops.length; }
  constant(value) { this.constants.push(value); return this.constants.length - 1; }
  pushScope() { this.scopes.push(new Map()); }
  popScope() { this.scopes.pop(); }
  currentScope() { return this.scopes[this.scopes.length - 1]; }
  // Register every name this block will declare before compiling its statements,
  // so a read before the declaration is an error instead of silently reaching an
  // outer (or stale) binding.
  reserve(name, constant, scope = this.currentScope()) {
    if (RESERVED.has(name)) this.fail(`"${name}" is reserved; choose another local name`);
    if (scope.has(name)) this.fail(`"${name}" is already declared in this block`);
    if (this.slots >= MAX_BODY_LOCALS) this.fail(`Body uses too many locals (max ${MAX_BODY_LOCALS})`);
    const binding = { name, slot: this.slots++, constant, initialized: false };
    scope.set(name, binding);
    return binding;
  }
  predeclare(statements) {
    for (const [name, constant] of directDeclarations(statements)) this.reserve(name, constant);
  }
  resolve(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const binding = this.scopes[i].get(name);
      if (binding) return binding;
    }
    return null;
  }
  assigned(name) {
    // Assignments can also target an outer block's binding, so the temporal-dead
    // zone is checked where the binding is actually resolved.
    const binding = this.resolve(name);
    if (!binding) this.fail(`Unknown name "${name}"; declare it with let/const first`);
    if (!binding.initialized) this.fail(`Cannot assign to "${name}" before its declaration`);
    if (binding.constant) this.fail(`Cannot assign to const "${name}"; declare it with let`);
    return binding;
  }
  assignmentTarget(target) {
    if (target.type !== 'Identifier') this.fail('Only a declared local can be assigned');
    if (SCRIPT_INPUT_NAMES.includes(target.name)) this.fail(`"${target.name}" is a read-only input`);
    return this.assigned(target.name);
  }
  expression(node, depth = 1) {
    if (!node || typeof node.type !== 'string') this.fail('Unsupported expression');
    if (depth > MAX_BODY_DEPTH) this.fail(`Expression nesting is too deep (max ${MAX_BODY_DEPTH})`);
    switch (node.type) {
      case 'Literal':
        if (typeof node.value !== 'number' || !Number.isFinite(node.value)) this.fail('Only finite numeric literals are allowed');
        this.emit(OP.PUSH_CONST, this.constant(node.value));
        return;
      case 'Identifier': {
        const name = node.name;
        const input = SCRIPT_INPUT_NAMES.indexOf(name);
        if (input >= 0) { this.uses[name] = true; this.emit(OP.PUSH_INPUT, input); return; }
        if (isScriptConstant(name)) { this.emit(OP.PUSH_CONST, this.constant(SCRIPT_CONSTANTS[name])); return; }
        const binding = this.resolve(name);
        if (binding) {
          if (!binding.initialized) this.fail(`Cannot read "${name}" before its declaration`);
          this.emit(OP.PUSH_LOCAL, binding.slot);
          return;
        }
        this.fail(`Unknown name "${name}"; use x, y, time, pi, e, a declared local or the listed math functions`);
        return;
      }
      case 'UnaryExpression':
        if (node.operator === '-') { this.expression(node.argument, depth + 1); this.emit(OP.NEG); return; }
        if (node.operator === '+') { this.expression(node.argument, depth + 1); return; }
        if (node.operator === '!') { this.expression(node.argument, depth + 1); this.emit(OP.NOT); return; }
        this.fail(`Unary operator "${node.operator}" is not allowed`);
        return;
      case 'BinaryExpression': {
        const arithmetic = BINARY[node.operator];
        const compare = COMPARE[node.operator];
        if (!arithmetic && !compare) this.fail(`Operator "${node.operator}" is not allowed`);
        // The left operand continues the current chain (`a + b + c` stays flat)
        // while the right operand nests, so the limit measures real operand
        // nesting instead of punishing left-associative sums.
        this.expression(node.left, depth);
        this.expression(node.right, depth + 1);
        this.emit(arithmetic || compare);
        return;
      }
      case 'LogicalExpression': {
        if (node.operator !== '&&' && node.operator !== '||') this.fail(`Operator "${node.operator}" is not allowed`);
        this.expression(node.left, depth);
        // Short circuit: the left operand is the result when it decides the
        // outcome (`x > 0 || 1 / 0 > 0` never evaluates the division), otherwise
        // it is dropped and the right operand is evaluated. Either way exactly
        // one value is left on the stack.
        const jump = this.emit(node.operator === '&&' ? OP.AND_KEEP : OP.OR_KEEP);
        this.expression(node.right, depth + 1);
        this.patch(jump);
        return;
      }
      case 'ConditionalExpression': {
        this.expression(node.test, depth + 1);
        const otherwise = this.emit(OP.JUMP_FALSE);
        this.expression(node.consequent, depth + 1);
        const end = this.emit(OP.JUMP);
        this.patch(otherwise);
        this.expression(node.alternate, depth + 1);
        this.patch(end);
        return;
      }
      case 'AssignmentExpression': {
        if (!Object.hasOwn(ASSIGN, node.operator)) this.fail(`Assignment operator "${node.operator}" is not allowed`);
        const binding = this.assignmentTarget(node.left);
        const compound = ASSIGN[node.operator];
        if (compound === null) this.expression(node.right, depth + 1);
        else { this.emit(OP.PUSH_LOCAL, binding.slot); this.expression(node.right, depth + 1); this.emit(compound); }
        // STORE_LOCAL leaves the stored value in place: an assignment expression
        // evaluates to that value, exactly like JavaScript.
        this.emit(OP.STORE_LOCAL, binding.slot);
        return;
      }
      case 'CallExpression':
        if (node.callee.type !== 'Identifier' || !isScriptFunction(node.callee.name)) this.fail('Only the listed math functions can be called');
        if (node.arguments.length > MAX_ARGS) this.fail(`Functions take at most ${MAX_ARGS} arguments`);
        for (const argument of node.arguments) {
          if (argument.type === 'SpreadElement') this.fail('Spread arguments are not allowed');
          this.expression(argument, depth + 1);
        }
        this.emit(OP.CALL, scriptFunctionIndex(node.callee.name), node.arguments.length);
        return;
      case 'ParenthesizedExpression': this.expression(node.expression, depth + 1); return;
      case 'MemberExpression': case 'OptionalMemberExpression': case 'ChainExpression':
        this.fail('Property access is not allowed');
        return;
      case 'AssignmentPattern': case 'ArrayPattern': case 'ObjectPattern':
        this.fail('Destructuring is not allowed');
        return;
      case 'UpdateExpression':
        this.fail(`Update expression "${node.operator}" is not allowed; assign the new value instead`);
        return;
      case 'SequenceExpression':
        this.fail('The comma operator is not allowed');
        return;
      case 'ArrayExpression': case 'ObjectExpression':
        this.fail('Arrays and objects are not allowed');
        return;
      case 'NewExpression': this.fail('"new" is not allowed'); return;
      case 'ThisExpression': this.fail('"this" is not allowed'); return;
      case 'FunctionExpression': case 'ArrowFunctionExpression': this.fail('Functions are not allowed'); return;
      case 'ClassExpression': this.fail('Classes are not allowed'); return;
      case 'TemplateLiteral': case 'TaggedTemplateExpression': this.fail('Template literals are not allowed'); return;
      case 'AwaitExpression': case 'YieldExpression': this.fail('await/yield are not allowed'); return;
      case 'ImportExpression': this.fail('Imports are not allowed'); return;
      case 'SpreadElement': this.fail('Spread arguments are not allowed'); return;
      default: this.fail(`"${node.type}" is not allowed; ${SCRIPT_BODY_HELP}`);
    }
  }
  statement(node) {
    switch (node.type) {
      case 'ExpressionStatement': this.expression(node.expression); this.emit(OP.POP); return;
      case 'VariableDeclaration': {
        if (node.kind !== 'let' && node.kind !== 'const') this.fail('Use let or const to declare a local');
        if (node.declarations.length !== 1) this.fail('Declare one variable per let/const');
        const [declarator] = node.declarations;
        if (declarator.id.type !== 'Identifier') this.fail('Destructuring is not allowed');
        if (!declarator.init) this.fail(`"${declarator.id.name}" must be initialized, e.g. let ${declarator.id.name} = 0;`);
        const name = declarator.id.name;
        // The initializer is compiled while the binding is still uninitialized,
        // so `let a = a + 1;` fails like JavaScript's temporal dead zone instead
        // of silently reading an outer or zero-filled slot.
        this.expression(declarator.init);
        const binding = this.currentScope().get(name) || this.reserve(name, node.kind === 'const');
        binding.initialized = true;
        // A declaration statement discards the value; only the expression form
        // (`a = 2`) keeps it.
        this.emit(OP.STORE_LOCAL, binding.slot);
        this.emit(OP.POP);
        return;
      }
      case 'BlockStatement': {
        this.pushScope();
        this.predeclare(node.body);
        for (const child of node.body) this.statement(child);
        this.popScope();
        return;
      }
      case 'IfStatement': {
        this.expression(node.test);
        const otherwise = this.emit(OP.JUMP_FALSE);
        this.statement(node.consequent);
        if (node.alternate) {
          const end = this.emit(OP.JUMP);
          this.patch(otherwise);
          this.statement(node.alternate);
          this.patch(end);
        } else this.patch(otherwise);
        return;
      }
      case 'ReturnStatement':
        if (!node.argument) this.fail('`return` needs a value, e.g. return x;');
        this.expression(node.argument);
        this.emit(OP.RETURN);
        return;
      case 'EmptyStatement': return;
      default: this.fail(`"${node.type}" is not allowed; ${SCRIPT_BODY_HELP}`);
    }
  }
}

// Pure function of the source text. Returns the compiled program (bounded
// instruction array) or a message; never throws and never evaluates.
export function compileBody(text) {
  const source = typeof text === 'string' ? text : '';
  try {
    // The source is bounded before Acorn ever sees it.
    if (!source.trim()) return fail('Body is empty');
    if (source.length > MAX_BODY) return fail(`Body exceeds ${MAX_BODY} characters`);
    let ast;
    try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
    catch (error) { return fail(`Syntax error: ${error.message}`); }
    if (ast.type !== 'Program') return fail('Body must be a program');
    if (countAstNodes(ast, MAX_BODY_NODES) > MAX_BODY_NODES) return fail(`Body has too many syntax nodes (max ${MAX_BODY_NODES})`);
    const compiler = new BodyCompiler(source);
    const stats = { count: 0, hasReturn: false };
    for (const statement of ast.body) scanStatement(statement, 0, message => compiler.fail(message), stats);
    if (stats.count > MAX_BODY_STATEMENTS) return fail(`Body is too long (max ${MAX_BODY_STATEMENTS} statements)`);
    if (!stats.hasReturn) return fail('Body must return a value, e.g. `return x;`');
    compiler.predeclare(ast.body);
    for (const statement of ast.body) compiler.statement(statement);
    return {
      ok: true, language: 'body', uses: compiler.uses,
      program: {
        ops: compiler.ops, constants: compiler.constants, locals: compiler.slots,
        instructions: compiler.ops.length, uses: compiler.uses,
      },
    };
  } catch (error) { return fail(error.message); }
  function fail(message) { return { ok: false, language: 'body', error: message }; }
}

// The interpreter. Every instruction runs at most once because v1 has no loops
// and every jump is forward; the step budget is a defensive bound. Values are
// plain doubles (comparisons and `!` yield 1/0, never booleans, while `&&`/`||`
// yield one of their operands) and the locals array is created fresh per
// evaluation, so a body is a pure function of its inputs and `time`.
export function evaluateBody(program, vars = {}, issues = []) {
  const { ops, constants, locals } = program;
  const inputs = [vars.x, vars.y, vars.time];
  for (let i = 0; i < SCRIPT_INPUT_NAMES.length; i++) {
    if (program.uses[SCRIPT_INPUT_NAMES[i]] && !Number.isFinite(inputs[i])) throw new Error(`${SCRIPT_INPUT_NAMES[i]} is not a finite number`);
  }
  const slots = new Float64Array(locals);
  const stack = [];
  scriptCompileStats.evaluations++;
  let ip = 0, steps = 0, returned = false, result = 0;
  while (ip < ops.length) {
    if (++steps > MAX_BODY_STEPS) throw new Error('Body exceeded its step budget');
    const [op, a, b] = ops[ip];
    switch (op) {
      case OP.PUSH_CONST: stack.push(constants[a]); ip++; break;
      case OP.PUSH_INPUT: stack.push(inputs[a]); ip++; break;
      case OP.PUSH_LOCAL: stack.push(slots[a]); ip++; break;
      // Peek, not pop: the value stays for an assignment expression to use.
      case OP.STORE_LOCAL: slots[a] = stack[stack.length - 1]; ip++; break;
      case OP.POP: stack.pop(); ip++; break;
      case OP.ADD: { const value = stack.pop(); stack[stack.length - 1] += value; ip++; break; }
      case OP.SUB: { const value = stack.pop(); stack[stack.length - 1] -= value; ip++; break; }
      case OP.MUL: { const value = stack.pop(); stack[stack.length - 1] *= value; ip++; break; }
      case OP.DIV: {
        const divisor = stack.pop(), value = stack.pop();
        if (divisor === 0) { issues.push('division by zero → 0'); stack.push(0); } else stack.push(value / divisor);
        ip++; break;
      }
      case OP.MOD: {
        const divisor = stack.pop(), value = stack.pop();
        if (divisor === 0) { issues.push('modulo by zero → 0'); stack.push(0); } else stack.push(value % divisor);
        ip++; break;
      }
      case OP.NEG: stack[stack.length - 1] = -stack[stack.length - 1]; ip++; break;
      case OP.NOT: stack[stack.length - 1] = truthy(stack[stack.length - 1]) ? 0 : 1; ip++; break;
      case OP.LT: { const right = stack.pop(), left = stack.pop(); stack.push(left < right ? 1 : 0); ip++; break; }
      case OP.LE: { const right = stack.pop(), left = stack.pop(); stack.push(left <= right ? 1 : 0); ip++; break; }
      case OP.GT: { const right = stack.pop(), left = stack.pop(); stack.push(left > right ? 1 : 0); ip++; break; }
      case OP.GE: { const right = stack.pop(), left = stack.pop(); stack.push(left >= right ? 1 : 0); ip++; break; }
      case OP.EQ: { const right = stack.pop(), left = stack.pop(); stack.push(left == right ? 1 : 0); ip++; break; }
      case OP.NEQ: { const right = stack.pop(), left = stack.pop(); stack.push(left != right ? 1 : 0); ip++; break; }
      case OP.SEQ: { const right = stack.pop(), left = stack.pop(); stack.push(left === right ? 1 : 0); ip++; break; }
      case OP.SNEQ: { const right = stack.pop(), left = stack.pop(); stack.push(left !== right ? 1 : 0); ip++; break; }
      case OP.JUMP: ip = a; break;
      case OP.JUMP_FALSE: { const condition = stack.pop(); ip = truthy(condition) ? ip + 1 : a; break; }
      case OP.JUMP_TRUE: { const condition = stack.pop(); ip = truthy(condition) ? a : ip + 1; break; }
      case OP.AND_KEEP:
        if (truthy(stack[stack.length - 1])) { stack.pop(); ip++; } else ip = a;
        break;
      case OP.OR_KEEP:
        if (truthy(stack[stack.length - 1])) ip = a; else { stack.pop(); ip++; }
        break;
      case OP.CALL: {
        const args = stack.splice(stack.length - b, b);
        stack.push(SCRIPT_FUNCTION_LIST[a](...args));
        ip++; break;
      }
      case OP.RETURN: result = stack.pop(); returned = true; ip = ops.length; break;
      default: throw new Error(`Unknown script instruction ${op}`);
    }
  }
  if (!returned) throw new Error('Body finished without returning a value');
  // The same contract as the expression language: a body is total, so a
  // non-finite result is an error instead of leaking NaN/Infinity downstream.
  if (!Number.isFinite(result)) throw new Error('Body returned a non-finite number');
  return result;
}
