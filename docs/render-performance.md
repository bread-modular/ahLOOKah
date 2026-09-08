# Mapping and media performance

## What changed

- **Bounded mapping passes.** Each projection surface scissors GPU work to its
  physical-pixel bounding box instead of shading the entire output. Rotated and
  perspective surfaces retain the existing 4×4 integration, edge coverage,
  premultiplied blending, surface order and black background.
- **Fast full-frame path.** An identity mapping with a non-minified source uses
  one texture sample per pixel rather than sixteen. Enabling edge smoothing
  alone no longer forces expensive 4×4 resampling. Native output resolution is
  unchanged; actual warps and minification still use the quality path.
- **Cheaper feathering.** Coverage is computed once per subpixel, not separately
  for RGB and alpha. CSS masks are enabled only during GPU failure, never on
  hidden source canvases during normal GPU presentation.
- **Cache and invalidation.** Geometry, inverse transforms and CSS presentation
  styles are reused until corners, smoothing, canvas identity or size change.
  Texture mipmaps are generated only when needed, once after the latest upload.
- **Media frame reuse.** Static images/placeholders no longer repaint or upload
  every display tick. Videos invalidate on decoded-frame callbacks (with frame
  count/current-time fallbacks), and draw directly from the video element into
  the presentation canvas, avoiding p5's extra intermediate video canvas copy.
  Animated GIFs retain their animation path. Framing/speed edits and resize still
  invalidate immediately. Independently assigned sources keep independent controls.
- **CUE lifecycle.** Parked media decoders pause with their runtime and resume
  for fresh-frame requests/TAKE. Control packets continue to be read on p5 ticks
  even if an image's pixels are unchanged, so skipping uploads cannot deadlock
  the CUE/TAKE freshness gate. Geometry-only presentation is revision-gated too.
- **Local startup cleanup.** Analytics is now production-only; development no
  longer attempts to load the external debug script blocked by the local CSP.
- **Less diagnostic churn.** A `first-draw-completed` timing is now recorded once
  per child rather than allocating and shifting the timing log every frame.

## Compatibility with local main updates

Integrated local `main` at `57fa078` (mapping drag-and-drop, mixed-program global
calibration, and Alpha Blend) without removing the optimizations above.

- Full-frame resampling preserves source alpha, including when only ordinary
  inputs in a mixed projection/ordinary program receive global calibration.
- Alpha Blend still removes black before filtering/minification. Raw and keyed
  textures track mipmap invalidation separately; unchanged media reuses both.
  The keying prepass reads the current base level after source resize, without
  depending on an old mip chain. CSS alpha filters and masks run only in fallback.
- Calibrated ordinary inputs also skip unchanged media uploads and include their
  mapping submission in their own pattern's performance budget. Geometry edits,
  parked-source re-enabling, and CUE/TAKE freshness gates remain supported.
- Regression coverage includes real mixed-program image/video reuse, independent
  alpha/raw mipmap invalidation, fast-path transparency, and CSS/GPU equivalence.
- The full suite exposed an existing Alpha Blend test expectation that also
  fails on unmodified `57fa078`: a point outside the ordinary input's global
  calibration incorrectly expected blue. That expectation now requires black
  in both GPU and CSS fallback; alpha must not bypass global calibration.

## Performance indicators

Active pattern tiles in the pad/library and individual mapping rows show a
**LIVE CPU budget** badge. Parameter panels show the budget bar, measured
milliseconds against a 16.67 ms / 60 Hz target, and output animation-frame cadence.
The status line shows aggregate CPU rendering and output FPS. Updates are limited
to once per second and do not trigger selection/parameter synchronization.

These are **measured main-thread draw/capture/compositor-submission timings**, not
GPU utilization, total browser CPU, or decoder utilization. Projection pattern
cost includes its children and mapping submission; individual surface costs omit
the shared compositor. Per-input mapping in mixed programs is attributed to that
ordinary pattern. Global output mapping is counted once in the output total.
Warm-up and control-preview work are not attributed to LIVE patterns. The output
cadence can reveal stalls due to work outside the measured CPU sections, but is
not a video decode/presented-frame counter. A low CPU badge is not a promise of
GPU headroom. Stale data expires after three seconds; CUE does not display LIVE
measurements as if they were CUE measurements.

No new surface limit, automatic downscaling or source-sharing policy was added.
Many videos can still be constrained by their resolution, codec, independent
hardware decoder capacity, memory bandwidth, CUE warm-up, and full-size source
buffers. Test the actual show on the projector machine.

## Synthetic before/after check

Baseline: `7cdf363e3733e1f103040b36db94ba35e51421b1`.
These measurements predate the local-main integration above and do not benchmark
the new Alpha Blend prepass or mixed-program calibration.
Headless Chromium / ANGLE SwiftShader (software rendering), 960×540 output and
source canvases. Every source is uploaded each frame; medians of 28 measured
frames per version, after warm-up, with alternating before/after runs. A one-pixel
readback forces completion **in the benchmark only**. Neither production rendering
nor the budget indicator introduces a synchronous GPU wait or readback.

| Mapping workload | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| One full-frame surface, smoothing off | 93.5 ms | 5.3 ms | 94% |
| One full-frame surface, 12% smoothing | 95.6 ms | 5.3 ms | 94% |
| Eight tiled, warped surfaces, smoothing off | 245.9 ms | 90.0 ms | 63% |
| Eight tiled, warped surfaces, 12% smoothing | 251.1 ms | 92.2 ms | 63% |
| Eight full-frame overlapping surfaces, 12% smoothing | 844.5 ms | 39.6 ms | 95% |

These numbers isolate mapping/upload work on a software renderer. They are **not
end-to-end playback FPS or guaranteed speedups on a physical GPU**. The small
smoothing-on/off difference here suggests the resampling path and repeated
uploads were larger contributors than the feather arithmetic itself.

Reproduce with an otherwise idle host:

```bash
npm run dev -- --port 5273 --strictPort
BENCHMARK_URL=http://localhost:5273 node scripts/benchmark-mapping.mjs 7cdf363e3733e1f103040b36db94ba35e51421b1
```

Regression coverage is in `tests/mapping-performance.spec.js` and
`tests/render-performance.spec.js`, plus the existing mapping pixel/AA, media,
merge, CUE and audio-control suites. New checks cover scissor area and invalidation,
lazy mipmaps, static upload suppression, real image/video readiness, decoder
pause/resume/disposal, GIFs, telemetry aggregation, LIVE/CUE separation and expiry.

For route-stubbed E2E tests, start a **fresh Vite server** after editing source.
Vite's HMR `?t=...` imports can bypass fixture routes ending in `.js`, so reusing
an already-hot server can silently run the real source instead of a delayed
media fixture. With the chosen port free, `CI=1 PLAYWRIGHT_PORT=5273 npm test`
lets Playwright own a fresh server and tear it down after the run.
