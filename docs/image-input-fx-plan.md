# Image-input FX: implementation plan

## 1. Scope and compatibility rule

**Planning only; none of the APIs or changes proposed below are implemented by this document.** The goal is to let an FX-capable pattern process an existing graph image/frame instead of acquiring its own camera image. Keep existing patterns, IDs, parameters, and source behavior. Add an explicit, per-node opt-in FX mode; never reinterpret an old pattern node merely because its definition gains FX capability.

First release: one image input per FX pattern, existing visual image edges, built-in and custom-script capability metadata, two pilot camera effects, an editor capability badge, and an FX-only pattern filter. Reuse the graph's existing canvases/rendering infrastructure. Do not introduce another image importer, arbitrary GPU texture sharing, multiple FX inputs, graph feedback, or automatic conversion of every camera pattern.

This plan uses focused reads, not a complete camera/catalog audit. **Observed** statements describe inspected code; **proposed** names are design choices; **TBD** means verification is required during implementation, not a reason to delay this plan.

## 2. Observed integration points and constraints

| Area | Observed behavior | Consequence |
|---|---|---|
| `src/nodes/definitions.js:48–59` | `inputs(node)` returns `[]` for patterns. `activeInputs` also serves editor/runtime contracts. | Adding a socket requires a shared contract, not just JSX. Retain the existing color node's `image` port semantics. |
| `src/nodes/model.js:103–111` | Image-edge destinations are explicitly limited to blend/color/output, and ports/duplicate destination wires are validated. `VERSION` is currently `1`. | Adding pattern ports alone will still reject FX wiring. Update structural validation and serialization together. |
| `src/nodes/runtime.js:86–108` | Each pattern owns a `ProgramRuntime`. Camera patterns are blocked in preview or without shared capture. Completed source draws are copied into node canvases inside `onDraw`, before WebGL pixels disappear. | FX mode needs capability-aware camera gating and a completed-draw input/output boundary. Do not read discarded WebGL buffers later. |
| `src/nodes/runtime.js:173–185` | Visual traversal recursively resolves edges for color/composite nodes; pattern nodes use their existing buffers rather than processing an upstream image. | Simply passing a canvas to independently running patterns does not establish FX-chain ordering. Scheduling is a central part of the feature. |
| `src/program-runtime.js` | Owns child runtimes and camera/fresh-frame bookkeeping. | Input mode, capture policy, draw completion, readiness, and disposal must propagate here. Exact new scheduling hook is TBD. |
| `src/sketches/video_chroma.js:146–174` | Creates capture through the runtime or raw `p.createCapture`; checks capture readiness/metadata/dimensions; uploads capture to `uTex`; computes cover crop. Shader comments also describe selfie mirroring. | Candidate for substituting an image source, but capture-only readiness and coordinate assumptions must be removed from its FX path. |
| `src/sketches/webcam_dots_gpu.js:170–194` | Same capture fallback pattern, capture-metadata gate, and texture uniform input. | Second shader-based pilot; preserve its existing audio mappings and time/parameter behavior. |
| `src/patterns/assembler.js:58–81`, `src/sketch-registry.js` | Assembler validates built-in descriptors, including `camera`; registry consumes the built-in catalog and combines runtime categories. Registry comments identify `src/patterns/builtins.js` and discovered `*.pattern.js` descriptors. | Add metadata to the canonical descriptor path, not a second hard-coded editor list. Exact legacy descriptor declaration files are TBD. |
| `src/custom-scripts/compiler.js:58–64` | Strict definition-key allowlist; `camera` is boolean; hooks are validated. | A new `fx` key must be explicitly allowed and validated. |
| `src/custom-scripts/adapter.js:69–94` | Provides shared capture, cleanup, cancellation, and a renderer context. Its earlier `frame` handling concerns audio data. | Add an explicitly named image input; do not overload existing audio `frame` data. |
| `public/docs/custom-scripts-api.md` | Documents synchronous `draw`, renderer-local state, camera preview restrictions, transactional reloads, and eventual cross-window revision synchronization. `p` is not sandboxed. | Preserve existing hooks and reload safety. Describe FX as a supported rendering contract, not a security boundary. |
| `src/core/media.js`, `src/core/renderer-gl.js`, `src/shared-camera-source.js` | Media comments describe `.canvas`/`.elt` source resolution; GL comments describe upload orientation; shared capture tracks device sources. | Prefer the existing source/texture path. Exact accepted input classes, upload caching, and release semantics remain TBD. |

The precise editor picker/search implementation, full camera inventory, renderer completion API, and current test locations were intentionally not exhaustively inspected.

## 3. Proposed capability, mode, and graph schema

### Descriptor capability is not an instance mode

Use the same validated optional descriptor on built-ins and custom scripts:

```js
// Proposed descriptor addition; omission means source-only.
fx: { input: 'image' }
```

This declares that the pattern has been adapted to consume an upstream image **without requiring its own camera in FX mode**. It does not say that the pattern is currently running as an FX. `camera: true` retains its legacy meaning for source mode; do not globally clear it on adapted camera patterns. Do not infer FX capability from `camera`, a name, a group, or the presence of a shader.

Use a graph-node property separate from numeric params and existing compositing modes:

```js
// Proposed graph fragment; patternId is the existing registered ID.
{ id: 'fx1', type: 'pattern', patternId: '<existing-id>', inputMode: 'fx' }
{ from: 'source1', to: 'fx1', port: 'image' }
```

- Missing `inputMode` means `source`, including imported graphs and standalone pattern playback. Never infer mode from connectivity.
- Source-mode patterns retain no visual input and preserve their current output.
- FX-mode patterns have exactly one `image` input and the existing visual output. They may consume pattern, blend, or color outputs, including other FX patterns.
- Keep scalar `script` nodes distinct from custom-script **patterns**. Their signal ports, approval handling, and scalar execution do not become image FX.
- The first release need not support FX-only descriptors with no standalone behavior. Custom effects can provide a simple source fallback and the FX path under the same definition.

### Structural and capability validation

Keep dependency-free port definitions free of registry imports. Let `inputs`/`activeInputs` derive the stored port shape from `type` and validated `inputMode`; use an injected descriptor lookup or a dependency-free capability helper for semantic availability checks. A missing live descriptor must not erase a saved socket/wire.

Update the model's explicit image-destination allowlist as well as shared port helpers. Validate modes, references, port names, one incoming image edge, visual-versus-scalar types, self-edges, and cycles through patterns. Include FX image dependencies in topological ordering and any mixed image/modulation cycle policy; inspect the existing cycle implementation before changing it. Retain existing size/resource limits.

Separate malformed graphs from currently unavailable capabilities:

- New editor connections require a known FX-capable definition in FX mode. Reject unsupported source-mode connections with a useful message.
- An FX node may be temporarily unconnected while editing; diagnose “Image input required” rather than substituting a camera.
- If a custom script disappears, loses FX capability, or fails reload, preserve the graph's mode, params, and wires for repair. Disable affected rendering with a diagnostic instead of silently deleting edges or reverting to source behavior. Reuse/extend the existing portability diagnostics path; exact import handling is TBD.
- Changing back to source mode while wired requires an explicit, undoable disconnect-and-switch confirmation, or refuse until disconnected. Replacing a wired FX pattern with a source-only one follows the same rule. Never retain an invisible ignored image wire.

### Saved graphs and versioning

Recommended: continue exporting source-only graphs in the existing format with no added default property. Introduce graph format version `2` for graphs containing FX mode/edges; the new reader accepts version `1` unchanged and version `2` explicitly. Do not label an FX graph as version `1` and hope old readers understand it.

Before finalizing, verify the actual version checks and save/import/export/clone paths (TBD). Old builds must reject unsupported FX graphs clearly rather than drop mode metadata or image edges. Preserve IDs, edge endpoints, params, and explicit mode across round trips, undo/redo, duplication, reload, and LIVE/CUE handoff. Descriptor capability stays in the registry, not as a trusted capability assertion copied into graph JSON.

## 4. Image/frame contract, scheduling, and ownership

### Proposed runtime surface

Provide built-in factories with `runtimeContext.inputMode` and `runtimeContext.getImageInput()`. Provide custom hooks with `ctx.inputMode` and a per-draw `ctx.imageInput`. Names are proposed, not existing APIs. Use one common internal provider so built-ins and custom scripts cannot diverge.

A first-release input is a borrowed, read-only-by-contract frame view:

```text
ImageInputFrame:
  source         canonical graph-owned HTMLCanvasElement
  width, height  actual pixel dimensions, positive when ready
  frameId        graph evaluation token
  timestampMs    monotonic graph render time, not a database/event timestamp
  generation     invalidates views after resize, rebuild, or disposal
```

`null` means no usable image for this draw. The host separately exposes an editor diagnostic/status for disconnected, pending, unsupported, or failed input. Setup/preload cannot assume a frame exists. Existing media, static-image, procedural, and composited patterns can supply their completed graph canvas without inventing a second asset path.

Start with canvases because the graph already captures into them. Let `p.image(input.source, ...)` and texture uniforms use the existing image-source resolver after verifying it with both renderers. Do not pass raw `WebGLTexture` objects between contexts. `ImageBitmap`, `VideoFrame`, direct video, and zero-copy GPU paths are later extensions with their own ownership contracts.

### Evaluate dependencies, not independent FX animation loops

Preferred sequence for one graph tick:

1. Pin each reachable source's latest completed frame and snapshot the tick's parameters/signals/time. A source need not produce a new camera frame on every graph tick.
2. Traverse the reachable image DAG. Resolve an FX node's upstream frame first, bind that frame to its child runtime, then request one controlled FX draw.
3. Wait for the core's real draw/renderer-finish completion, capture the result at the existing completed-draw boundary, and publish that node's output once. Fan-out consumers reuse it for the same tick.
4. Composite downstream color/blend/output nodes only after dependencies complete. Commit a completed graph output; never publish a partially evaluated chain.

Add a graph-driven mode for FX child runtimes so their autonomous loop cannot race the graph. Keep legacy source playback behavior unchanged. Allow at most one graph evaluation in flight; coalesce/drop excess tick requests instead of building an unbounded queue. User `draw` hooks stay synchronous even if the host must await renderer completion.

**Scheduling integration is TBD and a pilot release gate:** `render(targetId)` currently performs synchronous traversal. Verify its callers and the VizCore draw/finish hooks before choosing the controlled-draw method. If evaluation becomes asynchronous internally, preserve a synchronous “last fully committed output” view for callers that need it, with explicit readiness/fresh-frame signaling. A documented whole-graph presentation delay is acceptable; accidental additional stale-frame delay at every FX hop is not. Do not assume calling `redraw()` means pixels are complete, and do not use arbitrary timers as a completion barrier.

### Lifetime and resource rules

- The producer/runtime owns input canvases. Consumers must not draw into, resize, remove, dispose, or retain them for later asynchronous use. Freezing a wrapper does not make its underlying canvas immutable; this is a trusted rendering contract.
- Pin inputs for the full graph tick and keep them stable until all consumers finish. Independent source `onDraw` callbacks must not overwrite a pinned source. Use bounded reusable completed-frame/staging buffers, swapping only at graph boundaries; avoid per-edge copies and per-frame allocation.
- Each FX owns its output canvas and local shader textures, not the input. Keep input and output distinct to avoid read/write feedback. Texture caches must refresh contents for a reused canvas when its frame revision changes, not only when object identity changes.
- Temporal effects must explicitly copy into bounded effect-owned history. Reset history on upstream replacement, mode changes, resize/generation changes, and relevant device changes. Do not retain borrowed views as history.
- Dispose local textures, history buffers, and child runtimes once. Abort pending work; ignore late completed draws from old generations. Release only camera leases actually acquired by that runtime; never stop an upstream/another consumer's shared stream.
- Preview, LIVE, CUE, and projection children have separate renderer-local resources. Pass providers/revisions within a runtime; do not serialize canvas handles into saved graphs or send them as registry metadata between windows.
- Prefer the existing canvas-to-texture path. Avoid `getImageData`, `readPixels`, data URLs, or new image allocations in ordinary shader FX. Profile transfers later; do not promise zero-copy, a frame-rate target, or unchanged memory use without measurement.

### Coordinates, dimensions, and alpha

For FX, default to the upstream orientation with no automatic selfie mirror. Preserve existing source-camera mirror/cover behavior in source mode. Use actual input dimensions rather than `loadedmetadata`, capture width, or output size as a readiness proxy.

At equal sizes, coordinate mapping should be identity. For differing sizes, propose contain/transparent letterboxing unless the effect explicitly documents a different fit; a shared helper should handle this consistently. Existing graph buffers may already be sized to the output, so original asset dimensions must not be invented. Exact fit controls are an open decision.

Respect input alpha through the transport and compositor; audit each effect's intended output alpha separately. Both pilot paths currently clear to black, so transparent FX behavior is not proven. Test premultiplication, Y orientation, mirror, crop, and transparent borders using an asymmetric color/alpha fixture. Do not silently change the legacy camera appearance while correcting the FX path. Tainted/unuploadable images or GL context loss should produce a bounded diagnostic and the defined fallback, not repeated exceptions.

## 5. Camera/no-camera behavior and fallback

| Instance state | Required behavior |
|---|---|
| Existing/source-mode camera pattern on output | Preserve existing shared capture, device selection, readiness, and cleanup behavior. No automatic mode migration. |
| Source-mode camera pattern in control preview or without permitted camera | Preserve the current restriction/diagnostic. Do not create a second preview camera or invent a new fallback. Exact legacy visuals are TBD. |
| FX mode with ready upstream image | Render from that image. No camera lease, device permission prompt, capture-metadata wait, or camera-ready gate for the FX instance itself. |
| FX mode with a camera-source node upstream | Only that upstream source owns acquisition. Downstream FX reuse its frames. The graph still depends on a camera through the source. |
| FX mode disconnected, pending, or invalid | Clear to transparent, report the reason, and recover on a valid frame. Never silently open the camera or switch modes. |
| FX draw/texture failure or unsupported capability | Clear the failed output and report a bounded error. Default is not an unprocessed-image bypass or an indefinitely frozen last frame. A future explicit bypass toggle is a separate feature. |

Implement camera need as an **effective per-instance/per-graph dependency**, not just `sketch.camera`. The blanket camera check in `nodes/runtime.js` must allow an adapted camera pattern running in FX mode, but continue blocking a genuine source-mode camera dependency. Propagate this distinction through ProgramRuntime, child runtimes, preview checks, camera freshness, and output readiness; inspect other gates during implementation. Do not remove legacy camera flags globally.

The pilot sketches currently use `runtimeContext?.createCapture(...) || p.createCapture(...)`. Guard the entire acquisition branch by mode. Returning `null` from the host in FX mode is insufficient: it would trigger raw capture fallback. Supported capture entry points should fail explicitly if mistakenly called by an FX instance, including the instance's `p.createCapture` path where feasible. The guard must exist before setup and be cleaned up with the instance. Custom scripts expose real `p` and are trusted code; this is not a promise to sandbox arbitrary direct browser `getUserMedia` calls.

Recreate the affected child runtime on an explicit source/FX mode change for the first release. This gives a clear release/reset boundary and avoids partially initialized camera state. Rewiring an FX input can retain the runtime but must invalidate its frame provider and temporal history. Missing FX input must not hang an output “fresh frame” wait on a camera event that will never occur; distinguish setup-ready, input-pending, and completed-render states.

## 6. Camera effect classification and conversion order

This is a partial classification, not a claim that all camera sketches were audited.

| Class / inspected example | Initial decision | Conversion work / uncertainty |
|---|---|---|
| Single-frame GPU color/chroma processing: `video_chroma.js` | **Pilot candidate A; strong evidence of a substitutable texture input.** | Separate acquisition from shader draw; replace capture metadata checks; preserve audio/time/params; split source mirror/cover from FX coordinates; verify alpha and the exact visual effect. No claim that its output is already transparent keying. |
| Single-frame GPU sampling/stylization: `webcam_dots_gpu.js` | **Pilot candidate B; strong evidence of a substitutable texture input.** | Bind input to `uTex`; replace readiness checks; verify spacing/resolution, time animation, audio mapping, orientation, and transparent input. |
| Other single-frame shader camera effects | Likely adaptable, **names/count TBD**. | Audit acquisition and all capture property access; do not label FX-capable until both renderers/input fixtures pass where applicable. |
| CPU pixel-sampling effects | Potentially adaptable, **inventory TBD**. | Look for `loadPixels`/pixel arrays, density, video-specific dimensions, and readback cost. Require explicit bounded readback and origin/error handling. Not first pilots. |
| Temporal effects, motion differencing, trails, optical flow | Adapt only with explicit owned history; **inventory TBD**. | Define repeated-frame behavior, timing, history reset, memory budget, and whether “motion” makes sense for static input. |
| Camera/device-specific detection or calibration | Keep source-only unless the algorithm truly accepts arbitrary images; **inventory TBD**. | Verify model input type, intrinsics, camera controls, timing, and coordinate expectations. Camera use alone does not prove an image FX is meaningful. |
| Plain camera source / effects that do not actually transform an image | Keep as sources unless an intentional pass-through FX use case is agreed. | Avoid capability badges that promise nonexistent processing. Exact membership TBD. |

For each converted sketch, use one effect drawing function with a normalized frame and separate source acquisition. Prefer a small shared image-input helper to duplicated fake capture objects. Do not emulate `loadedmetadata`, `hide`, or `remove` on a borrowed graph canvas just to satisfy camera code. Inspect both the migrated audio-controls path and any legacy/raw-frame draw path; either route both through the shared effect draw or explicitly constrain unsupported invocation paths. Direct standalone use still defaults to the original source behavior.

## 7. Custom scripting API

Extend `validateDefinition` to permit and strictly validate `fx: { input: 'image' }`, rejecting unknown fields/values. Preserve synchronous hook requirements, params validation, cancellation, and transactional registration. Map the same capability into the sketch descriptor in the adapter; do not rely on the editor to infer it.

Proposed renderer context additions:

| Member | Contract |
|---|---|
| `ctx.inputMode` | Immutable for the renderer instance: `source` or `fx`. Mode changes recreate the instance initially. |
| `ctx.imageInput` | Current borrowed `ImageInputFrame` during a draw, or `null`. Refreshed every draw; unavailable for retention/async processing. |
| Existing `ctx.createCapture` | Unchanged source behavior; explicit error in FX mode, never a raw-camera fallback. |

Example **proposed API**, not executable against today's compiler:

```js
api.requireVersion(1); // Recommended additive extension; final version policy TBD.
api.create({
  id: 'custom-image-example',
  name: 'Image example',
  fx: { input: 'image' },
  draw(ctx) {
    const { p } = ctx;
    if (ctx.inputMode === 'fx') {
      const frame = ctx.imageInput;
      if (!frame) return; // Host clears and reports unavailable FX input.
      p.image(frame.source, 0, 0, p.width, p.height);
      // Apply the script's effect here; this example only demonstrates input access.
      return;
    }
    p.background(24); // Explicit standalone source behavior.
  },
});
```

Document a separate dual-source camera example whose setup acquires capture only in source mode, and a WebGL example using the common texture resolver. Keep image inputs out of `audio.update(frame,state)` and out of persistent params/registry snapshots. Refresh `ctx.imageInput` around each draw without changing audio/control consumption semantics.

Use the existing service's selected-generation validation/last-good behavior. Test that a failed reload preserves prior definitions/renderers; a successful change removing FX capability leaves referencing graphs repairable and diagnostic rather than silently switching them to cameras. Cross-window recipients must independently validate the capability and recreate affected instances on revision changes. Whether `service.js` needs code beyond propagating metadata is TBD; inspect for field picking before editing it.

Recommended compatibility policy: optional additive schema/context fields within scripting API version 1, leaving existing scripts unchanged. Before release, decide whether capability negotiation or a new API version is needed. Older compilers already reject unknown definition keys, but their error should make the required application/API support clear. Do not document this as an already supported API.

## 8. Node editor discovery, controls, and preview

Use a distinguishable **`◇ FX`** badge on capable pattern picker rows and pattern-node headers. Pair the symbol with accessible text/tooltip “Accepts an image input”; do not use color alone or replace pattern names/IDs. A capable source-mode node keeps its capability badge, while a separate “Source”/“FX active” state prevents confusion between capability and current operation. Final icon styling is open.

Add an explicit **FX only** toggle beside the node pattern picker search. Combine it with normal text search as an intersection, not a replacement. Prefer a shared capability selector so built-ins and loaded custom scripts appear consistently; camera labels and name substrings are not the filter. Retain existing type/category constraints, selection, keyboard navigation, and empty-state behavior. Current search component/state names are TBD. Optional `fx:` query syntax can wait.

Normal add-pattern flow defaults to Source. An explicit “Add as FX” action (including one offered in the FX-only results) creates FX mode with a visible `image` socket. Filtering alone should not silently change the behavior of an existing add action or selected node. The inspector exposes Source/FX mode only where appropriate, alongside the destructive-switch confirmation described above. Socket hit-testing, wire anchors, labels, validation feedback, and node layout must all use the shared port contract.

Preview must exercise the same frame provider, fit, alpha, scheduling, and fallback as output. A procedural/static upstream feeding an adapted camera effect in FX mode must preview without camera permission. If the upstream is itself a blocked camera source, show that dependency clearly; do not bypass preview policy by opening capture in the effect. An optional explicit demo/test image for an otherwise disconnected preview is a future UI decision, never an implicit saved-graph input. Preserve parameter modulation, audio routing, and renderer-local history isolation between preview/LIVE/CUE.

## 9. Proposed implementation sequence and file change map

No implementation is performed as part of this planning task. Future work should proceed in bounded slices:

| Slice | Files / seams | Deliverable and gate |
|---|---|---|
| 1. Contracts and compatibility | `src/nodes/definitions.js`, `src/nodes/model.js`; save/load callers **TBD**; optionally new dependency-free `src/patterns/capabilities.js` | Opt-in mode, image port, versioned round trips, pure structural validation plus live capability diagnostics. Legacy graph fixtures unchanged. |
| 2. Metadata | `src/patterns/assembler.js`, canonical built-in descriptors and `src/patterns/builtins.js` integration, `src/sketch-registry.js` | One validated descriptor contract; no parallel editor allowlist or changed IDs. Exact pilot descriptor paths **TBD**. |
| 3. Frame transport and scheduling | `src/nodes/runtime.js`, `src/program-runtime.js`, `src/core/sketch.js`; new shared input helper location **TBD** | Borrowed stable inputs, controlled FX draws, completed-output publication, bounded buffers, mode-aware camera/readiness policy. Prove two chained test effects before broad conversion. |
| 4. Core adapters only if needed | `src/core/api.js`, `src/core/media.js`, `src/core/renderer-gl.js`, `src/shared-camera-source.js` | Verify existing canvas image/texture support and camera lease behavior first. Edit only demonstrated gaps: texture refresh/orientation, completion hook, capture guard, or cleanup. No general core rewrite. |
| 5. Pilot effects | `src/sketches/video_chroma.js`, `src/sketches/webcam_dots_gpu.js`, their canonical descriptors | Dual-source behavior with legacy-source visual parity, no FX capture, explicit input transforms and cleanup. Mark FX capability only when verified. |
| 6. Script parity | `src/custom-scripts/compiler.js`, `adapter.js`, `service.js` only if propagation requires it; `public/docs/custom-scripts-api.md` | Schema/context parity, examples, version policy, safe reload and useful diagnostics. No change to scalar script nodes. |
| 7. Editor and portability | `src/nodes/NodesEditor.jsx`, existing editor styles/picker helpers **TBD**, `src/nodes/portability.js` if needed | Capability badge, explicit mode/add action, image wiring, FX-only search, preview/dependency errors, undo-safe edits. |
| 8. Focused regression coverage | Existing model/runtime/script/editor/core suites and fixtures; exact paths/commands **TBD** | Run the matrix below in the implementation task, then audit additional camera categories incrementally. |

The first demonstrable vertical slice should be procedural source → one pilot FX → output with no camera present. Then prove a two-FX chain/fan-out and old-source parity before converting further patterns or optimizing transfers. Keep schema, scheduling, and camera policy as release gates rather than deferring them behind a cosmetic socket implementation.

## 10. Test plan for future implementation

No tests, builds, screenshots, or generated fixtures are run/created for this document.

| Layer | Focused coverage |
|---|---|
| Model / compatibility | Version-1 source graphs stay sources; version-2 FX round trip; unsupported versions fail clearly; missing mode defaults to source; invalid modes, wrong port/type, duplicate image wires, self/cross-node cycles; unconnected FX editing; undo/redo/duplicate; missing or capability-changed custom pattern remains repairable. |
| Capability / catalog | Metadata omitted, valid, malformed, and unknown-key cases; built-in/custom selector parity; no automatic promotion of all camera patterns; public registry metadata survives assembly/reload. |
| Runtime ordering | Numbered fixture frames through source → FX → FX → color/blend → output; fan-out renders once per tick; no per-hop stale-frame lag; pinned input cannot be overwritten by concurrent source draws; one in-flight tick; late callbacks after rebuild/dispose ignored. |
| Rendering | Canvas2D and WebGL producers/consumers; same-canvas texture refresh; static images and animated frames; resize/DPR; asymmetric orientation/mirror/aspect fixture; transparent borders and alpha composition; context-loss/unsupported/tainted-input fallback. |
| Camera policy | Spy on shared capture and supported raw capture entry points: zero calls for FX including setup, preview, disconnected/error states; legacy source still acquires on output; only upstream camera acquires in camera → FX chains; mode switch and disposal release only owned leases. |
| Pilot regressions | Existing source-mode appearance and params/audio behavior unchanged; both migrated-controls and legacy draw routes covered where supported; FX input replaces camera content; all capture-only readiness assumptions removed from FX. |
| Custom scripts | Existing scripts unchanged; source/FX context and null-input behavior; 2D/GL input examples; synchronous draw enforcement; per-instance state; cleanup; failing reload retains last good; capability-removing reload preserves graph with errors; receiving windows revalidate. |
| Editor / preview | Badge and mode distinguishable without color; FX-only + text search intersection; custom patterns appear; accessible keyboard toggle/actions; explicit opt-in and disconnect confirmation; socket geometry/wiring; no-camera preview works for noncamera input; upstream camera restriction remains visible. |
| Resources / performance | Repeated connect/disconnect, resize, source/FX switching, preview open/close, LIVE/CUE transitions, and reload; bounded canvases/textures/history/leases; no upload/readback allocation per edge; later measure realistic multi-FX frame time without setting an unverified performance claim. |

Start with existing unit/browser harnesses and mocked capture; reserve physical-camera checks for legacy parity. Establish exact test commands and baseline fixtures during implementation rather than guessing suite names here.

## 11. Acceptance criteria

- Existing saved graphs and standalone patterns keep their IDs, parameters, source/camera behavior, and visual output without user action. FX requires an explicit instance mode and a validated descriptor capability.
- A procedural or existing media/image source can feed either pilot, then another FX, blend/color, and output with the correct frame ordering and no effect-owned camera request.
- Pattern image edges participate in validation, cycle detection, serialization, editing, diagnostics, and resource limits. Unsupported or missing definitions never silently lose wires or become cameras.
- Disconnected/not-ready/failed FX produces the documented transparent fallback and a useful status. Camera readiness cannot deadlock an input-only runtime.
- Input frames remain stable for their consumers; fan-out reuses completed outputs; consumers do not mutate or dispose inputs; cleanup/history/camera ownership survives resize, rewire, reload, and mode switching.
- Built-ins and custom-script patterns use the same FX capability semantics and discoverability. The scripting documentation explains source versus FX, borrowed lifetime, capture restrictions, and synchronous drawing.
- The editor visibly marks capability, separately marks active mode, and offers FX-only filtering combined with text search. No-camera preview works when all effective upstream sources are camera-independent.
- Targeted compatibility, ordering, rendering, camera-policy, script-reload, UI, and lifecycle tests pass before marking converted patterns FX-capable. Additional camera conversions are not implied by completion of the pilots.

## 12. Open decisions and bounded follow-up

1. **Graph/API version policy:** confirm existing version guards and choose the final version-2 export rule; decide additive scripting v1 versus explicit feature/version negotiation. Default recommendation is conservative rejection on older applications.
2. **Controlled draw completion:** locate the exact ProgramRuntime/VizCore hook and `render` callers; choose an awaitable internal scheduler with a committed-output view or an equivalent proven barrier. Do not ship independent unsynchronized FX loops.
3. **Frame sizing and fit:** confirm existing graph buffer sizing/DPR, settle contain versus explicit per-effect fit, and document alpha/color-space/orientation semantics. Preserve source camera transforms regardless.
4. **Capability syntax and badge:** confirm `fx: { input: 'image' }`, `inputMode`, context names, and the `◇ FX` badge before making a public API. Avoid expanding the first release into multi-input or FX-only pattern schemas.
5. **Failure presentation:** transparent output plus a diagnostic is the proposed default. Any bypass, hold-last-frame, demo preview image, or automatic camera fallback must be separately explicit; automatic camera fallback is not recommended.
6. **Complete inventory:** pilot files are inspected candidates, not completed conversions. Audit remaining canonical descriptors/camera sketches by the classification above; camera controls, CPU pixel paths, temporal history, and model-based effects are TBD.
7. **Nested patterns and hot reload:** verify effective-camera propagation through projections/nested graph patterns, imported capability loss, cross-window revisions, and child-runtime cleanup. If a nesting case cannot meet the contract initially, reject it explicitly in FX mode rather than silently degrading.
8. **Performance budget:** measure bounded buffer copies and per-context uploads once the pilot is correct. Optimize only after correctness; a zero-copy GPU pipeline is out of scope for the initial feature.
