# CUE Mode and Warm Effect Switching — Design Handoff

**Status:** CUE runtime implemented; input and panel mapping revised
**Date:** 2026-08-10
**Scope of this document:** Product behavior, runtime architecture, cross-window protocol, UI requirements, implementation sequence, and acceptance criteria.

## 1. Decision summary

Add a global CUE workflow with these transport controls:

- **Shift-click a pattern** or press **Shift + 1–0** to enter CUE with that pattern as the candidate.
- The Shift-entry request carries the stable sketch ID, so the screen can start CUE atomically without a transient LIVE selection change.
- **Enter while CUE is ready:** GO LIVE with the cued program.
- **Enter while CUE is still warming:** queue GO LIVE; the current LIVE program remains visible until the cue is ready, then promotion happens automatically.
- **Escape while CUE is active:** cancel the cue and leave LIVE unchanged.
- While CUE is active, **GO LIVE** and **CANCEL** appear as an overlay on the panel preview; there is no persistent top transport bar.

The output screen must keep separate LIVE and CUE renderer slots. The CUE slot is created at the real output resolution, behind the LIVE slot, and warmed before a TAKE. A TAKE promotes the already-running CUE renderer instead of destroying it and constructing it again.

This is feasible with the current p5 and DOM-compositing architecture. It removes the guaranteed blank interval caused by destroying the current p5 instance before the next canvas exists. It moves shader compilation/setup cost to the CUE preparation step. It does **not** make shader compilation free: warming a second WebGL context can still cause a short frame-time spike on some GPUs, so profiling remains required.

## 2. Why the current switch can be slow

The current output flow in `main.js` has a teardown-first lifecycle:

1. `loadSketch()` or `loadSketchById()` calls `removeCurrentP5()`.
2. The old visible p5 instance and canvas are removed.
3. A new p5 instance is constructed.
4. p5 2.x creates its canvas asynchronously during setup/first-frame work.
5. WebGL effects create a new context and compile/link shaders during setup or first use.
6. Camera effects also create a new capture and wait for media readiness.

The output therefore has no valid replacement canvas between steps 2 and 4–6. The existing control-panel preview does not solve this because it runs in another window and another WebGL context. Compiling a shader in that preview does not warm the output screen's context.

The existing merge implementation is useful groundwork: it already runs two p5 instances as stacked canvases and uses browser/GPU compositing instead of per-frame pixel readback. CUE should generalize that idea into two complete **program runtimes**: LIVE and CUE.

## 3. Goals

### Required

- LIVE output must remain unchanged while a cue is being selected, edited, or warmed.
- The panel preview must display the CUE candidate while CUE mode is active.
- Effect-specific parameters edited in CUE must not leak into LIVE or localStorage before TAKE.
- TAKE must reuse the warmed renderer; it must not rebuild the effect.
- CANCEL must destroy the staged renderer and discard all cue-only edits.
- The UI must make LIVE versus CUE unmistakable without relying on color alone.
- Single effects, library-only effects, merged effects, blend settings, and post-processing must be cueable.
- Existing number-key and merge gestures must target CUE while CUE mode is active.
- Multiple control windows must display the same screen-authoritative cue state.
- A failed or incomplete cue must never replace a valid LIVE output.

### Performance goals

- Once the screen reports CUE READY, TAKE-to-visible should complete on the next animation frame.
- LIVE must stay attached and visible for the whole warm-up period.
- At no point should a normal switch deliberately expose an empty stage.
- The screen must cap active p5 instances at:
  - two for single LIVE plus single CUE;
  - four for merged LIVE plus merged CUE.
- Only one camera stream per selected physical device should exist in the output screen.

### Non-goals for the first implementation

- Crossfades or timed transitions between LIVE and CUE. Initial TAKE is a cut.
- A global OS-level shortcut when the control browser window is unfocused.
- Persisting an unfinished cue across a full app/browser restart.
- Rewriting all effects into one shared WebGL renderer/context.
- Streaming an exact camera-effect thumbnail from the output window back to the control window. See the camera-preview limitation below.

## 4. Operator workflow

### 4.1 Normal LIVE state

- There is no persistent CUE transport bar.
- Shift-clicking any pad/library pattern or pressing **Shift + 1–0** starts CUE with that pattern selected.
- The preview title reads **LIVE PREVIEW**.
- Pattern, merge, parameter, blend, and post-processing edits retain their current live behavior.
- Direct live effect changes should eventually use the same prepare-then-promote runtime path so they no longer tear down the old output first.

### 4.2 Enter CUE

The operator Shift-clicks a pattern or presses Shift + a number key.

- The control sends the selected stable sketch ID together with the CUE-entry request.
- The screen creates a cue session from an exact snapshot of the current live program and visual parameter bank, with that requested selection as the initial candidate.
- Every control panel enters CUE mode after the screen accepts the session.
- The preview frame and selection markers change to a strong CUE treatment; the preview overlay exposes GO LIVE and CANCEL.
- The panel preview changes from LIVE PREVIEW to **CUE PREVIEW**.
- The current LIVE renderer continues unchanged.
- If the candidate is still identical to LIVE, it may be treated as **READY — SAME AS LIVE** without constructing a duplicate renderer. The first cue edit creates the staged runtime.

### 4.3 Edit the cue

While CUE is active:

- Clicking a pad or library effect updates only the cue candidate.
- Number keys 1–0 update only the cue candidate.
- The existing overlapping-two-number-key gesture creates a cued merge; it must not change the live merge.
- `+`, `-`, and `Tab` adjust the cue blend values when the cue candidate is a merge.
- Effect parameter sliders edit the cue-only parameter bank.
- Post-processing edits apply only to the CUE preview and CUE screen layer.
- LIVE selection and LIVE visual values remain visibly marked in the pad/library so the operator can always see both states.
- Selection changes rebuild the hidden CUE runtime. Parameter-only changes mutate its existing cue parameter objects and request a fresh staged frame; they must not rebuild the renderer.

### 4.4 GO LIVE

When the screen has a valid staged frame:

- The preview overlay shows an enabled **GO LIVE — ENTER** button.
- Pressing Enter or clicking GO LIVE requests a cut.
- The screen resumes the staged runtime if it was parked, waits for one fresh completed frame, then swaps the LIVE/CUE layer roles in one animation frame.
- The promoted runtime remains intact and becomes the new LIVE runtime.
- Only after promotion is confirmed are cue values made canonical and persisted.
- The old LIVE runtime is hidden immediately and disposed after the swap, not before it.
- All panels return to normal LIVE state and their preview continues to show the now-live candidate.

### 4.5 TAKE requested while warming

An Enter press must still have deterministic behavior if the cue is compiling/loading:

- Change the state to **TAKE PENDING — WARMING**.
- Keep LIVE visible.
- Lock further cue editing so the operator cannot accidentally change the candidate after committing to the TAKE.
- Automatically promote the exact committed cue revision as soon as it becomes ready.
- Escape/CANCEL remains available and aborts the pending TAKE.
- If warm-up fails, clear TAKE PENDING, retain LIVE, and show CUE ERROR.

This behavior is preferable to exposing a blank output or silently ignoring a GO LIVE request.

### 4.6 CANCEL

Escape or the CANCEL button is active in every cue phase, including warming, ready, pending, and error.

On cancel:

- Keep LIVE exactly as it was before and during CUE.
- Destroy the staged runtime and release its WebGL/media resources.
- Discard the cue parameter bank without writing it to localStorage.
- Restore the preview and parameter panel to LIVE.
- Clear cue selection markers and the high-visibility cue treatment.

Escape does nothing special when no cue is active.

## 5. Keyboard contract

Use Shift as a momentary modifier and physical digit codes for Shift-modified number keys:

- Shift-clicking a pad or library pattern starts/updates CUE with that pattern.
- Detect Shift + 1–0 from `KeyboardEvent.shiftKey` and `KeyboardEvent.code` (`Digit1` through `Digit0`), because `KeyboardEvent.key` becomes punctuation on many keyboard layouts.
- A Shift + digit starts CUE with one selected effect. Holding Shift and pressing a second digit while the first is still down stages a two-pattern CUE blend (the Shift gesture mirrors the unmodified two-number-key merge gesture used for LIVE; the blend latches after release).
- Handle a non-repeating `KeyboardEvent.code === "Enter"` while CUE is active before text-entry guards. It requests GO LIVE, including queued TAKE while warming.
- Handle active-CUE Escape before text-entry guards. Escape cancels CUE; when LIVE, preserve normal browser/control behavior.
- Ignore repeated entry/take keydown events.
- CUE state survives window blur; blur must not cancel it. Blur only clears held-key bookkeeping for normal merge gestures.
- Shortcuts work only while a control window has browser focus. Web pages cannot provide reliable global shortcuts while unfocused.
- Keep all CUE transport shortcuts disabled in output-screen windows.
- Caps Lock has no CUE behavior.

## 6. High-visibility UI design

### 6.1 Preview-overlay transport

Do not reserve a top transport row. CUE begins from the Shift pattern gesture, and transport controls appear only while a candidate exists.

The preview overlay contains:

- A textual CUE phase: SAME AS LIVE, WARMING, READY, GOING LIVE, or ERROR.
- A primary **GO LIVE** button with an **ENTER** key hint.
- A secondary **CANCEL** button with an **ESC** key hint.

State-specific presentation:

| State | Overlay | Primary action | Cancel | Required status |
| --- | --- | --- | --- | --- |
| LIVE | Hidden | — | — | LIVE PREVIEW |
| CUE, same as live | Visible | GO LIVE | Enabled | CUE / SAME AS LIVE |
| CUE warming | Visible | GO LIVE | Enabled | CUE / WARMING |
| CUE ready | Visible | GO LIVE | Enabled | CUE / READY |
| Take pending | Visible | GOING LIVE, disabled | Enabled | GOING LIVE / WARMING |
| Cue error | Visible | RETRY CUE | Enabled | Error summary; LIVE SAFE |

Color semantics should follow familiar production language while retaining text/icon labels:

- LIVE/program: red accent.
- CUE/preview: amber accent.
- READY: green status indicator in addition to the CUE label.
- CANCEL/error: high-contrast neutral/red treatment.

Do not use animation as the only signal. Respect `prefers-reduced-motion` if a warming pulse is added.

### 6.2 Layout impact

`#config-panel` remains a three-column, single-row full-height grid. The preview renderer host and the CUE control overlay are siblings inside a positioned preview surface, so preview re-renders cannot delete the controls and the overlay consumes no layout height.

Preserve `min-width: 0` and `min-height: 0` on every grid child so the panes continue to avoid horizontal overflow and preserve independent scrolling.

### 6.3 Preview treatment

While CUE is active:

- Rename the heading to **CUE PREVIEW**.
- Add a thick amber border and an explicit CUE badge/watermark.
- Show WARMING/READY/ERROR in the preview heading and the transport overlay.
- Keep GO LIVE and CANCEL above the preview canvas as an absolutely positioned sibling, never as children cleared by the renderer.
- Continue rendering the local low-resolution preview from the cue selection and cue parameter bank.
- Treat the screen's CUE READY acknowledgement as authoritative. A local preview frame does not prove that the output renderer is warmed.

When CUE ends, restore **LIVE PREVIEW** and the normal blue/live frame treatment.

### 6.4 Pattern and library markers

CUE mode needs two independent visual markers:

- **LIVE marker:** identifies the effect or merge pair currently on output.
- **CUE marker:** identifies the candidate effect or merge pair.

If both refer to the same effect, render a combined LIVE + CUE marker rather than hiding one. Do not replace the LIVE marker when the operator edits the cue.

The Parameters heading should also say **CUE Parameters — [effect]** while edits are isolated.

### 6.5 Accessibility

- Use native buttons, visible focus states, and text labels in addition to color.
- Announce CUE READY, TAKE PENDING, CUE CANCELED, CUE TAKEN LIVE, and CUE ERROR through a polite `aria-live` status region.
- Expose button state with `disabled` and/or `aria-disabled` as appropriate.
- Keyboard activation of focused buttons must continue to work independently of Enter/Escape transport handling.

## 7. What belongs to a cue

### Cue-scoped and atomic

- Single effect selection, by stable sketch ID.
- Merge pair selection, by two stable sketch IDs.
- All selected effect parameters.
- Merge mode and blend/additive levels stored under `BLEND_ID`.
- Global visual post-processing values stored under `POSTFX_ID`.

Post-processing becomes cueable by applying separate filter values to the LIVE and CUE program-layer containers. On TAKE, the cue filter becomes the live filter without being recomputed on a new renderer.

### System/global, not cue-scoped

- Audio input selection.
- Camera input selection.
- Band-split EQ under `BANDS_ID`.
- Noise-floor capture/profile.
- Pattern-pad assignment/reordering.

These are system configuration rather than a visual program preset. The UI should label them as global. Camera-device changes should be disabled while CUE is active because they can invalidate both live and staged camera resources. Other device/calibration actions may remain global, but they must not silently masquerade as cue-only edits.

## 8. State model

The screen window is the transaction coordinator and source of truth for active cue state. Conceptually maintain:

### Live program

- Stable selection: one sketch ID or a merge pair of IDs.
- Source pad indices only as derived UI metadata; never as the canonical identity.
- Live visual parameter bank.
- Live program runtime.

### Cue session

- Unique session ID.
- Monotonic revision number.
- Initiating control-window ID for diagnostics.
- Candidate selection by stable IDs.
- Isolated cue visual parameter bank.
- Phase: warming, ready, take-pending, or error.
- Candidate runtime generation/token.
- Optional error and readiness timing data.

### State transitions

- LIVE + Shift pattern selection → CUE WARMING or CUE READY/SAME AS LIVE.
- CUE + selection/visual edit → increment revision; stage that revision.
- CUE WARMING + TAKE → TAKE PENDING for the current revision.
- CUE READY + TAKE → promote → LIVE.
- TAKE PENDING + ready for the committed revision → promote → LIVE.
- Any CUE state + CANCEL → dispose/discard → original LIVE.
- Any CUE state + screen loss → cancel safely and notify controls.
- Warm-up failure → CUE ERROR; LIVE remains untouched.

Session IDs, revisions, and runtime generation tokens are required to prevent a stale asynchronous canvas/readiness callback from promoting an effect after the operator has selected another one or canceled the cue.

## 9. Screen runtime architecture

### 9.1 Introduce a program-runtime abstraction

Replace the single `currentP5` plus global `mergeP5` ownership model with a runtime object that owns:

- one container element representing a complete program layer;
- one or two p5 instances;
- selection IDs;
- the parameter-bank resolver used by those instances;
- merge compositing state;
- post-processing filter state;
- generation/readiness state;
- cleanup callbacks/resources;
- methods equivalent to prepare, request a fresh frame, pause/standby, resume, and dispose.

Maintain exactly two top-level slots:

- `liveRuntime`
- `cueRuntime`

The candidate runtime object itself is promoted. Do not call its sketch factory again on TAKE.

### 9.2 DOM layering

Refactor the current single `#screen-wrap` into a stable stage root containing two isolated program-layer containers:

- LIVE layer on top and visible.
- CUE layer behind it and not visible to the audience.

Each program layer owns its one or two canvases. Merge opacity/mix-blend styles must be scoped inside that layer, and each layer needs compositing isolation so CUE merge blending cannot interact with LIVE canvases.

The CUE layer must:

- exist at the real output dimensions;
- remain in the document and be renderable;
- avoid `display: none` and zero-sized layout;
- stay non-interactive;
- remain below/transparent behind LIVE until promotion.

At TAKE, swap layer-role classes/visibility in one animation frame. Resume/freshen the cue frame before that swap. Hide the old LIVE layer immediately, then dispose it after the promoted frame is visible. Keep the screen toolbar above both layers.

### 9.3 Readiness contract

Canvas existence alone is insufficient. The screen may report READY only after:

1. The full-size canvas exists and is attached to the CUE program layer.
2. Setup has completed without an uncaught error.
3. At least one complete draw has finished.
4. WebGL shaders have been used at least once, not merely constructed.
5. Any required media/asset readiness condition is satisfied.
6. The browser has had a compositor frame after the valid draw.

Provide a default first-completed-draw readiness wrapper for ordinary effects and an optional explicit readiness hook for effects with asynchronous assets/media. Camera effects must not report ready until a current video frame exists.

Add a bounded warm-up timeout. Timeout/error leaves LIVE untouched, moves CUE to ERROR, and exposes a retry/cancel path.

### 9.4 Warm standby policy

Running LIVE plus CUE continuously at full frame rate can double GPU load, or reach four full-screen renderers when both programs are merges.

Recommended default:

- Render the cue until the readiness contract is satisfied.
- Park the hidden p5 loop after readiness when the effect permits it.
- On a cue parameter edit, request one fresh frame and return to standby.
- On TAKE, resume and wait for one current completed frame before the visibility swap.
- Allow effects that require continuous warm-up to opt out and run at a capped standby rate.

Do not make this policy an assumption without profiling. Some effects may allocate resources over several frames. Instrument and test both LIVE frame time and take latency.

### 9.5 Candidate replacement and context cap

When the cue selection changes:

- Invalidate the old cue generation immediately.
- Dispose the previous cue runtime before constructing the replacement, keeping the maximum at LIVE + one CUE program.
- Coalesce rapid selection changes so keyboard/library browsing does not compile several abandoned shaders.
- Ignore late canvas/readiness callbacks from invalid generations.

Parameter-only changes must never rebuild the cue runtime.

### 9.6 Safe direct LIVE switching

After the runtime abstraction works, route ordinary non-CUE effect changes through a short-lived prepare-then-promote path:

- Keep the old LIVE runtime visible.
- Prepare the requested runtime behind it.
- Promote only when ready.
- Dispose the old runtime afterward.

This addresses the original slow/blank switch even when the operator chooses not to use manual CUE mode. Manual CUE adds editing, preview, and explicit TAKE control on top of the same primitive.

## 10. Isolated parameter banks

The current parameter objects are mutable references shared by running sketches, panel preview, BroadcastChannel handlers, and localStorage persistence. CUE requires a separate bank.

On CUE entry:

- Clone from the raw live values, not DEV proxy wrappers.
- Include defaults for the selected effects plus `BLEND_ID` and `POSTFX_ID`.
- Point the control CUE preview and output CUE runtime at the cue objects.
- Route cue slider deltas only to those objects.
- Do not call the existing live save path for cue deltas.

On TAKE:

- Promote/adopt the cue objects as the new canonical live objects so the warmed runtime keeps the exact references it already reads.
- Broadcast the committed values to all controls.
- Persist after successful promotion.

On CANCEL:

- Drop the cue bank.
- Leave live objects and saved storage byte-for-byte unchanged.

Avoid copying committed values only into the old live objects after TAKE; the promoted p5 instances would still be reading their cue object references unless the canonical map itself adopts those objects.

## 11. Camera effects

Six registered camera effects currently call `createCapture()` inside their own p5 instance. LIVE plus CUE would otherwise open duplicate captures, and repeated cue selection could repeatedly request/release the same device.

Introduce a screen-owned shared camera source:

- One `MediaStream`/video source per active device in the output screen.
- Reference-counted consumers for LIVE and CUE runtimes.
- Camera sketches consume the shared source through render context injection instead of independently owning capture lifecycle.
- Device changes invalidate the shared source in one controlled place.
- Tracks stop when there are no consumers, with cleanup verified on TAKE, CANCEL, selection change, and screen close.
- Readiness is tied to an actual current video frame.

The control window should continue to avoid opening another camera capture.

### Camera preview limitation

The existing panel preview intentionally shows a placeholder for camera effects because a second capture could compete with the output. The first CUE implementation should remain honest:

- Stage and warm the real camera cue in the output screen.
- Show **CAMERA CUE STAGED ON OUTPUT** plus screen-reported WARMING/READY in the panel preview.
- Never show the LIVE camera image and label it as the cue.

An exact remote camera-cue thumbnail would require a separate, carefully profiled frame transport from screen to control. Do not add synchronous canvas readback to the render loop by default; it could reintroduce the performance problem CUE is intended to solve.

## 12. Cross-window protocol

Do not reuse unscoped `pattern`, `pattern-id`, `merge`, or `params` messages for cue edits; their existing handlers mutate LIVE immediately.

Add explicit cue transport messages, with names along these lines:

- enter request;
- cue selection update;
- cue parameter delta;
- take request;
- cancel request;
- screen-authored cue state/readiness/error;
- cue ended/taken acknowledgement.

Every cue edit message must carry session ID and base revision. The screen accepts it, increments/announces the canonical revision, and stages that revision. Ready/error messages must identify both session and revision.

Rules:

- The screen coordinates one global cue session.
- All control windows show the same accepted LIVE/CUE state.
- Any focused control may operate the cue, matching the app's current shared-control behavior.
- Last screen-accepted edit wins; stale revisions are ignored and resynchronized.
- A late-open control receives current LIVE and full CUE state in the state handshake.
- If no output screen is online, CUE is disabled with an explicit OUTPUT OFFLINE message.
- If the screen closes during CUE, controls cancel the session rather than retaining a potentially unsafe stale TAKE.
- A TAKE acknowledgement is emitted only after the screen has actually promoted the warmed runtime.

## 13. Existing code touchpoints

### `main.js`

- Replace teardown-first `loadSketch()` and `loadSketchById()` internals with prepare/promote/dispose runtime operations.
- Generalize `loadMerged()`, `tagMergeCanvas()`, `adoptCanvas()`, and `applyBlendStyles()` so they operate on a supplied program runtime rather than global arrays.
- Split LIVE and CUE parameter resolvers.
- Add cue session state and BroadcastChannel handlers.
- Extend the `state` handshake for late-open controls.
- Route the existing number/merge keyboard actions by current transport scope.
- Handle Enter and active-CUE Escape before number-key processing; route Shift + digit through physical digit codes into atomic CUE entry.
- Extend the DEV `window.__viz` hook with cue state, revisions, readiness, and live/cue runtime diagnostics.

Prefer moving renderer lifecycle into a dedicated module instead of making the existing large `main.js` switch more stateful.

### `config-panel.js`

- Add Shift-click callbacks for atomic CUE selection and preview-overlay GO LIVE/CANCEL callbacks.
- Maintain separate LIVE and CUE selection markers.
- Make `refreshSelection()` render against the active editing scope without overwriting LIVE identity.
- Resolve Parameters and preview selection against the cue bank while CUE is active.
- Display screen-authored readiness/error states.
- Disable camera-device changes while cueing.

### `style.css`

- Keep the single-row three-pane grid and add a positioned preview overlay that consumes no layout height.
- Add cue-active, live-marker, cue-marker, ready, pending, error, and disabled styles.
- Add preview CUE framing and accessible reduced-motion behavior.
- Add screen program-layer isolation and role styles.

### Camera sketches / shared camera module

- Replace per-sketch capture ownership with the screen-shared camera source.
- Add media readiness and deterministic cleanup.

### Tests

- Add `tests/cue-mode.spec.js` for state, keyboard, UI, isolation, TAKE, CANCEL, merges, multiple controls, stale revisions, and camera behavior.
- Add performance/lifecycle coverage for prepare-before-dispose and renderer/context caps.
- Keep all existing merge, preview, parameter, post-processing, and new-effect smoke tests passing.

## 14. Recommended implementation sequence

1. **Instrument the existing switch path.** Record request, old teardown, p5 construction, canvas attach, first completed draw, and first visible frame for representative 2D, WebGL, merge, and camera effects.
2. **Create the program-runtime abstraction.** Preserve current behavior first, including merge and post-processing.
3. **Implement prepare-then-promote for ordinary LIVE switches.** Verify the old output stays visible until replacement readiness.
4. **Add separate LIVE/CUE screen layers and runtime slots.** Enforce generation tokens and instance/context caps.
5. **Add isolated cue program/parameter state.** Verify cancel causes no live or storage mutation.
6. **Add the screen-authoritative BroadcastChannel transaction protocol.** Include multiple-control and stale-message behavior.
7. **Add Shift-driven CUE entry, preview-overlay GO LIVE/CANCEL controls, dual markers, preview mode, Enter, and Escape interactions.**
8. **Add shared camera ownership/readiness.** Test camera-to-camera, camera-to-shader, and shader-to-camera cues.
9. **Add warm-standby policy and profile it.** Tune only from measured frame times.
10. **Complete end-to-end, lifecycle, accessibility, and regression testing.**

Do not start with only the UI toggle. Without isolated params and a prepared screen runtime, a CUE-looking UI could still mutate LIVE or rebuild on TAKE.

## 15. Acceptance criteria

### Core behavior

- Starting with effect A LIVE, entering CUE and selecting effect B leaves A on output.
- The panel clearly shows LIVE A and CUE B at the same time.
- CUE parameter changes alter the CUE preview/staged frame but not LIVE A.
- CUE changes do not update persisted visual values before TAKE.
- Escape at any cue phase returns the panel preview to A, destroys B's staged runtime, and leaves saved/live values unchanged.
- When B is READY, Enter or the GO LIVE overlay promotes the same B runtime on the next animation frame.
- The old A runtime is disposed only after B is visible.
- Pressing Enter while warming queues a safe TAKE and never shows an empty stage.
- A failed B remains in CUE ERROR and A stays LIVE.

### Selection and merge behavior

- Single pad, library-only ID, LIVE merge, CUE merge, merge-to-single, and merge-to-merge paths work.
- Number-key overlap, `+`, `-`, and `Tab` target the cue while cueing and live while not cueing.
- Reordering pads during CUE does not retarget a cue because canonical selection uses IDs.
- Both LIVE and CUE markers remain accurate after reorder and cross-window updates.

### Keyboard and UI

- Shift-clicking a pad/library pattern and Shift + 1–0 enter CUE with the requested stable-id candidate.
- Non-repeat Enter takes/queues GO LIVE only while CUE is active; Escape cancels only while CUE is active.
- Blur does not cancel the cue or cause stale held-key behavior.
- The preview overlay remains visible and usable throughout CUE without adding a layout row.
- Status is understandable without color and announced accessibly.
- Screen-offline and warm-up-error states cannot trigger an unsafe TAKE.

### Performance and resources

- LIVE remains attached throughout candidate creation.
- Ready TAKE-to-visible is at most one animation frame after the fresh-frame gate.
- Single/single never exceeds two screen p5 instances; merge/merge never exceeds four.
- Rapid cue browsing does not retain abandoned p5 instances, canvases, animation loops, media consumers, or stale readiness callbacks.
- Camera cues use one screen-owned stream per device and do not open a control-window capture.
- Repeated TAKE/CANCEL cycles do not cause steadily increasing memory, WebGL-context warnings, or duplicate camera tracks.

## 16. Test and observability plan

Add performance marks or structured debug timestamps for:

- cue request received;
- runtime construction started;
- canvas attached;
- first draw completed;
- media ready;
- cue ready broadcast;
- take requested;
- fresh frame completed;
- role/visibility swap;
- old runtime disposed.

Expose DEV-only diagnostics through `window.__viz`, including:

- transport mode and cue phase;
- live and cue stable IDs;
- session ID and revision;
- live/cue p5 counts;
- cue generation and ready/error status;
- whether TAKE is pending;
- last timing measurements.

Playwright should assert state and lifecycle deterministically through these hooks rather than relying only on arbitrary sleeps. Add manual profiling with representative expensive effects such as ray-marched WebGL shaders, merge pairs, and camera effects at the actual show resolution.

## 17. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Hidden WebGL compilation still hitches LIVE | Instrument; construct after a live frame; coalesce browsing; park after warm-up; consider deeper renderer reuse only if measured need justifies it. |
| Too many WebGL contexts during merge-to-merge cues | Hard cap at one LIVE and one CUE runtime; dispose replaced cue generations before constructing another. |
| Cue slider mutates LIVE through shared object references | Separate cue parameter bank and scoped messages; persist only after promotion. |
| Stale async p5 canvas appears after cancel/change | Session, revision, and runtime generation checks on every attach/readiness callback. |
| TAKE occurs before a useful frame | Screen-authoritative readiness contract and TAKE PENDING; never tear down LIVE first. |
| Camera capture duplicates or gets stolen | Screen-owned shared camera source with reference counting and explicit readiness. |
| Shift-modified digits become punctuation on many keyboard layouts | Parse `KeyboardEvent.code` (`Digit1`–`Digit0`) rather than `key`; keep Shift input outside the normal merge gesture. |
| Multiple control windows conflict | One screen-coordinated cue transaction with revisions; all panels mirror accepted state. |
| Preview re-render removes overlay controls | Keep the renderer host and transport overlay as positioned siblings; preserve `min-width: 0` / `min-height: 0` on the three-pane grid. |

## 18. Definition of done

CUE mode is complete only when the visual distinction, input routing, isolated parameters, screen-side warm renderer, safe TAKE/CANCEL transaction, camera lifecycle, cross-window synchronization, and regression/performance tests all ship together. A UI-only CUE flag or a preview-only implementation is not sufficient.
