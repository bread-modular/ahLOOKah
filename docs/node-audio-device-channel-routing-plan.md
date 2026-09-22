# Per-Node Audio Device and Channel Routing — Design Handoff

**Status:** Implemented (core feature, this build); see the implementation note below. Hardware soak from section 13.2 remains open.
**Scope of this document:** Capture ownership, channel semantics, compact transport, graph compatibility, editor UI, runtime integration, implementation sequence, and acceptance tests.
**Repository baseline:** Inspected at `4c2e846`. This document is the only task-authored file change.

> **Implementation status (updated with evidence).** Shipped: graph route fields
> with old-file migration (`deviceId`/`channel`, Global+Mono defaults, strict
> validation); compact protocol v2 accepting v1|2 with routing echoes, bounded
> per-slot source metadata and admission ceilings; owner input pool (shared
> context, one capture per resolved endpoint, four-source budget, release grace,
> pin/primary sharing, no-fallback pins, resource-limit admission, retries on
> confirmed device changes); channel-scoped analysis (raw seam, mono power-mix
> parity, Left/Right projection with per-channel RMS, uncalibrated-channel/device
> states); grouped route consumers (one slot per requested route per runtime) and
> both scalar read paths; catalog request/`audio-inputs` transport with the two
> inspector selects, resolved-status line, scalar readout and tile details;
> primary-status isolation and `ownerStopping` semantics. Verified with
> `tests/nodes-audio-routing.spec.js`, `tests/pattern-audio-routing.spec.js`,
> `tests/audio-input-pool.spec.js`, `tests/nodes-audio-device-channel.spec.js`
> and the real-analyser `tests/nodes-audio-routing-e2e.spec.js`, plus the
> existing audio/node/CUE regressions and `npm test` (@core) at parity with its
> pre-change baseline. Not yet done: real multi-USB hardware soak (section 13.2),
> single-input mode switch (section 13.3), additive per-channel Settings
> calibration capture (the plumbing/validation ships, production still writes the
> mixed profile), and the aggregate byte-ceiling enforcement on control packets
> (plan-side ceiling ships).

## 1. Decision summary

Add two persisted fields to each `audio` node:

```js
{ id: 'audio1', type: 'audio', x: 300, y: 200,
  band: 'bass', deviceId: null, channel: 'mono' }
```

- `deviceId: null` means **Global input (Settings)**, a live reference, not a snapshot of the current device ID. A nonempty device ID pins this node to that browser input.
- `channel` is exactly `left`, `right`, or `mono`; UI labels are **Left**, **Right**, and **Mono**. Missing fields in existing graphs normalize to `null` and `mono`.
- Extend the **existing capture-owning control window** with a shared input pool. Maintain one retained capture per resolved input endpoint, one shared capture `AudioContext`, and the existing single worker-driven analysis clock. No editor/screen microphone capture and no context per node.
- Route raw/cleaned channel analysis **before** feature extraction. Keep separate stateful canonical feature extractors per active device/channel route; never select a channel from already-combined `bass/mid/high` values.
- **Mono preserves today's Audio-node calculation:** combined channel activity using the mean of L/R spectral powers and combined waveform power. It is not the waveform downmix `(L + R) / 2`. This deliberate compatibility decision, including its consequences for phase cancellation, is specified in section 4.
- A pinned device never silently switches to another input. A missing/denied/disconnected pin emits zero and an explicit diagnostic. Global-default nodes follow the existing Settings fallback policy, with the requested and actually used devices displayed separately.
- Use a routing-aware version of the compact protocol, accepting legacy default-only plans. No FFT/waveform arrays cross windows. Deduplicate Audio-node slots by requested device/channel **within each graph runtime**, not by band or node count.
- Keep normal Pattern audio, the EQ, and Settings attached to the global input. An Audio node controls only its own scalar output and its outgoing mappings.

Do not start with inspector controls alone: changing a select without changing capture ownership, slot routing, feature state, and both scalar read paths would show a selection that does not control the signal.

## 2. Verified current behavior and important corrections

| Area | Verified implementation | Consequence for this work |
| --- | --- | --- |
| Global selection | `DeviceSetupModal.jsx` writes `viz2_audio_device_id`, invokes `runtime.commands.setDevices`, and `runtime.js` handles `devices` through `applyDevices`/`startAudio`. With no saved selection, `startAudio` reports `unselected`; it does not automatically capture the OS default. | Preserve this global behavior; a null node selector is not an instruction to acquire an arbitrary default microphone. |
| Capture | `AudioManager.startStream` releases its old stream **and closes its context**, opens one stream, then creates a context, splitter, and two analysers. `channelCount: { ideal: 2 }` is requested. Reported counts of one, or missing counts, currently mirror splitter output 0 to R. | Simply constructing more unchanged managers would produce multiple contexts and entangle cleanup with global fallback. Refactor lifetime responsibilities first. |
| Fallback/recovery | `AudioManager` retries the OS default only for a selected ID's `OverconstrainedError`/`NotFoundError`. `runtime.js` debounces `devicechange`/`DeviceEndedError` recovery by 250 ms and restores the preferred global input when available. | Move the policy to the pool's **global selector**, not every pooled manager. |
| Features | `makeAudioFeatures` combines L/R **power**, not signed waveform samples; AGC, previous spectrum, flux, and envelopes are stateful. `createReactiveController` wraps `createFeatureController` and emits exact zeros for a missing frame. `signalValue` uses `response`, clamping/dividing the selected 0…3.2 band to 0…1. | Reuse these algorithms and normalization; add route-specific state rather than inventing a second signal scale. |
| Capture-side cache | `PatternAudioControlEngine` has one `featureAnalyser`, one `SharedAudioAnalysisView` per tick, and controllers keyed by `consumerSessionId + runtimeId`. `beginStream()` resets all of them. | The shared analysis cache and restart handling must become source-aware. |
| Existing Audio slots | `createSignalConsumer` creates **one** `__node_audio_signal` slot for the entire graph; every Audio node reads its continuous values. | One slot per distinct requested route is sufficient; three bands on the same route can still share one slot. |
| Scalar read paths | `GraphRuntime.computeSignal` reads `this.readContinuous()` without a node ID. Separately, `modulation.js:parameterView` special-cases Audio sources and calls `readContinuous()` directly, bypassing `GraphRuntime.signalValue`. | Fix **both** paths. Fixing only `computeSignal` leaves direct Audio-to-parameter mappings on the wrong input. |
| Editor hosting | Standalone `?role=nodes` uses `nodes/audio-provider.js` and its own BroadcastChannel/store. The current `EditorHost.jsx` normally hosts one editor in the main control document; `runtime.createEditorAudio()` shares its existing store, capture facade, and local bus. Main remains mounted/inert behind the editor. | Support both providers. Do not add another channel/context or transfer ownership merely because the internal editor opens. |
| Protocol | Version 1 uses complete plans, 64 slots maximum, numeric accepted params, owner/consumer identities, plan and parameter revisions, stream generation, sequence, and bounded controls/events. The store handles interpolation, stale decay, and event suppression. | Routing is descriptor metadata, not a numeric pattern parameter. Extend every serializer/validator boundary. |
| Status | The main runtime currently treats every non-running `audio-status` as owner loss and calls `clearForOwnerLoss()` on the **entire** store. | A primary-device failure must no longer clear healthy extra-device routes. |
| Scheduling | Analysis runs from `platform/audio-clock.js`, independently of visual rAF. However, the main plan heartbeat still calls `queuePatternAudioPlanPublish`, which schedules rAF. Standalone editor refresh uses a microtask. | Remove the non-visual plan publication dependency on rAF as part of lease integration; test beyond the 3.5-second plan lease. |
| Noise floor | `noise-floor.js` has a module-global profile and one in-progress capture. Every current `AudioManager.getAnalysisFrame()` feeds it and mutates its frame during subtraction, including a combined `frame.rms`. | Extra managers must not all feed that accumulator; channel views must not inherit the opposite channel's RMS gate. |
| Persistence | Graph model version and `.nodes.json` envelope version are both 1. `validateGraph` reconstructs an allowlisted node object, so unrecognized route fields would currently be discarded. `parseGraph`, repository reads, and `GraphRuntime` all validate. | Add migration at the shared model boundary, not just at creation/UI time. |

`docs/pattern-audio-control-plan.md` describes the deployed controls-only architecture. `docs/background-audio.md` documents the clock and its limits. `docs/recent-audio-reactivity.md` explicitly marks its pattern inventory/measurements as historical and superseded; do not use those counts as current acceptance evidence. Some noise-floor comments still say the screen owns capture; the current runtime owns it in the control window.

## 3. Capture architecture and browser constraints

### 3.1 Selected architecture: extend the existing owner

```text
Settings global selector       Audio nodes in preview / LIVE / CUE
          |                          |
          |                   complete compact plans
          v                          v
   Control-window ownership lock / existing fallback lease
          |
          v
   AudioInputPool (requested selector -> resolved source)
          |
          +-- source A: one stream -> splitter -> L/R analysers
          +-- source B: one stream -> splitter -> L/R analysers
          +-- source C: one stream -> splitter -> L/R analysers
          |
          | all use one capture AudioContext; one worker tick
          v
   raw snapshots -> scoped noise processing -> route analysis views
          |
          v
   per-route canonical features -> per-runtime controllers
          |
          v
   bounded controls packets / local echo -> store -> route bindings
          |
          v
   Audio-node scalar -> Math/Script and/or mapped parameter
```

Add `src/audio-input-pool.js`. It owns acquisition, alias resolution, references, retries, source generations, catalog state, and the shared context. `src/app/runtime.js` remains the owner-election and bus coordinator. `pattern-audio-engine.js` remains DOM-free: it consumes supplied route frames/statuses and exposes current route demand; it must not call browser media APIs.

The invariant changes from “one capture stream total” to **one capture-owning window, one retained capture per resolved endpoint, and no capture in consumers**. All source entries use the existing `AUDIO_LOCK_NAME`/fallback ownership lease. Do not elect separate owners per device or allow an output screen to take over capture.

Rejected alternatives:

- Capturing in each node/editor duplicates permissions, streams, contexts, and lifecycle work; breaks internal-host sharing and background-tab assumptions.
- Switching the one global stream whenever a node selects a device cannot serve two differently routed nodes simultaneously and would change all Patterns.
- Sending raw frames to editors violates the deployed controls-only architecture and expands transport costs with FFT size and channel count.
- One unchanged `AudioManager`/context per device is an avoidable transitional design, not the target. It increases context/resume/clock coordination and makes stopping one input easier to confuse with stopping all audio.
- A worklet/native audio service is not required to route a few independent feature signals. Reserve native capture as the fallback if the actual show hardware cannot sustain browser multi-input capture.

### 3.2 Web Audio and Chrome realities

A single `AudioContext` can run several sources/pipelines concurrently; reusing it is recommended. Construct one `MediaStreamAudioSourceNode` per acquired input and keep each input's graph independent. No connection to `context.destination` is needed or permitted for this feature. [source](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext)

Request one stream per selected input using `audio.deviceId: { exact: id }`, `channelCount: { ideal: 2 }`, and the current disabled echo-cancellation/AGC/noise-suppression constraints. Multiple requests are the architecture, **not a promise that every browser/driver combination can satisfy them simultaneously**. A valid permission can still result in `NotReadableError`, and a permission prompt can remain unresolved indefinitely. Keep acquisition asynchronous and outside the analysis tick. [source](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

All analysis uses the shared context's sample rate and timeline, not an assumed hardware rate. Web Audio specifies resampling incoming MediaStreams to the context rate. Separate USB devices nevertheless must not be treated as phase-synchronized recording hardware; this feature compares independent activity signals, not phase-coherent cross-device samples. [source](https://github.com/WebAudio/web-audio-api/pull/2328)

`channelCount` describes the configured track, and constraints can be unsupported/ignored. Inspect `getSettings()` rather than assuming the ideal request was honored. Left/Right mean the first two browser-exposed channels, not arbitrarily selectable hardware channels on a multichannel interface. Report the observed count. If count is absent, retain the existing conservative one-channel/mirror assumption and show “Channel count unknown; treating as mono”; do not infer channel count from whether R happens to be silent. [source](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/channelCount)

Device enumeration is permission-filtered, labels may be unavailable, and enumeration requires a fully active visible document. A hidden owner's pending/failed enumeration must not stop its capture tick or be interpreted as every device disappearing. Maintain the last catalog, mark it stale, and refresh when visible. [source](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices)

Use `devicechange`, but also track `ended`, `mute`/`unmute`, context state, and user-requested refresh/retry. Device-change delivery alone is not the entire health contract. [source](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/devicechange_event)

Preserve genuine owner-window gesture-based `AudioContext.resume()`. A BroadcastChannel message from a click in another tab is not a substitute for interacting with the owning document; direct the user to the control window if resume/permission is needed. Do not use speaker playback or autoplay-disabling flags as a production workaround. [source](https://developer.chrome.com/blog/web-audio-autoplay)

The existing worker is best-effort scheduling, not a guarantee against page freezing/discarding, OS sleep, a blocked main thread, or suspended Web Audio. Continue the documented missing/stale-control behavior in all those cases.

### 3.3 Pool interfaces and responsibility split

Implement these conceptual interfaces; names may be adjusted together, but not their ownership boundaries:

| Pool operation | Contract |
| --- | --- |
| `setGlobalDeviceId(idOrNull)` | Called only from accepted global Settings state. Holds one persistent primary-input reference while selected. Resolves the global selector/fallback; never writes a node graph. |
| `reconcileDemands(demands)` | Receives deduplicated accepted engine demands, with consumer/runtime/role references. Starts/stops extra sources asynchronously. Heartbeats replace/renew declarations; they never increment reference counts cumulatively. |
| `resolveInput({ deviceId, channel })` | Sole authority translating a null/global selector to the concrete source, or returning a typed unavailable state. Exact pins do not consult editor localStorage. |
| `sample(now)` | Synchronously reads each running source at most once per owner tick, returns the primary cleaned frame and route frame/status lookups. Never awaits a media request. |
| `getSnapshot()` / `subscribe(listener)` | Immutable catalog/global-status snapshot for the internal editor and bus publication. Notification only on meaningful state change. |
| `refreshDevices()` / `retryInput(selector)` | Bounded, explicit recovery; neither duplicates in-flight acquisition nor makes consumers capture. |
| `resume(force)` / `dispose()` | Resume the shared context from the owner gesture; invalidate all pending work and stop all tracks on owner loss/disposal. Only the pool closes the shared context; source managers borrow it. |

Refactor `AudioManager` to accept an injected/lazy context and explicit context ownership, fallback, and processing policies. A pooled manager owns one stream/splitter/analysers/buffers, **not** the shared context. Introduce a raw-frame read separate from the existing cleaned `getAnalysisFrame()` facade. Pooled managers disable their own default-device fallback and automatic `feedNoiseCapture` calls. Retain standalone defaults where needed for existing tests/callers, but production capture must go through the pool.

Maintain a primary-input compatibility facade for global status and existing DEV inspection (`window.__viz.captureAudio`). Expose separate bounded pool diagnostics for route-aware tests. Update tests that stub the old single `getAnalysisFrame` entry point to inject through the pool's frame/source seam; do not accidentally create an unused parallel capture path just to satisfy a test.

Each source entry contains a canonical source ID, requested/actual device identity, manager, in-flight promise/token, track/context health, source generation, references, release deadline, and last error. Use Maps and structured tuple keys, not delimiter-parsing untrusted device IDs or object property indexing.

### 3.4 Device identity, reuse, and budget

- Keep **requested selector**, **actual device ID**, and **source ID** separate. A null selector follows Settings; the browser's literal `default` ID means OS default and is not the graph sentinel.
- Prefer concrete IDs in the node dropdown; omit pseudo-device aliases such as `default`/`communications` from new pinned choices. Existing explicit alias values remain loadable and are displayed as OS-default aliases, not as Global input.
- Use actual track settings and the owner's catalog to canonicalize aliases. An alias may be matched by group metadata only when it identifies exactly one concrete audio endpoint; never merge distinct physical IDs just because their labels/group names resemble one another.
- Share an existing source if an exact pin resolves to the primary's actual device. If the global requested device A falls back to B, a pin to A stays unavailable; a pin to B reuses B.
- Coalesce in-flight requests by canonical key. Resolve known aliases before opening another stream. The primary OS-default stream may be opened to establish its identity; an unresolved alias must not cause a speculative **second** capture. When identity cannot be established for reuse, report an unresolved alias and request a foreground refresh instead of guessing. If a completed acquisition reveals a duplicate, stop the redundant stream immediately and retain one source; document any transient discovery acquisition in diagnostics.
- Initial resource policy: at most **four retained input streams including the primary**, with up to three extra devices. This is an application safety budget, not a claim about a Chrome limit and not a graph-file validation limit. Count in-flight reservations too.
- The primary reserves capacity first. Keep already-admitted extra sources stable; admit additional ones deterministically by role priority `live`, `incoming`, `cue`, `retiring`, `preview`, then stable consumer/runtime identity. A new preview request cannot evict an existing live capture. If changing the primary makes a formerly shared source an extra and exceeds capacity, the primary reservation wins and the lowest-priority extra becomes explicitly `resource-limit`; do not silently substitute it.
- Store/load larger graphs normally. Excess device requests remain visible/editable and emit zero with a capacity explanation. Put the policy in one named pool constant so a measured later increase does not change graph/schema versions.
- Release unreferenced extras after a 250 ms grace period to absorb graph-runtime reconstruction. A complete empty plan releases demand immediately subject to that grace; expired plans release after the existing 3.5-second lease plus grace. Primary references remain independent of graph references.
- Acquire a new primary without tearing down a still-needed pinned old primary. Stopping any source must leave every other source and the shared context alive.
- Tokens must cover owner epoch, source request, global-selector revision, and disposal. Late successes stop their returned tracks; late errors cannot overwrite a newer running source. Do not retry an unresolved permission prompt in parallel. On owner loss invalidate everything before releasing the capture lock, stop tracks, then close the context.

### 3.5 Recovery state machine

Keep health/recovery off the render path. A new admitted, authorized demand makes one acquisition attempt. Coalesce track-ended/devicechange work for 250 ms. For a missing exact pin, wait for a valid foreground catalog refresh confirming reappearance or an explicit Retry; a denied permission waits for Settings authorization. For transient `AbortError`/`NotReadableError` acquisition failures, allow at most three automatic retries at 1, 2, and 5 seconds after the preceding failure, then remain `unavailable` until an explicit retry or a new confirmed device-change event. This backoff is per source, not per node. Do not retry a secondary while a primary it disrupted is still recovering. Never schedule retries while an acquisition promise is unresolved, or after its demand/owner has retired.

The global selector alone may perform the existing one-time OS-default attempt after an exact-device `NotFoundError`/`OverconstrainedError`; that attempt is not permission-error recovery. Returning from fallback to the preferred device requires a confirmed available ID and a new source transition. A stale/hidden catalog cannot trigger that transition.

Monitor track/context health before each read, and recheck reported device/channel settings on recovery and confirmed device changes. If the interval between actual analysis samples exceeds 750 ms, reset affected feature/controller history and increment its source generation before resuming current-input analysis; do not compare a newly resumed spectrum with arbitrarily old flux/AGC state. A consumer receiving a new generation starts from a fresh sample, not an interpolation across the gap. Publish an explicit owner-stopping notification when teardown can notify; abrupt process loss still relies on stale decay.

## 4. Exact channel semantics and feature state

### 4.1 Mono is a compatibility-preserving activity mix

This is an **analysis signal node**, not an audio-output mixer. The word Mono therefore denotes the existing combined activity measurement. For cleaned spectra in dB and equal-length waveform windows:

```text
P_L[k] = 10^(L_dB[k] / 10)
P_R[k] = 10^(R_dB[k] / 10)

Left:  P[k] = P_L[k]; RMS comes only from waveformLeft
Right: P[k] = P_R[k]; RMS comes only from waveformRight
Mono:  P[k] = (P_L[k] + P_R[k]) / 2
       raw RMS = sqrt((mean(waveformLeft^2) + mean(waveformRight^2)) / 2)
```

Keep the extractor's existing finite-dB floors, RMS override/noise gate, AGC, band crossovers, temporal envelopes, and `response()` normalization. The formulas describe the input combination, not a new output transfer function.

**Do not compute Mono as `(featuresLeft + featuresRight) / 2`.** Extraction is nonlinear and stateful. Also do not average dB values arithmetically. For default Mono, passing the existing two-channel cleaned frame through the existing extractor/support calculation preserves today's calculation without an extra mix/FFT.

This is intentionally **not** `monoSamples = (L + R) / 2`. A real signed-sample downmix cancels opposite-phase stereo and reduces a one-sided signal's amplitude differently. Existing code does neither: opposite-phase inputs retain activity, and a one-sided stereo signal contributes half its power to Mono. Mirroring one side on a stereo device would incorrectly discard the other side. Explain this briefly in the inspector help: “Mono combines both channels' activity; it does not phase-cancel stereo.”

If product requirements instead demand conventional audible-waveform Mono, that is a separate behavior change, not an implementation detail: add a capture-side 0.5-gain L/R sum feeding a **third analyser** (or a verified raw-sample FFT), calibrate it independently, and explicitly version/migrate the old power-mix behavior. It cannot simultaneously preserve old stereo graphs numerically. This plan chooses the power-mix definition to satisfy the stated backwards-compatibility requirement.

### 4.2 Physical mono and unknown channel count

For a track reporting one channel, preserve the existing mirror: both logical L and R represent channel 0. All three selections receive the same underlying input without halving or doubling its level; keep the stored requested selection so it takes effect if the device later supplies stereo. Show “1-channel input; Left and Right use the same signal.”

For a missing channel-count setting use the current mono assumption with an explicit unknown-count note. For a reported count greater than two, analyze only browser channels 0 and 1 and disclose that limitation. Any effective channel-layout change increments the source generation and resets its route histories.

### 4.3 Select before extraction; reuse analysis, not mixed features

Add a DOM-free `src/audio-routing.js` for selector normalization/validation, safe route keys, channel-frame projection, and shared route constants. `definitions.js` may import this dependency-free helper; update its current “no imports” comment without introducing a model/runtime cycle.

At each tick:

1. Read each source's raw L/R analyser arrays once.
2. Feed the raw primary frame to calibration at most once, then construct independent routed processing views as specified in section 5.
3. Mono uses both channels; Left exposes only L as a single-channel analysis frame; Right exposes only R as a single-channel analysis frame. Use `left`/`waveformLeft` for the chosen single channel and omit `right`/`waveformRight`; recompute/select its RMS, never copy a combined `frame.rms`.
4. Create one lazy `SharedAudioAnalysisView` per effective `(sourceId, sourceGeneration, channel)` that is used this tick. A physical mono source can alias all three requested routes to its one effective analysis route.
5. Maintain one `makeAudioFeatures()` instance per effective route across ticks. Share that view/features/support-cache result across consumer controllers. Do not use the module-global `getSharedFeatures()` analyser across different devices/channels.
6. Keep per-runtime `NODE_AUDIO_SOURCE.createAudioController()` state as today, but recreate the affected controller if its resolved source/generation/channel changes. Its per-consumer dynamics are not shared globally. Nodes grouped onto one route slot receive exactly the same continuous snapshot.

Default Mono nodes and ordinary Pattern slots can reuse the primary full-stereo shared view. Ordinary stereo-aware Patterns still receive L/R in their controller frame; do not turn their entire capture frame into a one-channel projection.

Reuse scratch arrays, but expose a new frame/view identity each tick so the extractor's same-frame memo cannot return the previous tick. Never mutate the Mono view while building L/R views, nor apply noise subtraction twice through aliased buffers. Only demanded channels need feature extraction. Release extractors when their source route is no longer retained; source/layout/calibration changes reset affected histories.

## 5. Noise-floor isolation

Noise handling is required plumbing, not an optional follow-up. Calling the current cleaned `getAnalysisFrame()` on multiple managers would mix devices into the single calibration accumulator. Taking Left from a frame with a stereo-derived RMS override also leaks the other channel into gating/AGC.

Make these concrete changes in `src/noise-floor.js` and the pool:

- Keep Settings calibration scoped to the **currently resolved primary source**. Lock acquisition metadata/source generation at calibration start; cancel with a diagnostic on device/fallback/layout changes, owner loss, or a gap longer than the existing stale threshold. An extra source never feeds that accumulator.
- Preserve the existing mixed `dbs`/`noiseRms` calculation for Mono and normal Patterns exactly. Existing stored profiles continue to work without recapture for those consumers.
- Extend the existing `viz2_noise_floor` profile additively with optional `leftDbs`, `rightDbs`, `noiseRmsLeft`, and `noiseRmsRight`, collected from the same raw primary ticks. Keep the existing storage version and mixed fields; old readers can ignore the additions. Validate optional array lengths, finite values, metadata, and completeness as a unit; malformed optional data must not be used as channel calibration.
- Add an explicit channel-processing API accepting a selected profile/signature rather than implicitly reading a different source's mutable state. Mono uses the mixed profile and existing two-channel cleanup. Left/Right process copies of the corresponding **raw** channel with that channel's profile and RMS only.
- A legacy mixed-only profile cannot be reverse-engineered into two channel profiles. Left/Right run without stored noise subtraction until recaptured, using the existing inherent feature silence gate. Report `uncalibrated-channel`; do not apply the other channel's/mixed RMS or invent per-channel calibration. On a known one-channel track, the mixed profile represents that one signal and is usable for all selections.
- This release retains **one Settings calibration profile**, not a bank of profiles or per-node calibration controls. Apply it to extra-device routes only if its concrete device ID matches. Otherwise those routes are `uncalibrated-device`; the node still operates. Unknown-ID legacy profiles may retain their existing primary-Mono behavior, but must not be applied to arbitrary additional devices.
- The pool builds/caches each cleaned route once per tick. Keep mixed/global EQ output unchanged. A calibration change resets only the affected source's feature/controller histories and slot generation.

Use structured calibration state in diagnostics, distinct from capture failure. Uncalibrated means a live signal with a warning, not zero. Update stale comments about screen ownership. Verify Settings export/import preserves the optional channel fields; update `src/platform/settings-portability.js` only if its envelope validation needs adjustment.

## 6. Graph model, migration, and portability

### 6.1 Stored contract

In `src/nodes/definitions.js:defaultNode('audio')`, add explicit `{ deviceId: null, channel: 'mono' }` alongside `band: 'bass'`. Device/channel selectors are not signal/image ports, not numeric modulation parameters, and not inputs to `activeInputs`; keep `inputs(audio) === []`.

In `src/nodes/model.js:validateGraph`:

- Missing `deviceId` becomes null; explicit null is valid.
- Otherwise require a nonempty string of at most 512 characters, without control characters. Treat it as an opaque ID: preserve case and punctuation; do not apply graph `idOK`, trim, parse delimiters, or coerce numbers/objects to strings. Empty string is invalid in files; only the UI adapter maps its Global option to null.
- Missing `channel` becomes `mono`; an explicit value must be exactly one of the three lower-case strings. Reject null, numbers, misspellings, and unknown values rather than silently reverting.
- Preserve the existing band validation and copy the normalized fields into the returned allowlisted node.
- Do not validate device availability at file-load time. A disconnected device is a repairable runtime condition, not an invalid graph.
- Keep graph `VERSION = 1`, envelope version 1, existing byte bound, link rules, cycle rules, and lack of a structural node-count limit. These are additive fields with well-defined old-file defaults.

### 6.2 Load/save behavior

`portability.js:parseGraph` and `serializeGraph` already call `validateGraph`; use that common normalization. Repository reads/queued operations and `GraphRuntime` construction therefore accept old in-memory or disk graphs too. Normalize before establishing the editor's serialized dirty baseline so opening an old graph is not presented as an unsaved user edit. Do not rewrite disk files or queued records merely on load; write canonical fields on the next explicit Save.

`repository.js` remains file-authoritative: preserve original file text/hash for conflict detection, stable file identity, and the existing save queue. `registry.js` continues to close over the validated graph record; no route state belongs on a global sketch registration and no new Audio-node palette Pattern is registered.

Keep exact pinned IDs in portable files, but do not embed device labels, permission state, streams, source generations, or a snapshot of Settings. Extend the portability notice to say pinned audio IDs are browser/origin-specific and may need reselection on another machine/profile. Device IDs can change when site data is cleared and differ in private sessions. Never relink automatically by matching a label. [source](https://developer.mozilla.org/en-US/docs/Web/API/MediaDeviceInfo/deviceId)

Missing device warnings must **not** enter the fatal `sourceDiagnostics` list: that list prevents saving and can prevent GraphRuntime from constructing visual sources. Add separate nonfatal audio-route diagnostics instead. Imported graphs must stay savable/editable while their audio devices are offline.

New fields remain in graph and file version 1 for old-file compatibility, but an older application build can discard unknown fields. Forward round-trip through an old build is not supported; document that routed graphs must be edited with a routing-aware build. Do not claim two-way compatibility that the current old validator cannot provide.

## 7. Compact protocol and engine/store routing

### 7.1 Version and descriptor extension

Set the current compact protocol version to **2** and explicitly accept supported versions 1 and 2 at the relevant boundaries. Keep message type names unchanged. Add this metadata to a version-2 Audio-signal plan slot:

```js
{
  runtimeId: 'node-audio-<runtime-uuid>-<route-index>',
  patternId: '__node_audio_signal',
  role: 'preview', childIndex: 0,
  paramsRevision: 1, params: {}, audioTransport: 'pattern-controls',
  audioInput: { deviceId: null, channel: 'mono' }
}
```

`params` remains the complete numeric parameter object, empty for this internal source. `audioInput` is not smuggled through `paramsFingerprint` or represented as a label. Require a complete valid `audioInput` for v2 `__node_audio_signal` slots; ordinary Pattern slots omit it and use the global full-stereo frame. Reject nondefault route metadata on other pattern IDs in this release.

Update `toPublicPlanSlot`/`publicSlot`, `validatePatternAudioPlan`, local descriptors, engine plan copies, diagnostics, and store descriptor equality. They must all retain routing. Version-1 plans normalize to global/default semantics internally; reject a v1 plan containing nondefault routing fields rather than ignoring their intent.

### 7.2 Output metadata and scoped generations

Every v2 control slot includes source availability/generation metadata, and a node slot also echoes its exact requested selector:

```js
{
  runtimeId, paramsRevision,
  audioInput: { deviceId: 'input-B', channel: 'right' }, // node slots only
  source: {
    id: 'owner-scoped-source-id', generation: 7,
    activeDeviceId: 'input-B', channels: 2,
    status: 'running', fallback: false,
    calibration: 'channel-profile'
  },
  continuous: { bass: 0.4, mid: 0.1, high: 0 /* other FEATURE_SCHEMA keys */ },
  arrays: {}, events: []
}
```

Allow null source ID/activeDeviceId and generation 0 before any source is resolved. Source IDs use the existing 160-character ID bound, device IDs the new 512-character bound, and generation the existing revision bound. `channels` is null when unknown, otherwise an integer from 1 to 256 as a transport safety bound (not a supported-hardware-channel promise). Preserve the separate effective mono assumption when settings omit the count. An error description belongs in a changed-status/catalog message or local diagnostic, not an unbounded per-tick field. `status` is one of `running`, `starting`, `unselected`, `permission-required`, `permission-denied`, `suspended`, `muted`, `missing`, `unavailable`, `resource-limit`, `identity-unknown`. `calibration` is exactly `none`, `mixed-profile`, `channel-profile`, `uncalibrated-device`, or `uncalibrated-channel`; `none` means no calibration profile was configured. Successful fallback is `running` plus `fallback: true`; calibration warnings are independent.

Keep the packet's `audioOwnerId`, `streamGeneration`, `sequence`, `captureTime`, consumer ID, and plan revision. For v2, packet `streamGeneration` is the **owner/context transport epoch**; a secondary-device restart does not reset it or every slot. Source generation is owner-allocated, increasing on replacement, failure/recovery, channel-layout change, or calibration reset. The store resets only matching slots when their source tuple changes. Include source generation in event de-duplication keys as well as transport generation.

`audioActive` on a v2 packet means “at least one slot in this packet has usable input”; consumers must not use it to assume every slot is live. Each slot's source status is authoritative. A silent but running microphone is active. No default input plus a healthy pinned input is a valid active packet.

Use the common context time for captured frames; keep local receipt time authoritative for stale age. While no context/frame exists, preserve the existing neutral timestamp fallback; never subtract timestamps from different windows. Sequence is monotonic within a transport epoch across all source restarts. Rotate epoch and reset ordering deliberately before the existing revision/sequence integer maximum is exceeded.

### 7.3 Revisions and accepted-packet routing

- `planRevision` changes for slot membership/identity/role topology changes and transport-version changes. Heartbeats do not increment it.
- Within a retained slot, increment `paramsRevision` when **either accepted params or the requested device/channel changes**. The numeric params may still be `{}`. Use a separate selector fingerprint, not `Number(deviceId)` through the numeric fingerprint helper.
- Moving a node, changing its band, or changing a device label does not require a different capture route. With the current full graph-content reconstruction, new runtime IDs on semantic edits are valid; grace-period pooling prevents capture churn. Do not require an incremental renderer rewrite for this feature.
- A Settings change alters the **resolved source** for null selectors, not the serialized selector or its parameter revision. Reset affected histories via source metadata, without rebuilding pinned nodes on unrelated devices.
- Strengthen `receivePlan`: lower plan revisions fail; same-plan slot revisions cannot regress; different selectors/params at an unchanged slot revision fail. An identical complete plan renews its lease. Rejected plans must not start captures, replace the last accepted demand, or renew an invalid declaration indefinitely.
- `PatternAudioControlStore.acceptPacket` validates envelope, negotiated version, consumer/plan, current owner/epoch and ordering, then runtime ID, parameter revision, selector equality, source metadata, and control schema **before mutation**. Routing uses the registered slot binding, never band names or a packet-wide “current device”.
- A node slot missing its routing echo in v2, or carrying a different selector, is dropped with a diagnostic. Do not turn that into global audio. Check the current owner against the owner announcement/catalog; retain bounded retired epoch information so delayed old-owner packets cannot switch a store back to a retired stream.
- On a source tuple change reset previous/current samples and events for that slot; never interpolate across devices or channels. Preserve CUE event suppression and render-marker semantics. Neutral failure controls count as delivered controls, not as evidence that hardware is healthy.

In `pattern-audio-engine.js`, replace the single canonical analyser with a bounded map of route analysers/views. Use `pool.resolveInput(slot.audioInput)` through a supplied lookup to choose the frame for each node controller. Normal Pattern controllers receive the primary frame. Reconcile capture demand only from accepted, nonexpired plans; reconcile it on removal/empty plans and lease expiry as well as acceptance. Reset controllers when their selected source changes, even if `patternId` and `runtimeId` did not.

Keep `beginStream` for a full owner/context reset. Add source-scoped reset handling; remove calls that globally reset v2 consumers merely because `startAudio` selects a different primary. For legacy v1 consumers retain their existing whole-stream reset semantics on **primary** restarts, using a legacy primary-stream generation; extra-device changes must not reset v1 Patterns.

### 7.4 Bounds and overflow

Retain the existing limits: 64 slots per plan/packet, 16 parameter keys, 64 control/array keys, 512 elements per typed array, 16 events per slot, 160-character runtime/owner IDs, and signed-31-bit revision/sequence bound. Node routing adds no signal arrays; its feature schema remains eight bounded continuous numbers and no events.

Add a 512-character device-ID bound, three-value channel enum, bounded source/calibration/status enums, and no nested arbitrary route properties. Apply these bounds before allocating captures. Add proposed aggregate transport ceilings of 256 KiB per plan and 2 MiB per controls packet using `estimateTransportBytes`, after cheap bounded shape checks and before expensive controller/schema work; verify the current schemas' maximum-size legitimate fixtures fit those ceilings before enabling them. Do not recursively size an arbitrary unvalidated object: check allowed shallow shapes/key counts first and stop a budgeted walk as soon as its limit is exceeded. These are operational estimates and limits, not exact structured-clone byte counts or replacements for structural validation.

Deduplicate Audio nodes with the same requested selector/channel in one GraphRuntime, so a graph with many bands/fanouts does not create one slot per node. This does **not** eliminate the existing aggregate 64-slot limit across Pattern children, LIVE/CUE roles, and editor children. Centralize publisher admission: reserve existing ordinary Pattern slots, retain already-admitted signal routes while referenced, then admit new signal-route groups to the remaining budget. For a denied signal group keep a local `resource-limit` binding emitting zero and a visible diagnostic; no descriptor for that group is published. Never send 65 slots, silently truncate a complete plan, or invalidate existing admitted audio merely by adding an excess Audio node. If ordinary Pattern slots alone exceed the existing transport limit, report a provider-level capacity error rather than claiming this feature removes that pre-existing limit.

Bound owner-side consumer/session state too (initially 16 leased consumer plans), enforce the four-source pool budget independently of slot count, and dispose rejected/expired request bookkeeping. Reject excess new consumers explicitly without evicting existing ones; return a small bounded admission-error message so they show a capacity reason instead of waiting forever. Do not introduce an unrestricted cross-window capture-request endpoint.

### 7.5 Heartbeats, compatibility, and local echo

Preserve complete plans, one-second heartbeat intent, 3.5-second plan lease, eight-second expected-consumer lease, and immediate republish on `pattern-audio-plan-request`. Empty complete plans still mean unsubscribe. Add optional capabilities to the owner's existing request and catalog: supported protocol versions, `nodeAudioRouting: 1`, and capture mode/budget. Old consumers ignore these fields.

Compatibility matrix:

| Producer/consumer combination | Required behavior |
| --- | --- |
| New owner, old v1 consumer | Accept its default-only plan; emit v1 packets for that consumer; unchanged primary audio, status, heartbeat, event and stream-reset behavior. |
| New owner, new consumer | Use v2 with route echoes and per-source status/generation. |
| Old owner, new consumer, only default/Mono routes | Allow an explicit v1 compatibility plan after capability discovery times out or a legacy owner request arrives. Strip only equivalent default metadata; bump plan revision when switching protocol. |
| Old owner, new consumer with any pin or Left/Right route | Do not downgrade that complete plan to global input. Show “Audio owner needs a routing-capable build”; remain neutral until an upgraded owner replies. |

New standalone consumers send the device/capability request and a v2 plan immediately. If no v2 capability reply arrives within 1.5 seconds, a default-only consumer may use v1; a routed one stays fail-closed. Upgrade again on a capable owner announcement. Absence of a reply alone is displayed as “No compatible audio owner”, not proof of permission denial. The store accepts packets for its currently published wire version only, with the v1 exception limited to a safely downgraded default-only plan. All application plan producers must implement the same rule, including saved graph LIVE/CUE plans.

Remove the main runtime's rAF dependency from plan refresh/heartbeat publication: use a coalesced microtask for descriptor changes, and an independent heartbeat that directly publishes the latest complete plan. The owner clock can service its own due heartbeat before expiring local demand. Do not add one clock per device. Freeze remains a documented limitation, with stale decay and lease cleanup rather than replay.

Use `createBroadcastBus.broadcast` for owner packets and catalog/status changes so internal consumers get the existing local echo. Standalone `createEditorAudio` keeps its own BroadcastChannel. Never add a second main-document channel to work around the fact that BroadcastChannel does not echo to its sender.

## 8. Device catalog, permissions, and editor UI

### 8.1 Catalog transport

Add `src/audio-input-catalog.js` for bounded snapshot validation and subscription state; the pool is the authoritative catalog producer. Add the following message types/validators alongside the compact protocol:

- `audio-inputs-request`: protocol version, requester ID, optional last revision. Requests discovery/capabilities only; it cannot cause a permission prompt or capture by itself.
- `audio-inputs`: owner ID/transport epoch, `ownerStatus: 'active' | 'stopping'`, catalog revision, complete/truncated indicator, supported protocol versions/routing capability/capture budget, permission state (`unknown`, `prompt`, `granted`, `denied`), requested global ID, active global ID, global status/fallback, and a bounded list of `{ deviceId, label }` audio inputs. Before releasing ownership/closing the bus, publish `stopping` when possible; receivers call `clearForOwnerLoss()` only for the matching current owner/epoch. A primary-device error with `ownerStatus: 'active'` is not an owner-loss notification.
- `audio-input-retry`: requester and selected route, accepted only for a route already leased by that consumer; rate-limit retries and retain the owner permission/gesture requirement. It is not an arbitrary device opener.
- `pattern-audio-plan-rejected`: owner, consumer ID, plan revision, and bounded reason enum for capacity/version/malformed admission errors; no reflected raw input or stack traces.

Use at most 128 catalog entries, labels at most 160 characters, and a 256 KiB catalog ceiling. Keep group IDs internal to owner alias resolution. If truncated, say so; a missing ID in a truncated, stale, or permission-filtered catalog is not proof of disconnection. Preserve active/selected device entries where possible. Keep unavailable pins as editor-derived placeholder options rather than injecting arbitrary graph IDs into the authoritative inventory.

Publish after successful capture/permission refresh, global selection/fallback changes, debounced device changes, and on request. Cache snapshots and answer repeated requests from cache; at most one enumeration in flight and one ordinary refresh per second, with a trailing refresh flag. Never broadcast the entire catalog at analysis frequency. Unknown or stale catalog state must not affect running source data. Publish status/label changes without changing graph content or preview-runtime keys.

Internal `runtime.createEditorAudio()` and standalone `createEditorAudio()` expose the **same** interface for `getInputSnapshot`, `subscribeInputs`, `refreshInputs`, and route status. Internal calls use runtime services; external ones consume validated owner messages. Subscribe/unsubscribe with editor lifecycle and dispose pending notifications. If the owner is hidden, display its cached snapshot and “Refresh in control window”; do not locally probe with getUserMedia.

### 8.2 Permission workflow

The editor does not request microphone permission itself. Before permission, show Global input and any known IDs with generic labels such as “Audio input 1”; show saved missing pins as “Unavailable input (…ID suffix)”. Show “Enable microphone access in Settings in the control window” when discovery/capture is unavailable. For the internal host, provide **Open Settings** using the existing main store's `setupModalOpen` state: `DeviceSetupModal` already portals into the document body, so opening it need not close the editor or discard the draft. For a standalone editor, instruct the user to switch to the existing control window; do not open a second control/capture session automatically. Do not use a camera label as proof of audio permission; the current modal's `devices.some(label)` heuristic is insufficient for this catalog.

Keep permission acquisition in the owning control's Settings/Initialize gesture. Update `DeviceSetupModal.jsx` to invoke an owner-managed audio initialization/refresh command instead of opening a redundant audio probe when the pool already has a stream. A no-selection label-unlock acquisition is a temporary pooled reference that is stopped if no primary/node needs it. Keep video permission handling separate so camera denial cannot prevent audio initialization; do not introduce video capture in the editor. Preserve the existing global device-selection persistence and command flow.

An accepted remote plan may reuse an already permitted input, but must not trigger repeated surprise permission prompts. Extra acquisition waits for owner audio authorization; permission denied remains a stable error until an explicit owner Settings action. If a new device still requires consent, show a pending/permission-required state and direct the user to the owner. A long-unanswered browser prompt does not block other sources or create more requests. Same-document editor gestures may resume the already-running shared context; standalone gestures cannot promise that.

### 8.3 Inspector and tile behavior

In `NodesEditor.jsx`, keep **Audio band**, then add:

1. **Audio input device**: existing `Select` component. First option is always **Global input (Settings)**, annotated with the owner's current label when available. Map its UI empty value to stored null. Concrete input options show human labels or permission-safe placeholders. Keep the selected missing option visible; never silently select the first available device.
2. **Channel**: accessible `Select` with **Left**, **Right**, **Mono**. Default Mono; keep choices enabled for physical mono and explain the mirroring. No numeric slider or modulation target.
3. **Resolved input/status**: requested label, actual fallback label if different, observed channel count, permission/capture/capacity/calibration state, and guidance. Use text plus a polite live region for transitions, not an announcement per audio tick.
4. **Scalar readout**: reuse `SignalReadout` for this Audio node, reading the same memoized routed value as renderers. Keep the Audio canvas preview omitted; scalar nodes do not need a blank video area.

Place the device snapshot subscription above the `Preview`/inspector split (or pass the provider through a shared editor hook). The current `Preview` owns its provider and returns null for Audio selections; putting status only in its hidden diagnostics would make the feature's error state invisible. Keep provider/runtime mounted for scalar selections.

Keep titles/chips such as `Audio · bass` stable where useful for existing wire/mapping labels; add a short tile-detail line like **Global · Mono** or **USB interface · Right**, with full accessible description/title and explicit warning text. Add ellipsis/wrapping in `nodes.css` without changing socket anchors or causing horizontal overflow. Do not display raw opaque device IDs as the primary label.

Changing device/channel calls the normal `patch`/`validateGraph` path, affects only that node, marks the draft dirty, and updates its preview route. It does not call `setDevices`, modify global localStorage, affect another graph's selectors, or change LIVE until the existing save/registry workflow applies. Changing the global Settings input updates null-selector labels/routing without making graphs dirty or rebuilding them. Preserve `EditorHost.jsx`'s one-editor session, mounted main view, leave guards, and legacy standalone route.

## 9. Runtime/data flow and deterministic failure behavior

### 9.1 Graph/runtime changes

Refactor `nodes/audio-provider.js:createSignalConsumer` into a grouped route consumer (or add `createSignalConsumers` with an adapter for existing callers):

- Accept the graph's Audio nodes, normalize routes, assign one stable descriptor/binding per distinct requested `(deviceId, channel)`, and keep `nodeId -> route binding`.
- Do not include `band` in the route key: every internal slot already emits all bands. Do not collapse a null selector and an explicit device ID just because they happen to resolve to the same input today; their future behavior differs.
- Expose `read(nodeId)` and `getNodeStatus(nodeId)` plus the existing child-runtime descriptor/disposal contract. Make disposal idempotent; remove only its own slots.
- Continue `_controlFreshMarkers()` returning the existing nonvisual behavior initially. Missing audio must not make a valid visual graph unable to reach CUE READY; it produces neutral scalar values and visible diagnostics. Test that a missing-input CUE can still TAKE without replaying stale signal/event state.

In `nodes/runtime.js`, pass nodes into the consumer, read the matching binding in `computeSignal`, and retain one route snapshot per render frame plus the existing per-node scalar memo. Supply the same `readSignal(id)` to parameter views and the inspector. Keep an optional `context.readAudioSignals(nodeId, route)` injection seam for tests; old default-only callbacks that ignore arguments can remain supported.

In `nodes/modulation.js:parameterView`, prefer the supplied `readSignal(source.id)` for **all** scalar sources, including Audio. Only the standalone utility fallback should call a route-aware `readContinuous(source.id, route)`. This ensures Audio -> Pattern/Blend/Color, Audio -> Math/Script -> target, marker, and scalar readout agree. Keep `signalValue`, step/clamp/range mapping, and saved base parameters unchanged.

In `program-runtime.js`, preserve child-runtime descriptor gathering for saved graphs through preview/LIVE/CUE/incoming/retiring roles. Route metadata must survive flattening; ordinary Pattern slot descriptors retain global semantics. Role transitions do not acquire a second source for the same device. Ensure graph child disposal and slot-change notifications still publish complete plans.

### 9.2 End-to-end authority sequence

1. Graph validation yields `{ deviceId: null | id, channel }`; UI edits only this graph state.
2. GraphRuntime/provider groups requested routes and registers runtime-scoped bindings with its store.
3. The appropriate provider publishes a complete plan (locally echoed in the main window, BroadcastChannel in a standalone editor).
4. The owner engine validates the plan, reconciles route demand, and asks the pool to maintain the required sources.
5. **`AudioInputPool.resolveInput` is the only module resolving null to Settings.** `runtime.js` supplies accepted global selection to the pool; neither renderer nor graph persistence substitutes a concrete ID.
6. The shared clock samples available inputs, the routing/noise layer selects channel data, and the engine computes per-route features and slot controls.
7. The store accepts only controls matching this node route's runtime/revisions/selector; GraphRuntime reads that binding and maps the selected band to 0…1.
8. Catalog and per-slot status update labels/diagnostics separately from saved graph data.

### 9.3 Failure/fallback table

| Condition | Signal and status | Recovery |
| --- | --- | --- |
| No control owner / no compatible owner | Initial zero; existing values become stale and decay as below. Visible `owner-offline` or `unsupported-routing` consumer diagnostic. | Republish on owner request/heartbeat and capability response; editor never captures locally. |
| Global selector, no global selection | Zero, `unselected`. | Operator selects an input in Settings. |
| Global selected ID missing at startup/unplugged | Zero while starting; only this selector may use the existing OS-default fallback after `NotFoundError`/`OverconstrainedError`. On success use that source and show “Global fallback: requested A, using B”. | Keep requested A; restore A after a valid refresh says it is available, resetting only followers of the global resolution. |
| Pinned device missing or disconnected | **Zero**, `missing`; retain pin and channel. Never use global/OS fallback for this node. Other sources continue. | Retry on confirmed reappearance/devicechange/explicit retry with backoff; same ID resumes with a new generation. Changed ID requires reselection. |
| Permission denied or not initialized | Zero, `permission-denied`/`permission-required`. No continuous reprompt. | Trusted Settings action in the owner. |
| Hardware/open failure (`NotReadableError`, etc.) | Zero, `unavailable`; do not claim permission was denied or infer an OS cause from the name alone. | Bounded retry or single-input mode; preserve the working primary. |
| Track muted, context suspended/interrupted, or source starting | Zero for affected routes after a status update; shared-context suspension affects all its routes. | Unmute/resume or explicit owner interaction; no fabricated idle waveform/beat. |
| Stream or slot capacity exhausted | Zero, `resource-limit`; graph still loads and saves. | Release another demand or revise routing; never steal a different source without the explicit primary-budget rule. |
| Catalog absent/stale but source healthy | Continue real signal; catalog warning only. | Refresh when owner visible; do not use catalog age as a signal gate. |
| Calibration unavailable | Real uncalibrated signal, warning only. | Recalibrate the desired primary in Settings if needed. |

For a positively identified failure, the owner emits schema-valid exact-zero node controls and the store clears that slot's interpolation history/events immediately; do not wait for an old nonzero sample to age out. A route edit/source generation change also starts neutral until matching controls arrive. Preserve normal envelope behavior for actual musical silence; do not confuse silence with device loss.

For transport loss without a newer status packet, retain the current store policy: after **750 ms** without accepted controls, decay continuously to neutral over **350 ms**, so the scalar is exactly zero by 1,100 ms after the last receipt. Explicit owner-loss notification starts that decay immediately. No replay of missed beats/events on resume. The Audio node's zero maps to the mapping's **minimum endpoint**, not necessarily the parameter's saved base value; no special mapping behavior is added.

In `runtime.js`, stop treating primary `audio-status` failures as whole-owner loss for v2 stores. They invalidate only primary-following slots; per-source packets handle pinned failures. Full owner/context loss still clears all slots. Keep legacy v1 status behavior for old consumers. `PreviewAudio` stays a compatibility/status facade with `idleSignal: false` for the standalone node editor; no new `receiveFrame` or synthetic input path is introduced.

## 10. File-by-file implementation map

| File | Planned change |
| --- | --- |
| **New `src/audio-routing.js`** | DOM-free route defaults, ID/channel validation, tuple keys, and channel-frame projection; common graph/protocol/runtime contract. |
| **New `src/audio-input-pool.js`** | Owner-only context/capture pool, requested-to-effective resolution, alias handling, reference admission/release, per-source generations, async race protection, retry/health, raw sampling, calibration coordination. |
| **New `src/audio-input-catalog.js`** | Bounded catalog/admission snapshot validation and consumer subscription state shared by both editor providers. |
| `src/audio-manager.js` | Borrowed-context ownership, exact acquisition/no per-entry fallback, raw read seam, track health and graph cleanup, compatible primary facade support. |
| `src/noise-floor.js` | Single-primary capture enforcement, additive L/R profile fields and validation, selected-channel cleanup without mixed RMS leakage, cancellation on source change. |
| `src/pattern-audio-protocol.js` | v1/v2 handling, route/source/status/catalog/admission messages, strict metadata bounds, routing-preserving serializers, payload-size checks. |
| `src/pattern-audio-engine.js` | Demand export/reconciliation, route-view/analyser maps, per-slot selected frames, source-scoped controller resets, v1/v2 packet output, bounds and diagnostics. |
| `src/pattern-audio-controls.js` | Selector-aware descriptor equality/acceptance, source-scoped sample/event reset, typed failure neutrality, source status on bindings, negotiated-version/owner ordering. |
| `src/app/runtime.js` | Construct/use pool; adapt global selection, owner acquisition/loss/resume, worker tick, primary-only EQ/noise calibration, bus handlers/capabilities, non-rAF plans, shared editor provider, status isolation, teardown/DEV diagnostics. |
| `src/components/control/DeviceSetupModal.jsx` | Reuse owner-managed audio permission/label initialization and catalog refresh; keep global selection semantics; separate audio and video permission results. |
| `src/nodes/definitions.js` / `model.js` | New defaults, strict field validation/default migration, preserved ports and graph limits. |
| `src/nodes/portability.js` | Portable-file warning, canonical route persistence via shared validator, nonfatal audio diagnostics kept separate from source validation. |
| `src/nodes/audio-provider.js` | Grouped nonvisual route bindings, standalone catalog/capability subscription, plan-version negotiation, admission/heartbeat/unsubscribe semantics. |
| `src/nodes/runtime.js` / `modulation.js` | Per-node routed reads, per-frame caching, direct and indirect scalar path parity, status/readout integration. |
| `src/nodes/NodesEditor.jsx` / `nodes.css` | Provider/catalog state accessible to inspector, two selects, labels/fallback/missing status, scalar readout, tile detail, accessibility/layout. |
| `src/program-runtime.js` | Audit/extend descriptor flattening and child lifecycle so saved preview/LIVE/CUE use the same routes. |
| `src/nodes/audio-source.js` / `sketches/feature-controls.js` / `sketches/audio-features.js` | Reuse internal schema/controller/feature algorithms; clarify route-scoped caching contract and add tests. Avoid retuning feature curves or changing ordinary Patterns. |
| `src/nodes/EditorHost.jsx` / `repository.js` / `registry.js` | Preserve hosting, disk conflict/hash, and validated-record semantics; normally regression tests only, except minimal wiring/normalization if needed. |
| `src/preview-audio.js` / `platform/BroadcastBus.js` / `platform/audio-clock.js` | Preserve controls-only facade, local echo, and one backpressured clock. Normally no algorithm change; tests verify multi-source integration. |
| `src/platform/settings-portability.js` | Verify optional channel-calibration metadata round-trips; change only if current validation drops it. |
| `tests/*` and architecture docs | Add coverage below; revise deployed audio/background documentation only when implementation ships. |

No changes to rendering patterns' individual device UI, camera ownership, band crossover UI, custom-script signal scale, or graph file handles are needed.

## 11. Test and observability plan

### 11.1 Existing test setup

`package.json` defines `npm test` / `npm run test:core` as `playwright test --grep @core`; the complete suite is `npm run test:e2e` or `npm run test:all`. Existing node specs often have no `@core` tag, so `npm test` alone does not cover this feature. Add `@core` to the new routing contract/lifecycle regressions and explicitly run the relevant existing specs.

`playwright.config.js` uses the `tests/` directory, Chromium, fake media-device/UI flags, and a Vite web server selected by `PLAYWRIGHT_PORT`. No separate Jest/Vitest runner is present. Existing specs mix direct imports for pure functions and browser `page.evaluate` module imports for browser-dependent services; follow that setup rather than adding another framework.

### 11.2 Pure/unit-style contracts

Add **`tests/nodes-audio-routing.spec.js`** for:

- `defaultNode` fields and old raw graph/queued snapshot migration through `validateGraph`, `parseGraph`, `serializeGraph`, and GraphRuntime; absence of fields, null global selector, all channels, opaque IDs containing punctuation.
- Invalid explicit values: empty/oversized/control-character IDs, arrays/objects/numbers, invalid channels and null channel. Preserve existing band rejection, byte limits, node/signal/modulation structure.
- Old graphs normalize to global/Mono with numerically unchanged signals; canonical reserialization is stable; opening an old file is not dirty; missing pins do not block save or create a dependency-manifest entry.
- Two nodes with the same route/different bands share a slot; same band/different device or channel does not; null and an explicit current-global ID remain separate requested-route groups.
- Direct Audio mappings, Math/Script chains, marker, and scalar readout all use the node-specific binding; memoized fanout reads once and never mutates saved bases.
- Pure channel-frame projection, selected RMS, no stale combined RMS, physical mono mirroring, unknown-count policy, and channels beyond the first two.

Extend **`tests/audio-features.spec.js`**, **`tests/nodes-audio.spec.js`**, and **`tests/noise-floor.spec.js`** for:

- L-only, R-only, unequal stereo, physical mono, all-silence, finite-dB floors, and 44.1/48/96 kHz frame metadata. Selected-channel features equal running the existing controller against that isolated raw channel with the same history.
- Mono power/RMS math, including opposite-phase waveforms retaining activity. Assert it is intentionally different from `(L + R) / 2` cancellation and from averaging final features. Compare old default Audio-node/custom-script output over an entire frame sequence, not only one saturated sample.
- Loud R does not alter L's gate/AGC/history and vice versa; interleaving device A/B cannot cross-contaminate analyser histories. No duplicate canonical scan for consumers sharing an effective route.
- One calibration frame per primary tick with several devices; extra devices never affect its accumulator; raw arrays are not mutated across views; no double subtraction on aliased channels.
- Legacy mixed profile keeps Mono behavior; stereo L/R warn/bypass until channel calibration exists; additive profiles use correct channel/device and invalid optional data is ignored safely. Cancel on primary generation changes; Settings export/import preserves metadata.

### 11.3 Pool and protocol integration

Add **`tests/audio-input-pool.spec.js`** using injected media/context/time fakes, then browser-backed integration cases:

- Several leases for device A acquire once; A/B/C use one context and three captures; releasing A's last node does not stop B or a primary A reference.
- Primary A and exact pin A share; global fallback A -> B shares with pin B, but pin A is missing. Alias resolution never merges merely similar labels.
- Rapid A -> B -> A edits, dispose during pending permission, late successful streams, failed secondary acquisition, channel changes, context suspension/resume, explicit track ending/muting, primary changes while old primary remains pinned.
- Four-source and in-flight admission bounds, deterministic denied extra, release grace, empty plans, lease expiration, owner loss, and no leaked contexts/tracks/listeners/promises. Stopping one pooled manager must not close the context.
- Hidden/pending enumeration does not block sampling, trigger false disconnection, or create a retry storm. Permission denial is stable and requests do not multiply.

Extend **`tests/pattern-audio-controls.spec.js`** and/or add **`tests/pattern-audio-routing.spec.js`** for:

- Complete plan route metadata survives every public/local serializer; numeric params remain validated; malformed route/source/catalog fields and oversized messages are rejected before side effects.
- Device/channel-specific synthetic frames produce separate correct slots; multiple bands/fanouts use the correct binding. Healthy device B continues while A is failed or restarted.
- Wrong consumer, wrong owner/retired epoch, old plan, duplicate/out-of-order sequence, wrong parameter revision, wrong selector echo, and old source-generation packets cannot apply.
- Equal-revision conflicting selectors/params fail; identical heartbeat renews without a generation bump. Global selector changes do not rewrite a graph or reset unrelated pins.
- Source reset clears only its previous/current samples/events; positive failure is exact zero; silent running input is active; `audioActive` cannot mask per-slot failure.
- Transport stale decay reaches zero at the documented bound, owner loss starts decay, CUE events are never banked/replayed, and source changes do not interpolate across channels.
- v1 -> new owner interoperability, safe default-only downgrade, explicit routed refusal with an old owner, later upgrade, old no-capability plan-request, consumer lease cleanup, 64/65-slot admission and 16/17-consumer admission.
- Slot and source budgets are separate: a many-node same-route graph still uses one signal slot/capture; normal Pattern plans and control arrays remain within the proposed byte ceilings.

### 11.4 Inspector/hosting Playwright coverage

Add **`tests/nodes-audio-device-channel.spec.js`** and extend **`tests/nodes-internal.spec.js`** / **`tests/device-setup-modal.spec.js`**:

- Create a new Audio node and load an old fixture: Global input and Mono are selected. Change band/device/channel on one of two nodes; verify the other node, global Settings/localStorage, and saved parameter bases do not change.
- Mock owner catalog states: absent labels, permission required/denied, no owner, stale/truncated list, duplicate human labels, missing saved pin, hotplug, relabeled device, and global fallback. Selected values survive refresh; no first-option auto-selection.
- Save/reload/import route fields using the existing OPFS/file-picker test technique; old files remain editable and opening does not trigger the dirty guard. Unavailable devices do not prevent save.
- Selects are accessible by labels, keyboard changes work, Delete inside a select does not remove a node, text status works without color, tile detail fits, and the Audio scalar readout works without an image-preview canvas.
- Changing catalog/global status does not reconstruct the graph or mark it dirty. An actual route edit does update the preview.
- Internal editor shares the existing provider/channel/context; opening/closing it does not acquire another primary stream or unmount the main canvas. Standalone editor never calls getUserMedia. Adding a genuinely different device may increase **owner** capture count, never editor capture count.
- Settings Initialize reuses audio permission/stream when available, refreshes labels, and handles video denial independently. Owner-resume guidance does not claim that a remote click resumed its context.

### 11.5 Real Web Audio end-to-end check and its limits

The repository **does support** an analyser-to-pixels audio check: `nodes-audio-background.spec.js` replaces the physical source feeding the real splitter with an oscillator in the same AudioContext, then verifies worker ticks, engine packets, BroadcastChannel, preview pixels, and mapping markers. Extend this harness rather than claiming a synthetic controls-only packet is microphone E2E.

Add **`tests/nodes-audio-routing-e2e.spec.js`** with an owner-only injected acquisition adapter keyed by two/three test device IDs. For deterministic CI it may return synthetic MediaStreams from `MediaStreamAudioDestinationNode`s created in the pool's context (not the speaker destination), with controlled channel mergers/oscillators. Stamp deterministic settings/identity in that adapter; production does not spoof device settings. Keep the real source -> splitter -> analyser -> noise/routing -> engine -> bus -> store -> GraphRuntime pipeline. Count acquisitions, tracks, contexts, controller/view builds, and cleanup.

Drive independent left/right tones at separate band frequencies and a second/third device with a different level/temporal pattern. Verify that selecting device B/Right changes only that node's scalar, actual preview pixel/marker, and saved-graph LIVE/CUE modulation. Switch channels, unplug/fail B, recover, change global A -> C while B stays pinned, then remove nodes/close the editor and assert extra tracks are released. Assert no full-frame transport, no render-side FFT reads, and no speaker connection.

Extend **`tests/nodes-audio-background.spec.js`** to hold owner visual rAF for **longer than two plan leases**, with more than one device and an internal-editor/local plan as well as a standalone plan. Verify capture/control time advances, leases remain live without rAF, no duplicate capture appears, no old ticks replay, and teardown stops all entries. Preserve the spec's removal of Playwright background-throttling-disabling flags and its lack of an autoplay bypass.

The existing native-hidden-tab variant must remain skipped with a stated reason if headless Chromium reports both tabs visible; do not call that a hidden-tab pass. Run a headed variant on a display-equipped host. CI fake media/synthetic streams prove routing and lifecycle, **not** that two real USB inputs can coexist. Phase 0 and release validation need a real hardware test with actual independent devices, observed channel settings, one-hour operation, unplug/replug, owner backgrounding, and mixed input sample rates.

### 11.6 Commands for implementation verification

Use a free isolated port; these commands are a future execution plan, not results from this planning task:

```sh
PLAYWRIGHT_PORT=5191 npx playwright test tests/nodes-audio-routing.spec.js tests/audio-input-pool.spec.js tests/pattern-audio-routing.spec.js tests/nodes-audio-device-channel.spec.js tests/nodes-audio-routing-e2e.spec.js --project=chromium --workers=1
PLAYWRIGHT_PORT=5191 npx playwright test tests/audio-input.spec.js tests/audio-features.spec.js tests/noise-floor.spec.js tests/pattern-audio-controls.spec.js tests/pattern-audio-all.spec.js tests/nodes-audio.spec.js tests/nodes-internal.spec.js tests/nodes-scalar.spec.js tests/nodes.spec.js tests/device-setup-modal.spec.js tests/settings-portability.spec.js tests/cue-mode.spec.js tests/preview-offline.spec.js --project=chromium --workers=2
PLAYWRIGHT_PORT=5191 npx playwright test tests/nodes-audio-background.spec.js --project=chromium --workers=1
PLAYWRIGHT_PORT=5191 npx playwright test tests/nodes-audio-background.spec.js --project=chromium --headed --workers=1
PLAYWRIGHT_PORT=5191 npm test -- --workers=2
PLAYWRIGHT_PORT=5191 npm run test:e2e
npm run build
git diff --check
```

Before running, confirm the port is unused; config permits server reuse outside CI, so do not accidentally verify another worktree. Inspect skips and dependency-project selection rather than quoting raw suite counts without context. No tests/builds were run for this planning-only change because they can generate artifacts outside the permitted document.

Expose DEV-only diagnostics for requested/resolved routes, source generation/status, in-flight/capture/context counts, per-route feature-build counts/time, controller counts, accepted/dropped routing packets, catalog age, and leased references. Avoid shipping unbounded logs or exporting raw device IDs to analytics. Measure the one-device default path against its baseline and multi-device owner tick cost; select a practical release budget from the target machine, not only synthetic CI timings.

## 12. Phased implementation order and exit gates

### Phase 0 — Browser feasibility and compatibility fixtures

**Files:** new `tests/audio-input-pool.spec.js`/routing E2E harness fixtures; existing `tests/audio-input.spec.js`, `tests/nodes-audio-background.spec.js`, `tests/nodes-audio.spec.js`.

Establish default Mono parity fixtures, one-source capture/context counts, and the hardware spike for two then three exact-ID input streams sharing a context. Check primary survival when a secondary fails, independent actual channel data, settings/permission behavior, and background progression. Confirm the Mono power-mix product contract before building UI copy. If hardware fails, select the fallback in section 13 rather than hiding failure in global substitution.

**Exit:** Evidence distinguishes real hardware support from simulated routing. Default compatibility assertions and channel-math expectations are agreed and executable.

### Phase 1 — Graph and transport contracts

**Files:** new `src/audio-routing.js`; `nodes/definitions.js`, `model.js`, `portability.js`; `pattern-audio-protocol.js`, `pattern-audio-controls.js`; contract tests.

Implement normalized fields, old-file migration, v1/v2 descriptors/echo/status validation, selector-aware revisions, source-scoped resets, and bounded admission/capability contracts. Do not expose a working-looking inspector until runtime routing exists. Keep changes testable with synthetic packets.

**Exit:** Old graphs/default-only v1 consumers still pass; malformed or wrongly routed data cannot drive a binding; exact failure neutrality and source isolation pass.

### Phase 2 — Owner pool, channel analysis, and noise isolation

**Files:** `audio-manager.js`, new `audio-input-pool.js`, `noise-floor.js`, `pattern-audio-engine.js`, `app/runtime.js`; feature/noise/pool/engine tests.

Separate source/context lifetimes, centralize global-vs-pin fallback, add shared capture reuse and races/cleanup, raw sampling, routed channel/profile views, canonical analyser map, resource admission, scoped generations, and primary-only EQ. Integrate accepted-plan demand and the existing worker tick. Fix status isolation and non-rAF plan heartbeat. Keep default facade/debug behavior deliberate.

**Exit:** A/B/C routes operate independently; default Mono/Pattern/EQ behavior is retained; primary failure does not zero B; no stream/context leaks; background lease tests pass.

### Phase 3 — Graph consumers and saved preview/LIVE/CUE

**Files:** `nodes/audio-provider.js`, `nodes/runtime.js`, `nodes/modulation.js`, `program-runtime.js`, `app/runtime.js`; `nodes-audio`/scalar/CUE tests.

Group requested routes, bind per node, fix the direct modulation bypass, add frame-scoped reads/status, negotiate versions, propagate child roles and slot notifications, enforce slot admission, and preserve empty-plan teardown. Verify saved graphs use the same path as editor previews, including neutral missing-input CUE readiness.

**Exit:** Two same-band nodes on different devices/channels produce independent direct/indirect mappings in standalone/internal preview and saved LIVE/CUE, without changing ordinary Pattern input.

### Phase 4 — Catalog, permissions, and inspector

**Files:** new `audio-input-catalog.js`; `pattern-audio-protocol.js`, `app/runtime.js`, `DeviceSetupModal.jsx`, `nodes/audio-provider.js`, `NodesEditor.jsx`, `nodes.css`; hosting/UI tests.

Implement owner catalog/capability subscriptions, visible-document refresh, permission-safe labels, explicit retries, the two inspector selects, resolved status/readout, and tile details. Preserve the current EditorHost lifecycle and don't add a main-document BroadcastChannel.

**Exit:** All routing choices are observable, persist correctly, do not change Settings, and remain repairable without permission/devices. Failure/old-owner/capacity cases have truthful visible explanations.

### Phase 5 — Soak, performance, release fallback, and docs

**Files:** new/extended tests above; deployed `docs/pattern-audio-control-plan.md`, `docs/background-audio.md`, and user-facing node documentation when applicable.

Run explicit routing and regression suites, core/full suite, build, headed background variant, and hardware soak. Record max retained captures, tick/transport cost, profile behavior, and supported hardware/browser environments. Verify old-file/default behavior and single-input fallback under secondary acquisition failure before rollout. Update this plan's status only with actual implementation evidence.

**Exit:** Acceptance criteria in section 14 pass; limitations and any skips/hardware gaps are documented. A UI-only or synthetic-only multi-device claim is not sufficient.

## 13. Risks, open questions, and fallback

### 13.1 Risks in priority order

| Priority | Risk | Mitigation / release response |
| --- | --- | --- |
| 1 | Browser/OS/driver cannot keep multiple real capture devices active, or opening a secondary interrupts the primary. | Hardware spike before UI, independent health monitoring, never restart a working primary just to retry an extra. Use explicit single-input mode below; synthetic CI is not hardware proof. |
| 2 | “Mono” is assumed to mean waveform downmix, conflicting with old-graph numerical compatibility. | Specify and test the existing power-mix definition prominently. If conventional downmix is required, approve a separate versioned behavior/migration before implementation; do not silently change legacy response. |
| 3 | Wrong input after global fallback, alias changes, route edits, or delayed packets. | Separate requested/effective identities, exact pins, selector echo/revisions, owner and per-source generations, no cross-route interpolation or label-based identity. |
| 4 | Combined noise/RMS or a global feature analyser leaks another device/channel into a node. | Raw route views, single-primary calibration, optional per-channel profile fields, route-specific state, noise/AGC-isolation tests. |
| 5 | Refactoring the single AudioManager breaks primary Settings/EQ/Patterns or closes a shared context prematurely. | Primary compatibility facade, borrowed-context tests, default parity fixtures, one-input rollout before enabling extras, source-scoped status. |
| 6 | Hidden owner/editor loses leases even though capture is running; worker resources get duplicated. | Non-rAF publication, one backpressured clock, multi-lease background tests, explicit freeze/timeout limits. |
| 7 | Pending prompts/rapid edits/hotplug leak tracks or cause repeated requests. | Generation tokens, one in-flight acquisition per source, no duplicate unresolved prompts, bounded retry/admission, disposal before ownership release. |
| 8 | More devices/routes/graph roles exceed slots, CPU, transport, or stream budgets. | Per-graph route grouping, once-per-source sampling, lazy route features, explicit admission, bounded metadata/maps, measured tick budget. No structural rejection of old graphs. |
| 9 | Device IDs/labels disappear across profiles or permissions; a stale catalog misleads users. | Global sentinel as portable default, retain missing pins, no automatic label remapping, catalog stale/truncated states and owner-only refresh. |
| 10 | Old owner/new consumer mismatch or existing tests mask per-route errors with a global stub. | Version compatibility matrix, no unsafe downgrade, real analyser-to-pixels route tests, update test injection seams deliberately. |

### 13.2 Remaining product/hardware confirmations

The implementation has concrete defaults; these are review/release questions, not permission to leave routing undefined:

- Confirm that **compatibility-preserving combined activity** is the intended Mono definition. This plan selects it because existing graphs must behave as today; conventional signed-sample Mono requires a separately approved migration.
- Identify the actual target OS/browser and two/three-input hardware combinations for the mandatory concurrency/background soak. No universal hardware support is claimed.
- Confirm whether the initial four-source budget is sufficient. Raising it is a measured pool-policy change, not a graph-format change.
- Confirm the release messaging for per-channel calibration: older mixed-only profiles keep Mono calibrated, while new Left/Right choices need recapture for channel-specific subtraction. Multiple remembered device profiles are intentionally deferred.

### 13.3 Fallback if multi-device capture is infeasible

Provide an owner capability/configuration of **single-input mode** (pool capacity one) rather than silently changing node selectors. Preserve Global input and Left/Right/Mono on the primary stream. Exact pins resolving to that same physical source may reuse it; all other explicit pins show “Multiple input devices are unavailable in this mode” and emit zero. Keep saved pins intact for another machine/session.

If only one secondary device fails, isolate that route and keep the rest running; do not automatically disable all multi-input capture based on one error. An operator can select single-input mode explicitly after hardware testing. The safe physical workaround is to route the required signals through one external/OS audio interface exposing the first two usable channels, then use Left/Right nodes. A future native capture bridge is another separately scoped option. Neither workaround grants arbitrary hardware-channel access in the browser, and neither makes three independent devices magically available through two channels.

Do not fall back to editor-local capture, reconnecting microphones to speakers, broadcasting raw FFT frames, or making all pins follow the global device. Those would violate the architecture or conceal incorrect show signals.

## 14. Acceptance criteria and definition of done

- A new Audio node and any old graph's Audio nodes default to the current global Settings input and Mono; old default graphs retain their existing numerical behavior and load/save path.
- Two/three different inputs can feed separate nodes simultaneously on the tested supported hardware, with retained capture count equal to distinct admitted resolved inputs, not node count, bands, windows, or channels.
- Left and Right isolate stereo channels before feature/gate/dynamics extraction; physical mono mirrors correctly; Mono follows the documented power-mix contract.
- Device/channel selection affects only that node's scalar and outgoing mappings. Pattern audio/EQ and global Settings remain unchanged by node edits.
- Null/global resolves only in the owner. Global fallback is visible; pinned failure never substitutes another device. Identified failures are exact-zero controls, and undetected transport loss reaches neutral within the documented stale/decay bound.
- Internal and standalone editors, saved preview, LIVE, and CUE use the same route contract. No editor/screen capture, raw-frame transport, speaker connection, or synthetic idle signal is added.
- Label/permission/hotplug/capacity/old-owner states are visible and repairable; absent hardware does not make a graph structurally invalid or unsavable.
- Complete plans, validated bounded packets, heartbeats, local echo, lease expiry, event suppression, ordering, and source-scoped resets remain correct during background operation and ownership changes.
- Capture/context/worker/listener/controller resources are released on node/graph retirement and owner teardown; another device's failure does not reset a healthy route.
- Routing contract/UI/integration tests, existing audio/node/CUE regressions, headed background follow-up, and actual target-hardware validation are reported separately with truthful limitations.

This feature is complete only when capture routing, channel math, persistence, both scalar paths, both editor hosts, compact protocol safety, visible diagnostics, and lifecycle verification ship together.
