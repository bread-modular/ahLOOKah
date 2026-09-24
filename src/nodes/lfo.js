// The graph's LFO signal node: a free-running oscillator that emits one number
// per frame so it can animate anything a signal can reach (a mapped slider, a
// Math/Script input, or the input of another LFO).
//
// Cycle time is a RATE, so the runtime integrates it: the position is the travel
// accumulated frame by frame (`travel += dt / cycle`), never `time × rate`. That
// is what makes automation musical — a mapped signal adds or removes speed, the
// shape accelerates and coasts, and it never snaps back to the start of its cycle
// when the rate dips. `lfoValue` still accepts a plain `time` and then answers
// with the same idealised closed form (`start + time / cycle`), which is what the
// docs describe and what tests pin; the runtime always supplies its `travel`.
//
// Everything else is a pure function of (node, travel): the same node at the same
// travel emits the same number, so a saved file reproduces its shape exactly.
//
// Patterns are seeded and deterministic (no Math.random anywhere): noise and
// random are hashes of an integer lattice derived from the position and the node's
// seed, so one cycle always repeats its shape, in every window.
//
// This module is dependency-free on purpose: definitions.js imports it (like
// transform.js), so it must never import back into the definition/model graph.
export const LFO_PATTERNS = Object.freeze(['linear', 'sine', 'noise', 'random', 'custom']);
export const LFO_PATTERN_LABELS = Object.freeze({
  linear: 'Linear (saw)', sine: 'Sine', noise: 'Noise (smooth)', random: 'Random (steps)', custom: 'Custom (drawn)',
});
// The output domain. Stored as one name; the mapping's default input range is
// read from the same table so a bipolar LFO maps −1…1 without extra setup.
export const LFO_RANGES = Object.freeze(['unipolar', 'bipolar']);
export const LFO_RANGE_LABELS = Object.freeze({ unipolar: '0 … 1', bipolar: '−1 … 1' });
export const LFO_RANGE_VALUES = Object.freeze({ unipolar: Object.freeze([0, 1]), bipolar: Object.freeze([-1, 1]) });
// Custom shapes are a wrapped table of values in 0…1. Bounds keep a hand-written
// file from carrying an unusable curve.
export const LFO_MIN_POINTS = 2;
export const LFO_MAX_POINTS = 64;
export const LFO_POINT_COUNT = 32;
// Lattice sizes: one cycle holds this many smooth-noise segments / random steps.
export const LFO_NOISE_PERIODS = 4;
export const LFO_RANDOM_STEPS = 8;
export const LFO_MAX_SEED = 9999;
// Travel is integrated one frame at a time; a tab that was backgrounded (or a
// stalled frame) contributes at most this many seconds, so a long gap cannot
// teleport the shape.
export const LFO_MAX_TRAVEL_STEP = .25;
// A change of rate is smoothed over roughly this long (a first-order glide, about
// five frames at 60 fps). A mapped signal that steps — a random pattern, an audio
// band — then accelerates the shape instead of kicking it, exactly the way a car
// eases into a new speed, while the position itself is never rewound.
export const LFO_RATE_SLEW = .08;
// Numeric controls only. The Range and Pattern dropdowns are enumerations like
// Blend mode or Audio band, and the modulation system maps numeric sliders only.
// Cycle time is logarithmic (100 ms … 10 s) because a linear track would spend
// most of its length on cycles slower than 3 s.
export const LFO_PARAMS = Object.freeze([
  { key: 'cycle', label: 'Cycle time', min: .1, max: 10, step: .002, scale: 'log', format: 'duration', default: 1 },
  { key: 'phase', label: 'Start Position', min: 0, max: 1, step: .001, default: 0 },
]);
export const lfoDefaults = () => Object.fromEntries(LFO_PARAMS.map(p => [p.key, p.default]));
// A linear ramp is the custom pattern's starting shape: switching to Custom
// changes nothing until the operator draws, and an absent table stays a saw.
const RAMP = Object.freeze(Array.from({ length: LFO_POINT_COUNT }, (_, i) => i / LFO_POINT_COUNT));
export const defaultLfoPoints = (count = LFO_POINT_COUNT) => count === LFO_POINT_COUNT
  ? RAMP : Object.freeze(Array.from({ length: count }, (_, i) => i / count));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const clamp01 = value => clamp(Number.isFinite(value) ? value : 0, 0, 1);
export const lfoPatternOf = value => LFO_PATTERNS.includes(value) ? value : 'linear';
export const lfoRangeOf = value => LFO_RANGES.includes(value) ? value : 'unipolar';
export const lfoSeedOf = node => Number.isInteger(node?.seed) ? clamp(node.seed, 0, LFO_MAX_SEED) : 0;
// The drawn table, or the shared ramp when the file carries no points. The
// returned array is never mutated (the editor copies before writing).
export const lfoPointsOf = node => Array.isArray(node?.points) && node.points.length >= LFO_MIN_POINTS
  ? node.points : RAMP;
// One control of the node, read through the runtime's live parameter view when
// there is one (so a mapped slider arrives already converted and clamped) and
// falling back to the stored base value.
export function lfoParameter(node, key, view = null) {
  const def = LFO_PARAMS.find(p => p.key === key);
  const live = view?.[key];
  if (Number.isFinite(live)) return live;
  const stored = node?.params?.[key];
  return Number.isFinite(stored) ? stored : (def ? def.default : 0);
}
// The effective cycle length in seconds, always inside the control's domain: a
// hand-written file can carry a zero or an absurd cycle and still get a moving,
// finite oscillator.
export function lfoCycleOf(node, view = null) {
  const def = LFO_PARAMS[0];
  return clamp(lfoParameter(node, 'cycle', view), def.min, def.max);
}
// Cycles per second — the rate the runtime integrates. Exported so the runtime
// and the tests share one definition of "how fast this node is travelling".
export const lfoRateOf = (node, view = null) => 1 / lfoCycleOf(node, view);
// Files written before Cycle time replaced Speed stored cycles per second, where
// 0 meant "frozen". The new control has no zero (its domain is positive by
// definition), so the slowest cycle stands in for frozen and every other rate
// converts exactly. Only the loader calls this.
export const lfoCycleFromLegacySpeed = speed => Number.isFinite(speed) && speed > 0
  ? clamp(Number((1 / speed).toPrecision(4)), LFO_PARAMS[0].min, LFO_PARAMS[0].max)
  : LFO_PARAMS[0].max;
// Phase wraps into [0,1): one cycle is one turn, and the wrap is exact for both
// directions (a negative start is a phase-behind offset, not a clamp).
export const wrapped = value => Number.isFinite(value) ? value - Math.floor(value) : 0;
// Deterministic integer hash → [0,1). A 32-bit mix of the lattice index and the
// seed, so two noise nodes never share a shape unless they share a seed.
export function hash01(index, seed = 0) {
  let h = Math.imul((Math.floor(index) | 0) ^ Math.imul(Math.floor(seed) | 0, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// 1-D value noise with Perlin's smootherstep fade: continuous over the lattice.
// `loop` wraps the lattice into a ring of that many points, so the segment after
// the last one returns to the first hash and the shape stays continuous across a
// cycle's wrap (loop = 0 leaves the lattice unbounded, for callers that want one).
export function smoothNoise(x, seed = 0, loop = 0) {
  const base = Math.floor(x), t = x - base;
  const at = index => hash01(loop > 0 ? ((index % loop) + loop) % loop : index, seed);
  const a = at(base), b = at(base + 1);
  return a + (b - a) * t * t * (3 - 2 * t);
}
// Linear playback of a wrapped point table: point i sits at phase i/n, and the
// segment after the last point returns to the first.
export function samplePoints(points, position) {
  const values = Array.isArray(points) && points.length >= LFO_MIN_POINTS ? points : RAMP;
  const x = wrapped(position) * values.length;
  const index = Math.floor(x) % values.length;
  const next = (index + 1) % values.length;
  const a = clamp01(values[index]), b = clamp01(values[next]);
  return a + (b - a) * (x - Math.floor(x));
}
// One cycle's shape, normalized to 0…1 (the range conversion happens once, at
// the end of lfoValue, so every pattern shares the same domain).
export function lfoShape(pattern, position, { points = null, seed = 0 } = {}) {
  const p = wrapped(position);
  switch (lfoPatternOf(pattern)) {
    case 'sine': return 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
    // The noise lattice is a ring, so the cycle's last segment lands back on its
    // first hash: a smooth pattern has no seam where the cycle wraps.
    case 'noise': return clamp01(smoothNoise(p * LFO_NOISE_PERIODS, seed, LFO_NOISE_PERIODS));
    // Sample & hold over the cycle: a new value every 1/LFO_RANDOM_STEPS, the
    // same sequence every cycle (a pattern, not a fresh frame-by-frame random).
    case 'random': return clamp01(hash01(Math.floor(p * LFO_RANDOM_STEPS), seed));
    case 'custom': return clamp01(samplePoints(points, p));
    default: return clamp01(p);
  }
}
// The phase this node reads. With a `travel` (cycles accumulated by the runtime)
// the position is that travel, anchored on Start Position; with only a `time` the
// idealised closed form `start + time / cycle` answers instead. Exported so the
// editor can draw the shape's marker and tests can pin the mapping.
export function lfoPosition(node, { time = 0, travel = null, params = null } = {}) {
  const start = wrapped(lfoParameter(node, 'phase', params));
  if (Number.isFinite(travel)) return wrapped(start + travel);
  const seconds = Math.max(0, Number.isFinite(time) ? time : 0);
  return wrapped(start + seconds / lfoCycleOf(node, params));
}
// The node's value, in the node's own range. Always finite.
export function lfoValue(node, { time = 0, travel = null, params = null } = {}) {
  const shape = lfoShape(node?.pattern, lfoPosition(node, { time, travel, params }), { points: lfoPointsOf(node), seed: lfoSeedOf(node) });
  const [low, high] = LFO_RANGE_VALUES[lfoRangeOf(node?.range)];
  return low + (high - low) * clamp01(shape);
}
