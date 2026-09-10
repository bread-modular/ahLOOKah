# Replacement results — workspace 123

Final wrap-up of **existing evidence**, not a new test run. See [design, provenance, concepts and method](replacement-mission.md). Registry: **60 removed, 50 older retained, 18 added = 68 built-ins**; Checkerboard and Ion Tempest retained; category labels/order, Media and custom Projection Mapping unchanged. No merge or advisor.

## Actual completed runs

- The targeted regression invocation selected **108 tests**, exited **0**, and saved `status: passed` with an empty `failedTests` array in `test-results/replacement-regressions/.last-run.json`. It covered replacement visual/band/bounds/integration/lifecycle checks and existing UI, search, audio transport, noise-floor, render, Media and docs regressions. The captured console log was truncated before its final summary; 108 is the recorded run-header count, not a newly reconstructed per-test report.
- The later live smoke/provenance run explicitly reported **20 passed (47.0 s)**: the 18 replacements, Ion Tempest, and the strengthened original-registry declaration check. Persisted status also remains passed.
- `npm run build` completed successfully. Vite warned that some minified chunks exceed **500 kB**; this was not fixed in the scoped mission. `git diff --check` passed.
- This wrap-up only reads retained artifacts, uploads images and writes this missing document. No implementation, test suite or build was restarted.

## Measured visual results

Source: `test-results/replacement-evidence/metrics.json`. Fresh instances/controllers/history for every condition; synchronized animated 320×180 renders over 24 × 50 ms steps. Means sample frames 8, 12, 16, 20 and 23. **RGB** is mean absolute RGB difference on the 0–255 scale; **coverage** is the fraction with any RGB component difference >16; **edge** is normalized-luminance edge XOR as a fraction of the whole frame. Autonomous motion is not counted as audio response. Synthetic feature levels are modest **0.2**, strong **0.85**, and pulsed **0.85** (three frames on/five off), not acoustic loudness units.

| Pattern | RGB modest / strong / pulse | Modest coverage | Modest edge | Isolated Bass / Mid / High RGB |
| --- | ---: | ---: | ---: | ---: |
| Truchet Relay | 90.44 / 105.00 / 42.01 | 54.05% | 37.85% | 28.26 / 74.96 / 31.99 |
| Counterweight | 18.70 / 19.59 / 7.85 | 14.54% | 10.31% | 13.33 / 12.69 / 3.41 |
| Membrane Modes | 21.91 / 21.47 / 8.58 | 40.19% | 33.20% | 22.43 / 22.57 / 19.03 |
| Ratchet Wheel | 32.66 / 39.64 / 15.92 | 25.79% | 16.62% | 22.85 / 10.42 / 6.70 |
| Pin Relief | 20.44 / 23.34 / 9.31 | 26.23% | 15.36% | 13.61 / 15.77 / 8.19 |
| Folded Spire | 18.45 / 24.64 / 9.86 | 24.56% | 14.29% | 12.13 / 4.30 / 8.32 |
| Schlieren Flow | 34.94 / 35.81 / 14.36 | 76.66% | 48.78% | 32.42 / 35.81 / 29.27 |
| Tidal Glass | 16.30 / 17.98 / 7.17 | 21.03% | 6.33% | 6.11 / 14.49 / 6.14 |
| Vector Knot | 17.36 / 20.34 / 8.25 | 24.12% | 21.65% | 11.82 / 11.27 / 8.81 |
| Prism Scanner | 12.01 / 13.27 / 5.32 | 15.72% | 11.85% | 8.95 / 7.34 / 5.76 |
| Video Slit Scan | 25.77 / 30.54 / 12.02 | 55.52% | 8.63% | 11.66 / 23.00 / 5.32 |
| Video Facet Fold | 16.81 / 19.87 / 8.31 | 19.44% | 6.87% | 16.68 / 6.90 / 9.12 |
| Bitplane Rewire | 79.85 / 74.49 / 29.79 | 76.42% | 38.13% | 70.93 / 76.60 / 81.43 |
| Riso Misprint | 26.60 / 32.84 / 13.15 | 28.56% | 15.53% | 17.92 / 12.27 / 15.51 |
| Barn Doors | 32.04 / 47.94 / 19.18 | 16.37% | 2.90% | 12.46 / 9.97 / 9.86 |
| Stair Wipe | 51.85 / 48.94 / 19.63 | 28.26% | 5.28% | 53.81 / 47.04 / 8.96 |
| Iris Diaphragm | 38.10 / 63.40 / 25.40 | 18.69% | 5.31% | 17.20 / 5.41 / 6.67 |
| Cellular Gate | 55.24 / 62.63 / 25.02 | 25.39% | 21.95% | 53.70 / 39.66 / 7.62 |

Across all 18, modest audio changes **14.54–76.66%** of pixels, RGB MAD **12.01–90.44**, and edge area **2.89–48.78%**. Strong coverage is **15.10–77.95%**; pulsed coverage **6.05–31.24%**. Shape overlap/topology means RGB distance need not increase monotonically with stronger audio.

All **54 isolated-band cases** exceed the individual-band gates. The weakest RGB/coverage case is Counterweight High: **3.411 RGB**, **3.558% coverage** (only **0.058 percentage points** above the 3.5% coverage floor). The minimum individual-band edge area is **1.507%** (Barn Doors High), and minimum edge relocation/union is **25.497%** (Cellular Gate High). These fixture-specific margins are not universal perceptual guarantees.

Duplicate silence, all-zero sliders, isolated mutes, and muting one band while the others remain active have **maximum RGBA byte difference 0 for every frame**, for all 18. Extreme-level lit/non-white checks, all 36 min/max visual-parameter cases and resize to 480×270 passed. Bounds checks are not a long-duration stability or high-resolution performance benchmark.

## Real pipeline and alpha compositing

`integration.json` records real Web Audio synthesis through AudioManager/analyser, feature extraction/noise-floor path, engine and packet/store, then deterministic replay of the accepted controls through all 18 renderers. Acquisition substitutes a generated MediaStream for a physical microphone; this is not a physical-device end-to-end claim. The separate deterministic camera fixture is animated and synchronized.

- Sample rate **48,000 Hz**; FFT size **2048**; measured maximum RMS **0.14719**; **48 shared feature builds**, **864 accepted slot deliveries**. Final Bass/Mid/High controls: **1.127 / 0.830 / 0.746**; silence controls **0 / 0 / 0**.
- All 18 pipeline-driven renders exceeded RGB >6, coverage >10%, and edge >1.5%; observed minima were **12.47 RGB**, **14.65% coverage**, **2.99% edge**.
- The real ProjectionLayer compositor retained both the blue lower layer and opaque white matte. From silence to modest audio, white coverage changed **4.42% → 19.00%** (Iris Diaphragm) and **7.90% → 20.69%** (Cellular Gate). Lower-layer blue coverage remained **76.71%** and **74.81%** respectively. These Alphas are opaque grayscale sources used with the app's existing **black key**, not native transparent RGBA masks or proportional-luma opacity.

## Research verification

Prior full-page tool extracts were recovered and confirmed for Truchet tiling. [source](https://thebookofshaders.com/09/) They also cover fBm/domain warping. [source](https://thebookofshaders.com/13/) Resolume Wire supplied shape/instance/compositing/transport grounding. [source](https://resolume.com/software/wire) TouchDesigner Laser CHOP supplied point/line-path and blanking grounding; these replacements only render raster aesthetics, not laser hardware output. [source](https://derivative.ca/UserGuide/Laser_CHOP)

The design doc retains additional search-grounded links for Chladni, instancing, slitscan, XOR, Risograph and cellular techniques. Do not interpret all of those links as full-page reviews: only the four full-page extracts above were independently recovered during wrap-up. No new web research was run. The sources establish technique inspiration, not physical accuracy or artistic acceptance of these implementations.

## Uploaded review images

Contact-sheet columns: **synchronized silence / modest audio / strong audio / absolute modest diff ×3**. Each row is a different pattern; the three sheets follow the registry's replacement order.

| Patterns | Contact-sheet upload | GIF-derived upload |
| --- | --- | --- |
| 1–6: Simple, Rhythmic, 3D | [Sheet 1](/uploads/e9021925-abb3-4c16-92cb-efd05bd8f89b.webp) | [Comparison 1](/uploads/bfa1cc7b-3503-47ae-ad9c-d840d7b9107d.webp) |
| 7–12: Cinematic, Neon, Video FX | [Sheet 2](/uploads/fe1fa224-4ad7-40be-bba1-195356b860d8.webp) | [Comparison 2](/uploads/998cd60e-0fbc-42f4-b040-a7e1e0e01b68.webp) |
| 13–18: Glitch, Basics, Alphas | [Sheet 3](/uploads/dbad0a76-ab85-43f6-bbd8-ca83a0450b14.webp) | [Comparison 3](/uploads/13f16b36-859c-40b1-818c-36c5bf718424.webp) |

**Upload limitation:** the image tool returned WebP URLs even for GIF inputs, and its displayed previews show only the blank initial timeline frame. Animation preservation/playback through those uploaded URLs is **not verified**. The original `comparison-1.gif` through `comparison-3.gif` were inspected with Pillow: each is **480×691, 24 frames × 50 ms = 1.2 seconds**, with silence/pulsed-audio/diff columns and no audio track. Originals, raw PNG frames, contact sheets, `metrics.json`, `integration.json` and `index.html` remain under `test-results/replacement-evidence/`. They are ignored workspace artifacts, not deployed web pages. Use the contact sheets for reliable immediate chat inspection; no extra server was started.

## Changed files and remaining limits

- Runtime: `src/sketch-registry.js`; six `src/sketches/replacements/*.js` modules; comment-only adjustments in `src/sketches/band-reactive.js` and `src/components/control/library-search.js`. Deleted rejected modules: `alpha-patterns.js`, `basic-patterns.js`, `basics-patterns.js`, `camera-patterns.js`, `lightweight-patterns.js` under `src/sketches/`.
- Evidence: six `tests/replacement-*.spec.js` files; `tests/fixtures/replacement-inventory.json`, `replacement-renderer.js`, `render.html`; `scripts/replacement-contact-sheets.py`. Retired `tests/expanded-patterns.spec.js` and `tests/recent-audio-reactivity.spec.js`; updated `control-panel`, `library-search`, `new-effects-smoke`, `pattern-audio-all` specs and `tests/smoke-patterns.js`.
- Docs: `README.md`, `public/docs/patterns.html`, historical `docs/recent-audio-reactivity.md`, `docs/replacement-mission.md`, and this new `docs/replacement-results.md`. **Only this results file was added during final wrap-up.** Pre-existing `.okbrain/workspace-init.log` remains untouched.

No physical mic/camera/projector checks, long music-set tests, sustained 1080p/4K frame-rate measurements, cross-browser/GPU certification or artistic approval are claimed. Temporal camera history remains 16 frames at 320×180; optics/mechanics are stylized. Saved references to deleted IDs have no alias/migration. Work remains unmerged on `okbrain/bread-viz/123-c1b5c30e`; no deployment or advisor calls.
