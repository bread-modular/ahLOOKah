# Pattern-Specific Control-Side Audio Plan

## Status

**Fully deployed.** All 58 registered patterns use `audioTransport: 'pattern-controls'`
and a DOM-free capture-side controller. The raw `analysis-frame` BroadcastChannel
transport has been removed.

Across windows, audio data now consists only of bounded, versioned
`pattern-audio-controls` packets and the existing compact `spectrum` feed for the
control-panel EQ. Renderers never receive a complete FFT/waveform frame.

## Architecture

```text
ProgramRuntime / embedded control preview
        |
        | pattern-audio-plan (slot identity + accepted parameters)
        v
Capture-owning control window
        |
        | one noise-cleaned analysis frame per controller tick
        v
Shared lazy analysis view -> per-runtime pattern controllers
        |
        | pattern-audio-controls (bounded render-ready values)
        v
Per-consumer control store -> renderer bindings
```

- Every LIVE, CUE, incoming, retiring, merge, and preview child publishes one
  `pattern-controls` slot with a stable runtime ID and parameter revision.
- The capture owner creates one controller per `consumerSessionId + runtimeId`.
  Controllers retain only pattern-specific temporal state and use the exact
  accepted parameters supplied by the renderer.
- Each renderer receives `runtimeContext.audioControls`; it interpolates
  continuous values, consumes one-shot events once, and renders locally.
- `PreviewAudio` remains only as a compatibility/status facade. A screen marks
  it active after accepted controls so `window.__viz.audio.isStarted` remains
  observable; it does not carry microphone analysis to renderers.

## Transport Rules

### Consumer to capture owner: `pattern-audio-plan`

Plans remain complete, revisioned declarations of active slots. Validation
requires every slot's `audioTransport` to be `pattern-controls`, validates the
pattern ID and parameter object, and applies existing size/range limits.

### Capture owner to consumer: `pattern-audio-controls`

Packets retain the established version, consumer/owner identity, stream
generation, sequence, capture time, slot parameter revision, continuous values,
typed arrays, and bounded events. Receiver validation, ordering, interpolation,
neutral decay, event suppression, and stream-reset behavior are unchanged.

The engine emits neutral controls while no capture frame is available, so preview
and CUE lifecycle behavior does not depend on a fallback audio path. Device
restarts still create a new stream generation and reset controller history.

## Scheduling and Lifecycle

1. The capture owner obtains one noise-cleaned analysis frame per audio tick.
2. The engine reconciles fresh plans and updates every active controller once.
3. It broadcasts one compact controls packet per consumer plan and dispatches it
   locally because `BroadcastChannel` does not echo to its sender.
4. Separately, it computes and broadcasts the existing throttled EQ spectrum.
5. Expired plans dispose their controllers; no full analysis frame is sent at
   startup, during uncertain topology, or for any program composition.

## Verification

Coverage includes protocol validation, ordering/interpolation/event behavior,
CUE readiness, and controls-only renderer behavior. Browser coverage iterates
all 58 embedded preview patterns, verifies controller health and the absence of
the retired full-frame message, and exercises representative LIVE patterns with
screen-side audio-facade spies.
