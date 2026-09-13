# Focused rendering-core migration review

## Follow-up: Canvas2D additive accumulation fixed

Workspace 130 only. Chroma Mandala and Echo Ripples explicitly select BLEND before their opaque black background, then ADD for shapes. Renderer2D.blendMode previously changed only the cached field; the actual context stayed in last frame's `lighter` until a shape called `_applyStyle()`. `background()` bypasses that helper, so black added nothing and old pixels accumulated to white. The fix synchronizes `globalCompositeOperation` immediately in `blendMode()`. No forced clearing or source-over override was added to background: translucent BLEND backgrounds still fade trails, explicit ADD backgrounds still add, and clear remains transparent and transform-safe. Pattern sources and pinned baselines are untouched.

Incremental files: `src/core/renderer-2d.js`, new `tests/core-background-blend.spec.js`, and this document. Prior migration work is preserved; no commits, merges, main changes or .okbrain edits.

- Before fix: all **6 new regression cases failed**, with a captured white-saturated Mandala reproduction.
- After fix: **24/24 focused core tests passed**, including those six regressions (`CI=1 PLAYWRIGHT_PORT=54332 npx playwright test tests/core-*.spec.js --workers=2`).
- Both unchanged factories tested through controls and legacy paths: **1,200 active frames + 200 quiet frames + an erase probe** each. Tests check saturation, removal of old outer content, next-frame erasure and final ADD state. Separate density-1/2 pixel contracts check partial alpha fading, repeated decay, opaque background, intentional additive background, push/pop blend restoration, clear and transform preservation.
- `npm run build` passed: JS **847.80 kB**, gzip **245.91 kB**, existing large-chunk warning only. Registry remains **91 patterns**. No full-suite timing investigation or new 3D parity work.
- Visually inspected after captures at frame 1,200: [Chroma Mandala](/uploads/5944f8ee-a13e-4279-b991-5db6cef74566.webp), [Echo Ripples](/uploads/0fcd3c3a-c5b2-4646-bd72-41df7e88c378.webp). These are synthetic pulsed-audio regression captures, not the user's live session.
- The supplied relative upload URL could not be read by the available URL tool (400); the diagnosis instead used source inspection and independently reproduced/captured rendering. No claim of inspecting that original image.
- Advisor review remains unavailable: no exposed advisor tool and advisor app discovery returned empty. This focused fix is tested, not independently advisor-approved; historical full-suite caveats below remain.


## Status: visual differences accepted; final validation has timing failures

The user explicitly accepts workspace 130's measured visual differences and requires both 3D patterns to remain. Exact p5 parity is no longer a release requirement. This final pass changed documentation only: no additional parity work, source changes, test weakening, commits, merges or changes to main. Exclude `.okbrain/workspace-init.log` from the deliverable.

### Final validation (supersedes historical test results below)

- Clean build: `npm run build -- --emptyOutDir` **passed**; JS **847.74 kB**, gzip **245.89 kB**. Only the large-chunk warning remains.
- Port 54322 was verified unused before the clean full run: `CI=1 PLAYWRIGHT_PORT=54322 npx playwright test`. Result: **462 passed, 3 failed, 70 did not run**, 535 total, 10.5 minutes, exit 1.
- Failures: `holo-swarm`, `aurora-veil`, `ink-dispersion`, all at `tests/new-effects-smoke.spec.js:67`, waiting for `window.__viz.patternId` to match the clicked selection (30-second test timeout). Mapping was blocked by project dependency gating. No clear blocking rendering regression was established; the timing failures remain unresolved rather than being waived.
- Unchanged targeted reruns: `CI=1 PLAYWRIGHT_PORT=54323 npx playwright test tests/new-effects-smoke.spec.js --grep 'holo-swarm|aurora-veil|ink-dispersion' --repeat-each=3 --workers=1`: **9 passed**, 58.5 seconds.
- Blocked mapping coverage run separately: `CI=1 PLAYWRIGHT_PORT=54324 npx playwright test --project=chromium-mapping --no-deps`: **70 passed**, 5.6 minutes.
- All 535 distinct tests therefore passed at least once across these runs, but **there is no clean single full-suite pass**. Do not report the reruns as a 535/535 green full run.
- An earlier attempt on port 54321 completed its build but lost remote connectivity without a final test summary; it is not counted as a completed suite.
- Registry imported directly: **91 patterns**, with **techno3d and character3d retained**. `npm ls --omit=dev --all` succeeded and contains **no p5 anywhere in the production dependency tree**. The optional isolated baseline installation remains outside that tree.
- Advisor final review is **unavailable**: no advisor tool is exposed and advisor app discovery returned no apps. No independent approval is claimed.

Readiness: accepted visual differences are not blockers. Handoff is documented, but unconditional release approval is withheld because the full-run selection timeouts remain unresolved and requested advisor approval could not be obtained.

Migration copied from stopped workspace 129 into authorized workspace 130 using a binary tracked diff and only the untracked core modules/tests. Both bases were `709db0074dc6738f9c5269b28fac0e52b89fe9c4`. No pattern factories, registry entries, pinned baselines, commits or merges were changed. The workspace-init log was already dirty before migration work and is not part of the migration.

Production imports VizCore and has no p5 dependency. A separate installation of main's exact package/lock files under ignored `node_modules/.p5-baseline` is used only for review. It is not imported by production or the default tests.

## Corrections made during escalation

- Replaced fixed gradient Perlin noise with p5-compatible shared, random, cosine-interpolated value noise (four octaves, 0.5 falloff). Seeded numeric outputs match the separately installed p5 baseline, including negative coordinates.
- Fixed half-sized `circle()` in both renderers.
- Replaced driver-clamped GL_LINES with triangle-expanded perspective strokes. Thickness now follows stroke weight, density and depth, rather than silently staying one pixel.
- Restored WebGL push/pop fill, stroke, weight, blend and light state.
- Corrected ambient-only lighting, additive ambient lights and the 0.73 point-diffuse factor; representative lit-sphere and ambient-box pixels match main exactly.
- Restored sphere phase, triangulation, diagonal strokes, shared triangle-edge overdraw and p5's high-detail stroke limit. Subdivided planes intentionally have no strokes, matching p5 even though Techno3D requests an 8x8 plane.
- Release evicted geometry buffers instead of clearing only their JavaScript cache.
- Prevent resource resurrection after removal during async setup; settle readiness on early removal; detach listeners when switching renderer modes.
- Await async draw callbacks before ProgramRuntime captures/publishes their pixels. Guard retired draws and prevent concurrent redraw while finishDraw is pending.

## Test review

The inherited tracked-test edits replace p5 imports/selectors with core equivalents. Merge tests add an observable screen-online prerequisite; they do not remove assertions or extend timeouts.

Two newly introduced core tests had encoded replacement bugs rather than main behavior:

- `circle(4,4,6)` at pixel `(1,1)` has alpha 24 on main, not zero. Corrected the expectation to the exact observed RGBA `[255,255,255,24]`.
- An 8x8 subdivided plane has no stroke on main. Corrected that expectation to zero and retained a positive simple-plane stroke assertion.

Added six regression tests in `tests/core-parity-regressions.spec.js` for numeric noise, mesh edge topology/overdraw, async setup removal, draw/finish ordering, ProgramRuntime post-callback capture and pixel-level circle/stroke/light/style behavior.

## Historical verification (before final validation)

- Full suite (`CI=1 PLAYWRIGHT_PORT=5315 npx playwright test`): **463 passed, 2 failed, 70 not run**. Failures were selection timeouts for aurora-reactor and warp-loom; dependency gating prevented mapping tests from running.
- Both failed smoke cases rerun unchanged, three times each, single worker: **6 passed**. This does not establish a clean full-suite run or prove the original timeouts harmless.
- Mapping project separately with `--no-deps`: **70 passed**.
- After the final sphere shared-edge correction: core and merge tests **27 passed**, and baseline comparisons/build rerun. The full suite was not rerun after that final geometry correction.
- Production build: JS **847.74 kB**, gzip **245.89 kB**. Separately rebuilt main: **1,974.77 kB**, gzip **573.16 kB** (about 57% smaller JS). Both builds retain Vite's large-chunk warning.
- `npm ls p5 --depth=0` reports empty for the production project.
- npm audit reports one high-severity nanoid finding; the independently installed main reports the same count. No unrelated dependency upgrade was made.

## Reproduce the visual audit

Install main's package.json/package-lock.json in a separate ignored directory, not the production dependency tree. Start this workspace's Vite on an isolated port, then:

```sh
P5_BASELINE_LIB="$PWD/node_modules/.p5-baseline/node_modules/p5/lib/p5.min.js" \
BASE_URL=http://localhost:5319 \
BASELINE_OUTPUT=node_modules/.p5-baseline/output \
node tests/fixtures/core-baseline.mjs
```

The audit loads main's standalone p5 into the browser alongside the replacement, runs the same unmodified factories with seeded random/noise, fixed elapsed time, neutral audio, eight frames at 320x180 DPR 1, and emits PNGs plus metrics. No visual assertions are silently relaxed. This is a representative comparison, not exhaustive parity approval.

Final results (mean RGB absolute error in 0..255; changed pixels require channel difference >16):

| Case | Mean RGB error | Changed pixels |
| --- | ---: | ---: |
| Canvas2D primitives | 0 | 0% |
| Fullscreen shader probe | 0 | 0% |
| Lit sphere / ambient-only box | 0 | 0% |
| Pendulum Wave | 0 | 0% |
| Gradient Wash | 0.01882 | 0% (max difference 1) |
| Event Horizon | 0.000023 | 0% (max difference 1) |
| Thick line | 0.23021 | 0.0903% |
| Wire box | 0.53878 | 0.6753% |
| Wire sphere | 0.38681 | 0.5764% |
| Techno3D | 3.76771 | 5.6563% |
| Character3D | 0.71488 | 1.0694% |

## Accepted visual differences and residual risks

The user accepts the visual differences below; they are not exact-parity release blockers. Further visual/performance exploration is outside this final validation pass.

- **Mesh visual parity is not complete (accepted).** Triangle strokes currently have butt-ended segments, not p5's complete cap/join generation and camera-facing depth adjustments. Techno3D and Character3D retain the measured differences above; do not interpret passing smoke tests as unchanged appearance.
- Thick-stroke expansion currently rebuilds/uploads edge vertices each draw. Representative tests pass, but a sustained real-GPU / high-resolution performance audit is still needed.
- All 91 patterns have not received deterministic before/after comparisons across audio peaks, parameter extremes, sizes, densities, transparency and camera input. Only representative neutral cases are measured here. General custom-shader alpha blending, cone lighting and the broader stubbed WebGL API are not certified.
- Resolve the full-suite selection timing failures and obtain a clean final run.
- No advisor tool was exposed in this escalation session (no advisor app was discoverable either), so **independent advisor approval was not obtained**.
