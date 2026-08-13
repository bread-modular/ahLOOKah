# ahLOOKah React + Vite SPA Refactor Plan

## 1. Purpose and scope

This document is the execution plan for moving ahLOOKah (the package is still named `viz2`) from imperative DOM assembly centered in `main.js` to a React + Vite single-page application.

The migration must preserve behavior, not redesign it:

- Plain JavaScript only: `.js` and `.jsx`; no TypeScript.
- React + Vite, with `@vitejs/plugin-react`.
- One SPA entry point and no `react-router`.
- `/?role=screen` remains the output window.
- `/?role=control` and `/` remain control windows.
- One control and one screen are allowed per browser profile.
- The screen remains authoritative for LIVE and CUE program state.
- Exactly one control owns microphone capture and the audio controller engine.
- The screen remains the only physical camera owner.
- BroadcastChannel message names/payload semantics and all existing `viz2_*` storage keys remain compatible.
- Existing p5 sketch factories and audio controllers remain behaviorally unchanged during this refactor.
- Existing Playwright selectors and the development-only `window.__viz` contract remain available.

Out of scope for this migration:

- No URL route hierarchy or router.
- No TypeScript conversion.
- No sketch visual redesign.
- No replacement of p5.
- No change from the compact `pattern-audio-controls` transport back to raw FFT-frame transport.
- No storage-key, BroadcastChannel-name, or protocol-version rename from `viz2` to `ahLOOKah`.
- No lazy-loading rollout in the first migration. The 58 sketches should remain eagerly registered until parity is proven; lazy chunks can be a later performance project.

## 2. Repository facts verified before planning

The plan was checked against the current repository, including every file requested in the task.

### 2.1 Current size and responsibilities

- `main.js`: 3,300 lines. It owns role selection, singleton enforcement, storage, screen program/CUE runtimes, control preview runtimes, BroadcastChannel dispatch, audio ownership, audio ticking, noise-floor orchestration, keyboard gestures, boot, teardown, and `window.__viz`.
- `config-panel.js`: 1,905 lines. It creates the complete control DOM, manages sliders, pattern pad/library drag-and-drop, CUE transport, post-FX, band EQ, noise controls, device setup, app menu, and key-map modal.
- `style.css`: 2,046 lines of global selectors whose IDs/classes are also test contracts.
- `sketch-registry.js`: 1,380 lines. It eagerly imports and describes 58 sketches across seven groups, plus global pseudo-parameter definitions and pad-order persistence.
- `program-runtime.js`: 832 lines. It handles p5 child construction, async canvas attachment, camera readiness, fresh-frame/compositor gates, pattern-audio slots, resizing, compositing, and teardown.
- `audio-manager.js`: 405 lines. It owns physical microphone capture, Web Audio graph setup, analysis buffers, status, reconnection behavior, and noise subtraction.
- Pattern audio is already separated into protocol, receiver store, and capture-side engine modules.
- `tests/` contains 14 Playwright specs covering the two-window model, CUE, singleton behavior, p5 rendering, audio, noise floor, EQ, post-FX, merge mode, device setup, and all-pattern smoke/transport behavior.

### 2.2 Existing build and HTML contracts

- Vite is already present.
- `vite.config.js` currently has both development and preview servers configured with:
  - `host: true`
  - `port: 3000`
  - `allowedHosts: ['devbox2.local']`
- Playwright intentionally uses port `5173`: its `webServer.command` runs `npm run dev -- --port 5173 --strictPort`, which overrides Vite's default `3000`. This is not an accidental mismatch and should remain documented.
- `index.html` contains a Content Security Policy and a camera/microphone Permissions Policy. The CSP currently allows the same-origin app, Vite WebSocket connections, blob media/workers, data/blob images, and inline/eval script/style behavior needed by the current development stack.
- The current HTML has no app root element and loads `/main.js`; the React migration must add `#root` and load `/src/main.jsx` without weakening or deleting either policy meta tag.

### 2.3 Important runtime contracts found in the code

- p5 2.x may create `instance.canvas` asynchronously. Both full-screen and preview paths retry canvas attachment with `requestAnimationFrame`.
- A CUE runtime is not ready merely because p5 constructed. Readiness requires canvas attachment, a completed draw, camera media readiness when applicable, and a compositor confirmation.
- CUE parameter revisions require a matching compact audio-controls packet to be read and drawn before READY/TAKE.
- LIVE and CUE camera consumers share one `MediaStream` through `SharedCameraSource`.
- Merge mode uses two independently running p5 canvases and DOM/GPU compositing, not `p5.image()` readback.
- WebGL contexts are explicitly lost before `p5.remove()` to avoid Chrome's active-context limit during rapid replacement.
- The physical microphone is owned through Web Locks (`viz2_audio_capture_owner`) with a localStorage lease fallback.
- All 58 registered sketches use the `pattern-controls` transport. Raw full analysis frames are not sent to renderers.
- Parameter objects read by running sketches are stable mutable references. Replacing those objects on an ordinary slider update would break live updates and CUE promotion semantics.

## 3. Architectural decisions

### 3.1 React owns declarative UI; services own long-lived browser resources

React will own:

- The control-panel DOM.
- The screen-stage DOM skeleton.
- Modal/menu/section visibility.
- Rendering current state snapshots into labels, buttons, badges, and sliders.
- Stable empty host elements into which p5 services attach canvases.

Plain JavaScript services will own:

- BroadcastChannel and protocol routing.
- Singleton and microphone-ownership leases.
- `MediaStream`, `AudioContext`, analyser nodes, Web Locks, timers, RAF loops, and `ResizeObserver` instances.
- `ProgramRuntime` and p5 instances.
- Canonical mutable parameter objects.
- Screen-authoritative LIVE/CUE transition logic.
- High-frequency spectrum and pattern-audio data.

This boundary avoids trying to represent p5 instances, streams, typed arrays, or animation frames as React state.

### 3.2 Use a per-window vanilla store

Use a per-window vanilla store rather than a single large React Context/reducer.

Add these runtime dependencies:

- `react`
- `react-dom`

Add this development dependency:

- `@vitejs/plugin-react`

The store is implemented in-house (`src/state/vanillaStore.js`) as a minimal `createStore` primitive with `getState`, `setState`, and `subscribe` semantics equivalent to `zustand/vanilla`. Create one store per booted window and bind React components through `useSyncExternalStore` (see `src/state/useVizStore.js`) for selective subscriptions. Provide that concrete store instance through a small React Context so tests/HMR never depend on an implicit module-global store.

Why a vanilla store fits this app:

- Protocol/services need to publish state from outside React event handlers.
- Components need narrow subscriptions; a single Context value containing the entire app would rerender the preview, library, EQ, and controls on every unrelated update.
- A vanilla store gives `getState`, `setState`, and `subscribe` to services and to the development debug bridge without coupling those services to React.
- The app has several independent state domains but does not need Redux-level ceremony.

What the store must **not** own:

- p5 instances or canvases.
- `MediaStream`, `AudioContext`, WebGL contexts, Web Locks, observers, timers, or RAF IDs.
- Raw FFT/waveform buffers or each 30 fps pattern-control packet.
- Mutable parameter objects handed to sketch factories.
- Persistence middleware. Existing repositories must continue writing the current exact localStorage schemas.

React Context is still used, but only to inject two stable objects: the per-window vanilla store and the composed application runtime/command API.

### 3.3 Keep one-way authority boundaries

- **Screen authority:** canonical LIVE selection, canonical visual parameter bank, CUE session/revision, stage runtime promotion, video-device activation.
- **Capture-owner control authority:** physical microphone, cleaned analysis frames, pattern controller engine, EQ spectrum production, noise-floor capture.
- **Each window:** its own pattern-control receiver store and active runtime/preview topology plan.
- **Vanilla store:** a renderable mirror of accepted authority, not an alternate protocol authority.
- **React component local state:** transient form/UI details such as an active range drag or menu focus.

Components invoke commands on the runtime. They do not post BroadcastChannel messages directly and do not mutate service fields.

### 3.4 Keep compatibility first, then remove adapters later

During the migration, retain tiny root-level re-export modules for old browser imports. Existing Playwright tests deep-import paths such as:

- `/program-runtime.js`
- `/shared-camera-source.js`
- `/noise-floor.js`
- `/pattern-audio-controls.js`
- `/pattern-audio-engine.js`
- `/sketch-registry.js`
- `/sketches/audio-features.js`
- `/sketches/circles.js`
- `/sketches/waveform_tunnel.js`

Moving implementation under `src/` without shims would break those tests before behavior is exercised. Keep the shims for at least the migration release. A later breaking cleanup may update test imports and remove them.

## 4. Target folder structure

```text
.
├── index.html
├── package.json
├── package-lock.json
├── vite.config.js
├── playwright.config.js
├── run.sh
├── tests/                              # Existing specs stay in place
├── docs/
│   ├── cue-mode-design.md
│   ├── pattern-audio-control-plan.md
│   └── react-refactor-plan.md
├── main.js                             # Temporary compatibility entry; then remove
├── program-runtime.js                  # Thin re-export shim
├── shared-camera-source.js             # Thin re-export shim
├── audio-manager.js                    # Thin re-export shim while external imports migrate
├── preview-audio.js                    # Thin re-export shim
├── noise-floor.js                      # Thin re-export shim
├── pattern-audio-controls.js           # Thin re-export shim
├── pattern-audio-engine.js             # Thin re-export shim
├── pattern-audio-protocol.js           # Thin re-export shim
├── sketch-registry.js                  # Thin re-export shim
├── sketches/                           # Thin per-file re-export shims during migration
└── src/
    ├── main.jsx
    ├── app/
    │   ├── App.jsx
    │   ├── RuntimeRoot.jsx
    │   ├── RuntimeContext.jsx
    │   ├── bootstrapWindow.js
    │   └── createAppRuntime.js
    ├── state/
    │   ├── createVizStore.js
    │   ├── VizStoreProvider.jsx
    │   ├── selectors.js
    │   └── slices/
    │       ├── sessionSlice.js
    │       ├── programSlice.js
    │       ├── audioSlice.js
    │       └── uiSlice.js
    ├── platform/
    │   ├── constants.js
    │   ├── resolveRole.js
    │   ├── windowIdentity.js
    │   ├── BroadcastBus.js
    │   ├── MessageRouter.js
    │   ├── SingletonCoordinator.js
    │   ├── WindowLifecycle.js
    │   ├── openRoleWindow.js
    │   └── debugBridge.js
    ├── protocol/
    │   ├── messageTypes.js
    │   ├── registerMessageHandlers.js
    │   └── validators/
    │       ├── common.js
    │       ├── stateMessages.js
    │       ├── cueMessages.js
    │       ├── parameterMessages.js
    │       └── deviceMessages.js
    ├── program/
    │   ├── ProgramRuntime.js
    │   ├── P5ChildRuntime.js
    │   ├── RuntimeReadiness.js
    │   ├── RuntimeAudioSlots.js
    │   ├── p5Lifecycle.js
    │   ├── canvasSizing.js
    │   ├── StageRuntimeManager.js
    │   ├── ProgramCoordinator.js
    │   ├── selection.js
    │   ├── postFx.js
    │   └── timing.js
    ├── cue/
    │   ├── CueAuthority.js
    │   ├── CueRuntimeGate.js
    │   ├── CueClient.js
    │   ├── cueBank.js
    │   └── cuePayload.js
    ├── params/
    │   ├── ParamRepository.js
    │   ├── ParamCommandBuffer.js
    │   ├── paramValidation.js
    │   └── paramStorage.js
    ├── preview/
    │   └── PreviewRuntime.js
    ├── audio/
    │   ├── capture/
    │   │   ├── AudioManager.js
    │   │   ├── audioGraph.js
    │   │   ├── AudioOwnershipService.js
    │   │   └── AudioLoop.js
    │   ├── preview/
    │   │   └── PreviewAudio.js
    │   ├── pattern/
    │   │   ├── PatternAudioControlStore.js
    │   │   ├── controlInterpolation.js
    │   │   ├── controlSlotState.js
    │   │   ├── PatternAudioControlEngine.js
    │   │   ├── PatternAudioPlanPublisher.js
    │   │   └── protocol.js
    │   └── noise/
    │       ├── index.js
    │       ├── noiseFloorStorage.js
    │       ├── noiseCapture.js
    │       ├── spectralSubtraction.js
    │       └── NoiseFloorCoordinator.js
    ├── media/
    │   ├── SharedCameraSource.js
    │   └── DeviceService.js
    ├── input/
    │   ├── KeyboardController.js
    │   └── mergeGesture.js
    ├── sketches/
    │   ├── registry/
    │   │   ├── index.js
    │   │   ├── sketchOrder.js
    │   │   ├── groups.js
    │   │   ├── globalParams.js
    │   │   ├── slotOrder.js
    │   │   └── entries/
    │   │       ├── rhythmic.js
    │   │       ├── threeD.js
    │   │       ├── cinematic.js
    │   │       ├── neonLasers.js
    │   │       ├── videoFx.js
    │   │       ├── glitch.js
    │   │       └── basics.js
    │   ├── lib/
    │   │   ├── audio-features.js
    │   │   ├── shader-utils.js
    │   │   └── viz-utils.js
    │   └── patterns/
    │       └── *.js                    # 58 existing factories, one file each
    ├── components/
    │   ├── common/
    │   │   ├── Button.jsx
    │   │   └── icons.jsx
    │   ├── errors/
    │   │   └── SingletonError.jsx
    │   ├── screen/
    │   │   ├── ScreenApp.jsx
    │   │   ├── Stage.jsx
    │   │   ├── ProgramLayer.jsx
    │   │   └── ScreenToolbar.jsx
    │   └── control/
    │       ├── ControlApp.jsx
    │       ├── ControlPanel.jsx
    │       ├── PreviewPane.jsx
    │       ├── PreviewStage.jsx
    │       ├── CueTransport.jsx
    │       ├── PatternPad.jsx
    │       ├── PatternLibrary.jsx
    │       ├── PatternButton.jsx
    │       ├── ControlsPane.jsx
    │       ├── ControlHeader.jsx
    │       ├── AppMenu.jsx
    │       ├── ScreenStatus.jsx
    │       ├── ParameterPanel.jsx
    │       ├── ParamSlider.jsx
    │       ├── BlendControls.jsx
    │       ├── PostFxPanel.jsx
    │       ├── BandEqPanel.jsx
    │       ├── BandEqCanvas.jsx
    │       ├── NoiseFloorControls.jsx
    │       ├── DeviceSetupModal.jsx
    │       └── KeyMapModal.jsx
    ├── hooks/
    │   ├── useP5Host.js
    │   ├── useBandEqCanvas.js
    │   ├── usePatternDragDrop.js
    │   └── useDocumentRole.js
    └── styles/
        ├── index.css
        ├── tokens.css
        ├── base.css
        ├── stage.css
        ├── control-layout.css
        ├── preview.css
        ├── transport.css
        ├── buttons.css
        ├── patterns.css
        ├── parameters.css
        ├── band-eq.css
        ├── status.css
        ├── screen-toolbar.css
        └── overlays.css
```

Guideline: orchestration and UI files should generally remain below roughly 250–400 lines. A self-contained sketch may remain longer where splitting shader source from its controller would reduce clarity. The former 832-line `ProgramRuntime` is explicitly split into child construction, readiness, audio slots, sizing, and lifecycle helpers rather than merely moved.

## 5. Current-to-target file mapping

### 5.1 Top-level files

| Current file | Target | Notes |
|---|---|---|
| `index.html` | `index.html` | Preserve both policy meta tags verbatim; add `<div id="root"></div>`; replace `/main.js` with `/src/main.jsx`; CSS is imported by `main.jsx`. |
| `main.js` | Multiple modules listed in §5.2 | Delete after the extracted runtime is active. A temporary `main.js` may import `/src/main.jsx` only while old bookmarks/tools are migrated. |
| `config-panel.js` | React control components and hooks listed in §5.3 | No imperative `ConfigPanel` class in the target. Delete after parity. |
| `program-runtime.js` | `src/program/ProgramRuntime.js` plus its helper modules | Root file becomes a re-export shim preserving `ProgramRuntime`, `disposeP5Instance`, `loseP5WebGLContext`, `selectionsEqual`, and `copyProgramSelection`. |
| `sketch-registry.js` | `src/sketches/registry/**` | Root file re-exports the current public names. Preserve canonical order and all reserved IDs. |
| `audio-manager.js` | `src/audio/capture/AudioManager.js` + `audioGraph.js` | Preserve public class behavior; root re-export during migration. |
| `config-panel.js` EQ drawing helpers | `src/hooks/useBandEqCanvas.js` and pure draw/math helpers colocated with `BandEqCanvas.jsx` | Spectrum remains outside React state. |
| `noise-floor.js` | `src/audio/noise/**` | `src/audio/noise/index.js` preserves the current function exports; root re-export remains. |
| `shared-camera-source.js` | `src/media/SharedCameraSource.js` | Root re-export remains for direct tests. |
| `preview-audio.js` | `src/audio/preview/PreviewAudio.js` | Preserve compatibility facade and idle-signal behavior. |
| `pattern-audio-controls.js` | `src/audio/pattern/PatternAudioControlStore.js`, `controlInterpolation.js`, `controlSlotState.js` | Root re-export preserves both store and binding exports. |
| `pattern-audio-engine.js` | `src/audio/pattern/PatternAudioControlEngine.js` | Root re-export preserves engine and `SharedAudioAnalysisView`. |
| `pattern-audio-protocol.js` | `src/audio/pattern/protocol.js` | Keep protocol version, limits, message types, validation, and public exports unchanged. |
| `ui.js` | `src/components/common/Button.jsx` and `icons.jsx` | JSX escapes text by default. Remove HTML-string `button()` and `escapeHtml()` once no legacy caller remains. |
| `style.css` | `src/styles/**` | First import it unchanged as `src/styles/legacy.css`; only split after DOM parity. Preserve selector text and cascade order when splitting. |
| `vite.config.js` | `vite.config.js` | Add React plugin only; preserve server/preview host, port, and allowed host settings. |
| `playwright.config.js` | `playwright.config.js` | Keep base URL/explicit test server at `5173`; document that CLI port overrides Vite's default `3000`. |
| `package.json` / lock | Same paths | Add React, React DOM, and React Vite plugin; preserve existing scripts. |
| `run.sh` | Same path | No architecture change; it continues to build and run Vite preview on `PORT` (default `3000`). |
| `.gitignore` | Same path | Existing `node_modules`, `dist`, and Playwright output ignores remain valid. |
| `workspace_init.sh` | Same path | No product-code change required. |
| Existing docs | Same paths | Keep the CUE and pattern-audio documents as behavioral references. |

All 14 files under `tests/` stay at their current paths. They are regression specifications, not files to fold into `src/`.

### 5.2 Exact split of `main.js`

| Current responsibility | Target module |
|---|---|
| Role parsing and window identity | `platform/resolveRole.js`, `platform/windowIdentity.js` |
| Singleton lease/handshake/error gate | `platform/SingletonCoordinator.js`, `components/errors/SingletonError.jsx`, `app/bootstrapWindow.js` |
| Global listeners/timers/pagehide/HMR teardown | `platform/WindowLifecycle.js` |
| Broadcast local echo and channel lifecycle | `platform/BroadcastBus.js` |
| Message switch and validation | `platform/MessageRouter.js`, `protocol/registerMessageHandlers.js`, `protocol/validators/**` |
| Storage constants | `platform/constants.js` |
| Parameter sanitization/load/save/live proxy/adoption | `params/ParamRepository.js`, `paramValidation.js`, `paramStorage.js` |
| Selection helpers and legacy index projection | `program/selection.js`, `ProgramCoordinator.js` |
| Screen layer registration/resizing/runtime promotion | `program/StageRuntimeManager.js` |
| Blend and post-FX application | `ProgramRuntime.js`, `program/postFx.js` |
| Preview p5 creation/compositing/resize/audio slots | `preview/PreviewRuntime.js` |
| Pattern-audio topology plans and heartbeat | `audio/pattern/PatternAudioPlanPublisher.js` |
| Screen CUE authority and warm/promotion state machine | `cue/CueAuthority.js`, `cue/CueRuntimeGate.js`, `cueBank.js`, `cuePayload.js` |
| Control CUE mutation queue, TAKE intent, acknowledgements | `cue/CueClient.js` |
| Audio device lifecycle | `audio/capture/AudioManager.js`, `media/DeviceService.js` |
| Audio Web Lock/local lease ownership | `audio/capture/AudioOwnershipService.js` |
| 30 fps control tick, 15 fps EQ spectrum, noise progress | `audio/capture/AudioLoop.js`, `audio/noise/NoiseFloorCoordinator.js` |
| Keyboard LIVE/CUE/merge gestures | `input/KeyboardController.js`, `input/mergeGesture.js` |
| Open control/screen windows | `platform/openRoleWindow.js` |
| Screen toolbar DOM | `components/screen/ScreenToolbar.jsx` |
| Control-panel creation/synchronization | vanilla store state + `components/control/**` |
| Early and full `window.__viz` diagnostics | `platform/debugBridge.js` |
| Boot/composition | `app/bootstrapWindow.js`, `app/createAppRuntime.js`, `app/RuntimeRoot.jsx`, `src/main.jsx` |

`createAppRuntime.js` is only the composition root: instantiate services, inject dependencies, register message handlers, and expose a small `start()`, `dispose()`, and `commands` API. Domain logic must stay in the domain modules rather than accumulating in this file.

### 5.3 Exact split of `config-panel.js`

| Current `ConfigPanel` responsibility | Target |
|---|---|
| Overall three-column markup | `ControlPanel.jsx`, `PreviewPane.jsx`, `PatternLibrary.jsx`, `ControlsPane.jsx` |
| App menu | `AppMenu.jsx` |
| LIVE/CUE preview labels and overlay actions | `PreviewPane.jsx`, `CueTransport.jsx` |
| p5 preview host | `PreviewStage.jsx`, `PreviewRuntime.js`, `useP5Host.js` |
| Pattern pad | `PatternPad.jsx`, `PatternButton.jsx` |
| Grouped library | `PatternLibrary.jsx`, registry group selectors |
| HTML5 drag-and-drop | `usePatternDragDrop.js` |
| Parameter rows and value formatting | `ParameterPanel.jsx`, `ParamSlider.jsx` |
| Blend/Additive controls | `BlendControls.jsx` |
| RAF-coalesced parameter sends | `ParamCommandBuffer.js` |
| Post-processing section | `PostFxPanel.jsx` |
| Band EQ section and canvas | `BandEqPanel.jsx`, `BandEqCanvas.jsx`, `useBandEqCanvas.js` |
| Noise status/actions | `NoiseFloorControls.jsx`, `NoiseFloorCoordinator.js` |
| Screen status and Open Screen action | `ScreenStatus.jsx` |
| Device enumeration/permission/selection | `DeviceService.js`, `DeviceSetupModal.jsx` |
| Key map modal | `KeyMapModal.jsx` |
| Section-open persistence | Small hooks inside `PostFxPanel`/`BandEqPanel`, still using current keys |
| DOM listener teardown | React effects plus runtime `dispose()` |

### 5.4 Sketch files and registry

Move files without renaming their factory filenames:

- `sketches/audio-features.js` → `src/sketches/lib/audio-features.js`
- `sketches/shader-utils.js` → `src/sketches/lib/shader-utils.js`
- `sketches/viz-utils.js` → `src/sketches/lib/viz-utils.js`
- Every other `sketches/<name>.js` → `src/sketches/patterns/<name>.js`

Leave a tiny matching file at each old `/sketches/<name>.js` path that re-exports both the default factory and named exports. This keeps current browser tests and any external controller tooling compatible.

Split registry descriptors by group, but do **not** concatenate the groups to form canonical order. Instead, each group module exports descriptors keyed by ID and `sketchOrder.js` assembles them in the exact current declaration order:

```text
circles, circles-ch1, bars, techno3d, character3d,
neon-spectrum, pulse-rings, particle-storm, waveform-tunnel,
chroma-mandala, starfield-rush, echo-ripples, laser-grid,
strobe-pulse, plasma-waves, vortex-spiral, glitch-matrix,
orbital-rings, shockwave-beats, neon-ribbons, prism-burst,
cosmic-web, event-horizon, liquid-chrome, laser-cathedral,
cymatic-bloom, holo-swarm, aurora-veil, mandelbulb-drift,
storm-surge, ink-dispersion, infinity-mirror, ion-tempest,
crystal-reliquary, neural-cascade, aurora-reactor, warp-loom,
fractal-nebula, aurora-storm, wormhole-transit, crystal-cavern,
neon-metropolis, solid-color, gradient-wash, color-bars,
noise-static, film-grain, checkerboard, video-chroma,
video-kaleido, video-pixelate, video-trails, glitch-rgb-split,
glitch-scanlines, glitch-slices, glitch-crt, video-dots-gpu,
video-high-contrast
```

That exact ordering preserves the default 1–0 pad and every positional legacy message.

Registry submodule ownership:

- `entries/*.js`: sketch imports and descriptors (`id`, name, factory, params, group, camera flag, controller, schema, transport).
- `sketchOrder.js`: exact 58-ID canonical order above.
- `groups.js`: `GROUP_ORDER`, `getGroups`, and `getSketchesByGroup`.
- `globalParams.js`: `BLEND_ID`, `BANDS_ID`, `POSTFX_ID`, definitions, defaults, and `defaultParamValues`.
- `slotOrder.js`: `SHORTCUT_COUNT`, `SLOT_ORDER_KEY`, `EFFECT_ORDER_KEY`, legacy migration, load/save, and `indexFromKey`.
- `index.js`: public `SKETCHES` assembly and re-exports.

## 6. React component tree

```text
main.jsx
└── Runtime provider (one store + one runtime for this window)
    └── App
        ├── ScreenApp                         [role === "screen"]
        │   ├── Stage                         #screen-wrap
        │   │   ├── ProgramLayer A            stable empty p5 host
        │   │   └── ProgramLayer B            stable empty p5 host
        │   └── ScreenToolbar                 #screen-toolbar
        │       └── Button                    #open-control-btn
        └── ControlApp                        [role === "control"]
            ├── ControlPanel                  #config-container > #config-panel
            │   ├── PreviewPane               #preview-pane
            │   │   ├── Preview section
            │   │   │   ├── heading           #preview-title, #preview-renderer
            │   │   │   ├── preview surface
            │   │   │   │   ├── PreviewStage #preview-stage
            │   │   │   │   │   ├── stable nested p5 host
            │   │   │   │   │   └── optional .preview-empty React overlay
            │   │   │   │   └── CueTransport #cue-preview-controls
            │   │   │   │       ├── phase     #cue-preview-phase
            │   │   │   │       ├── action    #cue-primary
            │   │   │   │       └── cancel    #cue-cancel
            │   │   │   └── live region       #cue-live-region
            │   │   └── PatternPad             #pattern-pad
            │   ├── PatternLibrary             #library-pane > #pattern-library
            │   └── ControlsPane               #controls-pane
            │       ├── ControlHeader
            │       │   ├── title
            │       │   ├── ScreenStatus       #status-line
            │       │   └── AppMenu            #app-menu-btn, #app-menu-list
            │       ├── ParameterPanel         #params-list
            │       │   ├── ParamSlider(s)
            │       │   └── BlendControls      when selection.merge
            │       ├── PostFxPanel            #post-fx > #post-fx-list
            │       └── BandEqPanel            #band-eq
            │           ├── BandEqCanvas       #band-eq-canvas
            │           ├── legend             [data-eq-range]
            │           └── NoiseFloorControls #noise-*
            ├── DeviceSetupModal               portal to body
            └── KeyMapModal                    portal to body
```

`SingletonError` is a separate blocked-root render. It is mounted only after the pre-React singleton check says the role is already owned. No app runtime, p5 instance, audio manager, preview, or control panel is started for a blocked page.

## 7. Store shape and command flow

### 7.1 Vanilla store state slices

The exact implementation may flatten keys internally, but the conceptual state is:

```text
session
  role: "screen" | "control"
  windowId
  tabId
  bootStatus: "checking" | "ready" | "blocked"
  singletonBlocked
  screenOnline

program
  liveSelection: { ids, merge }
  cue: null | accepted cue payload
  editingScope: "live" | "cue"
  editingSelection
  padOrder: [10 stable sketch ids]
  liveParamSnapshot: immutable accepted bank for UI
  bandSnapshot
  paramRevision: monotonically increasing UI invalidation number
  cueTimings: lightweight diagnostics only when needed

audio
  isOwner
  status
  audioDeviceId
  videoDeviceId
  devices
  eqSplit
  noiseState
  noiseMeta

ui
  appMenuOpen
  setupModalOpen
  keyMapOpen
  postFxOpen
  bandEqOpen
  transportNotice
```

Do not place `eqSpectrum` in the store. `AudioLoop`/message handlers deliver the latest spectrum to an imperative EQ sink. `useBandEqCanvas` stores the packet in a ref and schedules one draw; React is not rerendered at ~15 fps.

### 7.2 Runtime command API

Components call a narrow command surface provided by `RuntimeContext`, for example:

```text
program.select(selection)
program.stageCue(selection)
cue.take()
cue.cancel()
params.change(id, values)
pad.reorder(ids)
devices.selectAudio(id)
devices.selectVideo(id)
noise.start(seconds)
noise.cancel()
noise.clear()
windows.openScreen()
windows.openControl()
```

The command layer decides whether an action is LIVE, CUE-scoped, screen-authoritative, capture-owner-only, or local UI. JSX never imports `BroadcastBus` directly.

### 7.3 Parameter state rules

`ParamRepository` keeps the current mutable-reference behavior:

- `getLiveParams(id)` creates defaults once and returns the same object thereafter.
- Accepted LIVE changes mutate that object in place.
- The screen owns canonical persistence and broadcasts accepted snapshots.
- A CUE session owns a separate plain-object bank.
- On TAKE, the promoted runtime's exact CUE objects become the canonical LIVE bank; do not clone them during the role swap.
- `__bands` remains system-scoped and is not copied into a visual CUE bank.
- `__merge` and `__postfx` are visual values and can be CUE-scoped.
- The DEV read-proxy behavior remains in `ParamRepository` so `window.__viz.readLog()` keeps proving per-frame sketch reads.

`ParamSlider` keeps a local draft while dragging and sends values through `ParamCommandBuffer`, which coalesces to one request per animation frame. Accepted external values update the same DOM input when it is not actively dragging. Use a stable React key based on `scope + selectedId + paramKey`; an acknowledgement must not replace the range node. This preserves the existing test that tags a slider DOM node during a drag.

## 8. p5 integration without React/render-loop conflicts

### 8.1 Stable host rule

React renders stable host elements; p5 exclusively owns the descendants of the innermost host.

- `Stage` renders `#screen-wrap` and two empty layer elements once.
- `StageRuntimeManager` receives those refs and may attach/remove canvases inside them.
- `PreviewStage` renders `#preview-stage`, containing a dedicated empty `.preview-canvas-host`. `PreviewRuntime` mutates only that nested host.
- React may render `.preview-empty` or a camera note as a sibling of the nested host, so it never reconciles p5-owned children.

`useP5Host` should only register/unregister a DOM host with a long-lived runtime. It must not use a dependency list containing selections or parameter objects to construct p5 on every React rerender.

### 8.2 Runtime ownership

- `StageRuntimeManager` owns LIVE, CUE, incoming, and retiring `ProgramRuntime` references.
- `PreviewRuntime` owns control-preview p5 instances and preview pattern-audio slot descriptors.
- React stores no p5 references.
- Selection changes are explicit service commands. Parameter changes mutate existing references and generally do not recreate p5.
- CUE parameter revisions request a fresh frame from the existing runtime; they do not rebuild it.

### 8.3 Preserve `ProgramRuntime` behavior while splitting it

- `P5ChildRuntime.js`: wraps factory setup/draw, installs viewport sizing, creates the p5 instance with its parent at construction time, attaches/tag canvases, handles camera callbacks, and exposes pause/resume/resize/dispose.
- `RuntimeReadiness.js`: ready promise, timeout, attachment/draw/media checks, double-RAF compositor confirmation, serialized/rebased fresh-frame requests.
- `RuntimeAudioSlots.js`: descriptors, params revision/fingerprint, bindings, draw markers, event delivery enable/disable, retirement.
- `canvasSizing.js`: viewport and intentional shader render-scale rules.
- `p5Lifecycle.js`: `WEBGL_lose_context`, `noLoop`, and async-safe `remove` behavior.
- `ProgramRuntime.js`: small public facade composing the helpers and preserving its current external API.

### 8.4 Required p5 invariants

- Continue passing the parent host to `new p5(factory, host)` to prevent a default canvas flashing in `<body>`.
- Continue retrying until `instance.canvas` exists; p5 2.x creation is asynchronous.
- Keep `.p5Canvas`, `.program-canvas`, `.merge-canvas`, `data-program-layer`, and `data-preview-sketch` contracts.
- Resize through `p5.resizeCanvas()`/`windowResized()`, never by assigning DOM `canvas.width`/`height` from React.
- Preserve intentional reduced shader backing stores.
- Merge stays as stacked DOM canvases with `opacity` and `mix-blend-mode: screen`; do not draw one canvas into another.
- Explicitly lose WebGL contexts before removal.
- Cancel attachment RAFs, readiness RAFs/timeouts, and observers during disposal.

### 8.5 React development behavior

Do not wrap the initial root in `React.StrictMode`. Development double-invocation of effects can transiently create duplicate p5 instances, media streams, observers, or ownership tasks. Services should still be made idempotent and fully disposable; StrictMode can be enabled in a later hardening task after tests prove double-mount safety.

## 9. Two-window SPA and BroadcastChannel design

### 9.1 Boot sequence

`src/main.jsx` performs this sequence:

1. Import `styles/index.css`.
2. Parse role from `window.location.search`; only `role=screen` selects screen, everything else defaults to control.
3. Create/reuse the current `viz2_tab_id` in sessionStorage and create a new window ID/boot time.
4. Create one `BroadcastBus` on `viz2_channel` and install the early minimal `window.__viz` stub.
5. Run `SingletonCoordinator.claim(role)` before mounting the app or creating audio/p5 resources.
6. If blocked, set `body.singleton-blocked` and mount only `SingletonError` with the existing IDs/text/actions.
7. If allowed, begin the singleton heartbeat, create the per-window store and app runtime, then mount React.
8. Stable screen/preview hosts register in layout effects.
9. `RuntimeRoot` starts services after hosts exist, publishes the topology heartbeat, and sends `hello`.
10. On pagehide/unload/HMR, dispose services, release locks/leases, stop media, remove p5, close the channel, and clear the singleton lease if still owned.

### 9.2 Broadcast transport

`BroadcastBus.send(message)` must retain current semantics:

- Add `windowId`.
- Post to `BroadcastChannel`.
- Dispatch the same complete message locally because BroadcastChannel does not echo to its sender.
- Preserve local dispatch order relative to the post.

`MessageRouter` is a type-to-handler registry rather than another giant switch. Domain services register handlers through `registerMessageHandlers.js`.

Preserve these message types and payload behavior:

```text
singleton-claim, singleton-alive, hello,
state, pattern, pattern-id, merge,
cue-enter, cue-cancel-entry, cue-selection, cue-params,
cue-take, cue-cancel, cue-state,
devices, params, live-params, reorder,
audio-status, spectrum, noise-capture, noise-floor,
pattern-audio-plan-request, pattern-audio-plan,
pattern-audio-controls, screen-closed
```

Validation remains at the boundary before services or the vanilla store are mutated. Keep current limits on string lengths, IDs, array sizes, numeric finiteness, revisions, known sketch IDs, and parameter counts.

### 9.3 State handshake

- Each allowed window sends `hello` only after its runtime can answer.
- A screen receiving `hello` sends canonical `state`.
- A control marks `screenOnline` only from an accepted screen announcement/state.
- `state` and `cue-state` carry the screen-authored LIVE selection, canonical visual bank, band split, CUE payload, and audio status metadata as they do now.
- `screen-closed` immediately clears control CUE state because the warmed candidate no longer exists safely.
- A reloaded same tab can reclaim its singleton lease through the unchanged sessionStorage tab ID.

## 10. Preserving tricky feature pipelines

### 10.1 LIVE, merge, and CUE

`ProgramCoordinator` handles direct LIVE requests. `CueAuthority` handles only screen-side CUE transactions; `CueClient` handles only control-side request serialization.

Direct selection flow:

1. Control emits existing positional `pattern`/`merge` messages where possible, or `pattern-id` for library-only sketches.
2. Screen resolves stable IDs and prepares an incoming runtime in the hidden layer.
3. After fresh-frame readiness, `StageRuntimeManager` swaps LIVE/layer roles in one animation frame.
4. Old LIVE remains visible until the promoted runtime is visible, then retires on the next frame.
5. Screen broadcasts canonical state.

CUE flow:

1. Shift-selection sends one atomic `cue-enter` with a stable-ID selection.
2. Screen clones the visual parameter bank, creates a session/revision, and warms only if the candidate differs from LIVE in selection or visual values.
3. Parameter-only revisions mutate the same CUE objects and require a revision-bound fresh controls/draw/compositor frame.
4. `CueClient` serializes selection/param requests against accepted revisions and keeps the latest slider value queued.
5. TAKE immediately locks edits in the initiating control but leaves CANCEL enabled.
6. Screen promotes only the runtime matching the session, selection generation, and pending revision.
7. TAKE adopts the promoted CUE object bank by reference and broadcasts committed values before controls return to LIVE editing.
8. CANCEL disposes only the candidate and never changes LIVE or persisted visual values.

Preserve the latched keyboard merge gesture, the separate Shift+CUE held-key list, `+`/`-` level changes, Tab blend mode, Enter TAKE, Escape CANCEL, text-input guards, and blur cleanup.

### 10.2 Pattern-specific audio

Keep the current controls-only topology:

- Every active screen runtime child and non-camera preview child publishes one slot descriptor.
- `PatternAudioPlanPublisher` computes topology fingerprints, increments plan revisions only for topology changes, increments per-slot parameter revisions for accepted parameter changes, writes its own local plan, broadcasts public descriptors, and sends a one-second lease heartbeat.
- The microphone-owning control's `PatternAudioControlEngine` holds independent controllers by consumer/runtime ID.
- One cleaned analysis frame per ~30 fps tick is shared lazily across controllers.
- Controls packets are compact, schema-validated, ordered, and scoped to consumer/plan/stream/params revisions.
- Receiver stores interpolate continuous values, discard stale/suppressed one-shot events, and decay stale controls to neutral.
- A parked CUE continues receiving continuous controls but cannot bank events.
- No `analysis-frame` message or raw diagnostic fields are reintroduced.

High-frequency engine/store state remains in services. The vanilla store receives only operator-facing status and low-frequency diagnostics when requested.

### 10.3 Audio ownership and recovery

`AudioOwnershipService` preserves:

- Web Lock name `viz2_audio_capture_owner`.
- Fallback lease key `viz2_audio_capture_lease` and current lease timing.
- One physical microphone graph in one control.
- Automatic takeover after the owner closes.
- Selected-device fallback and reconnect behavior.
- Trusted pointer/key gestures resuming suspended Web Audio.
- Local spectrum delivery to the owning control as well as peer delivery through local echo.

`AudioManager` preserves analyser FFT size, light smoothing, stereo split/mono mirror, float and byte buffers, token-based stale-start cancellation, status payloads, and noise subtraction before consumers see a frame.

### 10.4 Noise floor and band EQ

- Keep profile key `viz2_noise_floor` and schema version.
- Only the capture-owning control samples raw frames.
- Sample before subtraction; apply subtraction before features/EQ.
- Broadcast lifecycle/progress, not the full profile; peers reload the shared localStorage profile.
- Keep device/sample-rate/FFT compatibility checks and Hz-domain resampling.
- Keep EQ constants, log-frequency mapping, drag limits, legends, stale overlay messages, HiDPI canvas sizing, and dashed noise curve.
- Keep band values under `__bands` in `viz2_params`; they remain globally editable during CUE.

### 10.5 Camera and devices

- `SharedCameraSource` remains screen-only and shares one stream per selected device between LIVE and CUE consumers.
- Each p5 consumer still gets its own hidden video element backed by the shared stream.
- Control previews never open a camera. They show the current `.preview-empty`/camera note behavior and publish no preview audio slot for an unrendered camera pattern.
- Video changes remain disabled and rejected while CUE is active.
- A video change reparses/reprepares LIVE only if its selection uses a camera.
- Audio selection is enacted only by the capture-owning control.
- Device choices and first-run completion continue using `viz2_audio_device_id`, `viz2_video_device_id`, and `viz2_device_setup_done`.

### 10.6 Sketch loading and pad order

- Keep all descriptors eager in the first React release.
- Preserve all factory signatures: `(audio, videoDeviceId, params, runtimeContext) => p5Sketch`.
- Preserve `runtimeContext.audioControls`, `audioSlot`, `createCapture`, `reportMediaReady`, and `addCleanup`.
- Preserve the exact ten-slot order migration from `viz2_effect_order` to `viz2_slot_order`.
- Reorder messages remain stable-ID arrays. LIVE and merged selections are remapped by ID after positional slot changes.

## 11. HTML, CSS, and Vite plan

### 11.1 `index.html`

Keep the existing CSP content and Permissions Policy exactly. The only structural changes are:

- Add `<div id="root"></div>` inside `<body>`.
- Change the module script to `/src/main.jsx`.
- Remove the standalone `./style.css` link after `main.jsx` imports `src/styles/index.css`.

Do not add inline boot scripts. This keeps policy review simple and gives Vite one module graph.

### 11.2 Vite

Use `defineConfig` with the React plugin. Preserve:

```text
server.host = true
server.port = 3000
server.allowedHosts = ['devbox2.local']
preview.host = true
preview.port = 3000
preview.allowedHosts = ['devbox2.local']
```

Playwright remains on `5173` because its command-line `--port 5173 --strictPort` intentionally overrides the config. `run.sh`/normal development continue to use `3000` unless overridden.

### 11.3 CSS migration

Do not combine the React conversion with an early selector rewrite.

1. Move `style.css` verbatim to `src/styles/legacy.css` and import it. Establish DOM/test parity first.
2. Split it in the same cascade order into the files shown in §4.
3. `styles/index.css` imports them in original section order.
4. Keep global selectors; do not adopt CSS Modules in this migration because IDs/classes are external test and integration contracts.
5. Verify computed style assertions after every split, particularly grid columns, overflow, active/merge/CUE classes, range thumbs, hidden modals, and screen toolbar hover opacity.

## 12. Playwright and compatibility contract

### 12.1 Preserve URLs and body classes

- `/` → control.
- `/?role=control` → control.
- `/?role=screen` → screen.
- `body.is-control`, `body.is-screen`, and `body.singleton-blocked` remain exact.

### 12.2 Preserve core IDs/classes/data attributes

React should emit the existing hooks rather than replacing them with test IDs. Additive `data-testid` values are allowed but unnecessary.

Screen/runtime contracts:

- `#screen-wrap`, `#screen-toolbar`, `#open-control-btn`.
- `.program-layer`, `.program-layer-live`, `.program-layer-cue`.
- `[data-program-role="live"]`, `[data-program-role="cue"]`.
- `data-program-ids`, `data-program-merge`, `data-program-layer`.
- `.p5Canvas`, `.program-canvas`, `.merge-canvas`.

Control layout contracts:

- `#config-container`, `#config-panel`.
- `#preview-pane`, `#library-pane`, `#controls-pane`.
- `#preview-stage`, `#preview-title`, `#preview-renderer`.
- `#pattern-pad`, `#pattern-library`.
- `.pattern-btn`, `.slot-btn`, `.library-btn`, `.pattern-key`, `.pattern-name`.
- `data-index`, `data-id`, `data-preview-sketch`.
- Active classes: `active`, `merge-active`, `live-active`, `live-merge-active`, `cue-active`, `cue-merge-active`, `live-cue-active`.

CUE/parameter contracts:

- `#cue-preview-controls`, `#cue-preview-phase`, `#cue-primary`, `#cue-cancel`, `#cue-live-region`.
- `#params-list`, `#params-heading`, `.param-row`, `.param-value`, `input[data-key]`.
- `.blend-header`, `.blend-names`, `.blend-mode-btn[data-mode]`.
- `#post-fx`, `#post-fx-list`, `#post-fx-reset-btn`.

EQ/noise contracts:

- `#band-eq`, `#band-eq-canvas`, `#band-eq-idle`.
- `[data-eq-range="bass"]`, `mid`, and `high`.
- `#noise-status`, `#noise-capture-btn`, `#noise-clear-btn`.

Header/modal/singleton contracts:

- `#status-line`, `.badge-online`, `.badge-offline`, `.viz-pill`, `#open-screen-btn`.
- `#app-menu-btn`, `#app-menu-list`, `#app-menu-docs`, `#app-menu-keymap`, `#app-menu-setup`.
- All existing `#device-setup-modal-*` IDs.
- `#key-map-modal`, `#key-map-modal-title`, `#key-map-modal-close`.
- `#singleton-error`, `#singleton-reload-btn`, `#singleton-close-btn`.

Preserve real semantic elements where tests rely on them: `<details open>`, `<summary>`, `<input type="range">`, `<select>`, `hidden`, disabled state, and dialog/ARIA attributes.

### 12.3 Preserve `window.__viz`

`debugBridge.js` must install an early safe stub and, in development, the full getter-based facade. Preserve at least this shape:

```text
role
singletonBlocked
singletonError
pattern
patternId
merge
screenOnline
params
cue
cueParams
cueRuntime
runtimeCounts { live, cue, incoming, retiring, total, camera }
cueTimings
blend
audioFeatures
bands
postfx
eq { split, drawn, spectrumAt, lastSpectrum }
noise { capturing, capture, profile, sampleDb }
audio
captureAudio
audioOwner
audioStatus
audioDeviceId
patternAudio { planRevision, store, engine }
readLog()
```

The facade should read live service/store state through getters rather than copying a stale snapshot. In particular, `audio` and `captureAudio` must return the live mutable service references—not frozen or cloned facades—because existing tests instrument fields and methods such as `isStarted` and `getAnalysisFrame`. Blocked pages still expose enough of `__viz` for waits to resolve without throwing.

### 12.4 Preserve storage and channel names

Treat these as compatibility API:

```text
viz2_channel
viz2_tab_id
viz2_singleton_control
viz2_singleton_screen
viz2_audio_capture_owner
viz2_audio_capture_lease
viz2_audio_device_id
viz2_video_device_id
viz2_params
viz2_slot_order
viz2_effect_order
viz2_noise_floor
viz2_device_setup_done
viz2_band_eq_open
viz2_post_fx_open
```

### 12.5 Test-import compatibility

Keep root re-export shims while existing tests import absolute old paths. Each shim should contain exports only and no boot side effects. Do not make importing `ProgramRuntime` or `noise-floor` initialize React, singleton leases, media, or the channel.

## 13. Ordered implementation checklist

### Phase 0 — Establish a parity baseline

1. Record a clean `npm run build` and full `npm test` result before refactoring.
2. Save a generated inventory of test selectors, `window.__viz` accesses, storage keys, BroadcastChannel message names, and absolute test imports.
3. Confirm the 58-sketch count, seven groups, and exact canonical/default pad order.
4. Treat `docs/cue-mode-design.md` and `docs/pattern-audio-control-plan.md` as behavioral specifications.

**Gate:** no migration starts from an unexplained failing baseline.

### Phase 1 — Add the React/Vite shell without changing behavior

1. Add React, React DOM, and `@vitejs/plugin-react`; update the lockfile.
2. Add the React Vite plugin while preserving server/preview settings.
3. Add `#root`, switch to `/src/main.jsx`, and preserve CSP/Permissions Policy verbatim.
4. Import the old stylesheet verbatim as `src/styles/legacy.css`.
5. Add `App`, store provider, runtime context, and role-based `ScreenApp`/`ControlApp` shells.
6. Do not use React StrictMode initially.

**Gate:** Vite dev/preview and CSP/HMR still work on normal port `3000`; Playwright still boots its explicit `5173` server.

### Phase 2 — Extract platform bootstrap before mounting React

1. Move role/identity constants and singleton logic into `platform/**`.
2. Implement `BroadcastBus` local echo and one-channel lifecycle.
3. Install the early debug stub before the asynchronous singleton wait.
4. Render only `SingletonError` when blocked.
5. Centralize unload/pagehide/HMR disposal.
6. Run `singleton.spec.js` and root/control/screen opening tests.

**Gate:** duplicate roles create no p5 canvas, control panel, audio ownership, or toolbar; reload of the same tab reclaims the lease.

### Phase 3 — Move pure/domain modules with compatibility shims

1. Split and move the registry, preserving all public exports and exact order.
2. Move all sketches/helpers and add root `/sketches/*` re-export shims.
3. Split parameter storage/validation/repository from `main.js`.
4. Split `ProgramRuntime` into the modules in §8.3 while preserving its public API.
5. Move pattern-audio, audio, noise, preview-audio, and camera modules; add root re-export shims.
6. Keep module imports side-effect-free.
7. Run direct-import Playwright tests (`audio-features`, `band-eq`, `noise-floor`, CUE runtime tests, pattern-audio controls) after each move.

**Gate:** all old absolute imports still resolve and no import boots the application.

### Phase 4 — Extract application services from `main.js`

1. Implement `ParamRepository` and its DEV read-log bridge.
2. Implement `StageRuntimeManager` and `ProgramCoordinator` against registered DOM hosts.
3. Implement `CueAuthority`, `CueRuntimeGate`, and `CueClient` with current revision semantics.
4. Implement `PreviewRuntime` with a registered nested host.
5. Implement `PatternAudioPlanPublisher`.
6. Implement audio ownership, audio loop, noise coordinator, and device service.
7. Implement keyboard/merge gesture controller.
8. Replace the message switch with validated router registrations.
9. Compose services in `createAppRuntime.js`; no domain logic should move into the composition root.
10. Wire accepted snapshots into the per-window vanilla store.

**Gate:** service-level behavior passes existing tests before the old `main.js` logic is removed.

### Phase 5 — Migrate the screen DOM to React

1. Render stable `#screen-wrap` and two program layer hosts.
2. Register hosts in layout effects before starting initial LIVE.
3. Render the screen toolbar and open-control action.
4. Keep manager-owned canvas descendants and role/data attributes outside React reconciliation.
5. Verify initial canvas, resize, shader render scale, merge, post-FX, CUE warm/swap, camera sharing, and WebGL teardown.

**Gate:** `render-regressions`, `merge-mode`, `post-processing`, and screen portions of `cue-mode` pass unchanged.

### Phase 6 — Migrate the control panel to React

1. Recreate the exact three-column shell/IDs first.
2. Add PreviewStage and CUE overlay.
3. Add PatternPad/PatternLibrary with exact classes/data attributes and drag behavior.
4. Add ParameterPanel/BlendControls with stable slider nodes and RAF-coalesced command buffer.
5. Add PostFxPanel.
6. Add BandEqPanel/Canvas and the imperative spectrum sink.
7. Add NoiseFloorControls.
8. Add ControlHeader, screen status, app menu, device modal, and key map modal.
9. Use portals for body-level modals while preserving IDs and `hidden` behavior.
10. Remove the imperative `ConfigPanel` only after selector and behavior parity.

**Gate:** `control-panel`, `band-eq`, `device-setup-modal`, `audio-input`, and control-side CUE tests pass unchanged.

### Phase 7 — Remove legacy monoliths and split CSS

1. Delete old `main.js`, `config-panel.js`, and `ui.js` implementations after all callers are migrated.
2. Keep only intentionally documented compatibility re-export shims.
3. Split `legacy.css` into the target global CSS files without changing cascade order.
4. Check source file sizes and split any new orchestration/UI file that has started accumulating unrelated responsibilities.
5. Ensure every service has one idempotent `dispose()` path.

**Gate:** no giant replacement monolith exists in `createAppRuntime.js`, `App.jsx`, a vanilla-store slice, or a protocol router.

### Phase 8 — Final verification

1. Run `npm run build`.
2. Run the full Playwright suite with two workers as configured.
3. Run the 58-pattern preview and output smoke paths.
4. Manually open one root control and one `?role=screen` window on port `3000`.
5. Manually verify microphone setup/resume, camera effect, merge, CUE edit/TAKE/CANCEL, screen close, and singleton reload.
6. Watch both windows for page errors, React warnings, WebGL-context warnings, leaked media indicators, and duplicate BroadcastChannel traffic.
7. Compare selector/storage/message inventories against the Phase 0 snapshot.
8. Confirm production preview honors the original CSP and `devbox2.local` allowed-host behavior.

## 14. Acceptance criteria

The refactor is complete only when all of the following are true:

- The app boots through `/src/main.jsx` as React + Vite and contains no TypeScript.
- Root URL, `role=control`, and `role=screen` behavior are unchanged with no router dependency.
- `main.js` and `config-panel.js` no longer contain application implementations.
- There is no new all-purpose store/service/component replacing the old monolith.
- The screen remains authoritative for LIVE/CUE and canonical visual parameters.
- One control owns microphone capture; one screen owns camera capture.
- CUE revision/fresh-frame/audio-control gates remain intact.
- p5 instances survive unrelated React rerenders and are recreated only for real runtime/selection changes.
- Merge remains dual-canvas GPU compositing.
- WebGL and media resources are released deterministically.
- All 58 sketches, seven groups, and ten default pad positions remain in exact current order.
- Existing localStorage/channel/protocol contracts remain readable and writable without migration loss.
- Existing Playwright selectors and `window.__viz` getters remain compatible.
- The current CSP, Permissions Policy, Vite host/port/allowedHosts, and Playwright port override are preserved.
- `npm run build` and the full Playwright suite pass.

## 15. Principal risks and mitigations

| Risk | Mitigation |
|---|---|
| React rerender/remount destroys p5 or slider nodes | Stable p5 hosts, services outside React, stable keys, local slider draft, no StrictMode initially. |
| p5 canvas is absent immediately after construction | Keep RAF attachment retry and parent-at-construction behavior. |
| Hidden CUE reports READY too early | Preserve draw/media/audio-controls/compositor revision gates in `RuntimeReadiness` and `CueRuntimeGate`. |
| Screen and control both believe they are canonical | Keep screen authority and accepted state/cue-state responses; the vanilla store is a mirror only. |
| Raw high-frequency data rerenders React | Keep FFT, spectrum, control packets, and p5 loops in services/refs. |
| Multiple microphone/camera captures | Preserve Web Lock/lease ownership and screen-only shared camera source. |
| WebGL context exhaustion | Explicit context loss before async-safe p5 removal; do not rebuild previews for parameter acknowledgements. |
| Canonical sketch order changes when registry is grouped | Assemble groups through the explicit 58-ID `sketchOrder.js`, not group concatenation. |
| Existing tests fail before behavior runs | Keep root re-export shims and exact selector/debug contracts. |
| CSS split changes specificity/cascade | Import the legacy file first; split only after React DOM parity and retain original order/selectors. |
| Development HMR leaks leases or channels | One `WindowLifecycle.dispose()` registered with pagehide/unload and `import.meta.hot.dispose`. |
| CSP or test-port regressions | Preserve policy strings and Vite settings; explicitly retain Playwright's `5173` CLI override. |
