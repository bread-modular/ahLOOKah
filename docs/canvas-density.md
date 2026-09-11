# Canvas density candidate fix: live preview and output

> **NOT cleared for merge.** The user reports Ubuntu working but macOS still
> broken on their current fixing branch. All proof below is Linux/Chromium;
> native macOS and Safari remain unverified. The Linux root cause is established,
> but must not be presented as a complete diagnosis of the remaining Mac failure.

## Verified cause of the Linux reproduction

The described top-left rectangle/ghosting was reproduced in the actual control
panel and output window with Pendulum Wave, with the BGLM changes still present.
That reproduction is a **backing-density / drawing-transform mismatch**, not an
aspect-fit bug.

- The installed p5 creates a new renderer in `createCanvas()`. Calling
  `pixelDensity(1)` before it only configured the discarded default renderer.
  On a DPR 2 display the replacement renderer therefore had a 2× backing store.
- Both wave Canvas2D factories then called native `ctx.setTransform(1,0,0,1,0,0)`.
  That discarded p5's density transform but continued drawing and clearing with
  logical `p.width` / `p.height`. Only the upper-left quarter was cleared.
- Shapes extending outside that logical rectangle were not erased on subsequent
  frames, producing the observed accumulated bob/string ghosts. Transparent
  areas exposed the preview stage/background or underlying composite layer.
- Measured before: 960×540 logical output, 1920×1080 backing store, identity
  transform, exactly **25% opaque coverage**. Circles at the same DPR kept its
  density transform and **100% coverage**.
- `p5.Graphics` is not used in either affected scene factory. The camera factories
  use explicit 320×180 HTML canvas source/history buffers and composite into the
  full p5 surface; those buffers were not incorrectly sized to the parent.
  The older Slice Glitch `p5.Graphics` path passed the production resize checks.
- Preview sizing wrappers / ResizeObserver and output ProgramRuntime correctly
  sized the canvas. The defect was inside the renderer drawing coordinates.

## Focused production diff

Only four production files change:

- `src/sketches/{expansion,replacements}/runtime.js`
- `src/sketches/{expansion,replacements}/video.js`

Create the canvas **before** setting its intended single-density policy, and use
`p.resetMatrix()` instead of native identity so drawing remains correct if the
host later changes density. No manual backing-store dimension assignments, CSS
stretching, compositor rewrites, FFT/controller changes or audio tuning.

This covers 24 vector/spatial scenes and 4 Canvas2D camera effects. All 39 new
patterns (18 replacement + 21 expansion), plus the 2 restored cameras, were
checked. The 11 new GPU scenes and 2 restored GPU cameras were already filling
the output and did not need artistic or shader changes.

The BGLM field/object transforms and Lissajous geometry edits were reverted;
geometry/palettes/audio mappings are back to HEAD (`e747ddb`). Its fixture changes
were also removed. Its original patch, working files, tests, scripts and evidence
are preserved under `.okbrain/scaling-handoff/`, not deleted. That folder is
handoff/archive material, not part of the proposed fix.

## Verification performed

- `canvas-density-production.spec.js`: real control → output, landscape →
  portrait → resize, device DPR 1 and 2, every backing pixel opaque, no stale
  sentinel pixels. **Before: DPR 1 passed; DPR 2 failed at ~25% coverage. After:
  both passed.** Also passed against the built/minified app in headed Chromium
  on the Ubuntu Wayland desktop, with no development debug facade dependency.
- `wave-production-sizing.spec.js`: **86 passed** — the 39 new patterns, 2 restored
  cameras, Circles and Slice Glitch × DPR 1/2. Real application selection,
  production output lifecycle, three output dimensions, real preview resizing,
  Canvas2D alpha/transform checks and browser-composited visible screenshots.
  Camera placeholders remain intentional in the control panel; output used the
  browser's fake camera device with the real shared capture pipeline.
- Focused audio/percussion, bounds, lifecycle and render regressions, including
  the supplemental explicit backing-density 1 → 2 → 1 contract: **70 passed**.
- `canvas-density-compositing.spec.js`: **4 passed**, built app in headed Chromium;
  actual merge and projection paths at DPR 1/2 and landscape/portrait sizes.
  Checks for uniform composition without uncovered red-base leakage.
- Production build passed (`npm run build -- --outDir /tmp/pendulum-128-dist`).
  Existing large-bundle warning; no build errors.
- Audio transport, controller, feature, graphic and spatial files checked against
  HEAD: unchanged. No merge, commit, branch reset, workspace deletion or main edits.

## Evidence

`canvas-density-assets/before/` holds real-UI reproductions from the received
BGLM workspace, not isolated render fixtures. `after/` holds 12 headed built-app
screenshots: control and output × landscape/portrait/resized × DPR 1/2.
The before control screenshot is 1600×950 CSS; the after landscape control is
1600×720 CSS, so these are not pixel-registered still comparisons. Output before
and after landscape both use 960×540 CSS. Animation phase is not frozen.

Representative uploaded images:

- Before control: `/uploads/27782d44-2d20-46b2-a256-e376eb388409.webp`
- After control (built app): `/uploads/081698ba-b6d6-4edd-a162-c2ca2b957080.webp`
- Before output: `/uploads/cddd4a54-0fb4-484a-9953-a0c12d117d6d.webp`
- After output (built app): `/uploads/520b5f58-583f-4741-91e1-f8ebe65822f7.webp`

## Limits

The original user URL `/uploads/301eb558-5b29-4e65-8cda-56f4d15482bc.webp`
could not be opened by the available URL reader (400). I inspected the generated
real-UI reproductions of the described rectangle/ghost failure; I do not claim
to have viewed the original attachment. Software-rendered Chromium/fake-camera
checks are not physical projector/GPU or hardware-camera certification.
Authored framing is preserved: wide compositions can still crop in portrait,
and Pendulum Wave intentionally hangs from the upper rail. This fixes the
incorrect quarter-canvas/ghosting, not a redesign of those compositions.

## Re-run from this workspace

Use an unused isolated port; do not reuse another user's server:

```sh
PLAYWRIGHT_PORT=5286 npx playwright test canvas-density-production.spec.js canvas-density-contract.spec.js canvas-density-compositing.spec.js --project=chromium --workers=1
PLAYWRIGHT_PORT=5286 npx playwright test wave-production-sizing.spec.js --project=chromium --workers=2 --reporter=html
npm run build
```

The takeover used isolated ports 5286 (source) and 5287 (built app). The temporary
Playwright config/server scripts are retained in `.okbrain/scaling-handoff/` for
exact reproduction on this host; their absolute paths are intentionally local.
