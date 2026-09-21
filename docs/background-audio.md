# Background capture-owner audio scheduling

## Cause and change

`src/app/runtime.js` previously scheduled `audioBroadcastLoop` exclusively with
`requestAnimationFrame`. That callback reads `AudioManager.getAnalysisFrame`,
updates `PatternAudioControlEngine`, and publishes controls/spectrum. It is not
just a visual refresh. Pausing the main tab's visual callbacks therefore stopped
fresh analysis and publication even with a running input AudioContext. The
visibility listener only maintains the singleton lease; it does not schedule
audio. The editor correctly subscribes to the owner's bus and does not capture.

The owner now uses one independent worker clock (`src/platform/audio-clock.js`)
with a 34 ms delay between completed ticks (approximately 30 Hz). The worker only
sends wakeups; FFT reads, control calculation and bus publication remain on the
owner's main thread, using the same AudioManager, stream and analysers. Each
wakeup requires acknowledgement before the next is scheduled: a busy thread
cannot build a backlog or replay old ticks. Capture timestamps, spectrum rate
limit, control delta clamp, consumer leases and visual rAF loops are unchanged.

Start/stop are idempotent. Ownership loss and runtime disposal terminate the
worker; ownership acquisition creates a fresh one. No visibility-driven second
loop, second microphone, audio-output connection or autoplay-policy workaround
is introduced. A worker construction/load failure falls back to a single regular
timer, whose background timing is less reliable.

## Limits

This decouples audio from visual rAF; it does **not** promise real-time delivery
under browser/OS freezing, discarding, sleep, a blocked main thread, or suspended
Web Audio. Worker timers are not an exemption from all browser resource policies.
A blocked worker (e.g. CSP) degrades to document timers, which may be throttled.
Existing gesture-based audio resume and missing/stale-control handling still
apply. Keep the capture tab open and its input running. Foregrounding cannot
replay audio missed during suspension; the next tick samples the current input.

## Verification

`tests/nodes-audio-background.spec.js` exercises the real owner, worker, Web Audio
analysers, control engine, BroadcastChannel, editor preview pixels and mapped
marker. A controllable oscillator replaces only the physical signal feeding the
existing capture splitter; it uses the same AudioContext and never connects to
speakers. Tests check silence/tone/silence, continued audio time and analysis while
all main visual rAF callbacks are held, resumed foreground rendering, unchanged
capture acquisition/context/stream, editor unsubscribe and owner teardown.
Additional browser tests check double-start/stop, restart, slow-main-thread
backpressure and the timer fallback.

The native-tab variant calls `bringToFront` and explicitly requires main
`visibilityState === 'hidden'` and editor `=== 'visible'`. In this environment,
headless Chromium leaves both tabs visible, so that variant is **skipped**, not
claimed as a hidden-tab pass. The deterministic rAF-paused integration runs
separately; it fails against the original runtime (preview stays at silent red
51) and passes with the independent clock. Native hidden-tab verification remains
a headed-browser follow-up (run with `--headed` on a display-equipped host).
Playwright's default background-throttling-disabling flags are removed for this
spec; no autoplay-bypass flag is used.

```sh
PLAYWRIGHT_PORT=5191 npx playwright test tests/nodes-audio-background.spec.js --workers=1
PLAYWRIGHT_PORT=5191 npx playwright test tests/nodes-audio-background.spec.js --headed --workers=1
```
