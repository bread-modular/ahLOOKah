# Recent-pattern audio reactivity audit — 2026-09-10

## Scope selected from history

Inspected non-merge history for the lookback ending September 10, 2026 (September 3–10 inclusive), then inspected **addition diffs**, not just recently modified files:

```sh
git log --since=2026-09-03 --until=2026-09-11 --no-merges --date=short --name-status -- src
git show 7ebcd47 -- src/sketches src/sketch-registry.js
git show cbee609 -- src/sketches src/sketch-registry.js
```

Exactly **60 current patterns**, all exposing Bass/Mid/High Responsiveness, qualify. Dates below are the dates recorded in those commits.

| Added | Commit | Collection | Pattern IDs |
| --- | --- | --- | --- |
| 2026-09-09 | `7ebcd47` | Simple (5) | `dot-grid`, `pulse-stripes`, `cross-pulse`, `diamond-tiles`, `radial-spokes` |
| 2026-09-09 | `7ebcd47` | Lightweight shader groups (10) | `beat-weave`, `ripple-lattice`, `polygon-tunnel`, `orbital-cages`, `silk-flow`, `prism-caustics`, `laser-fan`, `neon-hex`, `data-rain`, `signal-tear` |
| 2026-09-09 | `7ebcd47` | Video FX (5) | `video-edge-glow`, `video-thermal`, `video-prism-split`, `video-ripple-lens`, `video-mirror-tiles` |
| 2026-09-10 | `cbee609` | Simple (4) | `triangle-mesh`, `ring-grid`, `hatch-weave`, `dash-lanes` |
| 2026-09-10 | `cbee609` | Lightweight shader groups (20) | `pulse-grid`, `wave-stack`, `beat-orbit`, `level-blocks`, `helix-tower`, `perspective-floor`, `gyro-rings`, `depth-frames`, `ember-drift`, `velvet-fog`, `prism-flare`, `molten-glass`, `laser-harp`, `neon-frame`, `beam-cascade`, `circuit-pulse`, `pixel-sort`, `vhs-tracking`, `block-shift`, `interference` |
| 2026-09-10 | `cbee609` | Video FX (4) | `video-halftone`, `video-solarize`, `video-wave-warp`, `video-duotone` |
| 2026-09-10 | `cbee609` | Basics (4) | `vignette`, `split-tone`, `sweep-band`, `grid-lines` |
| 2026-09-10 | `cbee609` | Alphas (8) | `alpha-rings`, `alpha-bars`, `alpha-grid`, `alpha-spot`, `alpha-sweep`, `alpha-diamonds`, `alpha-fog`, `alpha-waves` |

Excluded:

- Older Bars, Circles and Checkerboard were **modified**, not added, on September 9. Older shaders and camera effects also remain unchanged.
- Media playback was added September 4 (`5a68fdf`) but exposes scaling, zoom, pan and playback-speed parameters, not audio-reactivity parameters. Projection composites are not new audio-reactive visual patterns either.
- The shared audio capture, noise-floor processing, crossover/feature extractor, transport, interpolation, registry defaults and older patterns are not modified.

## Traced path and cause

`AudioManager.getAnalysisFrame()` reads float spectra/waveforms and applies the existing noise floor. `audioBroadcastLoop` calls `PatternAudioControlEngine` about every 33 ms. Its lazy `SharedAudioAnalysisView` extracts unparameterized musical features once per tick. Controllers apply each slot's accepted parameters; schema-validated packets reach `PatternAudioControlStore` and each renderer's binding. Parameter revisions reset old samples. This wiring works: the main problem was **conservative visual transfer**, not a missing microphone connection or ignored sliders.

The new collections passed smoothed band levels straight through `scaleBands` (slider default 1), then multiplied them by small size/warp/light coefficients. Thin or dark effects barely changed at modest input. The former render check only required an average RGBA-byte difference above **0.02**, even with an almost-full feature of **0.85**. At feature **0.2**, 39/60 patterns failed the stronger per-band threshold; 68/180 individual band samples changed by less than one average byte.

Two related scoped issues:

- Standalone Lightweight/Alpha shaders bypassed the common reader and entered the older shader runtime's synthetic idle-beat path. They could differ from their bound LIVE/CUE versions even with no audio.
- Alpha Spot used `1.6 - bass * 0.5` and `2.2 - bass` in its falloff. At the legal band maximum 3.2 it collapsed into white; above 2.2 the falloff exponent could invert.

## Implementation

- `responsiveBands` is used only by the 60 recent entries and their standalone readers. It lifts each independent level with `x * ((1.6 + 0.35) / (x + 0.35))`, bounded to 1.6, **before** multiplying by that band's 0–2 slider. A modest 0.2 becomes approximately 0.709 at default sensitivity (3.55×). The curve is monotonic, has finite slope at zero, and has no added noise pedestal or fabricated beat.
- Slider scaling remains linear after the curve. Zero removes exactly that band's modulation, half halves its control value, and the final maximum remains 3.2. No total-energy signal or cross-band transient is fed back into muted bands. Existing shared attack/release and stale decay remain intact; no extra temporal smoothing is added.
- Weak visual mappings receive local geometry/color/light changes: Simple ripple/size/color, Vignette opening/squeeze/rim, Grid Lines intersections, orbital/helix/laser details, ember drift, circuit nodes/colors, VHS mid warp, Prism Split offsets/axis, Alpha Sweep edges. They keep their individual band meanings rather than sharing a scene-wide flash.
- Alpha Spot now has strictly positive falloff factors. Beat Orbit's expansion is bounded to keep orbiters in view. Grid Lines highlights are bounded to at most 33×33 nodes even at 4K/8K.
- `makeBandShader` makes the standalone recent shaders use the same reader. Bound rendering still reads once and never scans raw FFT data or reapplies slider gain.
- `scaleBands`, `BAND_PARAMS`, and `BAND_SCHEMA` stay unchanged because **older Bars uses the linear mapper** and older registry entries share the slider definitions. Saved slider values are respected; no settings migration/reset is performed.

## Render evidence

Real p5 Canvas2D/WebGL rendering in Chromium at 360×240; default parameters except speed frozen at zero to isolate audio. Camera tests use a deterministic canvas-backed video stream. Compare silence with `{ sub: 0.2, mid: 0.2, high: 0.2 }` at default sliders, using the same source and phase before and after. Metric: mean absolute byte difference across RGBA (alpha is unchanged), not a perceptual loudness score.

- All 60 patterns passed the stronger rendered checks: every single-band difference >1, combined difference >3, exact zero-slider neutrality (also with the other bands active).
- Median combined difference improvement: **3.24×**; range **1.20–27.90×** across these fixed fixtures.
- All 60 pre-change and post-change **silence baseline images were pixel-identical**.

| Pattern | Before | After | Ratio |
| --- | ---: | ---: | ---: |
| `dot-grid` | 4.178 | 20.040 | 4.80× |
| `beat-weave` | 9.202 | 21.026 | 2.28× |
| `video-prism-split` | 0.818 | 6.755 | 8.26× |
| `grid-lines` | 0.840 | 8.246 | 9.81× |
| `alpha-spot` | 4.039 | 19.659 | 4.87× |
| `vignette` | 0.393 | 10.977 | 27.90× |
| `beat-orbit` | 1.522 | 4.724 | 3.10× |
| `ember-drift` | 0.843 | 4.983 | 5.91× |

Per-pattern PNGs, audio PNGs and `reactivity.json` metrics are generated under the chosen Playwright output directory. For this workspace: `test-results/reactivity-before/` and `test-results/reactivity-final/`. A five-pattern comparison sheet was also visually inspected (silence / before audio / after audio). Generated artifacts are intentionally not committed.

## Validation

All commands used isolated port 5272 and two workers; no unrelated dev server was reused.

- `PLAYWRIGHT_PORT=5272 npx playwright test tests/recent-audio-reactivity.spec.js tests/expanded-patterns.spec.js --workers=2 --output=test-results/reactivity-final` — **71 passed**.
- `PLAYWRIGHT_PORT=5272 npm run test:core -- --workers=2 --output=test-results/core-reactivity` — **291 passed** (including the dependency tests selected by the project configuration).
- `PLAYWRIGHT_PORT=5272 npx playwright test tests/audio-features.spec.js tests/pattern-audio-all.spec.js tests/pattern-audio-controls.spec.js tests/noise-floor.spec.js tests/band-eq.spec.js tests/render-regressions.spec.js tests/render-performance.spec.js --workers=2 --output=test-results/audio-regressions` — **27 passed**.
- `npm run build` — passed; Vite reports its >500 kB chunk-size warning. No dependency/bundling changes were made.
- `git diff --check` — passed.

The runs overlap; these counts are not a count of distinct tests. Added numerical/integration regressions cover the exact historical scope, unchanged older Bars/defaults, bounded monotonic response, independent/zero/partial sliders, malformed inputs, raw Hz spectra at 44.1/48/96 kHz, right-only audio, 30/60/120 Hz cadence, crossover changes, silence release, all 60 controllers through the actual engine/schema/store, revision changes, stale/owner-loss decay, one shared feature scan, no render-side FFT/double gain, standalone shader neutrality, and 4K/8K geometry budgets. Enhanced rendered tests also exercise max audio, min/max visual controls, resize, grayscale Alphas, camera lease lifecycle, and no shader/WebGL errors.

## Limitations and workspace boundary

- Synthetic spectra/features and a synthetic camera were used, not the user's physical microphone, music set, camera or projector. Response still depends on input level, spectral content, saved sensitivities and visual controls. Pixel-difference ratios are fixture-specific, not a promise of uniform perceptual gain.
- Detailed image comparisons freeze motion to separate audio from animation. Existing lifecycle/live-render tests exercise running patterns, but no long-duration hardware performance benchmark or new beat/onset detector was added.
- Changes remain in workspace 122; no merge, deployment, advisor, or other-model calls were made for this continuation.
- `.okbrain/workspace-init.log` was already dirty at the start and was left untouched by this task.
