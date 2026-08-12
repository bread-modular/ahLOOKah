# Pattern-Specific Control-Side Audio Plan

## Status

Implemented for the three pilot patterns: **Checkerboard**, **Circles**, and
**Waveform Tunnel**. The raw `analysis-frame` path remains available for every
non-migrated pattern.

The implementation is split across `pattern-audio-protocol.js`,
`pattern-audio-controls.js`, and `pattern-audio-engine.js`, with runtime/preview
slot publication in `main.js` and `ProgramRuntime`.

## Decision

Add a second, pattern-specific audio path in which the audio-capture owner runs each active pattern's audio controller and sends only render-ready controls to the consumer that owns that pattern instance.

The existing raw `analysis-frame` path stays in the codebase and continues serving every pattern that has not been migrated. There is no user-facing mode switch:

- Migrated patterns always use pattern-specific controls.
- Non-migrated patterns continue using the existing audio facade and raw analysis frames.
- A mixed LIVE/CUE/MIX program may use both paths at the same time.
- A migrated renderer never falls back to running FFT, waveform, band, onset, or audio-envelope logic locally.
- If all active consumers use migrated patterns, remote raw-frame broadcasting can be skipped automatically. The existing raw path remains available and resumes automatically as soon as a legacy pattern needs it.

## Pilot Patterns

These are the exact names shown in the pattern UI:

| UI name | Pattern ID | Complexity represented |
| --- | --- | --- |
| **Checkerboard** | `checkerboard` | Simple shader driven by compact scalar uniforms |
| **Circles** | `circles` | Stereo frequency analysis, continuous controls, particles, and one-shot visual events |
| **Waveform Tunnel** | `waveform-tunnel` | WEBGL rendering plus a bounded waveform-derived typed array |

`Circles CH1` is not part of this pilot.

## Goals

1. Move all audio interpretation for the three pilot patterns to the audio-capture owner.
2. Pass each controller the exact accepted parameters for its LIVE, CUE, or MIX runtime instance.
3. Send compact, versioned, render-ready values instead of a complete spectrum and waveform.
4. Keep simultaneous instances independent, including the same pattern in LIVE and CUE with different parameters.
5. Keep visual simulation and drawing on the rendering consumer.
6. Preserve all existing patterns and the current raw-frame implementation.
7. Add enough diagnostics to measure controller cost, packet size, packet age, and raw frames avoided in real use.

## Non-Goals

- Migrating every pattern in the first implementation.
- Deleting or rewriting `PreviewAudio` and the current `analysis-frame` protocol.
- Moving p5, canvases, particles, WEBGL, or camera work to the control side.
- Adding an operator-visible transport selector.
- Making pattern-specific controls a generic public plug-in API in the first pass.

## Architecture

```text
Output ProgramRuntime / embedded control preview
        |
        | pattern-audio-plan
        v
Audio-capture owner
        |
        | cleaned analysis frame
        v
Shared lazy audio-analysis view (once per capture tick)
        |
        +--> Checkerboard controller
        +--> Circles controller
        +--> Waveform Tunnel controller
        |
        | pattern-audio-controls
        v
Per-consumer control store
        |
        v
Thin p5 renderer: interpolate/consume controls and draw
```

### Authority

- The output screen remains authoritative for its actual LIVE, CUE, transition, and two-pattern merge runtimes.
- The embedded control-panel preview is authoritative only for its own preview instances.
- Each rendering consumer publishes the runtime instances it actually owns. The capture owner does not infer active patterns from panel selection fields.
- Accepted parameter objects and their revisions are included in the plan, so the controller uses the same values as the corresponding renderer.

### Shared work

The capture owner obtains one noise-cleaned analysis frame from `AudioManager` per audio tick. A shared helper then exposes expensive representations lazily:

- Float spectrum and waveform from `getAnalysisFrame()`.
- Legacy-equivalent byte spectrum only when a migrated controller requests it.
- Legacy-equivalent byte waveform only when a migrated controller requests it.
- Canonical RMS, bands, and transient features only when requested.

The conversion or shared feature extraction runs at most once per capture tick, regardless of the number of LIVE, CUE, preview, or merge controllers.

## Registry and Pattern Contract

Add explicit opt-in metadata to the three registry entries. An absent value means the existing raw-frame path.

```js
{
  id: 'checkerboard',
  name: 'Checkerboard',
  factory: checkerboard,
  audioTransport: 'pattern-controls',
  createAudioController: createCheckerboardAudioController,
  // existing params and group remain unchanged
}
```

Each migrated pattern exports a DOM-free controller alongside its existing renderer:

```js
export function createAudioController(options = {}) {
  return {
    update({
      frame,
      shared,
      params,
      deltaSeconds,
      captureTime,
      sequence,
    }) {
      return {
        continuous: {},
        arrays: {},
        events: [],
      };
    },
    dispose() {},
  };
}
```

Contract rules:

- Controllers cannot import p5 or access the DOM.
- Controllers may retain envelopes, phase, counters, and transient history.
- All returned values must be serializable and finite.
- Arrays must be bounded typed arrays.
- Events must be bounded and have stable IDs or counters so a render loop consumes each event once.
- Controller calculations must use `deltaSeconds`; they must not depend on render FPS.
- Random event generation must support an injected RNG for deterministic tests.
- A parameter update keeps the same controller instance unless the runtime itself is replaced.

The renderer receives a binding through the existing fourth `runtimeContext` argument:

```js
runtimeContext.audioControls
```

The binding exposes the latest continuous values, interpolated values, queued one-shot events, packet sequence, packet age, and freshness. Migrated renderers ignore the legacy `audio` argument.

## Runtime Identity

Pattern ID is not sufficient because one pattern can run more than once. Every p5 child receives a stable runtime slot ID:

```text
consumerSessionId : runtimeGeneration : childIndex
```

Requirements:

- Each side of a two-pattern merge has a different slot ID.
- LIVE and CUE instances have different slot IDs even when their pattern IDs match.
- A prepared CUE runtime keeps its slot IDs when that same `ProgramRuntime` is promoted to LIVE.
- Rebuilding or disposing a runtime retires its slot IDs.
- Embedded preview instances use their own preview generation and child index.

`ProgramRuntime` should expose its slot descriptors and place the matching control binding in each child's `runtimeContext`.

## Protocol

Use the existing `BroadcastChannel`, with strict validation before state is changed.

### Consumer to capture owner: `pattern-audio-plan`

```js
{
  type: 'pattern-audio-plan',
  version: 1,
  consumerSessionId: '...',
  planRevision: 14,
  sentAt: 12345.6,
  slots: [
    {
      runtimeId: '...',
      patternId: 'circles',
      role: 'cue',
      childIndex: 0,
      paramsRevision: 8,
      params: { bass: 1, mid: 1, high: 1, glitch: 1 },
      audioTransport: 'pattern-controls'
    }
  ]
}
```

Plan rules:

- Include every active rendering slot, including non-migrated slots. This allows the capture owner to determine whether raw frames are still required.
- Coalesce rapid parameter edits to at most one plan publication per animation frame.
- Increment `planRevision` when topology changes.
- Increment each `paramsRevision` when accepted parameters for that slot change.
- Publish immediately on runtime creation, replacement, promotion, disposal, CUE changes, and merge changes.
- Send a low-frequency heartbeat while the consumer exists so abandoned plans can expire.
- Limit the number of slots, parameter keys, key lengths, and numeric ranges during validation.

### Capture owner to consumer: `pattern-audio-controls`

```js
{
  type: 'pattern-audio-controls',
  version: 1,
  consumerSessionId: '...',
  planRevision: 14,
  audioOwnerId: '...',
  streamGeneration: '...',
  sequence: 9321,
  captureTime: 12346.1,
  slots: [
    {
      runtimeId: '...',
      paramsRevision: 8,
      continuous: { pump: 1.42 },
      arrays: {},
      events: []
    }
  ]
}
```

Receiver rules:

- Accept only the current `consumerSessionId`, `planRevision`, runtime ID, and slot `paramsRevision`.
- Reject duplicate or decreasing sequences within an audio-owner stream generation.
- Clear queued events and interpolation history when owner or stream generation changes.
- Reject unknown keys, non-finite numbers, oversized arrays, and oversized event lists.
- Store two accepted continuous samples for generic interpolation.
- Queue events by packet sequence and consume each event exactly once.
- On stale controls, decay continuous values to a pattern-defined neutral state and discard stale events. Do not invoke the legacy audio facade for a migrated pattern.

Suggested initial limits:

- 8 active slots per consumer.
- 64 continuous scalar values per slot.
- 512 typed-array elements per slot.
- 16 one-shot events per slot per packet.

## Scheduling and Lifecycle

1. The current capture loop obtains and noise-cleans one analysis frame.
2. The control engine creates the shared lazy-analysis view for that frame.
3. It reconciles all fresh consumer plans against controller instances.
4. It updates each migrated controller once with the exact slot parameters.
5. It broadcasts one compact control packet per consumer plan.
6. It sends the existing raw `analysis-frame` message only when at least one fresh consumer plan contains an active non-migrated slot.
7. It disposes controllers whose runtime slots disappear or whose plans expire.

Before any valid plan is known, preserve current behavior and send raw frames. This prevents startup ordering from breaking legacy patterns.

Controller state is keyed by `consumerSessionId + runtimeId`, not by pattern ID. A parameter revision updates the existing controller; a changed pattern under the same malformed runtime identity forces disposal and recreation.

The control engine must also dispatch locally because `BroadcastChannel` does not deliver a sender's own messages. This keeps the embedded preview working when its window owns audio capture.

## Screen-Side Control Store

Add a small transport-level store, separate from pattern code. Its responsibilities are:

- Validate packet identity and ordering.
- Retain previous/current continuous samples and receive timestamps.
- Interpolate continuous scalars and equal-length typed arrays between packets.
- Replace arrays directly when their length changes.
- Queue and deduplicate one-shot events.
- Expose `isReady`, `isFresh`, packet age, sequence, and revisions.
- Return pattern-defined neutral controls before the first valid packet or after staleness.

Interpolation is generic transport behavior, not pattern audio analysis. Patterns consume already-mapped render controls.

## Pilot Conversion Details

### Checkerboard

Controller responsibilities:

- Run the existing feature extractor on the control side.
- Read `cell`, `hueA`, `hueB`, `speed`, and `pulse` from the slot parameters.
- Maintain phase using elapsed time rather than render-frame count.
- Produce final shader uniforms: `uHueA`, `uHueB`, `uCell`, and `uPhase`.
- Preserve the current visual speed by calibrating time-based phase movement to the existing nominal 60 FPS behavior.

Renderer responsibilities:

- Compile and draw the existing shader.
- Read/interpolate the final uniforms from `runtimeContext.audioControls`.
- Perform no `makeAudioFeatures()` call and no audio-dependent uniform mapping.

Extend `makeAudioShader()` with an explicit external-controls path, or add a smaller shared shader renderer if that keeps the legacy utility untouched. Existing shader patterns must continue through the current internal-analysis path.

### Circles

Controller responsibilities:

- Request the shared legacy-equivalent stereo byte spectrum.
- Reproduce the current left/right band calculations.
- Apply `bass`, `mid`, `high`, and `glitch` parameters.
- Produce continuous render controls such as:
  - `pump`
  - `midBrightness`
  - `strokeWeight`
  - `movementMultiplier`
  - `glitchAmount`
  - `noiseIntensity`
  - `scanlineAlpha`
- Produce bounded one-shot events such as:
  - Hat spawn count
  - Invert flash
  - Background spark
  - Screen-slice trigger
- Convert frame-dependent random probabilities and spawn behavior to time-based rates so behavior remains stable at different controller cadences.

Renderer responsibilities:

- Retain circle and hat particle state.
- Choose visual-only random positions, offsets, sizes, and slice geometry when consuming controller events.
- Apply continuous controls to movement, size, brightness, jitter, and scanlines.
- Never call `getFrequencies()` or calculate audio bands.

### Waveform Tunnel

Controller responsibilities:

- Request the shared byte waveform and byte spectrum.
- Reproduce its sub, mid, high, and energy calculations.
- Apply `rings`, `twist`, `scale`, and `sub` parameters.
- Maintain time-based hue and twist state.
- Downsample the left waveform to exactly the accepted ring count.
- Produce:
  - Final `ringRadii` as a bounded `Float32Array`
  - `hueOffset`
  - `twist`
  - `shimmerAmount` or a bounded shimmer event
- Replace the array cleanly when `rings` changes.

Renderer responsibilities:

- Draw tunnel geometry from the provided ring radii.
- Apply supplied hue, twist, and shimmer controls.
- Keep visual-only arc placement and geometry randomness local.
- Never call `getWaveforms()`, `getFrequencies()`, or calculate audio bands.

## CUE and MIX Correctness

- Publish control plans from actual `ProgramRuntime` objects, including both children of a merge.
- Warm CUE controllers while the CUE runtime is hidden so their envelopes and phase are ready before TAKE.
- A fresh-frame request for a migrated runtime is satisfied only after every migrated child has consumed a controls packet matching its current `paramsRevision`, followed by the existing compositor confirmation.
- A legacy child continues using the existing draw/compositor readiness rules.
- A mixed merge is valid: the migrated child consumes compact controls while the legacy child consumes the existing raw frame.
- Promoting CUE to LIVE must not recreate its controllers or reset their state when the same prepared runtime is reused.

## Embedded Preview

The embedded preview must also use the new system for these three patterns.

- `createPreviewInstance()` creates preview runtime IDs and passes an audio-control binding as the fourth factory argument.
- Preview selection, merge composition, editing scope, and parameter changes publish a preview consumer plan.
- The capture owner runs preview controllers alongside output controllers, sharing the same per-frame analysis cache.
- Preview teardown retires its plan slots and controller instances.
- Non-migrated preview patterns continue using `previewAudio` exactly as they do now.

## Raw-Frame Demand

Do not delete or repurpose `analysis-frame`. Add automatic demand calculation:

- Raw required when any fresh output or preview slot is non-migrated.
- Raw not required when all fresh active slots are migrated.
- Raw required by default during startup, when no valid plans exist, or when plan state is uncertain.
- Mixed migrated/legacy programs send both raw frames and compact controls.
- Migrated renderers ignore raw frames even when another slot requires them.

This has no UI setting. It preserves existing patterns while allowing the pilot to demonstrate transport savings whenever only pilot patterns are active.

## Failure Handling

- Missing first packet: draw with neutral controls and wait; do not run local audio analysis.
- Brief packet gap: hold/interpolate, then decay smoothly to neutral after the freshness window.
- Capture-owner loss: clear events immediately and decay continuous values.
- New capture owner or device stream: change `streamGeneration`, reset packet ordering, and recreate controller audio history.
- Stale consumer plan: expire its controllers and stop emitting packets for it.
- Malformed controller output: drop that slot's output, report diagnostics, and keep the render loop alive.
- Controller exception: isolate it to the affected runtime slot and send neutral controls for that slot.

## Diagnostics

Expose development diagnostics under a stable `window.__viz` namespace without adding an operator-facing mode selector:

- Fresh consumer plans and revisions.
- Active controller count and pattern IDs.
- Per-runtime packet sequence, age, source owner, and parameter revision.
- Controller update duration per pattern and total per tick.
- Control packet bytes per second.
- Existing raw-frame bytes per second.
- Raw frames sent and automatically skipped.
- Dropped stale, duplicate, malformed, or wrong-revision packets.
- Event queue depth and dropped-event count.
- Per-runtime count of legacy audio-facade calls; this must remain zero for pilot renderers.

## Implementation Phases

### 1. Protocol and validation

Create focused modules for message constants, validation, size limits, plan leasing, and stream/sequence comparison. Add unit tests before connecting them to `main.js`.

### 2. Runtime slot identity and plan publication

Add stable child slot IDs to `ProgramRuntime`, expose slot descriptors, publish plans from LIVE/CUE runtime topology, and add equivalent preview slot publication. Verify duplicate pattern IDs remain independent.

### 3. Control engine and shared analysis

Add the capture-owner engine, lazy per-frame conversions, controller reconciliation, local dispatch, plan expiry, stream generations, and instrumentation. Keep the existing analysis-frame sender intact.

### 4. Receiver store and runtime bindings

Add the per-consumer control store and pass child bindings through `runtimeContext` for output and preview factories. Implement ordering, interpolation, event consumption, neutral states, and staleness.

### 5. Convert Checkerboard

Implement the scalar controller and external shader-control path. Confirm it renders without any screen-side audio API calls in LIVE, CUE, preview, and either merge position.

### 6. Convert Circles

Move stereo band analysis and audio-trigger decisions into its controller. Keep visual particle simulation and geometry on the renderer. Verify one-shot events are not replayed across render frames.

### 7. Convert Waveform Tunnel

Move spectrum/waveform interpretation and temporal audio state into its controller. Send the bounded ring-radii typed array and verify dynamic ring-count changes.

### 8. Automatic raw demand

Use fresh consumer plans to skip raw-frame broadcasting only when no active legacy slot requires it. Preserve raw-by-default startup behavior and verify mixed programs still receive both protocols.

### 9. CUE readiness and hardening

Gate migrated CUE acknowledgement on matching control revisions, cover ownership/device changes, add diagnostics, and run the complete existing test suite plus new end-to-end scenarios.

## Tests

### Unit tests

- Plan and controls validation, limits, and malformed payload rejection.
- Sequence rejection within a stream and acceptance after stream-generation change.
- Controller lifecycle reconciliation and disposal.
- Shared byte conversion or feature extraction runs once per capture tick.
- Deterministic controller outputs from synthetic spectra/waveforms and injected RNG.
- Circles event rate remains stable across different update cadences.
- Waveform Tunnel emits exactly `rings` finite radii within protocol limits.
- Store interpolation, array replacement, staleness, event deduplication, and neutral decay.

### Browser tests

- Each pilot as LIVE and CUE.
- Each pilot in control-panel preview.
- Two pilots merged together.
- One pilot merged with a legacy pattern.
- The same pilot simultaneously in LIVE and CUE with different parameters.
- The same pilot on both sides of separate runtime generations.
- CUE parameter change followed immediately by TAKE.
- Rapid selection replacement and runtime disposal.
- Audio owner reload, device restart, packet reordering, and stale-plan expiry.
- Pilot renderers make zero calls to `getAnalysisFrame()`, `getFrequencies()`, `getWaveforms()`, and `getAmplitudes()`.
- A legacy pattern still follows the unchanged raw-frame path.
- Raw frames are skipped only when every active slot is migrated.

### Manual performance pass

For **Checkerboard**, **Circles**, and **Waveform Tunnel**, record:

- Control-side controller time.
- Screen render time and frame rate.
- Packet bytes per second.
- Raw frames sent/skipped.
- LIVE-only, CUE warm-up, pilot/pilot merge, and pilot/legacy merge behavior.
- Visual response while moving every exposed parameter.
- Recovery after stopping/restarting audio capture and closing/reopening the control window.

## Acceptance Criteria

- The existing raw audio implementation remains in place and all non-pilot patterns still work.
- Checkerboard, Circles, and Waveform Tunnel use only pattern-specific controls in output and preview renderers.
- Their renderers perform no audio acquisition, FFT scanning, band analysis, transient detection, or audio-envelope updates.
- LIVE, CUE, preview, and both merge positions receive the correct instance-specific parameters.
- Same-pattern simultaneous instances do not share controller state.
- CUE cannot acknowledge a frame produced from stale controls.
- One-shot events are not duplicated or lost during normal 30-to-60 FPS operation.
- Only bounded, validated controls and typed arrays cross the new protocol.
- Raw remote frames stop automatically when only migrated slots are active and resume automatically for any legacy slot.
- Diagnostics make the real transport and CPU impact measurable.
