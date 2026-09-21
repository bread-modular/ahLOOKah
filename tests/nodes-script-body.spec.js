import { test, expect } from '@playwright/test';

import { compileScript, evaluateScript, scriptCompileStats } from '../src/nodes/script.js';
import { scriptValue, scriptProgram, scriptLanguageOf, scriptSource } from '../src/nodes/scalar.js';
import { approveScript, isScriptApproved, clearApprovals } from '../src/nodes/script-approval.js';
import { validateGraph } from '../src/nodes/model.js';
import { serializeGraph, parseGraph, manifestFor, sourceDiagnostics } from '../src/nodes/portability.js';
import { defaultNode, DEFAULT_BODY, DEFAULT_LANGUAGE, COLOR_PARAMS } from '../src/nodes/definitions.js';

const program = source => {
  const compiled = compileScript(source, 'body');
  expect(compiled.ok, compiled.error).toBe(true);
  return compiled;
};
const evaluate = (compiled, vars = {}) => { const issues = []; return { value: evaluateScript(compiled, vars, issues), issues }; };
const expects = (compiled, value) => expect(evaluate(compiled, {}).value).toBe(value);
const rejects = (source, message) => {
  const compiled = compileScript(source, 'body');
  expect(compiled.ok, `expected rejection: ${source}`).toBe(false);
  if (message) expect(compiled.error, source).toMatch(message);
  return compiled;
};
const solid = (id, x, y) => ({ id, type: 'pattern', patternId: 'solid-color', params: { hue: 0, saturation: 1, brightness: 1, pulse: 0 }, x, y });
const bodyGraph = (overrides = {}) => {
  const shape = { id: 'shape', type: 'script', language: 'body', source: 'return x;', inputX: .5, inputY: 0, x: 440, y: 300, ...overrides };
  return { version: 1, name: 'Body chain', nodes: [
    solid('base', 40, 40), shape,
    { id: 'tint', type: 'color', params: { saturation: 1, brightness: 1, contrast: 1, hue: 0 }, x: 260, y: 40 },
    { id: 'output', type: 'output', x: 620, y: 40 },
  ], edges: [{ from: 'base', to: 'tint', port: 'image' }, { from: 'tint', to: 'output', port: 'image' }],
  modulations: [{ from: 'shape', to: 'tint', param: 'brightness', min: .2, max: .8 }] };
};
const legacyGraph = () => {
  const graph = bodyGraph();
  graph.name = 'Legacy chain';
  delete graph.nodes.find(n => n.id === 'shape').language;
  graph.nodes.find(n => n.id === 'shape').source = 'x / 2 + y * 0';
  return graph;
};
const sketches = [{ id: 'solid-color', name: 'Solid Color', params: [...COLOR_PARAMS, { key: 'pulse', label: 'Pulse', min: 0, max: 1, step: .01, default: 0 }] }];

test('the body language accepts the documented subset and rejects JavaScript outside it', () => {
  const ok = source => expect(compileScript(source, 'body').ok, source).toBe(true);
  for (const source of [
    'return x;',
    'const a = 1;\nreturn a + x;',
    'let a = 0;\nif (x > 0) { a = x * 2; } else { a = -1; }\nreturn a;',
    'let a = 1;\na += 2; a -= 1; a *= 2; a /= 2; a %= 3;\nreturn a;',
    'return x > 0 && y > 0 ? clamp(x, 0, 1) : pi;',
    'return !x;',
    '{ let a = 1; return a; }',
    'if (x > 0) return 1;\nreturn 0;',
    ';;\nreturn 1;',
    'return (x);',
    'return min(x, y) + max(0, time) % 2;',
    'const v = tan(time);\nreturn hypot(v, x) + atan2(y, x) + sign(-1) + floor(1.7) + ceil(1.2) + round(.5) + exp(0) + log(1) + pow(2, 3) + abs(-2) + sqrt(4) + cos(0) + sin(0) + asin(0) + acos(1) + lerp(0, 1, .5);',
  ]) ok(source);
  // loops, functions, objects, property access, imports and globals are rejected;
  // a statement after an early return is validated too, even though it is unreachable
  rejects('', /empty/i);
  rejects('let a = 1;', /must return/i);
  rejects('while (true) return 1;', /WhileStatement/);
  rejects('for (;;) return 1;', /ForStatement/);
  rejects('do { return 1; } while (false);', /DoWhileStatement/);
  rejects('switch (x) { case 1: return 1; }', /SwitchStatement/);
  rejects('try { return 1; } catch (e) { return 0; }', /TryStatement/);
  rejects('throw 1;', /ThrowStatement/);
  rejects('function f() { return 1; }\nreturn f();', /FunctionDeclaration/);
  rejects('const f = () => 1;\nreturn f();', /Functions|math functions/i);
  rejects('class A {}\nreturn 1;', /ClassDeclaration/);
  rejects('return 1;\nwhile (true) {}', /WhileStatement/);
  rejects('return new Date();', /"new" is not allowed/);
  rejects('return this;', /"this" is not allowed/);
  rejects('return window.location;', /Property access/);
  rejects('return x.__proto__;', /Property access/);
  rejects('return [1, 2];', /Arrays and objects/);
  rejects('return { a: 1 };', /Arrays and objects/);
  rejects('const a = `v`;\nreturn 1;', /Template literals/);
  rejects('return eval("1");', /math functions|Unknown name/);
  rejects('return Function("return 1")();', /math functions/);
  rejects('return globalThis;', /Unknown name/);
  rejects('return process;', /Unknown name/);
  rejects('var a = 1;\nreturn a;', /Use let or const/);
  rejects('let a;\nreturn 1;', /must be initialized/);
  rejects('let [a] = x;\nreturn a;', /Destructuring/);
  rejects('let a = 1;\na++;\nreturn a;', /Update expression/);
  rejects('let a = 1;\nreturn a ** 2;', /"\*\*" is not allowed/);
  rejects('return x ?? 0;', /"\?\?" is not allowed/);
  rejects('return x, 1;', /comma operator/i);
  rejects('debugger;\nreturn 1;', /DebuggerStatement/);
  rejects('with (x) return 1;', /WithStatement/);
  rejects('return "x";', /finite numeric literals/);
  rejects('return null;', /finite numeric literals/);
  rejects('return true;', /finite numeric literals/);
  rejects('double(x);\nreturn 1;', /math functions/);
  rejects('return sin(x, y, 1, 2);', /at most 3 arguments/);
});

test('body source, statements, instructions, locals and nesting are all bounded', () => {
  const boundary = depth => `${'{'.repeat(depth)}return 1;${'}'.repeat(depth)}`;
  rejects('return x;'.padEnd(1025, ' '), /1024 characters/);
  rejects(`${';'.repeat(81)}return 1;`, /max 80 statements/);
  rejects(`${Array.from({ length: 33 }, (_, i) => `let a${i} = ${i};`).join('\n')}\nreturn 1;`, /max 32/);
  expects(program(boundary(12)), 1); // exactly 12 nested blocks are allowed
  rejects(boundary(13), /blocks nest too deep/); // the 13th is rejected
  rejects(`return ${Array.from({ length: 20 }, () => '1+(').join('')}x${')'.repeat(20)};`, /nesting is too deep/);
  // A total syntax-node budget bounds the AST itself, before any compilation:
  // a dense unary chain (1 node per character, well under the source limit) trips
  // it, while 240 sibling empty blocks stay inside it.
  rejects(`return ${'!'.repeat(600)}x;`, /too many syntax nodes/);
  expects(program(`${'{}'.repeat(240)}return 1;`), 1);
  // The instruction budget bounds the compiled program: chained assignments are
  // cheap in AST nodes but emit several instructions each.
  const heavy = `let a = 0;\nlet b = 0;\nlet c = 0;\n${'a += b += c += 1;\n'.repeat(48)}return a;`;
  rejects(heavy, /max 512 instructions/);
  expect(boundary(12).length).toBeLessThan(1024);
  const compiled = program('let a = x + 1;\nif (a > 2) return a;\nreturn 0;');
  expect(compiled.program.instructions).toBeGreaterThan(0);
  expect(compiled.program.instructions).toBeLessThanOrEqual(512);
  expect(compiled.program.locals).toBe(1);
});

test('body scope is lexical: const, inputs, redeclaration and declaration order are enforced', () => {
  const value = (source, vars) => evaluate(program(source), vars).value;
  // an inner block shadows an outer local for that block only
  expect(value('let a = 1;\nif (x > 0) { let a = 2; return a; }\nreturn a;', { x: 1 })).toBe(2);
  expect(value('let a = 1;\nif (x > 0) { let a = 2; }\nreturn a;', { x: 1 })).toBe(1);
  // a block-local of a branch that did not run is simply out of scope, so a
  // zero-filled slot can never leak into the result
  rejects('if (x > 0) { let a = 1; }\nreturn a;', /Unknown name "a"/);
  rejects('let a = 1;\nlet a = 2;\nreturn a;', /already .*declared/);
  // a nested block may shadow an outer name; the outer value is untouched
  expect(value('let a = 1;\n{ let a = 2; return a + 0; }\nreturn a;', {})).toBe(2);
  expect(value('let a = 1;\n{ let a = 2; a = a + 1; }\nreturn a;', {})).toBe(1);
  rejects('let a = a + 1;\nreturn a;', /Cannot read "a" before its declaration/); // temporal dead zone
  rejects('return a;\nlet a = 1;', /Cannot read "a" before its declaration/); // use before declaration
  // the innermost declaration owns the name for the whole block, as in JavaScript
  rejects('let a = 1;\n{ let a = a + 1; return a; }\nreturn a;', /Cannot read "a" before its declaration/);
  rejects('{ a = 2; let a = 1; return a; }', /Cannot assign to "a" before its declaration/);
  rejects('const a = 1;\na = 2;\nreturn a;', /Cannot assign to const/);
  rejects('const a = 1;\na += 1;\nreturn a;', /Cannot assign to const/);
  rejects('x = 1;\nreturn x;', /read-only input/);
  rejects('y += 1;\nreturn y;', /read-only input/);
  rejects('time = 1;\nreturn time;', /read-only input/);
  rejects('let x = 1;\nreturn x;', /reserved/);
  rejects('let pi = 1;\nreturn pi;', /reserved/);
  rejects('let sin = 1;\nreturn sin;', /reserved/);
  expect(value('const a = 2;\nlet b = 3;\nb = a * b;\nreturn b;', {})).toBe(6);
});

test('body execution short-circuits, stays numeric and is a pure function of its inputs', () => {
  const guarded = program('if (x <= 0 || 1 / 0 > 0) return 1;\nreturn 2;');
  // the divide-by-zero issue is the probe: a short-circuited right side leaves it empty
  expect(evaluate(guarded, { x: -1 })).toEqual({ value: 1, issues: [] });
  const loud = evaluate(guarded, { x: 1 });
  expect(loud.value).toBe(2);
  expect(loud.issues).toEqual(['division by zero → 0']);
  expect(evaluate(program('if (x > 0 && 1 / 0 > 0) return 5;\nreturn 3;'), { x: -1 })).toEqual({ value: 3, issues: [] });
  expect(evaluate(program('return x > 0 ? 1 : 1 / 0;'), { x: 1 })).toEqual({ value: 1, issues: [] });
  // comparisons and ! produce numbers, never booleans
  expect(evaluate(program('return x < y;'), { x: 1, y: 2 }).value).toBe(1);
  expect(evaluate(program('return x < y;'), { x: 2, y: 2 }).value).toBe(0);
  expect(evaluate(program('return !x;'), { x: 0 }).value).toBe(1);
  expect(evaluate(program('return !x;'), { x: 2 }).value).toBe(0);
  expect(evaluate(program('return x && y;'), { x: 0, y: 9 }).value).toBe(0);
  expect(evaluate(program('return x || y;'), { x: 0, y: 9 }).value).toBe(9);
  // logical operands are values, not booleans, and leave the stack balanced
  expect(evaluate(program('return 10 + (1 && 2);'), {}).value).toBe(12);
  expect(evaluate(program('return min(1 && 2, 5);'), {}).value).toBe(2);
  // an assignment expression evaluates to the value it stored
  expect(evaluate(program('let a = 0;\nreturn (a = 2) + 3;'), {}).value).toBe(5);
  expect(evaluate(program('let a = 0;\nlet b = 0;\na = b = 2;\nreturn a + b;'), {}).value).toBe(4);
  expect(evaluate(program('let a = 0;\nif ((a = 3) > 2) return a;\nreturn 0;'), {}).value).toBe(3);
  // every evaluation starts from a fresh locals frame
  const counter = program('let a = 0;\na += x;\nreturn a;');
  expect([evaluate(counter, { x: 1 }).value, evaluate(counter, { x: 1 }).value, evaluate(counter, { x: 3 }).value]).toEqual([1, 1, 3]);
  // missing runtime return, non-finite results and non-finite inputs propagate safely
  expect(() => evaluate(program('if (x > 0) return 1;'), { x: -1 })).toThrow(/without returning a value/);
  expect(() => evaluate(program('return sqrt(-1);'), {})).toThrow(/non-finite/);
  expect(() => evaluate(program('return exp(1000);'), {})).toThrow(/non-finite/);
  expect(() => evaluate(program('return x * 1;'), { x: NaN })).toThrow(/not a finite number/);
});

test('a compiled body is retained: steady-state use parses nothing and evaluates once per call', () => {
  const source = 'let a = x * 2;\nreturn a + time;';
  const node = { type: 'script', language: 'body', source, inputX: 0, inputY: 0 };
  const cache = new Map();
  const before = { ...scriptCompileStats };
  for (let i = 0; i < 200; i++) {
    const result = scriptValue(node, { time: i / 100, readInput: () => .5 }, cache);
    expect(result).toMatchObject({ error: null, uses: { x: true, y: false, time: true }, language: 'body' });
    expect(result.value).toBeCloseTo(1 + i / 100, 9);
  }
  expect(scriptCompileStats.parses - before.parses).toBe(1); // one compile, never per use
  expect(scriptCompileStats.hits - before.hits).toBe(0); // the retained program is used directly
  expect(scriptCompileStats.evaluations - before.evaluations).toBe(200);
  // the compile cache is keyed by language + exact source too
  const cacheHits = scriptCompileStats.hits;
  compileScript('return x;', 'body');
  compileScript('return x;', 'body');
  expect(scriptCompileStats.hits - cacheHits).toBe(1);
  // exact source AND language key the program: the same text in another language
  // is a different program, and a retained program is the same object every time
  const mixed = new Map();
  expect(scriptProgram({ type: 'script', source: 'x' }, mixed).language).toBe('expression');
  expect(scriptProgram({ type: 'script', language: 'body', source: 'x' }, mixed).language).toBe('body');
  expect(mixed.size).toBe(2);
  expect(scriptProgram(node, cache).compiled).toBe(scriptProgram(node, cache).compiled);
});

test('script approval is bound to exact source and language and cannot travel in a file', () => {
  clearApprovals();
  expect(isScriptApproved('body', 'return x;')).toBe(false);
  approveScript('body', 'return x;');
  expect(isScriptApproved('body', 'return x;')).toBe(true);
  expect(isScriptApproved('expression', 'return x;')).toBe(false); // language is part of the key
  expect(isScriptApproved('body', 'return x ;')).toBe(false); // one character invalidates approval
  expect(isScriptApproved('body', 'x'.repeat(1025))).toBe(false);
  expect(() => approveScript('body', '')).toThrow(/1–1024/);
  expect(() => approveScript('body', 'x'.repeat(1025))).toThrow(/1–1024/);
  expect(() => approveScript('expression', 'x'.repeat(257))).toThrow(/1–256/);
  // A forged file cannot self-approve: unknown keys are dropped by the model and
  // the source still needs an explicit review + Apply in this browser.
  clearApprovals();
  expect(isScriptApproved('body', 'return x;')).toBe(false);
  const forged = bodyGraph({ approved: true, trusted: true });
  const graph = validateGraph(forged);
  expect(graph.nodes.find(n => n.id === 'shape')).toEqual({ id: 'shape', type: 'script', x: 440, y: 300, language: 'body', source: 'return x;', inputX: .5, inputY: 0 });
  const text = serializeGraph(graph, manifestFor(graph, sketches));
  expect(text).not.toMatch(/approved|trusted|trust/i);
  expect(parseGraph(text).graph).toEqual(graph);
  expect(isScriptApproved('body', 'return x;')).toBe(false);
  expect(sourceDiagnostics(graph, sketches, manifestFor(graph, sketches))).toEqual([]);
  clearApprovals();
});

test('legacy expression nodes stay expression nodes while body nodes carry an explicit language', () => {
  const legacy = legacyGraph();
  const parsedLegacy = parseGraph(serializeGraph(legacy, manifestFor(legacy, sketches))).graph;
  expect(parsedLegacy).toEqual(legacy);
  expect(parsedLegacy.nodes.find(n => n.id === 'shape').language).toBeUndefined();
  const body = bodyGraph();
  expect(parseGraph(serializeGraph(body, manifestFor(body, sketches))).graph).toEqual(body);
  expect(scriptLanguageOf({ type: 'script', source: 'x' })).toBe('expression');
  expect(scriptLanguageOf({ type: 'script', language: 'expression', source: 'x' })).toBe('expression');
  expect(scriptLanguageOf({ type: 'script', language: 'body', source: 'return x;' })).toBe('body');
  expect(scriptSource({ type: 'script' })).toBe('x');
  expect(scriptSource({ type: 'script', language: 'body', source: '   ' })).toBe(DEFAULT_BODY);
  expect(defaultNode('script')).toMatchObject({ language: DEFAULT_LANGUAGE, source: DEFAULT_BODY });
  // an unknown explicit language is rejected and the length bound follows the language
  expect(() => validateGraph(bodyGraph({ language: 'python' }))).toThrow(/language/);
  expect(() => validateGraph(bodyGraph({ source: 'return x;'.padEnd(1025, ' ') }))).toThrow(/1024/);
  expect(() => validateGraph(bodyGraph({ source: `let padding = 0; // ${'x'.repeat(200)}\nreturn padding;` }))).not.toThrow();
  const longLegacy = legacyGraph();
  longLegacy.nodes.find(n => n.id === 'shape').source = `x + ${'1'.repeat(255)}`;
  expect(() => validateGraph(longLegacy)).toThrow(/256/);
  // a broken body is repairable but is reported and blocks a save
  const broken = bodyGraph({ source: 'while (true) {}' });
  expect(sourceDiagnostics(broken, sketches, manifestFor(broken, sketches)).join(' ')).toMatch(/Invalid script on shape/);
  // the compiled form is data: no source text, function or eval survives into it
  const compiled = program('return x + 1;');
  expect(Array.isArray(compiled.program.ops)).toBe(true);
  expect(JSON.stringify(compiled.program)).not.toMatch(/function|eval|return x/i);
});

test('compilation happens once per source and steady-state evaluation cost is measured, not claimed', async ({}, testInfo) => {
  const source = 'let a = x * 0.5;\nif (a > 0.25) { a += time * 0.01; } else { a -= 0.01; }\nconst b = clamp(a, 0, 1);\nreturn lerp(b, y, 0.5);';
  const samples = 200;
  const startedCompile = performance.now();
  let compiled = null;
  // A unique (comment-prefixed) source forces a real parse + compile each time.
  for (let i = 0; i < samples; i++) compiled = compileScript(`// ${i}\n${source}`, 'body');
  const compileMs = (performance.now() - startedCompile) / samples;
  expect(compiled.ok).toBe(true);
  const steady = program(source);
  const evaluations = 20000;
  const before = scriptCompileStats.parses;
  const startedEvaluation = performance.now();
  for (let i = 0; i < evaluations; i++) evaluateScript(steady, { x: .5, y: .25, time: i / 1000 }, []);
  const evaluationMs = (performance.now() - startedEvaluation) / evaluations;
  expect(scriptCompileStats.parses - before).toBe(0); // steady state parses nothing at all
  testInfo.annotations.push({
    type: 'measurement',
    description: `body compile ${compileMs.toFixed(3)} ms/source (${samples} fresh sources), steady-state evaluation ${evaluationMs.toFixed(4)} ms/eval (${evaluations} evaluations) on this machine — indicative single run, not a comparative claim`,
  });
  expect(compileMs).toBeGreaterThan(0);
  expect(evaluationMs).toBeGreaterThan(0);
});

const useGraph = async (page, data) => page.evaluate(async graph => {
  FileSystemHandle.prototype.queryPermission = async () => 'granted';
  FileSystemHandle.prototype.requestPermission = async () => 'granted';
  const { SKETCHES } = await import('/src/sketch-registry.js');
  const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
  const { approveScript } = await import('/src/nodes/script-approval.js');
  for (const n of graph.nodes) if (n.type === 'script') approveScript(n.language ?? 'expression', n.source);
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('script-body-tests', { create: true });
  const file = await dir.getFileHandle('body.nodes.json', { create: true });
  const writer = await file.createWritable(); await writer.write(serializeGraph(graph, manifestFor(graph, SKETCHES))); await writer.close();
  window.showDirectoryPicker = async () => dir;
  const { nodePatterns } = await import('/src/nodes/repository.js');
  await nodePatterns.link();
  return (await nodePatterns.open('body.nodes.json')).id;
}, data);

test('the editor applies a body script, keeps the last applied code after a failed apply, and warns about unapplied text', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await page.goto('/?role=nodes');
  const id = await useGraph(page, bodyGraph());
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.getByLabel('Graph name')).toHaveValue('Body chain');
  await page.getByRole('button', { name: 'Select Script', exact: true }).click();
  await expect(page.getByLabel('Script language')).toHaveValue('body');
  await expect(page.getByLabel('Script source')).toHaveValue('return x;');
  await expect(page.getByTestId('node-signal-readout')).toContainText('Output 0.500');
  // plain Enter inserts a newline and never applies
  await page.getByLabel('Script source').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('return 0;');
  await expect(page.getByLabel('Script source')).toHaveValue('return x;\nreturn 0;');
  await expect(page.getByTestId('script-status')).toContainText('Not applied');
  // a failed apply reports the error and leaves the running code untouched
  await page.getByLabel('Script source').fill('x = 1;\nreturn x;');
  await expect(page.getByRole('alert')).toContainText('read-only input');
  await expect(page.getByRole('button', { name: 'Apply script' })).toBeDisabled();
  await page.getByLabel('Script source').press('Control+Enter');
  await expect(page.locator('.nodes-workspace')).toHaveAttribute('data-status', /read-only input/);
  await expect(page.getByTestId('script-status')).toHaveText('Not applied');
  await expect(page.getByTestId('node-signal-readout')).toContainText('Output 0.500');
  // a valid body is applied, approved and immediately drives the scalar output
  await page.getByLabel('Script source').fill('return x * 2;');
  await page.getByLabel('Script source').press('Control+Enter');
  await expect(page.getByTestId('script-status')).toContainText('Applied and approved');
  await expect(page.getByTestId('script-status')).toContainText('body · uses x');
  await expect(page.getByTestId('node-signal-readout')).toContainText('Output 1.000');
  // unapplied text is never saved silently
  await page.getByLabel('Script source').fill('return 0;');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(dialogs).toContain('Script text has not been applied. Save without it?');
  const saved = await page.evaluate(async id => (await import('/src/nodes/repository.js')).nodePatterns.load(id).then(r => r.graph), id);
  expect(saved.nodes.find(n => n.id === 'shape')).toMatchObject({ language: 'body', source: 'return x * 2;' });
  // ... and Reload from Disk confirms before dropping it, then resets the draft
  await page.getByRole('button', { name: 'Select Script', exact: true }).click();
  await expect(page.getByLabel('Script source')).toHaveValue('return 0;');
  await page.getByLabel('Reload from Disk').click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(dialogs).toContain('Discard unapplied script text?');
  // A reload selects Output again and drops the draft: the applied source returns.
  await page.getByRole('button', { name: 'Select Script', exact: true }).click();
  await expect(page.getByLabel('Script source')).toHaveValue('return x * 2;');
  await expect(page.getByTestId('script-status')).toContainText('Applied and approved');
  expect(errors).toEqual([]);
});

test('a disk-loaded body script is gated until it is reviewed in this browser', async ({ page }) => {
  await page.goto('/?role=nodes');
  const id = await page.evaluate(async graph => {
    FileSystemHandle.prototype.queryPermission = async () => 'granted';
    FileSystemHandle.prototype.requestPermission = async () => 'granted';
    const { SKETCHES } = await import('/src/sketch-registry.js');
    const { manifestFor, serializeGraph } = await import('/src/nodes/portability.js');
    const { clearApprovals } = await import('/src/nodes/script-approval.js');
    clearApprovals();
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('body-review', { create: true });
    const file = await dir.getFileHandle('review.nodes.json', { create: true });
    const writer = await file.createWritable(); await writer.write(serializeGraph(graph, manifestFor(graph, SKETCHES))); await writer.close();
    window.showDirectoryPicker = async () => dir;
    const { nodePatterns } = await import('/src/nodes/repository.js');
    await nodePatterns.link();
    return (await nodePatterns.open('review.nodes.json')).id;
  }, bodyGraph({ source: 'const v = x * 2;\nreturn v;' }));
  await page.goto(`/?role=nodes&graph=${encodeURIComponent(id)}`);
  await expect(page.locator('.nodes-diagnostics')).toContainText('not approved');
  await page.getByRole('button', { name: 'Select Script', exact: true }).click();
  await expect(page.getByTestId('script-status')).toContainText('review required');
  await expect(page.getByTestId('node-signal-readout')).toContainText('Output 0.000');
  await page.getByRole('button', { name: 'Apply script' }).click();
  await expect(page.getByTestId('script-status')).toContainText('Applied and approved');
  await expect(page.locator('.nodes-diagnostics')).not.toContainText('not approved');
  await expect(page.getByTestId('node-signal-readout')).toContainText('Output 1.000');
  expect(await page.evaluate(async () => (await import('/src/nodes/script-approval.js')).isScriptApproved('body', 'const v = x * 2;\nreturn v;'))).toBe(true);
});

// Live integration: the real shared analyser of the main window feeds a body
// script node, whose output is mapped onto a Color parameter and rendered.
test('live shared audio drives a body script through a mapping into pixels', async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => localStorage.setItem('viz2_audio_device_id', 'default'));
  await page.goto('/');
  await page.waitForFunction(() => window.__viz?.captureAudio?.isStarted);
  await page.evaluate(async () => {
    const audio = window.__viz.captureAudio; await audio.audioContext.resume(); audio.source.disconnect();
    const ctx = audio.audioContext, tone = ctx.createOscillator(), gain = ctx.createGain();
    tone.frequency.value = 94; gain.gain.value = 0; tone.connect(gain); gain.connect(audio.splitter); tone.start();
    window.toneGain = gain;
  });
  const graph = bodyGraph({ source: 'const level = x;\nreturn level;' });
  graph.nodes.push({ id: 'source', type: 'audio', band: 'bass', x: 40, y: 300 });
  graph.signalEdges = [{ from: 'source', to: 'shape', port: 'x' }];
  const id = await useGraph(page, graph);
  await page.locator(`.library-btn[data-id="${id}"]`).click();
  await page.getByRole('button', { name: 'Edit Pattern', exact: true }).click();
  const editor = page.locator('.app-editor-panel');
  await expect(editor.getByLabel('Graph name')).toHaveValue('Body chain');
  await editor.locator('[data-node-id=tint] .nodes-node-title').click();
  const red = () => editor.getByTestId('node-preview').evaluate(c => c.getContext('2d').getImageData(10, 10, 1, 1).data[0]);
  await expect.poll(red).toBe(51); // quiet: mapped minimum 0.2 over a full-brightness pattern
  const before = await page.evaluate(async () => ({ ...(await import('/src/nodes/script.js')).scriptCompileStats }));
  await page.evaluate(() => { window.toneGain.gain.value = .3; });
  await expect.poll(red).toBeGreaterThan(65); // the body script's output moved the mapping
  await page.evaluate(() => { window.toneGain.gain.value = 0; });
  await expect.poll(red).toBe(51);
  const after = await page.evaluate(async () => ({ ...(await import('/src/nodes/script.js')).scriptCompileStats }));
  // Frames kept evaluating one body per frame while the graph never recompiled.
  expect(after.evaluations).toBeGreaterThan(before.evaluations);
  expect(after.parses).toBe(before.parses);
});

test('the nodes guide documents the body language, its scope and its limits', async ({ request }) => {
  const response = await request.get('/docs/nodes.html');
  expect(response.ok()).toBe(true);
  const article = await response.text();
  for (const contract of ['Script source', 'Body (statements + return)', 'short-circuiting', 'Scope is lexical', 'Ctrl+Enter', '1024 characters', 'no <code>eval</code>']) {
    expect(article).toContain(contract);
  }
  expect(article).not.toContain('eval(');
});
