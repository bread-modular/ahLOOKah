# Node editor and recent features — deep code audit

**Review date:** 2026-09-23  
**Reviewed revision:** `5a50ac3` (the workspace's base commit; full hash is in the evidence JSON)  
**Scope:** Node editor, graph validation/execution, scalar scripts/audio routes, optional image-input FX, Camera nodes, Blend/Transform, disk persistence, and the new project save/open/reset workflows.  
**Deliverable only:** No application source, existing test, dependency, or configuration changes were made. The report, reproduction harness, and observations live in `.design/`.

## Executive summary

The core architecture has useful safeguards: typed image/signal/modulation connections, structural validation, bounded scalar-script interpreters, exact-source script approval, shared capture, disk conflict checks, and completed-frame FX compositing. The new Blend/Transform and image-FX tests passed in the targeted run.

However, this review reproduced **11 application issues**, including **four high-priority issues** involving editor crashes, lost script drafts, incorrect project-directory resolution, and partial project imports. There are also performance problems from rebuilding a whole graph on parameter changes and running sources that cannot reach the live Output.

The existing test baseline is **not green**. Targeted coverage ran 243 cases with three failures; the Chromium core suite ran 205 cases with four failures. Isolated retries left four test cases reproducibly failing, with source evidence pointing to outdated expectations. Three other initial failures did not reproduce on their isolated retry. Test failures are described separately from the application findings; they are not automatically counted as product bugs.

### Prioritized findings

| ID | Priority | Area | Reproduced issue |
| --- | --- | --- | --- |
| F01 | P1 | Editor safety | Clearing the graph name unmounts the entire embedded control UI |
| F02 | P1 | Draft safety | Editing a second Script silently destroys the first Script's unapplied draft |
| F03 | P1 | Project identity | Relinking a different same-named directory can redirect an older project to the wrong assets |
| F04 | P1 | Project import | Storage failure can produce a mixed old/new project while reporting a normal result |
| F05 | P2 | Project reset | New Project retains individually opened node-pattern files, including after reload |
| F06 | P2 | Preview performance | One parameter edit disposes the graph and recreates every Pattern source |
| F07 | P2 | Live resource use | Unreachable Pattern sources still initialize and draw |
| F08 | P2 | Failure isolation | An unrelated missing Pattern prevents a healthy non-FX branch from rendering |
| F09 | P2 | Editor feedback | Connection failures are stored in a data attribute but not shown to the operator |
| F10 | P2 | Input validation | Out-of-range signal-input bounds throw an uncaught error without visible feedback |
| F11 | P2 | Graph compatibility | Valid graphs whose Output ID is not `output` initially show an empty preview |

**Priority convention:** P1 = address before trusting this workflow with valuable drafts/project state; P2 = correctness, recoverability, or performance issue to address next. These are review priorities, not claims of exploitable security vulnerabilities.

## Method, evidence, and boundaries

- Inspected recent Git history, the current implementation, related design notes, existing fixtures, and integration tests. Important recent changes include optional image inputs, camera acquisition fixes, Blend/Transform, editor simplification, and project portability.
- Read the node modules and traced their integration into `ProgramRuntime`, the control/screen runtime, shared camera handling, custom-script adapters, and project storage.
- Built the application and exercised real Chromium with isolated profiles. Reproductions use browser-owned OPFS files and permission doubles, not the operator's real files or devices.
- Used targeted fault injection for the storage-quota case and instrumented production methods for source-lifecycle counts. Those cases are explicitly identified below.
- Retained a runnable harness: [`node-editor-audit.probes.mjs`](node-editor-audit.probes.mjs).
- Retained raw observations: [`node-editor-audit-evidence.json`](node-editor-audit-evidence.json). All 11 probes completed without harness errors. Expected application exceptions remain in each probe's `pageErrors` field.
- The harness records behavior; it is **not** a passing regression suite certifying correctness. Its exit status fails on a broken probe, not merely on an observed application defect.
- This is not an exhaustive hardware/GPU/browser-compatibility audit. Physical USB disconnects, long-duration shows, driver memory exhaustion, and all unselected application suites were not tested. The core run briefly overlapped the isolated audit harness on a separate port; every failed core case was subsequently retried alone with one worker.

### Architecture map

| Responsibility | Main implementation | Review implication |
| --- | --- | --- |
| Graph contract and typed wires | `src/nodes/model.js`, `definitions.js` | Strong boundary, but invalid in-progress editor text should not be fed into strict serialization |
| Editor session/selection/controls | `NodesEditor.jsx`, `EditorHost.jsx`, `useNodeSelection.js`, `ModulatedParameter.jsx` | Draft lifecycle and error delivery need stronger separation from persisted graph validity |
| Scalar execution and audio | `script*.js`, `scalar.js`, `modulation.js`, `audio-provider.js` | Restricted scalar scripts are different from trusted `.viz.js` code; retain that distinction |
| Image scheduling and presentation | `nodes/runtime.js`, `program-runtime.js` | Legacy synchronous and FX async paths have different failure-isolation policies |
| GPU image operations | `blend-modes.js`, `transform.js`, `gl-compositor.js` | Shared context and identity shortcuts are good; driver-failure telemetry needs further work |
| Node files and portability | `repository.js`, `portability.js` | Disk conflict protection is present; project-level identity/reset semantics need tightening |
| Project orchestration | `platform/settings-portability.js`, `folder-portability.js`, `project-folders.js`, `app/runtime.js` | Multi-store mutations need explicit failure accounting and a commit/rollback policy |

## Detailed application findings

### F01 — P1: Clearing the graph name crashes the embedded editor and control UI

**Evidence:** `NodesEditor.jsx:278–283, 533–549`; `portability.js:118–122`; `model.js:37–40`; `EditorHost.jsx:35–38`; `src/main.jsx:44–51`.

The name input immediately writes its text into the graph, including the empty intermediate value produced by Select All → Delete. The embedded editor's `onState` effect calls `dirty()`, which calls `serializeGraph()`, which invokes strict validation and throws for an empty or whitespace-only name. There is no React error boundary around this editor/control subtree.

**Reproduction:** Main UI → New Node Pattern → clear Graph name. The probe observed `Name must contain 1–80 characters` and `#root.childElementCount === 0`. A secondary closed-BroadcastChannel exception appeared during teardown in repeated runs; it is not necessary to trigger the crash and is not counted as another finding.

**Impact:** A normal rename gesture can remove the whole control UI and lose the unsaved graph, not merely reject Save. The standalone editor has a related risk because its unload guard also calls the throwing `dirty()` function, although the embedded crash is the directly reproduced case.

**Recommendation:** Keep an editable name draft separate from the validated graph, or use a non-throwing dirty comparison of raw editor state. Perform strict validation at Apply/Save boundaries and display a field-level error. Add an editor error boundary that preserves a recoverable draft instead of unmounting the surrounding show controls.

**Regression coverage:** Empty/whitespace name, select-all replacement typed one character at a time, invalid-name Back/Reload/unload, and continued operation of the main control UI. Probe: `empty-name-embedded-editor`.

### F02 — P1: Unapplied text is retained for only one Script node

**Evidence:** `NodesEditor.jsx:235, 328–344, 432–444, 677–680`.

`scriptDraft` is one `{ id, language, text }` object for the whole graph. Selecting another node does not immediately erase it, but typing into another Script replaces that object. The first draft then disappears without confirmation. The comment promising that switching nodes preserves the draft does not cover this second-edit case.

**Reproduction:** Two Script nodes A and B, both saved as `return x;`. Type `return 111;` into A without Apply; type `return 222;` into B without Apply; select A. Its source field contains `return x;`, not `return 111;`. No exception or warning occurs.

**Impact:** Silent loss of authored code. The Save/Back guards only know about whichever draft survived, so they cannot warn about the lost text.

**Recommendation:** Store pending text/language by node ID and inspect all pending entries for Save/leave guards. Deleting a Script with unapplied text should use an explicit discard policy. Ensure Apply clears only that node's draft.

**Regression coverage:** Alternating edits between multiple Scripts, applying B while A is still pending, language changes, deleting one pending node, and reload/leave cancellation. Probe: `script-drafts-overwrite-each-other`.

### F03 — P1: Project directory identities are mutable aliases, not stable directory identities

**Evidence:** `platform/project-folders.js:42–59, 153–158`; `nodes/repository.js:103–117`; `platform/folder-portability.js:155–180`.

`ensureProjectFolder()` reuses the current section's ID and overwrites its remembered handle without checking whether the new handle is the same entry. Old project files still contain that ID. During restore, the main safety check on the recalled handle is its name. Two different directories named `nodes` therefore pass this check.

**Reproduction:** Create OPFS entries `project-a/nodes` and `project-b/nodes`. Register A, then register B as the current node folder without starting a fresh project identity. Both receive the same ID. Looking up the old ID returns B; applying A's saved folder reference reports `resolved: ["nodes"]` and `pending: []`, with no relink warning.

**Impact:** An older saved project can load assets from the wrong directory. With different directory names, it instead loses the seamless restore promised for the original directory. This risk also applies to other sections using the same helper. It is not a native-path-disclosure problem; browser handles already provide `isSameEntry()` for identity comparison.

**Recommendation:** Distinguish ordinary folder replacement from explicit adoption of a missing imported-project reference. Ordinary relinking to a different entry should allocate a new directory identity and preserve the old mapping. Explicit adoption may bind the imported ID after operator confirmation. Do not use matching basenames as evidence of identity.

**Regression coverage:** Save A, relink B with the same basename, save B, reopen A, and verify the physical handle is A; repeat with different names and with explicit cross-machine adoption. Probe: `same-name-folders-rebind-saved-project`.

### F04 — P1: Project imports can silently become partial transactions

**Evidence:** `platform/settings-portability.js:280–315`; `app/runtime.js:3716–3742`. Related export/reset error suppression: `settings-portability.js:103–118, 195–217`.

`applySettings()` changes localStorage key by key, suppresses write/removal errors, then updates folder and media stores. A failed key does not appear in the returned summary as a failure. A later IndexedDB error can also occur after localStorage has already changed, with no rollback mechanism.

**Reproduction — injected failure:** Seed old parameters and an old camera selection; throw `QuotaExceededError` only when writing the new parameter bank. Import new parameters and a new camera selection. `applySettings()` returns normally, the parameters remain from the old project, and the camera becomes the new one. No failure list is returned.

**Impact:** The UI can announce a successfully opened project even though its state belongs to two projects. An outright later exception can leave a partially modified current project even when Open reports failure.

**Recommendation:** Collect explicit per-store/key errors, stage and validate the entire payload before mutating live state, and define commit/rollback behavior across localStorage and IndexedDB. At minimum, do not report success or initiate normal peer reload on partial failure. Preserve a recovery snapshot. Apply the same truthful-error rule to Save Project and New Project instead of silently skipping inaccessible data.

**Regression coverage:** Quota failures on early/middle/late settings keys, denied IndexedDB writes after settings changes, rollback/recovery, and duplicate/open requests. Probe: `project-import-swallows-quota-failure`.

### F05 — P2: New Project leaves individually opened node patterns in the library

**Evidence:** `app/runtime.js:3769–3781`; `nodes/repository.js:119–124, 70–80`; `platform/settings-portability.js:195–217`.

New Project invokes each service's ordinary `unlink()`. Node `unlink()` intentionally removes only `folder` while preserving `opened` and `hidden`. `clearProject()` does not reset this node handle record. That is correct for a normal Unlink action, but not for a clean project reset.

**Reproduction:** Open an individual `.nodes.json` with no linked folder. Run the real Menu → New Project action and accept. The persisted state still has `opened.length === 1`; the old pattern remains after a page reload as well.

**Impact:** A supposedly empty new project continues to include assets from the old project, and subsequent exports can carry stale references.

**Recommendation:** Add a dedicated project-reset operation that clears current folder/opened/hidden/reference state while keeping the separate bounded remembered-directory registry for old-project recovery. Do not change ordinary Unlink semantics to solve this.

**Regression coverage:** New Project with folder-linked files, individually opened files, hidden files, and combinations; verify both before and after reload. Probe: `new-project-retains-individually-opened-node-files`.

### F06 — P2: A parameter change rebuilds the entire preview graph

**Evidence:** `NodesEditor.jsx:174–219`; `nodes/runtime.js:121–127, 167–227, 459–466`.

The preview effect depends on serialized graph content. Position/name changes are intentionally excluded, but every parameter value, mapping endpoint, blend setting, and structural field is included. Any such change disposes the GraphRuntime and all child ProgramRuntimes, then recreates them.

**Reproduction — lifecycle instrumentation:** Open a two-Pattern graph and change one Brightness value from `0.8` to `0.7`. Production-method counters record one graph disposal and two source preparations, including the unrelated source.

**Impact:** Slider drags can repeatedly rebuild canvases, shaders, media instances, audio bindings, accumulated animation state, Script time, and temporal FX history. This is more than avoidable React rendering: it changes the visual continuity of the preview.

**Recommendation:** Separate topology/source revisions from mutable parameter updates. Preserve source instances for numeric changes; update parameter views and audio revisions in place. Recreate only affected nodes for changes that truly alter lifecycle, such as source/FX mode or source identity. Keep the current generation guards for retired async work.

**Regression coverage:** Repeated slider/mapping movement does not increase source-construction counts; unaffected playback position, animation clock, and feedback history remain continuous. Probe: `single-parameter-recreates-every-source`.

### F07 — P2: Unreachable Pattern sources consume live rendering resources

**Evidence:** `nodes/runtime.js:107–110, 140–145, 155–175, 191–227, 325–340`.

The constructor computes image reachability from Output but applies it only to Camera nodes. Every ordinary Pattern source is prepared, even for `preview: false`. Audio route consumers likewise include every Audio node. FX graphs allocate front/work buffers for every visual node and staging canvases for eligible source nodes before knowing whether a requested target needs them.

**Reproduction:** Construct a live (`preview: false`) graph with ten Pattern nodes but connect only one to Output. All ten sources initialize and draw: `sources = 10`, `setups = 10`, `draws = 10`, while Output needs one source.

**Impact:** Disconnected experiments on the editor canvas increase the cost of the saved live graph. Shader contexts, capture dependencies of source-mode camera patterns, media loading, and warm-up waits can be incurred for branches that never contribute pixels. The Camera-node reachability exception does not protect camera-based Pattern nodes.

**Recommendation:** Compile an execution plan from the active image target plus its modulation/signal dependencies. Use Output reachability for LIVE, and lazily expand to the selected inspector target for editor previews. Release or park unused sources and buffers. Preserve editable disconnected nodes in the graph rather than rejecting them or adding an arbitrary hard node-count cap.

**Regression coverage:** Large disconnected banks do not start unused cameras/media/renderers; selecting a disconnected node in the editor lazily prepares it; shared dependencies are instantiated once. Probe: `unreachable-sources-are-prepared-and-drawn`.

### F08 — P2: The non-FX renderer lets an unrelated missing source poison the entire graph

**Evidence:** `nodes/runtime.js:137–154, 298–305`; compare the per-node checks in `nodes/runtime.js:379–423`.

For graphs without FX, any graph diagnostic causes the constructor to return before preparing sources. The synchronous renderer also paints `this.diagnostics[0]` onto every visited node. The async FX path is more selective. This is explicitly retained legacy behavior, not a newly proven FX-chain regression, but it is an over-broad failure policy for an editable graph.

**Reproduction:** Wire a healthy red source to Output and leave a separate missing Pattern node disconnected. The runtime starts zero sources and produces the diagnostic-card color `[41,23,34,255]`, instead of the healthy red branch.

**Impact:** An unrelated deleted custom pattern or obsolete dependency can interrupt working output. Adding an FX node can also change the graph's failure-isolation behavior because `hasFx` is a graph-wide switch.

**Recommendation:** Use one node-scoped failure policy in both execution paths. Preserve graph-wide repair diagnostics, but isolate failed branches and keep unrelated reachable branches operational. Decide separately whether warnings should block publishing/saving.

**Regression coverage:** Missing/changed/unapproved/invalid nodes on reachable and unreachable branches in both legacy and FX graphs. Probe: `unconnected-invalid-pattern-blocks-healthy-output`.

### F09 — P2: Important editor errors are deliberately invisible

**Evidence:** `NodesEditor.jsx:364, 420–430, 562–586`; `nodes.css:26–27, 88–89`.

Connection/type/cycle errors and several action messages use `setMessage()`. Outside disk failures, that value is only attached to the workspace as `data-status`. It is not visible text or a live region. Simplifying the UI removed the feedback channel along with the old status strip.

**Reproduction:** Connect a Script output to Output's image input. The workspace gets `Scalar outputs connect to Math/Script inputs or a signal endpoint, not image inputs.` in `data-status`, while the page's visible text contains none of that explanation.

**Impact:** Operators see an apparently non-responsive connection action. The application knows why it rejected the operation but withholds the explanation, including from assistive technology.

**Recommendation:** Keep the quieter layout, but expose action failures through a compact inline alert, transient notification, or inspector message. Separate success/guidance text from actionable errors instead of hiding both.

**Regression coverage:** Invalid type connections, cycles, refused mappings, and protected Output deletion must have visible, accessible explanations. Probe: `connection-error-only-in-data-attribute`.

### F10 — P2: Signal input-range validation escapes the UI error handler

**Evidence:** `NodesEditor.jsx:703–706`; `ModulatedParameter.jsx:16–19, 109–110`; `model.js:35, 171–175`.

Mapping output endpoints are clamped with `mappingEndpoint()`, but signal input endpoints pass finite numbers directly into `edit(mapSignalInput(...))`. The handler only checks ordering and is not wrapped in `attempt()`. Values outside the model's ±1,000,000 bound therefore throw from the React event handler.

**Reproduction:** Expand a Brightness mapping and enter `1000001` in Signal in max. Chromium reports `Invalid modulation input range`. The focused field displays `1000001`, while the workspace status remains null and the graph edit has been rejected.

**Impact:** No useful validation feedback; the field temporarily suggests a value the graph did not accept. This is an uncaught event error, not the full React-root crash seen in F01.

**Recommendation:** Validate/clamp both input endpoints consistently, wrap graph mutations in a common error-handling path, and surface field-level errors. Continue allowing legitimate signed and reversed **output** ranges; only input bounds require max greater than min.

**Regression coverage:** ±1,000,000 boundaries, exponent notation, partial negative input, equal/reversed input limits, and restoring the accepted field value on blur. Probe: `input-range-overflow-throws-without-visible-error`.

### F11 — P2: The editor assumes Output has a specific ID that the file contract does not require

**Evidence:** `useNodeSelection.js:12`; `NodesEditor.jsx:504–509`; compare `model.js:33, 134` and `nodes/runtime.js:274, 315`.

Validation requires exactly one node of type Output but accepts any valid unique ID. The runtime derives the default target by type; the editor initializes/reloads selection using the hardcoded string `output` and sends it as the explicit preview target.

**Reproduction:** Load a valid graph whose Output node ID is `final`, connected to a red Pattern. No card is selected and the preview is transparent `[0,0,0,0]`. Clicking the actual Output card immediately produces `[204,0,0,255]`.

**Impact:** Imported/hand-authored valid graphs initially appear broken even though their LIVE runtime can render. The current UI's own new-graph default masks the mismatch in most existing tests.

**Recommendation:** Derive the selected/default Output ID from the loaded graph everywhere, or use null selection to request the runtime's default target. Do not tighten the persisted contract merely to match a UI convenience.

**Regression coverage:** Arbitrary valid Output IDs across open, reload, selection reset, and preview. Probe: `nonstandard-output-id-initially-previews-nothing`.

## Verification results and test-health findings

### Commands and observed results

| Run | Result | Notes |
| --- | --- | --- |
| `npm run build` | Passed | Catalog validated 68 built-ins; Vite emitted a large-chunk warning |
| Targeted Node/FX/scripts/project/audio-pool suite, 2 workers | 240 passed / 3 failed | 243 cases; selection command below |
| Retry the 3 targeted failures, 1 worker | 2 passed / 1 failed | LIVE mapping disclosure test still fails |
| Chromium `@core` suite, 2 workers | 201 passed / 4 failed | 205 cases, not the entire application suite |
| Retry the 4 core failures, 1 worker | 1 passed / 3 failed | Two renderer-readback cases and one old scrollbar assertion still fail |
| Audit harness | 11 probes completed | All findings above have recorded observations; not a green regression claim |

These runs overlap in test coverage; their counts must not be added and described as distinct tests.

Targeted command used:

```sh
PLAYWRIGHT_PORT=5199 npx playwright test \
  'nodes.*\.spec\.js' 'video-fx.*\.spec\.js' \
  'pilot-image-fx.spec.js' 'custom-script.*\.spec\.js' \
  'project-relink.spec.js' 'settings-portability.spec.js' \
  'audio-input-pool.spec.js' --project=chromium --workers=2
```

Core and reproduction commands:

```sh
PLAYWRIGHT_PORT=5200 npm test -- --project=chromium --workers=2 \
  --reporter=dot --output=test-results/audit-core

node .design/node-editor-audit.probes.mjs
# Optional private-port override:
AUDIT_PORT=5201 node .design/node-editor-audit.probes.mjs
```

The harness launches/stops its own Vite server and isolated browser contexts and rewrites only its evidence JSON plus ordinary ignored Vite-generated artifacts. It does not need a running application or the operator's browser session.

### Reproducible test expectation drift

| Test | Observation and likely correction |
| --- | --- |
| `tests/nodes-audio.spec.js:385–438` | Opens mapping settings at line 401, then clicks the same toggle again at line 418 after confirming its LIVE text still exists. That closes the fields, and line 420 waits for the now-unmounted max field. Ensure `aria-expanded=true` instead of blindly toggling. Failed on initial run and isolated retry. |
| `tests/canvas-density-production.spec.js:20–23, 42–64` — DPR 1 and 2 | Still describes Pendulum Wave but selects `membrane-modes`; then requests a 2D context from a shader canvas. Both cases throw on null `getContext('2d')`. `replacements/fields.js:21` constructs Membrane with `shaderFactory`. Update the test target or use renderer-appropriate pixel capture and expectations. These failures do not establish a production density defect. |
| `tests/linked-library.spec.js:321–328` | Expects an 8px stable gutter on `.nodes-pattern-list`. Current CSS deliberately places the scroll container on `.nodes-palette` and sets the list padding to zero (`nodes.css:40–42`). Test the current scroll owner/geometry rather than an obsolete styling implementation. |

### Initial failures that passed in isolation

- `tests/nodes-audio.spec.js:209`: raw `page.evaluate()` dereferenced a missing palette during startup. Use an auto-waited readiness assertion before measuring.
- `tests/nodes-camera-fx-editor.spec.js:156`: `nodePatterns.load()` reported the pattern unavailable while the test polled disk immediately after Save. Its helper triggers another refresh while save/refresh work can be in progress. Await save completion first and investigate the repository read/write race rather than assuming a renderer fault.
- `tests/custom-scripts.spec.js:507`: expected Link Folder immediately after initiating Unlink and reloading. The asynchronous unlink was not explicitly awaited through visible completion. Await the dialog closing/committed unlink state before reload.

One passing retry does not prove these paths are free of product races; it only means the initial failure was not reproduced in isolation.

### Core selection misses most node-specific coverage

`package.json:10–17` makes `npm test` run only `@core`. Enumeration found **173 cases in the 17 `nodes*.spec.js` files**, but only **17** of those are selected by the Chromium core filter. The new Blend/Transform, most scalar/editor interactions, and several FX node suites therefore are not exercised by the default command.

Recommended change: define a small, explicit node regression tier covering draft safety, file compatibility, lifecycle continuity, and FX pixels; run the broader node suite in CI as well. Keep test expectations synchronized with UI simplifications rather than disabling broken tests without replacing their original safety coverage.

## Additional risks requiring follow-up, not counted among the 11 reproduced issues

### Camera hot-unplug and post-readiness errors

`shared-camera-source.js:172–207` subscribes to initial video readiness and suppresses its error callback once `reported` is true. There is no track `ended`/`mute` or device-change recovery path in this manager. A physical disconnect after readiness may therefore leave a stale stream/frame with insufficient diagnostics. This was **not tested on physical hardware**. Add fake-track lifecycle tests and a manual unplug/reconnect matrix for Global and pinned devices, with two devices active concurrently.

### Async FX frame cancellation and deadlines

`nodes/runtime.js:315–322, 393` retains one in-flight evaluation until its promise settles; `program-runtime.js:774–792` awaits redraw without a frame deadline. Existing warm-up and TAKE timeouts do not independently settle a hung per-frame FX draw. Built-in tested FX draws completed; a permanently pending asynchronous renderer was **not demonstrated through the supported custom-script UI**. Treat cancellation/deadline handling as defensive hardening, not a claim that a current built-in hangs. Preserve generation checks so a timed-out late draw cannot overwrite a replacement frame.

### GPU allocation/context-failure handling

`gl-compositor.js:164–206, 279–295` catches JS exceptions but does not check GL error state after texture upload. GL allocation failures can be reported through GL error state rather than exceptions, so the documented graceful fallback deserves fault-injection tests. The unused `releaseGlCompositor()` helper also calls `shared?.dispose()` when the sentinel may be `false`; optional chaining does not guard a non-null boolean. Prefer a safe capability check and explicit cleanup ownership before wiring this helper into production lifecycle.

Do not replace the shared-context approach with a context per node: that would worsen the resource problem. Also preserve the existing viewport-origin handling; the larger-to-smaller graph regression is already covered.

## Improvements beyond correctness fixes

| Theme | Suggested improvement | Why it matters |
| --- | --- | --- |
| Compiled graph plan | Pre-index nodes, incoming image/signal edges, modulation targets, and topological order per structural revision | Validation/runtime repeatedly use `.find()`/`.filter()` over whole arrays (`model.js:178–187`; `runtime.js:233–242, 283–288, 335–339, 370–377`). Avoid repeated graph-wide scans in frame loops. |
| Resource-aware previews | Prepare only active targets, reuse scratch buffers when lifetimes do not overlap, expose source/context/buffer diagnostics | FX currently adds front/work/staging canvases and existing sources may keep their own render surfaces. Use measured warnings and quality controls, not the removed arbitrary node/source caps. |
| Resolution policy | Make the current 1280×720 maximum graph-intermediate resolution visible and optionally configurable | `runtime.js:85–88` intentionally caps graph buffers. It is a quality/performance policy, not an accidental Transform bug; users should understand why high-resolution output may be upscaled. |
| Error delivery | One typed diagnostic model with severity, node ID, operation, and recovery guidance; surface critical LIVE degradation outside the editor | Runtime `warnings`/`messages`, graph diagnostics, editor `message`, and disk errors currently have different presentation/throwing behavior. |
| Recovery UX | Undo/redo for graph edits, per-node text drafts, and a recoverable unsaved draft snapshot | Destructive edits and crashes currently offer much less recovery than disk conflict handling. Any browser recovery copy should be explicitly separate from the authoritative disk record. |
| Accessibility | Add a keyboard-accessible Add-at-canvas-center/context-menu action while keeping drag-to-place | Palette creation is drag-only (`NodesEditor.jsx:565–590`). Existing keyboard wire selection and node nudging are good, but keyboard-only users cannot create these nodes. |
| Module boundaries | Extract editor state transitions, persistence actions, and project orchestration into independently testable units | `NodesEditor.jsx` is 716 lines and `app/runtime.js` is 3,960 lines at the reviewed revision. Shared error/transaction logic is difficult to enforce across these large coordinators. |
| Startup delivery | Lazy-load editor UI/script compiler where practical, without duplicating the mutable registry | The build emitted one main JS chunk of **1,146.24 kB**, **337.16 kB gzip**. Treat this as measured bundle size, not a measured startup-time regression. |
| Contracts and documentation | Remove obsolete transition comments and duplicate capability checks | `visibleInputs()` comments still talk about definitions not supporting optional image inputs, while `definitions.js` now does. The editor's local `acceptsImage()` also differs from `canAcceptImageFx()` for composite sources. Prefer one capability predicate with a deliberate repair-mode policy. |

### Suggested implementation sequencing

| Stage | Scope | Exit criterion |
| --- | --- | --- |
| Protect authored work and project identity | F01–F04, focused fault-injection tests | Normal edits cannot crash or lose text; project open either commits correctly or reports/recoverably handles partial failure |
| Correct reset and editor feedback | F05, F09–F11 | New Project is actually clean; all refused edits explain themselves; valid Output IDs work |
| Stabilize preview/live execution | F06–F08, runtime-plan and lifecycle tests | Numeric edits preserve unaffected resources; disconnected sources consume no live execution budget; branch failures stay isolated |
| Restore test confidence and harden devices/GPU | Test drift, CI tiering, camera/GL fault matrix | Default and node-specific tiers are green for the right reasons, and degraded hardware paths produce actionable diagnostics |

## Positive findings to preserve

- Structural graph validation rejects cycles, duplicate IDs/ports, recursive graph references, malformed script fields, and non-finite/range-invalid values. Imported missing dependencies remain structurally repairable.
- Scalar Script expressions and bodies are interpreted/compiled through allowlisted, bounded logic rather than `eval`/`Function`. Approval is keyed to exact text and language. This should not be conflated with trusted filesystem `.viz.js` code, which intentionally has browser privileges.
- Per-node audio routes use distinct requested device/channel identities; existing pool tests cover sharing, resource limits, retirement, and failure statuses. The editor consumes the control owner's signals instead of opening its own microphone.
- FX graphs snapshot upstream sources, avoid overlapping evaluations, await completed draws, and commit front/work buffers together. Existing tests cover fan-out, asynchronous ordering, resize/dispose, failed FX clearing, and WebGL image transport.
- Camera previews use a generated clip rather than acquiring camera access. The recent per-device acquisition fix prevents one pending physical device from retiring another.
- Blend/Transform share one lazily created compositor, preserve identity shortcuts, distinguish warnings from error cards, and include tests for alpha, formulas, geometry, fallback, and changing viewport sizes. No new pixel-compositing defect was established in this audit.
- Node file saves include structural checks, payload limits, Web Locks, stale-draft detection, overwrite confirmation, and rechecking after confirmation. These safeguards should survive any higher-level project transaction refactor.

## Deliverable location

All review files were created in the isolated workspace:

```text
/home/azero/.okbrain/workspaces/bread-viz/199/.design/
```

Files:

- `2026-09-23-node-editor-code-audit.md` — this report.
- `node-editor-audit.probes.mjs` — isolated browser/OPFS reproduction harness.
- `node-editor-audit-evidence.json` — observations at the reviewed revision.

Application source fixes are deliberately outside this audit. The highest-value immediate fixes are the blank-name crash, multi-Script draft storage, stable project directory identity, and truthful/transactional project import behavior.
