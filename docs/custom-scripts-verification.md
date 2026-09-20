# Custom Scripts implementation and verification

## Scope and design

Implemented in isolated workspace 133, branch `okbrain/bread-viz/133-dac4f085`, based on main commit `7a7d67d3458ff5cdcf1ece73af9a3b36edd787fc`. No advisors were used. No merge or commit was performed. The pre-existing `.okbrain/workspace-init.log` change was left alone.

Architecture inspected first: mutable `SKETCHES` registry, dynamic Media/Projection registrations, `ProgramRuntime` LIVE/CUE promotion and disposal, compact audio control engine, parameter banks, preview factory wrapper, React library, static docs and Playwright setup.

- Real File System Access directory picker; structured-clone handle persistence in IndexedDB; explicit reconnect/permission, support and secure-context UX. No production OPFS/upload fallback.
- Disk-backed create with unique filename and writable close. Editing guidance for OS editors/agents. Explicit Reload reads external changes; Create only activates its new starter and never silently reloads other edited files.
- Strict classic `.viz.js` scripts, API v1, no static/dynamic imports; bundle dependencies. All candidate files parse/compile before any candidate registration code executes. Full-folder staging validates fields, hooks, parameter/audio schemas and ID ownership/collisions; any failure preserves the entire last-good generation.
- Synchronous file-owned create/get/list/update/delete API; immutable definitions; built-ins/media/projection protected. Registry removal and confirmed disk deletion are separate operations.
- Adapter gives hooks the actual VizCore, host params, per-instance state, compact audio controls, shared camera, assets, cancellation and cleanup. Async preload/setup supported, synchronous draw/audio/dispose required. Existing output/preview/CUE/merge/projection paths reused.
- Persisted source generations and revision notifications synchronize windows, including late output startup. Activation cancels CUE/TAKE and stale promotions, reconciles parameters/projection schemas, disposes affected LIVE and previews, retires audio and falls back when IDs disappear. A discovered directly-owned camera stream cleanup leak was fixed in `VizMediaElement.remove`; shared camera lease ownership remains unchanged.
- Full static tutorial, Markdown agent API/schema/troubleshooting/checklist, and eight executed examples: 2D/pixels/offscreen/text, WebGL meshes/lights, GLSL/textures, audio controls/arrays/events, local image, local video, shared camera, CRUD/lifecycle.

## Checks actually run

No lint/typecheck command exists in package.json. Build, JavaScript syntax checks, parser checks, and Playwright were run. All Playwright runs used an isolated Vite port (5183); baseline used 5184.

### Latest focused run — 36 passed

```sh
PLAYWRIGHT_PORT=5183 npx playwright test tests/custom-scripts.spec.js tests/docs.spec.js --project=chromium --workers=3 --reporter=json
```

18 Custom Scripts tests and 18 docs tests. Coverage: syntax-before-any-execution; rejected imports; malformed metadata/types/hooks/ranges; duplicates/protected IDs/file ownership; CRUD; last-good rollback on schema, syntax and storage failure; real browser handle create/write/delete/IndexedDB persistence; explicit reload; no implicit reload on create; permission/support/reconnect UX; deletion confirmation/cancel; adapter/audio/resource cleanup; all eight examples rendered/disposed (including generated test image/video and fake camera); multiple windows/late output; CUE cancellation; held-RAF stale TAKE invalidation; external deletion; projection child/schema reload and removal fallback; docs navigation/link uniqueness.

### Integration run — 57 passed

```sh
PLAYWRIGHT_PORT=5183 npx playwright test tests/custom-scripts.spec.js tests/docs.spec.js tests/cue-mode.spec.js tests/media-pattern.spec.js --project=chromium --workers=2 --reporter=json
```

18 custom + 18 docs + 20 CUE + 1 existing media test. No retries/skips/failures. After this run, minor closed-service notification guards and stricter malformed audio-schema checks were added; the 36-test focused suite and build were rerun successfully.

### Independent mapping run — 60 passed

```sh
PLAYWRIGHT_PORT=5183 npx playwright test tests/projection-mapping.spec.js tests/screen-mapping.spec.js --project=chromium-mapping --no-deps --workers=1 --reporter=json
```

41 projection + 19 screen-mapping tests. This independently exercises mapping even though the broad core project's unrelated failures block its dependent mapping phase.

### Broad project core run — 389 passed, 6 failed, 2 skipped

`npm test` was run initially. The later broad run used its exact test selection with JSON reporting and two workers:

```sh
PLAYWRIGHT_PORT=5183 npx playwright test --grep @core --workers=2 --reporter=json
```

397 tests selected. The six remaining failures were independently reproduced against an untouched archive of main at the commit above:

| Test file | Failures | Observed reason |
|---|---:|---|
| `canvas-density-compositing.spec.js` | 2 | Projection readiness predicate times out (DPR 1 and 2). |
| `canvas-density-contract.spec.js` | 1 | `TypeError: ctx.save is not a function`. |
| `canvas-density-production.spec.js` | 2 | `getContext('2d')` is null before `getImageData` (DPR 1 and 2). |
| `library-search.spec.js` | 1 | Existing favourites assertion expects 92 buttons, receives 72. |

These unrelated assertions/render-contract failures were not weakened or fixed as part of this feature. Tests explicitly expecting the library group count/order were updated for the new empty Custom Scripts category. Two dependent mapping tests were skipped by project dependency gating; the independent 60-test mapping run above passed.

Baseline command, in the untouched main archive with the same installed dependencies:

```sh
PLAYWRIGHT_PORT=5184 npx playwright test tests/canvas-density-contract.spec.js tests/canvas-density-production.spec.js tests/canvas-density-compositing.spec.js tests/library-search.spec.js --project=chromium --workers=2 --reporter=json
```

Baseline result: 15 passed, the same 6 failed. A separate 54-test regression selection in the implementation workspace yielded 48 passed and these same 6 failures. The initial four-worker core run also had a GPU audio timing failure that passed on rerun; it is absent from the two-worker broad result.

### Static/build verification

- `npm run build`: passed; Vite warns that the JS chunk exceeds 500 kB (about 959 kB minified / 278 kB gzip). No build error.
- `node --check` on the four new JS modules, runtime coordinator and media core: passed.
- Compiling all eight published example sources through `compileSources`: passed without executing registration code.
- `git diff --check`: passed.

JSON evidence is retained on this host outside the repository at `/tmp/custom-scripts-focused-final.json`, `/tmp/custom-scripts-integration-final.json`, `/tmp/custom-scripts-mapping-final.json`, `/tmp/custom-scripts-core-final.json`, `/tmp/custom-scripts-regression.json` and `/tmp/custom-scripts-baseline.json` (temporary host artifacts, not shipped assets).

## Explicit remaining limitations / manual checks

- Trusted JavaScript, **not a sandbox**: arbitrary globals, runaway code and top-level side effects cannot be isolated or rolled back. Hooks are type-checked, not exhaustively executed before activation.
- Last-good rollback covers syntax/registration/schema/collision/storage failure. Post-activation setup/draw/GLSL/media failure does not automatically restore an old program. File/hook errors are surfaced.
- Reload is a stop/restart boundary and cancels CUE/TAKE. Windows synchronize eventually and independently evaluate deterministic declarations; no atomic distributed renderer commit or seamless hot swap is promised.
- No imports/exports/TypeScript/JSX/npm resolver, no file watcher, no recursive script/asset paths, no browser source editor. Bundle dependencies. VizCore is not full p5.js. Files/assets are not packaged in settings export.
- Disk deletion and browser snapshot persistence cannot form one filesystem transaction. If deletion succeeds and persistence fails, the user must Reload after resolving storage errors.
- Automated filesystem tests use actual browser handles backed by OPFS with a stubbed picker, **only in tests**. An actual OS-directory picker round trip, external desktop editor save, Chrome restart/permission-revocation prompts and moved-directory reconnection were **not manually verified** in this environment. Follow the manual checklist in the API reference before release.
- No entire unfiltered `test:all` run was claimed; the broad core and listed targeted suites were executed.

## Changed files

- `README.md`
- `docs/custom-scripts-verification.md`
- `package-lock.json`
- `package.json`
- `public/docs/blending.html`
- `public/docs/cue-mode.html`
- `public/docs/custom-script-examples/audio.viz.js`
- `public/docs/custom-script-examples/camera.viz.js`
- `public/docs/custom-script-examples/crud-lifecycle.viz.js`
- `public/docs/custom-script-examples/drawing.viz.js`
- `public/docs/custom-script-examples/image.viz.js`
- `public/docs/custom-script-examples/mesh.viz.js`
- `public/docs/custom-script-examples/shader.viz.js`
- `public/docs/custom-script-examples/video.viz.js`
- `public/docs/custom-scripts-api.md`
- `public/docs/custom-scripts.html`
- `public/docs/devices.html`
- `public/docs/eq-noise.html`
- `public/docs/getting-started.html`
- `public/docs/index.html`
- `public/docs/interface.html`
- `public/docs/media.html`
- `public/docs/patterns.html`
- `public/docs/post-processing.html`
- `public/docs/projection-mapping.html`
- `public/docs/screen-mapping.html`
- `public/docs/slots.html`
- `src/app/runtime.js`
- `src/components/control/CustomScriptsPanel.jsx`
- `src/components/control/PatternLibrary.jsx`
- `src/core/media.js`
- `src/custom-scripts/adapter.js`
- `src/custom-scripts/compiler.js`
- `src/custom-scripts/service.js`
- `src/custom-scripts/storage.js`
- `src/sketch-registry.js`
- `src/styles/index.css`
- `tests/control-panel.spec.js`
- `tests/custom-scripts.spec.js`
- `tests/docs.spec.js`
- `tests/expansion-inventory.spec.js`
- `tests/library-search.spec.js`
- `tests/replacement-inventory.spec.js`
- `tests/smoke-selection.spec.js`
