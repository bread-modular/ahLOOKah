# The LFO signal node

The node graph gained an **LFO** signal node: a free-running oscillator that emits
one number per frame, so anything a signal can reach (a mapped slider, a Math or
Script input, another LFO's Cycle time) can be animated without audio or a script.
This document records the contract, the shapes, the failure behavior and how to
verify them.

## 1. Compatibility rule

- The node is additive: no existing node type, port, parameter or file version
  changes, and no new wire semantics are introduced. Modulations onto it use the
  existing `modulations` links, so a graph with an LFO is still **version 1**.
- A graph stores only names (`pattern`, `range`) and numbers, so a file never
  depends on which build rendered it. Unknown names and out-of-range values are
  rejected at load; an absent optional field falls back to the documented default.
- The optional drawn table (`points`) is only written when a file declares one, so
  a node that never used **Custom** stays small and round-trips exactly.
- `params.speed` (cycles per second) is the pre-release name of `params.cycle`: the
  loader converts it (0, which used to mean frozen, becomes the slowest cycle), and
  an explicit `cycle` in the same file wins. Nothing in the current contract is
  called `speed`.
- A **mapping** saved onto that old control is migrated with it: `param: "speed"`
  becomes `param: "cycle"` and its endpoints are converted to seconds per cycle, so
  the input that selected the fast end still selects the fast end and the saved
  automation keeps working (never reported as an unsupported parameter). A `speed`
  parameter on any other target — a sketch may have one — is left untouched.

## 2. Contract

| Field | Values | Default |
| --- | --- | --- |
| `pattern` | `linear`, `sine`, `noise`, `random`, `custom` | `linear` |
| `range` | `unipolar` (0…1), `bipolar` (−1…1) | `unipolar` |
| `seed` | integer `0…9999`, shapes `noise` / `random` | `0` |
| `points` | optional array of `2…64` numbers in `0…1` | shared linear ramp |
| `params.cycle` | `0.1…10` seconds per cycle, logarithmic, `0.002` decades per step | `1` |
| `params.phase` | `0…1` of a cycle, step `0.001` | `0` |

Cycle time is shown and edited as a **duration** (`250 ms`, `2.50 s`) on a
logarithmic track, where the middle of the slider is 1 s: a linear 100 ms … 10 s
track would spend most of its length on cycles slower than 3 s.

The node has **no ports**: it is a signal *source*, and it is automated through the
ordinary modulation endpoint (the ◇ socket) rather than through scalar input wires.
Its two numeric controls are the ones a signal can map onto; `pattern`, `range` and
`seed` are enumerations/values like Blend mode, Audio band or Script language, which
the mapping system deliberately does not map.

## 3. Signal math

```
rate     = 1 / params.cycle                     // cycles per second
travel  += dt × rate                            // integrated once per frame
position = wrap01(params.phase + travel)
shape    = pattern(position)                    // a total function into 0…1
value    = range[low] + (range[high] − range[low]) × shape
```

- `lfoValue(node, { time })` — what tests and this document describe — answers with
  the idealised closed form `wrap01(params.phase + time / params.cycle)`.
- `wrap01` is an exact wrap in both directions, so a cycle is one turn and a
  negative phase runs behind.
- `linear` = `position` (a saw: 0 at the start of the cycle, rising to 1).
- `sine` = `0.5 − 0.5·cos(2π·position)` — it starts where the saw starts and peaks
  at the half cycle, so every pattern shares the same start.
- `noise` = 1-D value noise: a seeded integer hash at each of `LFO_NOISE_PERIODS = 4`
  lattice points per cycle, interpolated with Perlin's smootherstep fade
  (`t²(3 − 2t)`). The lattice is a **ring**, so the segment before the wrap returns
  to the hash the cycle starts with: a noise cycle has no seam where it repeats.
- `random` = sample & hold over `LFO_RANDOM_STEPS = 8` steps per cycle: a new seeded
  hash every step, the same sequence every cycle (a pattern, never a per-frame
  `Math.random`).
- `custom` = linear playback of `points` with the segment after the last point
  returning to the first; the default table is a 32-point ramp, so switching to
  Custom changes nothing until the operator draws.

`bipolar` is the same shape mapped onto −1…1 (`2·shape − 1`). Every pattern is
clamped into its range, so the node is total: it always emits a finite number, and
a non-finite `time` yields the node's frozen start value instead of `NaN`.

### Cycle time is a rate, not a multiplier

The runtime integrates the travel frame by frame (`GraphRuntime.advanceSignals`,
called once per `render()` / `_evaluate()` right after the per-frame signal cache is
cleared), and evaluates the value from that travel. So:

- Editing **Cycle time**, or driving it with a mapped signal, changes how fast the
  shape moves and never teleports it: the shape accelerates and coasts like a car
  instead of restarting. Under the old `time × speed` form, a mapped rate that
  dipped towards zero snapped the shape back towards the start of its cycle. The
  speed itself also eases into its new value (see below), so a stepped source does
  not kick the shape either.
- **Start Position** stays the absolute anchor the operator can scrub, and a cycle
  that reaches the control's floor (`100 ms`) is the top speed.
- A frame contributes at most `LFO_MAX_TRAVEL_STEP = 0.25 s` of travel, so a
  backgrounded tab or a stalled frame cannot jump the shape.
- The step is **dependency-ordered**: an LFO whose Cycle time is mapped from
  another node advances everything that node reads first — through a Math or Script
  node as well as directly — so the same graph renders the same frame whatever order
  its nodes are stored in, and a mapped rate is never one frame behind its own
  source.
- A rate **change** glides: the applied rate approaches the control's value with an
  `LFO_RATE_SLEW = 0.08 s` first-order time constant (about five frames at 60 fps,
  and a single step when frames are longer than that). A stepped source — a random
  pattern, an audio band — therefore accelerates the shape instead of kicking it,
  while the travel itself still never rewinds. Continuous sources are followed
  within a frame or two.
- The accumulator lives in the runtime and survives parameter edits
  (`updateGraph`); a *rebuilt* runtime (a structural change, a new preview) starts a
  fresh clock at Start Position, exactly like every other node's prepared state.
- The value is still frame-stable: every consumer in one frame reads the same
  travel, so the readout and the renderers agree by construction.

## 4. Automation (signals onto the LFO)

- Modulations are the only automation path: select the source, wire it to the LFO's
  ◇ endpoint, then drag its chip onto **Cycle time** or **Start Position** and set
  the output range.
- A **new** mapping from a bipolar LFO starts with **Signal in** −1…1 (its own
  domain); every other source keeps the historical 0…1, and replacing an existing
  mapping keeps the input range the operator already set.
- A logarithmic control is interpolated **logarithmically**: a 250 ms … 4 s mapping
  passes 0.5 s at its midpoint (the geometric mean), and the endpoints are quantized
  to the control's four significant digits. An endpoint at or below zero has no
  logarithm and is read at the domain floor for that interpolation only; the stored
  endpoint is never rewritten.
- The runtime evaluates the node every frame through the same live parameter view
  every other controllable node uses, so a mapped control arrives already converted
  and clamped into the control's domain (`mappedValue` → `clampStep`), and the
  overlay's box, handles and LIVE marker sit where the logarithmic thumb is.
- An LFO can be a source *and* a target, which makes a modulation loop
  constructible for the first time. `validateGraph` now walks `modulations` in its
  cycle check, so an LFO on its own Cycle time — or two LFOs driving each other —
  is refused when connecting and when saving, like any other cycle. Two runtime
  behaviors cover a graph that bypassed validation: a loop through **Start
  Position** is read while the value is computed, so the per-node re-entrancy guard
  reports `Signal loop detected → 0.` instead of recursing; a loop through **Cycle
  time** needs no guard at all, because the rate is read by the frame and the value
  depends only on the travel — it resolves in a single pass.

## 5. Editor behavior

- The palette gains **+ LFO** (drag-only, like every structural node) and the node
  card reads `pattern · range · cycle`, e.g. `sine · 0…1 · 1.00 s`.
- The inspector holds **Range**, **Pattern**, the **Reshuffle** button (Noise and
  Random), a live output readout, the two mappable sliders, and — for Custom — the
  drawing pad: one cycle across the width, value up the height, 32 columns.
- Drawing writes only the y value of the column under the pointer, so the table
  keeps its length and stays a valid 0…1 curve; one stroke is a **single undo step**
  (the moves merge under the node's key and the global pointer release seals the
  gesture), and **Reset shape** returns the table to the ramp.
- The node is a scalar source, so its inspector hides the image preview; the
  runtime keeps ticking so the readout and mapped values stay live.

## 6. Failure behavior

| Condition | Behavior |
| --- | --- |
| Unknown `pattern` / `range`, bad `seed`, out-of-range or unknown `params` key, malformed `points` | Save/load refused with a message naming the field |
| Partial `params` (e.g. only `cycle`) | Completed with the documented defaults, never rejected |
| Legacy `params.speed` | Converted to `cycle` (`1 / speed`, floor `0.1 s`); a frozen `0` becomes the `10 s` maximum |
| Legacy mapping onto `wave.speed` | Renamed to `cycle` with endpoints converted (same fast/slow ends), so the automation keeps running |
| `cycle` outside `0.1…10` in a hand-edited file the validator cannot see | Clamped by `lfoCycleOf` — never a division by zero, never a non-finite value |
| Missing `points` | The shared ramp plays; the node stays small in the file |
| Modulation loop | `Connection would create a cycle` on connect/save; `Signal loop detected → 0.` at runtime for a value-path loop (see §4) |
| Non-finite time or signal | The node emits its frozen start value (0) — never `NaN` |

## 7. Verify

```sh
npm run build
PLAYWRIGHT_PORT=5186 npx playwright test tests/nodes-lfo.spec.js --project=chromium --no-deps
# Neighbouring graph behavior (palette order, wires, mappings, persistence):
PLAYWRIGHT_PORT=5186 npx playwright test tests/nodes.spec.js tests/nodes-scalar.spec.js tests/nodes-blend-transform.spec.js tests/nodes-camera-fx-editor.spec.js tests/docs.spec.js --project=chromium
```

`tests/nodes-lfo.spec.js` covers the shared contract, every shape/range pair across
a dense time sweep, seeded determinism, per-cycle repeat and the seamless noise wrap,
cycle clamping, the travel form versus the closed form, the cycle and validation
rules (including modulation loops and the legacy `speed` conversion of both a
control and a saved mapping), the documented default input range, logarithmic
mapping, file round-trips, the live runtime (advancing value, mapped parameter,
mapped Cycle time, a rate change without a jump, a rate step that glides,
source-first advance order directly and through a Math node, loop guard) and the
editor (creation, logarithmic slider readouts, drawing pad undo, save and reload
with its wirings).

See also `public/docs/nodes.html` (operator guide), `README.md` (node graph section)
and `src/nodes/lfo.js` (the dependency-free math), `src/param-scale.js` (the shared
linear/logarithmic track math).
