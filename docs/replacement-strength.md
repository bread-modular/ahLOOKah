# Replacement audio structure — workspace 125

**Scope:** improve only the existing replacement designs from `9f707fe`. Production changes are confined to `src/sketches/replacements/{runtime,graphic,fields,spatial,video}.js`. No registry, replacement index, shared inventory, older renderer, category, Media, or Mapping implementation changes. No advisor and no merge.

## Review the actual pictures

- [Before/after animated gallery](replacement-strength-review.html): every pattern, four equal-time columns — silence / bass / mid / high. Expand “Before” to see the actual `9f707fe` implementation through the same recorded analyzer frames.
- Contact sheets: [mechanisms/graphics](replacement-strength-assets/contact-1.png), [fields/glass/iris](replacement-strength-assets/contact-2.png), [mattes/3D/video](replacement-strength-assets/contact-3.png).
- [Full per-pattern measurements](replacement-strength-assets/metrics.json). The 0.8-second loops contain two weak pulses; the end-to-start jump is the review loop, not an effect discontinuity. Animated assets are compressed review copies; numerical comparisons use original 320×180 RGBA render buffers.
- With the isolated development server running, open `/docs/replacement-strength-review.html` on port 5275. These review documents are not added to the application's public documentation navigation or production inventory.

## Why the previous test passed while the signal failed

Studied the actual implementations, not their descriptions:

- `techno3d.js` uses byte-spectrum averages, interpreted on the relatively generous -100…-30 dB byte scale. Core size, core mode/grid, and perspective line length are visibly different structures. Its thresholds/legacy behavior were **not** copied or changed.
- `ion_tempest.js` maps both sustained features and short kick/snare/hat envelopes into different lightning systems, sparks and a shock ring. That motivated separate silhouette, articulation and detail responses, not another universal brightness pulse. Its fabricated idle beats were deliberately **not** imported.
- `AudioManager.configureAnalyser()` uses FFT 2048 and smoothing 0.12; the float path reads actual dB spectra and full float waveforms, then applies captured noise-floor subtraction and cleaned RMS.
- The canonical extractor averages **power per bin**, uses different per-band dB windows, compensates input gain with a 2.4-second upward / 0.4-second downward adaptation, gates RMS with `smoothstep(-72, -48, rmsDb)`, then follows bass/mid/high with 22/30/12 ms attacks and 170/200/100 ms releases.
- The old replacement controller lifted canonical levels with knee 0.35; the renderer then compressed **again after the slider** using `x / (1 + x)`. The earlier primary visual fixture injected `0.2` directly as a canonical feature; its raw-frame fixture paired spectra with RMS `0.1`. Neither represented a weak input following a loud passage.

### Actual reproduction

`tests/fixtures/replacement-pipeline.js` creates three oscillators inside each selected band, feeds **real Web Audio AnalyserNodes configured by AudioManager**, and calls the production `getAnalysisFrame()`. No spectral array, normalization function, or envelope is mocked in this acquisition. The source is inaudible (zero-gain output sink); it does not acquire a microphone.

The sequence primes gain with 18 frames at -22 dBFS RMS, leaves a 12-frame gap, then emits -60 dBFS RMS pulses with -74 dBFS tails. Three harmonics exercise sparse band content; real windowing and spectral leakage remain present. The actual analyzer peaks during the weak passage are around -74 to -75 dB. After the preceding loud passage, canonical bass/mid can fall below 0.001 and treble below 0.000001 **while new pulses are arriving**. This is not merely a small multiplier: per-bin averaging plus a still-low adaptive gain can put the band below its normalization window. Treble suffers most because it is averaged over many more bins. The remaining tiny canonical numbers are largely old release tails, not a useful pulse train.

The new measurements use the real controller engine, schema validation and store interpolation (33 ms, the production default), rather than feeding renderer uniforms directly from an optimistic feature constant. The separate existing integration test also exercises actual AudioManager stream acquisition through a generated MediaStream, then the real alpha compositor.

## Replacement-only correction

`runtime.js` owns a new local controller; the shared `band-reactive.js`, feature extractor, schemas and slider declarations remain untouched.

1. Preserve canonical features, but supplement them with **integrated cleaned spectral power in the current user-selected Hz bands**. This avoids diluting a sparse treble event across hundreds of empty bins. Map the integrated dB window -82…-30 and apply the same -72…-48 RMS gate. Honor the noise-floor module's cleaned `frame.rms`; never recover sound from a deliberately gated frame.
2. Cache this extra measurement once per `SharedAudioAnalysisView`, shared by all replacement LIVE/CUE/merge controllers. It adds one bounded spectrum traversal per capture tick, not one per pattern, and **no new FFT or output-side analyzer read**. Standalone use gets the identical controller through a local reader.
3. A finite-slope weak-level knee plus a linear loud shoulder retains headroom. The supplemental response has separate bass/mid/high attacks of 12/18/8 ms and releases of 110/140/65 ms. Canonical features already carry their own smoothing; they do not receive a second local smoothing stage. The controller takes the greater available per-band response, never total energy or another band's onset.
4. Apply the selected band gain **after** shaping/following. Renderer conversion is linear (`control / 3.2`), so 0.5 is precisely half the modulation, 2 is twice it, and 0 eliminates it even with a held envelope. Each output is finite and bounded. No hidden minimum gain or autonomous audio pulses.
5. Canvas and shader procedural phases integrate Motion Speed; setting it to zero pauses the existing phase without snapping shader time back to zero. Audio deformation and an incoming camera remain active independently. Silence means the ordinary, non-audio animated design, not a forced black screen.

This preserves the real silence/noise policy. It cannot make an input below the RMS gate audible, nor should it. Calibration is still important for a genuinely noisy room/interface; stronger response also makes **uncalibrated** noise above that gate more visible.

## Three distinct mappings per pattern

All audio sliders retain their original keys, ranges and defaults. The same visual identities, palettes and categories remain; some neutral proportions were adjusted to leave room for the stronger excursions.

| Pattern | Bass: large structure | Mid: articulation / deformation | High: separate detail structure | Non-audio detail control |
|---|---|---|---|---|
| Counterweight | Swings and lengthens alternating upper levers | Curls lower joints with different relative phases | Opens and extends counterweight jaws | None; Motion Speed and Palette Hue remain |
| Ratchet Wheel | Expands gear body and moves the side pawls | Advances gear/spokes and hinges pawls | Extends teeth and reciprocating strikers | Tooth Count |
| Vector Knot | Expands three knot lobes | Tilts depth and reshapes the projected crossing | Separates three tracks along their local normals, with traveling corrugation | Beam Width |
| Prism Scanner | Moves incident launch height and internal bounce | Moves the strike point and turns the refracted system | Opens a much wider nine-beam fan | None; Motion Speed and Palette Hue remain |
| Riso Misprint | Pulls subtractive plates out of registration | Shears the different print plates | Tears gaps and displaces individual horizontal strips | None; Motion Speed and Palette Hue remain |
| Barn Doors | Opens overall aperture width | Rotates and displaces the aperture hinge | Splits it into five separated, alternating sliding louvers | Aperture Aspect |
| Iris Diaphragm | Opens the polygonal matte | Turns and squeezes the blade assembly | Perforates the center and unfolds alternate pointed blade tips | Blade Count; grayscale only |
| Truchet Relay | Inflates connected tracks | Moves/reconnects complete tiles | Separates additional inset rails | Tile Scale |
| Membrane Modes | Bows the membrane/nodal field coherently | Turns and shears the nodal lattice | Fractures smooth nodal lines into fine rippled ridges | Mode Scale |
| Schlieren Flow | Deepens broad fluid-domain displacement | Twists the field by radius rather than globally zooming it | Multiplies fine contour ridges | Flow Scale |
| Tidal Glass | Separates the main glass bodies | Lifts and turns the upper lobe | Corrugates the actual raymarched surface and its normals | Surface Frequency; most apparent during treble |
| Bitplane Rewire | Enlarges address blocks | Displaces addresses by scanline | Rewires row strides into fine digital breakup | Address Density |
| Stair Wipe | Translates the reveal with bounded travel | Turns its diagonal axis | Unfolds deeper/coarser staircase teeth | Step Count |
| Cellular Gate | Dilates Voronoi walls | Moves cell sites/reconnects boundaries | Cuts walls and opens independent internal ring vents | Cell Scale; grayscale only |
| Pin Relief | Extrudes a traveling height wave | Slides rows sideways and yaws the whole bed | Shrinks/separates pin caps and adds small cap chatter | Pin Density |
| Folded Spire | Expands the body radius | Bends the centerline and twists successive floors | Unfolds alternating pleated rings | Fold Count |
| Video Slit Scan | Deepens finite frame history by ribbon | Shears broad ribbons horizontally | Subdivides and combs alternating ribbons | Slice Count |
| Video Facet Fold | Expands/displaces facet crops | Hinges opposing triangles on one axis | Shears and separates crops on the other axis | Facet Count |

No band controls brightness alone. Quantized structures (tiles, byte addressing, teeth/slices) intentionally have discrete topology changes; continuous gain does not promise every single slider increment changes an integer count. Video Slit Scan's bass is **temporal**: it needs a moving camera source to reveal a history difference. A perfectly stationary source is a real limitation, not a reason to inject fake motion into its bass channel.

## Validation and actual runs

**48 distinct focused tests have passing final results across the runs below, not a claimed single clean 48-test invocation.** No repeated full suite or performance/mapping sweep was run.

| Run | Actual result |
|---|---|
| `replacement-audio`, `replacement-strength`, `replacement-bounds`, one worker | 24 selected; 21 passed initially. Cellular Gate treble was still too weak, Slit Scan bass narrowly missed the weak-feature floor, and Folded Spire hit a dynamic-import fetch failure. |
| Focused strength rerun: Cellular Gate / Folded Spire / Slit Scan | **3 passed (18.3 s)**. Added real internal vents and increased bounded history reach, without lowering acceptance thresholds. Used the retained actual analyzer recordings. |
| `replacement-audio`, `replacement-visuals`, `replacement-integration`, `replacement-lifecycle`, one worker | 29 selected; 27 passed initially. Max-gain Stair Wipe could leave the frame; Iris treble coverage was marginal. |
| Strength + previous visual regression for Iris / Stair / Spire after visual review and fixes | **6 passed (22.7 s)**. Bounded wipe travel, enlarged/perforated iris, and visible spire centerline bending. |
| Final bounds + real stream/alpha-compositing integration | **2 passed (9.9 s)** on the final geometry. |
| Final complete focused strength file, retained real recordings, production-default interpolation | **18 passed (1.8 min)**; all 54 band cases. Preliminary replay used a conservative 35 ms delay; the final fixture leaves the setting to the real store default (33 ms) and asserts that value. The replay delay is no longer test-overridden. |
| After discovering/fixing the renderer-fixture frame-zero readiness race | **37 passed (2.6 min)**: all 18 weak-pipeline, all 18 prior visual, and stream/alpha integration cases. The bounds case hit a Vite reload/navigation failure; its isolated rerun **passed (3.2 s)**. Final gallery and metrics use this corrected, fully painted frame sequence. |
| `npm run build` | **Passed**. Existing warning: minified chunks exceed 500 kB. |
| `git diff --check` | **Passed**. |

Commands, from the workspace root (use an isolated port):

```sh
PLAYWRIGHT_PORT=5275 npx playwright test tests/replacement-audio.spec.js tests/replacement-strength.spec.js tests/replacement-bounds.spec.js --workers=1 --output=test-results/replacement-focused
PLAYWRIGHT_PORT=5275 npx playwright test tests/replacement-visuals.spec.js tests/replacement-integration.spec.js tests/replacement-lifecycle.spec.js --workers=1 --output=test-results/replacement-regressions
npm run build
python3 tests/replacement-review.py
```

The optional review generator needs Pillow; it reads saved artifacts and does **not** rerender or rerun audio. A targeted rerun can use `REPLACEMENT_REUSE_CAPTURE=1` to replay retained actual analyzer acquisitions; omit it for fresh Web Audio capture. The comparison fixture extracts baseline files using `git show 9f707fe:...` into ignored `test-results`, never checkout/overwrite production files. New focused tests enumerate the owned module exports, not the parallel worker's registry inventory.

### What is checked

The old p5 fixture resolved from inside `setup()` before p5 finished its async lifecycle, so it captured an unpainted transparent frame zero and raced the first control read. Waiting for the initial **completed unarmed redraw** fixes this without advancing effect time, camera history, or audio. Every captured frame now asserts an opaque painted corner. This also removes an artificial black flash from the review loops. Reusing a Vite server immediately after edits can separately trigger a one-off module reload; use a fresh isolated port or rerun only that interrupted case, not the full suite.

- All **54 pattern×band** combinations have real weak-analyzer animated comparisons, plus independently injected 0.015/0.001 canonical-feature pulses. The former expose the normalization failure that the latter alone cannot find.
- Per-frame normalized edge relocation; a 6×4 spatial grid of four oriented edge directions; foreground occupancy/moments; and **temporal edge residual after subtracting equal-time autonomous/source-camera motion**. Not just changed RGB pixels. Equal-input band pairs must also have different geometry signatures.
- The real weak-pulse comparisons relocate approximately **25–98% of the union of detected edges** across the measured pattern/band cases. These are image-analysis proxies, **not** “percent better looking.” See JSON for exact per-case data and thresholds.
- Zero-all matches animated silence byte-for-byte; the previous rendered suite also checks each individual mute and preservation of the other bands. Gain linearity holds through final geometry at 0, 0.05, 0.25, 0.5, 1, 1.5 and 2.
- Cleaned RMS hard gate, genuine noise-profile capture/subtraction, right-only input, 44.1/48/96 kHz Hz-based split behavior, live crossover change, 30/60/120 Hz envelope equivalence, standalone/bound shader parity, no bound output FFT reads, live Motion Speed zero, revision handling, stale/owner-loss neutral decay.
- Min/max visual parameters at max gain and resize produce finite geometry. Max gain retains lit and dark areas; Alphas remain opaque grayscale and pass the application's actual black-key alpha compositor.
- Existing camera lease/CUE handoff/denial cleanup and Checkerboard invariance pass. Media and custom Mapping source files are untouched; their full unrelated suites were not rerun.

### Limitations / honest review boundary

This uses real browser analysis of **generated three-tone pulses**, not a recording from the user's music/interface/room. Software Chromium/SwiftShader at 320×180 verifies bounded rendering and structural response, not projector contrast, physical latency, GPU frame-rate guarantees, or a long live set. Fixed-step replay separates audio effects from timing races but does not simulate every packet-jitter pattern. The extra capture-side spectrum traversal is cached; it was not separately benchmarked on low-power hardware.

Human inspection caught that the earlier iris and spire comparisons could be numerically different yet visually insufficiently distinct; those were strengthened and selectively rerun. Metrics are regression guards, not a substitute for the user's visual/audio review. User hardware validation remains outstanding; there was no implementation blocker. The original workspace initialization log change was present before this work and was left alone.
