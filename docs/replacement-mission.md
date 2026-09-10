# Replacement mission — workspace 123

## Scope and provenance

Base: `01e798a`. Inspected **addition diffs** of `7ebcd47` (20 entries) and `cbee609` (40 entries); the intervening reactivity work added none. The [superseded audit](recent-audio-reactivity.md) retains the exact historical ID list. `tests/fixtures/replacement-inventory.json` pins all 60 removed IDs, the 50 retained registry signatures, and SHA-256 digests of the older implementation files.

**110 − 60 + 18 = 68 built-ins.** Checkerboard was an older modified entry, not one of the 60; it remains static. Ion Tempest and every older implementation are byte-unchanged. The first 50 registry entries, their order, metadata, defaults and schemas are unchanged. Category labels/order remain Simple, Rhythmic, 3D, Cinematic / Shaders, Neon / Lasers, Video FX, Glitch / Effects, Basics, Alphas, Media, Projection Mapping. **Zero additions/removals in Media or custom Projection Mapping.** No storage migration or deletion of saved settings/custom patterns is performed; references to retired IDs cannot resurrect their implementations.

| Visual category | Retained | Removed | Added | Final |
| --- | ---: | ---: | ---: | ---: |
| Simple | 3 | 9 | 2 | 5 |
| Rhythmic | 6 | 6 | 2 | 8 |
| 3D | 7 | 6 | 2 | 9 |
| Cinematic / Shaders | 13 | 6 | 2 | 15 |
| Neon / Lasers | 5 | 6 | 2 | 7 |
| Video FX | 6 | 9 | 2 | 8 |
| Glitch / Effects | 5 | 6 | 2 | 7 |
| Basics | 5 | 4 | 2 | 7 |
| Alphas | 0 | 8 | 2 | 2 |
| **Total** | **50** | **60** | **18** | **68** |

## Research → independent concepts

These are original implementations informed by the linked techniques, not copied patches, 18 palette swaps, or renamed versions of removed implementations. The technical inspiration is not a claim of physical simulation accuracy.

| Category | Two concepts and structural band roles (Bass / Mid / High) | Technique grounding |
| --- | --- | --- |
| Simple | **Truchet Relay**: connected quarter-circle tiles; path width / tile reconnection and row shift / inset-rail separation. **Counterweight**: double-jointed hanging levers; arm swing / joint articulation / jaw opening. | Truchet tiling uses local transforms and orientation rules. [source](https://thebookofshaders.com/09/) Wire combines and animates simple shapes. [source](https://resolume.com/software/wire) |
| Rhythmic | **Membrane Modes**: nodal sand field; orthogonal mode tuning / other axis tuning / higher-frequency fracture. **Ratchet Wheel**: escapement and pawls; gear expansion / angular advance / tooth and striker travel. | Standing-wave nodal patterns motivate the membrane, rather than another spectrum bar reskin. [source](https://www.dynamicmath.xyz/chladni-patterns/) Wire's transport tools motivate rhythmic geometric mechanisms (our wheel is envelope-driven, not a new BPM detector). [source](https://resolume.com/software/wire) |
| 3D | **Pin Relief**: painter-sorted extruded pin bed; height waves / ridge shaping and yaw / cross-section. **Folded Spire**: connected triangulated floors; body radius / floor-to-floor twist / alternating pleat depth. | Instancing repeats geometry with independent transforms; here bounded CPU-projected faces provide actual perspective/depth. [source](https://docs.derivative.ca/Instance) Mesh deformation is a distinct construction from a flat radial tunnel. [source](https://www.davepagurek.com/programming/shader-domain-warping/) |
| Cinematic / Shaders | **Schlieren Flow**: warped density/ridge field; flow distortion / field orientation / fine contour splitting. **Tidal Glass**: smooth-union raymarched lobes with reflected/refracted shading; body separation / upper-lobe lift and turn / lower lobe and corrugations. | fBm domain warping supports organic fields. [source](https://thebookofshaders.com/13/) Distance fields support shape construction; our glass uses bounded sphere tracing and stylized optics. [source](https://thebookofshaders.com/07/) |
| Neon / Lasers | **Vector Knot**: sampled 3D torus-knot tracks; lobe deformation / tilt and depth / track separation. **Prism Scanner**: incident beam and refracted path bundle; launch height / strike point / outgoing angular separation. | Laser CHOP represents shapes as point/line paths and handles blanking between paths. These are raster light-path aesthetics only, **not hardware laser output or safety software**. [source](https://derivative.ca/UserGuide/Laser_CHOP) |
| Video FX | **Video Slit Scan**: real finite frame history; temporal depth / ribbon shear / alternating-age subdivisions. **Video Facet Fold**: independently clipped triangular camera crops; crop expansion/offset / opposite facet hinge / second-axis shear. | Slitscan combines image slices across time. [source](https://derivative.ca/community-post/tutorial/slitscan/62945) Wire's shape/compositing routing motivates the separate spatial facet construction. [source](https://resolume.com/software/wire) |
| Glitch / Effects | **Bitplane Rewire**: explicit 8-bit XOR address texture; address scale / byte offset / row stride. **Riso Misprint**: subtractive overprinted glyph plates; misregistration / skew / torn-out strips. | XOR arithmetic generates digital texture topology. [source](https://invisiblewater.github.io/MattGraphicsTutorials/textures/xor.html) Separate Risograph ink passes introduce registration differences. [source](https://campus.collegeforcreativestudies.edu/imaging-center/category/ic-main-guide/ic-riso-printing/page/2/) |
| Basics | **Barn Doors**: hard rectangular stage aperture; width / orientation and lateral position / height. **Stair Wipe**: quantized diagonal reveal band; translation / axis angle / staircase subdivision. | Shape fields and coordinate transforms are practical reusable building blocks, intentionally simpler than the cinematic entries. [source](https://thebookofshaders.com/07/) |
| Alphas | **Iris Diaphragm**: grayscale polygon/blade matte; opening / blade rotation and squeeze / scalloped aperture. **Cellular Gate**: Voronoi channel matte; wall dilation / site displacement / internal channel perforations. | Cellular noise supplies nearest-site distances. [source](https://thebookofshaders.com/12/) VJ compositing distinguishes luma-as-alpha from keys; this app's existing Alpha Blend is specifically a **black key**, not proportional luminance opacity. [source](https://resolume.com/support/en/blend-modes) |

## What was learned from Ion Tempest

Read `src/sketches/ion_tempest.js`, including both controller and shader. Its strength is a coherent layered scene with different musical jobs: warped lightning trunks/forks, cloud body, corona sparks, shock ring and ground sheet; attacks reveal recognizable structure, not merely an overall exposure ramp. The replacements adopt **macro form / articulation / fine structure** roles without copying the lightning scene. Ion's own legacy idle behavior, Punch mapping and shader remain untouched. New patterns deliberately **do not inherit synthetic idle beats** or cross-band transient feedback that would defeat a muted band.

## Architecture and limits

- Existing `reactiveEntry`, band schema, capture-side controller, shared analysis, revision-aware packet/store bindings and `makeAudioShader` are reused. The renderer reads the binding once per draw and never scans output-side FFT data. Older Bars' linear `scaleBands`, shared slider defaults, and the audio pipeline are unchanged.
- The existing finite-slope soft knee lifts a feature of 0.2 to approximately 0.709. Each independent 0–2 slider scales its own band, yielding 0–3.2. The new geometry maps use `x / (1 + x)` after that, bounded below 0.762. A slider's control gain is linear, **not a promise that geometric displacement doubles**. Zero and no-input remain exactly zero; malformed inputs are bounded. Existing attack/release and stale/owner-loss decay remain in the shared pipeline.
- A fresh factory starts animation phase and camera history at zero. Baseline motion has its own speed. No randomness or persistent global scene state is added. No generic brightness multiplier depends on audio.
- Geometry budgets are fixed or parameter-bounded: pin bed at most 11×11×3 faces; spire at most 13×8×2 triangles; knot 421 points per track; glass at most 42 marching steps; cellular field 9 neighbor sites. Temporal camera history is exactly 16×320×180 RGBA frames (about 3.52 MiB) plus a crop buffer. It is instance-local and released on removal. Both Video FX use the existing shared camera lease.
- No runtime dependencies, global processing changes, category changes, Media code changes or Projection code changes. The five rejected implementation modules and their registration spreads are deleted, including their local control maps. Obsolete rendering tests are replaced, useful band/Checkerboard/camera lifecycle regressions retained, and UI/search/smoke counts corrected.

## Validation method

`tests/fixtures/replacement-renderer.js` creates **real p5 Canvas2D/WebGL instances** at 320×180. Every condition starts with a new factory/controller/camera history, advances 24 identical 50 ms steps, and leaves default Motion Speed enabled. A deterministic **animated** canvas camera fixture supplies the same frame at the same index. Duplicate silence, every isolated mute, all-zero sliders and each “mute one band with the other two active” pair are checked across **every RGBA byte of all 24 frames**. Chromium's adaptive Canvas2D GPU→CPU readback promotion initially introduced resampling differences, so this measurement harness requests `willReadFrequently` from the first 2D context creation; production rendering is not changed.

RGB/coverage/edge means use synchronized frames 8, 12, 16, 20 and 23 (0.45, 0.65, 0.85, 1.05, 1.20 s). Cases: silence twice, modest 0.2, strong 0.85, 3-frame-on/5-frame-off pulses at 0.85, max 1.6 with 2× sliders, each isolated band at 0.2, and independent mute controls. Autonomous silence-frame motion is reported separately, never counted as audio response. Min/max visual controls and resize to 480×270 are additional safety tests, not frozen-motion A/B evidence.

Acceptance floors were set before tuning and not weakened:

- Modest combined: RGB mean absolute difference >6/255, changed pixel area >10% (any RGB component difference >16), normalized-luma edge XOR >1.5% of frame.
- Every individual band: RGB MAD >2, coverage >3.5%, edge XOR >0.6%, relocation >12% of the union of normalized edge pixels. Per-frame luma normalization prevents a uniform exposure gain from passing as geometry.
- Strong/pulsed: RGB MAD >3 and coverage >5%; extreme audio retains lit and dark areas. Alphas remain opaque grayscale-on-black.
- Exact duplicate/zero/mute neutrality: maximum byte difference **0**. The tests also catch WebGL errors, nonfinite Canvas geometry, absent camera readiness, leaked leases and stale registry counts.

The thresholds are fixture-specific engineering gates, not a universal perceptual score or proof of artistic preference. See [numerical results](replacement-results.md) and the generated contact sheets for the actual visual evidence.

## Reproduction and workspace boundary

Run the README's `tests/replacement-*.spec.js` command, then `python3 scripts/replacement-contact-sheets.py` (Pillow). Generated artifacts are ignored under `test-results/replacement-evidence/`, not bundled or committed. `index.html`, `contact-1.png` through `contact-3.png`, `comparison-1.gif` through `comparison-3.gif`, `metrics.json`, and `integration.json` are the review entry points. GIFs contain visual comparisons, not an audio track. Raw PNG timelines remain available for closer inspection.

All work remains in isolated workspace 123 on `okbrain/bread-viz/123-c1b5c30e`. **No merge, deployment, advisor or other-agent calls.** The pre-existing dirty `.okbrain/workspace-init.log` was left untouched. Physical mic/camera/projector validation, long music sets, and sustained 1080p/4K GPU performance are not claimed. Camera history resolution is intentionally limited, optical/physical constructions are stylized, and a deleted pattern's saved reference has no replacement-ID alias.
