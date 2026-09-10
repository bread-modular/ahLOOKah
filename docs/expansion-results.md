# Expansion Wave: 21 New VJ/VFX Patterns + 2 Restored Camera Looks

Date: 2026-09-11. Branch: okbrain/bread-viz/126. Built-ins: **68 → 91**
(50 preserved older + 18 replacements + 21 new expansion + 2 restored).

Nothing was added or changed in **Media** or **Projection Mapping**. All current
patterns, category labels/order, and Checkerboard are unchanged; the expansion
lives in `src/sketches/expansion/` and is appended in `src/sketch-registry.js`
after the replacement wave. The only shared-file edit outside the expansion
module is `src/sketches/replacements/runtime.js` (controller dynamics fix,
explicitly permitted by steering after Astra finished).

## Research basis (verified web sources)

- **Simple** — Lissajous/vectorscan oscilloscope visuals used in VJ shows
  ([source](http://www.dima-vj.com/lissajous/), [source](https://www.audiomasterclass.com/blog/visualizing-stereo-information-using-lissajous-figures));
  pendulum-wave kinetic sculpture
  ([source](https://sciencedemonstrations.fas.harvard.edu/presentations/pendulum-waves), [source](https://en.wikipedia.org/wiki/Pendulum_wave)).
- **Rhythmic** — TR-808 16-step sequencer workflow
  ([source](https://en.wikipedia.org/wiki/Roland_TR-808), [source](https://www.midibox.org/dokuwiki/doku.php?id=trsequencer));
  stutter-edit/beat-repeat buffer manipulation
  ([source](https://en.wikipedia.org/wiki/Stutter_edit), [source](https://www.soundonsound.com/reviews/izotope-stutter-edit)).
- **3D** — voxel heightfield terrain rendering
  ([source](https://github.com/s-macke/VoxelSpace/)); wireframe vector-display
  heritage ([source](https://vectrex.com/understanding-the-vector-display-of-the-vectrex/));
  torus-knot as a demoscene staple ([source](https://threejsdemos.com/)).
- **Cinematic / Shaders** — crepuscular/god rays via screen-space radial
  scattering ([source](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process), [source](https://en.wikipedia.org/wiki/Volumetric_lighting));
  video feedback loops as video art ([source](https://en.wikipedia.org/wiki/Video_feedback), [source](https://rhizome.org/editorial/2009/may/06/the-cybernetic-pioneer-of-video-art-nam-june-paik/)).
- **Neon / Lasers** — ILDA galvo-scanned laser shows
  ([source](https://www.starshinelights.com/blogs/news/laser-scanning-system-stage-laser-safety), [source](https://www.laserfx.com/Works/Works3S.html));
  neon-sign transformer flicker/buzz aesthetics
  ([source](https://www.neonsignsnow.com/guides/do-neon-signs-make-noise-buzzing-humming-sound)).
- **Video FX** — datamoshing (I-frame removal, P-frame smearing)
  ([source](https://glitchology.com/datamoshing/), [source](https://spotlightfx.com/blog/what-is-datamoshing));
  rolling-shutter skew/jello ([source](https://en.wikipedia.org/wiki/Rolling_shutter), [source](https://www.adobe.com/creativecloud/video/discover/rolling-shutter-effect.html)).
- **Glitch / Effects** — VHS tracking/head-switching artifacts and chroma bleed
  ([source](https://www.avartifactatlas.com/artifacts/tracking_error.html), [source](https://modulate.to/effects/vhs/));
  JPEG 8×8 DCT blocking, ringing and mosquito noise
  ([source](https://en.wikipedia.org/wiki/Compression_artifact), [source](https://scanly.co/blog/jpeg-compression-artifacts-explained)).
- **Basics** — broadcast waveform monitors for camera calibration
  ([source](https://en.wikipedia.org/wiki/Waveform_monitor));
  Philips PM5544 circle test card ([source](https://en.wikipedia.org/wiki/Philips_circle_pattern)).
- **Alphas** — stage gobos and gobo wheels in moving lights
  ([source](https://en.wikipedia.org/wiki/Gobo_(lighting)), [source](https://topdancelight.com/what-is-a-gobo-a-complete-guide-to-gobo-in-stage-lighting/));
  audience blinders / ACL bars ([source](https://theatrecrafts.com/pages/home/topics/lighting/glossary/), [source](https://www.reddit.com/r/lightingdesign/comments/wbifs9/is_there_a_name_for_lights_like_these/)).

## The 21 new patterns and their structural band split

Every pattern maps **bass → major movement/scale**, **mid → deformation/geometry**,
**high → fine accents** — documented in each registry `description` and verified
per-band at 0.2 analyzer level by the visuals audit.

| Group | Pattern | Bass | Mid | High |
|---|---|---|---|---|
| Simple | Lissajous Scope | figure swell + drift | X:Y ratio morph | phase dither, ghost trace, sparkles |
| Simple | Pendulum Wave | swing amplitude, string stretch | frequency spread (dephase) | glints, arc ticks, string beads |
| Rhythmic | Step Sequencer | kick-row mass + punch glow | pattern rotation, row shear | hat subdivisions, vertex accents |
| Rhythmic | Stutter Buffer | repeat-region length, ring pump | slice scatter, ring squash | boundary clicks, grain |
| 3D | Voxel Cascade | column extrusion waves | lattice shear, bed yaw | height jitter, top glints |
| 3D | Gyro Lattice | ring radii, core swell | ring precession | rim ticks, traveling beads |
| 3D | Techno Torus (T3D descendant) | knot scale, streak speed | knot winding morph | streak length, vertex sparks, satellites |
| 3D | Techno Helix (T3D) | helix radius, dolly | twist density, rung skew | rung sparks, ghost strand |
| 3D | Techno Array (T3D) | cube scale waves | grid ripple | corner glints, edge flicker, data rain |
| Cinematic | Godray Forge | shaft reach, radiant energy | occluder rotation/density | dust motes |
| Cinematic | Feedback Bloom | per-layer zoom pump | spiral rotation per layer | chroma fringes, monitor grain |
| Neon / Lasers | Galvo Sweep | sweep amplitude | scan-pattern warp | hard flicker, scan dots, tip sparks |
| Neon / Lasers | Neon Sign | glow halo, wall wash | outline morph (bolt↔wave) | tube-wide buzz, dropouts, scan spark, wall seams |
| Video FX | Video Datamosh | macroblock scale, hold strength, P-frame drift | motion-vector warp | block-edge speckle, hairline grid |
| Video FX | Video Rolling Shutter | skew amplitude | wobble waveform | band tears, seam lines |
| Glitch | VHS Head Switch | tear magnitude | band structure, wobble curvature | dropouts, grain, chroma bleed |
| Glitch | DCT Blocks | block scale | coefficient crush, DC scramble/bleed | mosquito noise, ringing flicker |
| Basics | Waveform Monitor | trace gain | signal-shape morph | trace jitter, peak dots, IRE LEDs |
| Basics | Test Card | circle/grid breathing | misconvergence beams, grid misregistration | wedge subdivision/shimmer, castellation swap |
| Alphas | Gobo Wheel | gobo zoom, beam swell | rotation, spoke↔dot morph | rim shimmer, shadow notches, shimmer web, dust |
| Alphas | Blinder Matrix | lamp radius/glow | chase geometry | twinkle, filament glints, orbit sparkles |

Restored from git history (exact prior ids/names/labels from 6fc98ac, subtle by
design — image stays dominant, amount default 0.5): **video-thermal**
("Video Thermal") and **video-edge-glow** ("Video Edge Glow").

## Audio dynamics fix (both controller runtimes)

Diagnosis (GLM + local verification): the merged controller pinned at ~max for
ordinary loud music — `smooth(-82,-30)` saturates on integrated band sums and
`max(canonical, envelope)` never relaxes, so continuous music looked static.

Fix in `replacements/runtime.js` and `expansion/runtime.js` (identical math):
- Support window `smooth(-85,-12)` — loud program material lands mid-scale;
  ±4dB around −32dB now resolves ≈0.13 (was 0.0036; 0.0 around −24).
- Per-band **dB-domain deviation**: primed adaptive baseline (8dB offset,
  2.5s/3.5s asymmetric settle), elevation-above-baseline, and a positive-flux
  onset envelope (0.12s decay). **Bounded sustained** term `lift(min(raw,1.2))·(1−.35·settled)`
  relaxes during unchanging passages without collapsing.
- No output-side smoothing (features are pre-smoothed; onsets land exactly on
  the beat), no fabricated idle beats, no cross-band coupling, sliders applied
  after shaping (linear; 0 = exactly silent), noise-floor RMS gate honored.

## Tests (all green)

- `expansion-inventory.spec.js` — 21+2 provenance, 91 unique built-ins, group
  counts (2 per category + 3 Techno 3D descendants in 3D), schema/params/order.
- `expansion-visuals.spec.js` (21) + `replacement-visuals.spec.js` (18) —
  per-pattern audit: bit-exact duplicate silence, exact zero-disables and band
  independence, modest/strong/pulse visibility floors, per-band structural
  response at 0.2 (rgb>2, coverage>3.5%, edge>0.6%, relocation>12%), max-audio
  bounds, Alphas grayscale.
- `expansion-audio.spec.js` / `replacement-audio.spec.js` — knee linearity,
  RMS gate, Hz-split at 44.1/48/96kHz, once-per-view caching, immediate mute,
  standalone==capture at 30/60/120fps (bit-exact), engine/schema/store
  revisions, stale/owner-loss neutrality, weak-fresh-treble recovery
  (canonical reads ~0; support still moves geometry), real noise-floor capture.
- `band-dynamics.spec.js` — loud continuous/broadband: no window saturation,
  20dB steps resolvable, constant passages relax (<0.7 of peak), time-varying
  modulation depth >0.3 with pulse coherence >0.65, bass-step independence,
  exact silence/mute, half-gain linearity, both controllers agree to 1e-9.
- `expansion-musicality.spec.js` — 120 BPM arrangement through the real
  engine/store: deep, beat-coherent (rise-based, >0.6), unsaturated
  (pinned <0.45) band modulation; renderer-visible beat frames.
- `expansion-integration.spec.js` — real Web Audio → analyser → noise floor →
  engine → store → all 23 renderers (48 accepted packets × 23); real GPU alpha
  compositing of Gobo Wheel / Blinder Matrix (blue reveal >0.2, white >0.02).
- `expansion-lifecycle.spec.js` — 4 camera FX: shared capture, per-band
  causality, exact mute, silence stability, canvas/capture disposal.
- `expansion-restored-camera.spec.js` — exact restored identity/schema,
  per-band measurable response with zero-disable, image dominance >60%.
- `expansion-bounds.spec.js` — min/max params at max gains, resize, nonfinite
  geometry guard (46 renders).
- Count/provenance updates: `replacement-inventory.spec.js` (91; restored pair
  re-present), `control-panel.spec.js`, `library-search.spec.js`,
  `pattern-audio-all.spec.js` (91 through the controls-only transport),
  `new-effects-smoke.spec.js` (+23 smoke renders).
- Full `@core` suite: 306 passed; `@patterns` suites listed above all pass;
  `vite build` clean.

Evidence: `docs/expansion-evidence/sheet-*.png` (silence / modest / strong /
diff per pattern, pulse-locked animation frames, restored-pair stills,
alpha-composite PNGs in `test-results/expansion-evidence`).

## Changed semantics (documented, not a regression)

Controller outputs for **constant** signals are intentionally relaxation-shaped
(settle toward a bounded floor) instead of permanently pinned near maximum;
**deviation (change within a band) now dominates**. Constant-level audit
thresholds were not lowered: the same floors pass with causal dynamics.

## Limitations

- Datamosh bass response is invisible on a perfectly static camera by physics
  (stale blocks of a still image are identical); its bass mapping is verified
  on the moving fixture and via macroblock rescale + P-frame color drift.
- The restored pair is deliberately subtle; full structural floors apply only
  to the 21 new patterns (restored pair has its own measurable-response spec).
- Support dB deviation primes 8dB below first observed level; a track starting
  mid-drop relaxes over ~2s before steady-state deviation tracking.
- Harness fixtures drive features-only (no support frames); production dynamics
  are covered by engine-level and real-WebAudio integration tests instead.
- No deployment was performed or verified; local revision only.
