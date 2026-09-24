// Shared vocabulary for the two Script-node languages. This module imports
// nothing so it can be used by the language front ends (script.js, script-body.js)
// and by the approval store without creating an import cycle.
//
//   expression — the original single-value language (256 characters). Kept
//                byte-for-byte compatible: graphs saved before the body language
//                existed have no `language` field and keep running as expressions.
//   body       — a JavaScript function body with `return` (1024 characters),
//                compiled once into bounded bytecode and run by script-body.js.
export const LANGUAGES = Object.freeze(['expression', 'body']);
// A missing/unknown value is the legacy expression language; only the literal
// 'body' opts into the body language, and model.js rejects any other explicit
// value so a typo can never silently downgrade a saved script.
export const scriptLanguageOf = value => value === 'body' ? 'body' : 'expression';
export const scriptLanguageLabel = value =>
  scriptLanguageOf(value) === 'body' ? 'Body (statements + return)' : 'Expression (single value)';

// Limits. Source, approval, model validation and the inspector's maxLength all
// read these, so a limit can never drift between validation and the UI.
export const MAX_EXPRESSION = 256;
export const MAX_BODY = 1024;
export const MAX_SOURCE = MAX_BODY;
export const MAX_NODES = 64;       // expression-language operations
export const MAX_DEPTH = 12;       // expression-language nesting
export const MAX_ARGS = 3;
export const MAX_BODY_STATEMENTS = 80;
// Total syntax nodes (statements, blocks and every expression node). Counted with
// an explicit stack before compilation so an adversarial AST cannot overflow a
// walk of its own, and so the whole compile is bounded before it starts.
export const MAX_BODY_NODES = 512;
export const MAX_BODY_INSTRUCTIONS = 512;
export const MAX_BODY_LOCALS = 32;
export const MAX_BODY_DEPTH = 16;
// How deeply blocks may nest. Statements inside a block are counted against the
// statement budget, but the block wrappers themselves are not statements, so an
// explicit nesting bound keeps every compile-time walk shallow.
export const MAX_BODY_BLOCK_DEPTH = 12;
// With no loops in v1 every instruction runs at most once, so the executed-step
// budget is a defensive guard rather than a reachable limit.
export const MAX_BODY_STEPS = 2048;

// Persistent state (body language only). A node keeps one bounded store of
// doubles for as long as its graph runs: `state.<name>` is a slot and
// `state.<name> = [0, 0, 0, 0]` declares a bounded buffer inside that same
// store. Names are resolved at compile time (no computed properties, no
// strings, no objects), so the storage is one fixed-size Float64Array and the
// per-frame cost stays a plain array index.
export const SCRIPT_STATE_NAME = 'state';
export const MAX_STATE_SLOTS = 64;      // one node's whole store, in doubles
export const MAX_STATE_STEP = 0.25;     // seconds; the dt clamp (see script-state.js)
// `state` itself can never be a local, and these can never be slot names: they
// describe JavaScript objects, not stored numbers.
export const SCRIPT_STATE_RESERVED = Object.freeze(['__proto__', 'constructor', 'prototype']);

export const SCRIPT_CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E, tau: Math.PI * 2 });
export const SCRIPT_FUNCTIONS = Object.freeze({
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sqrt: Math.sqrt, pow: Math.pow, exp: Math.exp, log: Math.log, sign: Math.sign, hypot: Math.hypot,
  clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
  lerp: (a, b, t) => a + (b - a) * t,
});
// Function order is the bytecode's function index; both languages share it.
export const SCRIPT_FUNCTION_NAMES = Object.freeze(Object.keys(SCRIPT_FUNCTIONS));
export const SCRIPT_FUNCTION_LIST = Object.freeze(SCRIPT_FUNCTION_NAMES.map(name => SCRIPT_FUNCTIONS[name]));
// `dt` is the seconds since this node's previous evaluation, clamped by the
// runtime (MAX_STATE_STEP). It is listed here so both languages share one input
// table; the expression front end lists only x/y/time (see script.js) so a
// legacy expression is unchanged.
export const SCRIPT_INPUT_NAMES = Object.freeze(['x', 'y', 'time', 'dt']);
export const SCRIPT_VARIABLES = SCRIPT_INPUT_NAMES;
export const isScriptFunction = name => Object.hasOwn(SCRIPT_FUNCTIONS, name);
export const isScriptConstant = name => Object.hasOwn(SCRIPT_CONSTANTS, name);
export const scriptFunctionIndex = name => SCRIPT_FUNCTION_NAMES.indexOf(name);

export const SCRIPT_HELP = 'Restricted expression: numbers, x, y, time, pi, e, + − × ÷ %, parentheses and the listed math functions.';
export const SCRIPT_BODY_HELP = 'Body syntax: numbers, x, y, time, dt, state.<name>, pi, e, let/const locals, if/else, return, comparisons, && || !, ?:, + − × ÷ %, parentheses and the listed math functions.';
export const SCRIPT_STATE_HELP = `state.<name> keeps a number between frames (slots start at 0 and must be assigned before they are read); state.<name> = [0, 0, 0, 0] declares a buffer of at most ${MAX_STATE_SLOTS} values, indexed with state.<name>[i]. dt is the seconds since this node last ran, capped at ${MAX_STATE_STEP}.`;
export const helpForLanguage = value => scriptLanguageOf(value) === 'body' ? SCRIPT_BODY_HELP : SCRIPT_HELP;
export const limitForLanguage = value => scriptLanguageOf(value) === 'body' ? MAX_BODY : MAX_EXPRESSION;

// Compile cache key. Exact source plus language: two sources that differ by one
// character, or the same text in the other language, never share a program.
export const compileKey = (language, source) => `${scriptLanguageOf(language)}\u0000${source}`;

// Diagnostics counters only. They make "compiled once, never per frame" and
// "one evaluation per frame" measurable in tests instead of a claim in a log;
// they carry no behaviour of their own.
export const scriptCompileStats = { parses: 0, hits: 0, evaluations: 0 };
