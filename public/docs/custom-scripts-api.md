# Custom Scripts API v1 — agent reference

This is ahLOOKah's **trusted JavaScript** extension API, not p5.js and **not a security sandbox**. Scripts execute in each same-origin app window with application privileges. Only use reviewed code. Syntax/metadata validation prevents mistakes, not hostile behavior. A loop can hang Chrome; arbitrary global/network/storage effects cannot be rolled back. The site's existing CSP still applies.

## Files and activation contract

- Desktop Chrome, HTTPS or localhost, with `showDirectoryPicker`. The app checks capabilities; other Chromium browsers may expose them but are not the supported target. No upload/virtual-filesystem fallback.
- Choose a real OS directory in **Custom Scripts → Link Folder**. Chrome persists the directory handle using IndexedDB structured cloning. Permissions can expire independently. Open Script and reload request renewed read permission from a user gesture; denied permission never discards last-good registrations.
- Write scripts in your external editor. Linking only lists filenames; it never executes files. Click **Open Script**, choose a file in the app modal, then **Open** to validate and activate it. There is no Create Script workflow, browser editor or disk writing. External saves remain inactive until Reload.
- Only explicitly opened immediate files named `*.viz.js` are executed (alphanumeric initial character, then ASCII letters/digits/dot/underscore/hyphen). No recursive traversal. At most 100 files, 1 MB each, 256 resulting patterns. Non-script files are assets.
- Each file is a **classic strict JavaScript script**, receiving the lexical `api` argument. Not ESM, CommonJS, TypeScript, JSX or p5 global mode. Static and dynamic `import` are rejected. Bundle dependencies into one `.viz.js` file; no local module resolver, npm/CDN import loader or source maps. Local asset bytes are available separately.
- Every candidate file is parsed with Acorn and compiled before **any** candidate registration code executes. Registration then runs synchronously in opened-file order; per-script reload re-evaluates only that file, retaining other last-good definitions. Hook bodies are not executed for validation. Any syntax/registration/schema/collision error rejects the **selected reload generation** and preserves the prior registry and renderers.
- Deterministic declarations only at top level. Do not allocate resources or mutate globals during registration: the same text executes independently in control/output windows and again on app startup. Put allocations in lifecycle hooks, state in `ctx.state`.
- Successful generations are stored in IndexedDB as source snapshots plus their folder handle, not as serialized functions. Open windows receive a revision notification, read the same snapshot and independently revalidate. Late-opened windows restore that snapshot without reading edited source files. This is eventual synchronization, not an atomic distributed renderer transaction. Do not depend on immediate cross-window globals.
- Reload cancels staged CUE and pending TAKE, invalidates in-flight promotions, disposes affected LIVE and all previews, retires audio slots/controllers and rebuilds against new definitions. A brief output interruption is intentional. Missing selected IDs fall back to a built-in; missing projection children use existing black fallback. Slots are reconciled. Existing compatible parameter values survive, clamped to changed ranges; new keys receive defaults.
- This rollback is **registration rollback**, not arbitrary JavaScript/runtime rollback. A setup/draw/GLSL/media failure after activation reports the file/hook; the previous generation is not automatically restored. Keep a backup and revert the disk file, then Reload.

## Synchronous registration API

```js
api.requireVersion(1); // mandatory in every file; api.version === 1
const id = api.create({ id: 'custom-example', name: 'Example', draw({p}) { p.background(20); } });
api.update(id, { name: 'Renamed' });
const definition = api.get(id); // immutable snapshot, this file only
const definitions = api.list(); // this file's staged definitions only
api.create({ ...definition, id: 'custom-copy' });
api.delete('custom-copy'); // unregister staged pattern; DOES NOT delete a file
```

`create` rejects duplicates even within the same file. `update(id, patch)` is a shallow merge followed by complete validation (replace an entire params/audio array/object); IDs cannot change. `get`, `update`, `delete` reject IDs not created by this file in the **current evaluation**, including built-ins, media, projection and other scripts. All mutations are staged, not live until evaluation completes. API methods become closed after synchronous registration; never call from hooks, timers or promises. To update across reloads, rewrite the declaration (each reload starts an empty custom staging registry). To stop loading a file, use Delete in Parameters. To permanently remove a definition from its source, edit the file externally. `api.list` is not the global pattern library.

### Definition schema

Unknown fields are errors (including `factory`, `group`, `media`, `projection`, misspelled hooks). Required: `id`, `name`, `draw`.

| Field | Contract |
|---|---|
| `id` | `custom-` + lowercase letter/digit followed by up to 55 lowercase letters/digits/hyphens; max 63 total. Globally unique. |
| `name` | Nonblank string, max 80 characters. |
| `renderer` | Optional `'2d'` (default) or `'webgl'`. |
| `camera` | Optional boolean; true retains the existing source-mode camera behavior. It does not imply FX capability. |
| `fx` | Optional, exactly `{ input: 'image' }`. Declares the ability to process one graph-owned image in FX mode; no other fields, inputs or values are accepted. Omission means source-only. Capability does not switch a running instance's mode. |
| `params` | Optional array of at most 16 numeric sliders. Unique safe keys. |
| `preload(ctx)` | Optional sync or async hook, before canvas/setup; suitable for asset loading. |
| `setup(ctx)` | Optional sync or async hook, after automatic host-sized canvas creation. |
| `draw(ctx)` | Required synchronous function, called per frame. |
| `resize(ctx)` | Optional synchronous hook after automatic resizing. |
| `dispose(ctx)` | Optional synchronous hook, once per renderer instance before core removal. |
| `audio` | Optional custom capture-owner controller: `{schema, update(frame,state), dispose(state)?}`. Omit for the built-in reactive default. |

Generators are unsupported. Drawing/disposal/audio hooks must not be async. A synchronous hook returning a Promise is also inappropriate except preload/setup; async work must honor cancellation and explicitly handle rejection.

```js
params: [{ key: 'speed', label: 'Speed', min: 0, max: 4, step: 0.1, default: 1 }]
```

All six fields required. `key`: starts with ASCII letter, then letters/digits/underscore/hyphen, max 64; no `constructor`/`prototype`/`__proto__`. `label`: nonblank max 80. All numbers finite with absolute value <= 1,000,000; min <= max, step > 0, default inside range. Read `ctx.params.speed` on every draw; do not copy once during setup. The host maintains mutable parameter banks across live edits, cue/take, preview and output. Do not write directly to them to change UI state.

## Renderer context and cleanup

| Member | Meaning |
|---|---|
| `p` | Actual VizCore instance, full existing rendering API, no proxy/security membrane. In FX mode its supported `p.createCapture` entry point throws instead of opening a camera. |
| `inputMode` | Read-only for this renderer instance: `'source'` by default, `'fx'` only when an FX-capable graph instance explicitly requests it. Switching modes recreates the renderer. |
| `imageInput` | Current borrowed graph image frame during a synchronous FX `draw`, otherwise `null`. Refreshed before every draw and cleared on return, error or disposal. This is **not** the audio `frame`. |
| `params` | Current host-owned parameter object. |
| `state` | Fresh mutable object for this renderer instance; separate for each output, CUE, preview and projection child. |
| `reactive`, `response`, `accent` | Preferred built-in channels and normalization helpers; see Preferred reactive mapping. |
| `controls` | Compact audio binding. `read()` returns continuous/arrays and freshness; `consumeEvents()` drains fresh events once. |
| `onCleanup(fn)` | Register synchronous cleanup, reverse order, once. If already disposed, runs immediately. |
| `signal` | AbortSignal aborted before dispose/cleanup. Async work must check it before using p/state/resources. |
| `assetURL(filename)` | Promise of a blob URL from this generation's real folder. Immediate filename only, no paths. Automatically revoked on disposal. Does not execute JS. Permission errors instruct reconnect. |
| `createCapture(constraints, callback?)` | Source mode: output's shared camera factory (selected camera device), fallback to VizCore capture outside ProgramRuntime. FX mode: throws before either path, even when no image is connected. |
| `videoDeviceId` | Selected output device ID, null in control preview. |
| `runtime` | Existing integration callbacks: `audioSlot`, `audioControls`, `createCapture(p, constraints, callback)`, `isPaused()`, `addPlaybackLifecycle({pause,resume})`, `reportMediaReady()`, `reportMediaSettled()`, `addCleanup(fn)` where supplied. An FX-capable graph host also passes `inputMode` and `getImageInput()`; the adapter only reads the provider during FX draws. Some callbacks are absent in embedded preview; use optional chaining. Prefer `ctx.onCleanup` for portable teardown. |
| `audio` | Existing legacy audio object, not a guaranteed raw capture stream in remote windows. Prefer `reactive` for new scripts; advanced controllers retain `frame`/`shared` and renderer `controls`. |

The adapter handles canvas sizing, graphics mode, lifecycle error reporting, loop stop on draw failure and exactly-once cleanup. VizCore removal stops rAF, removes canvas/media/listeners and releases GL. You **must** clean up timers, external listeners, fetched resources, workers, offscreen Graphics, raw GL resources and manually owned MediaStreams. Do not remove the host canvas, replace the host draw loop or use page reload as cleanup. Do not allocate on every frame. Disposal also happens on ordinary pattern switches, not just script reload.

```js
setup({state, onCleanup, signal}) {
  state.count = 0;
  const timer = setInterval(() => state.count++, 1000);
  onCleanup(() => clearInterval(timer));
  window.addEventListener('online', () => { state.count = 0; }, {signal});
}
```

### Image-input FX (opt-in graph contract)

`fx: { input: 'image' }` is **capability metadata**, not a mode switch. Existing scripts, standalone playback and old graph instances remain sources; `camera: true` retains its source-mode behavior. In the Node Patterns editor, an FX-capable script appears with a ◇ FX badge and **Add as FX** action; alternatively add it as Source and choose **FX** in its inspector. Wire a Pattern or Camera image output to its image input, then wire its output onward. Only a graph instance explicitly set to `runtime.inputMode === 'fx'` receives that upstream image. Camera nodes are preview-restricted and capture only on the output screen.

For each synchronous FX draw, the host calls `runtime.getImageInput()` and exposes the result as `ctx.imageInput`. `null` means disconnected, pending or otherwise unusable input. A non-null frame has this shape:

```js
{ source, width, height, frameId, timestampMs, generation }
```

- `source` is the **graph-owned HTMLCanvasElement**, not a camera/video wrapper or cross-context WebGL texture. `width`/`height` are its positive pixel dimensions. `frameId` identifies the graph evaluation, `timestampMs` is monotonic render time, and `generation` invalidates old views on rebuild, resize or disposal. These values describe an image, not the capture-side `audio.update({ frame })` analysis data.
- The graph owns and pins input for the current draw/tick. Read or sample it synchronously; do **not** resize, draw into, remove, dispose, mutate or retain the canvas/view for async work or future draws. Make an effect-owned copy only for intentional, bounded history. `ctx.imageInput` is `null` outside the draw and on dispose, but your own stored reference cannot be revoked by the adapter. Keep output distinct from input to avoid feedback.
- In FX mode `ctx.createCapture()` and `p.createCapture()` explicitly throw, including when the input is absent. Never write `ctx.createCapture(...) || p.createCapture(...)` as an FX fallback. Source-mode capture is unchanged; only an upstream camera-source node should acquire a camera for a camera → FX chain. These guards cover the supported VizCore paths, **not** arbitrary trusted JavaScript calling browser media APIs directly.
- Handle `null` by clearing to transparent, not opening a camera or retaining an old output. The graph host diagnoses missing/unsupported input and clears failed outputs; saved FX mode and wires remain for repair if a script reload removes its capability. FX preview does not request an effect-owned camera; an upstream Camera node remains unavailable in the editor and works on the output screen. `preload` and `setup` must not assume a frame exists.

**Canvas2D source/FX example** (the source branch is deliberately useful on its own):

```js
api.requireVersion(1);
api.create({
  id: 'custom-image-wash', name: 'Image wash', fx: { input: 'image' },
  draw({ p, inputMode, imageInput }) {
    p.clear();
    if (inputMode === 'source') { p.background(24); return; }
    if (!imageInput) return;
    p.tint(255, 180);
    p.image(imageInput.source, 0, 0, p.width, p.height);
    p.noTint();
  },
});
```

**Dual-source camera example**: acquire only in source mode. Do not test capture metadata to decide whether an FX frame is ready; use `imageInput` and its dimensions instead. Source-only camera behavior and mirroring remain explicit.

```js
api.requireVersion(1);
api.create({
  id: 'custom-camera-wash', name: 'Camera / image wash',
  camera: true, fx: { input: 'image' },
  setup({ inputMode, state, createCapture }) {
    if (inputMode === 'source') {
      state.capture = createCapture({ video: true, audio: false });
      state.capture.hide(); // The source-mode host owns its shared camera lease.
    }
  },
  draw({ p, inputMode, imageInput, state }) {
    p.clear();
    if (inputMode === 'fx') {
      if (!imageInput) return;
      p.tint(255, 180);
      p.image(imageInput.source, 0, 0, p.width, p.height);
      p.noTint();
      return;
    }
    p.background(0);
    if (state.capture?.elt.readyState >= 2) {
      p.push(); p.translate(p.width, 0); p.scale(-1, 1);
      p.image(state.capture, 0, 0, p.width, p.height); p.pop();
    }
  },
});
```

**Optional WebGL example**: the existing texture resolver accepts `imageInput.source` as a canvas. A reused canvas must be re-uploaded when its frame changes; do not cache the borrowed input as an effect-owned texture. The shader below simply demonstrates the image path; replace its fragment body with your effect.

```js
api.requireVersion(1);
api.create({
  id: 'custom-image-shader', name: 'Image texture FX',
  renderer: 'webgl', fx: { input: 'image' },
  setup({ p, state }) {
    state.shader = p.createShader(`
      precision highp float;
      attribute vec3 aPosition; attribute vec2 aTexCoord;
      varying vec2 uv;
      void main() { uv = aTexCoord; gl_Position = vec4(aPosition.xy * 2.0 - 1.0, 0.0, 1.0); }
    `, `
      precision highp float;
      varying vec2 uv; uniform sampler2D uImage;
      void main() { gl_FragColor = texture2D(uImage, uv); }
    `);
  },
  draw({ p, state, inputMode, imageInput }) {
    p.clear();
    if (inputMode === 'source') { p.background(24); return; }
    if (!imageInput) return;
    p.shader(state.shader);
    state.shader.setUniform('uImage', imageInput.source);
    p.rect(0, 0, p.width, p.height); // VizCore custom shader: fullscreen quad
  },
});
```

The scripting API remains **version 1**: these optional fields are additive. Older app versions reject unknown `fx` definitions rather than guessing what to render; a failing reload keeps the last-good registration. A successful reload that removes `fx` changes the registry capability; the graph host preserves saved FX mode/wires and reports an unavailable capability instead of switching them to cameras. Cross-window generations independently validate the new definition, then recreate affected renderers.

### Existing VizCore capabilities (not full p5)

The custom adapter does not reduce `p`. Current source of truth: `src/core/api.js`, `src/core/sketch.js`, `src/core/renderer-2d.js`, `src/core/renderer-gl.js`, `src/core/media.js`; renderer-specific calls can be no-ops in the other mode.

- Canvas: `createCanvas(w,h,mode)`, `resizeCanvas(w,h,noRedraw?)`, `pixelDensity(value?)`, `width`, `height`, `canvas`, `drawingContext`. Host preview/output sizing overrides requested dimensions; draw using `p.width/p.height`, never assume window dimensions match preview.
- Time/lifecycle: `frameCount`, `deltaTime` (ms), `millis()`, `frameRate(fps)`, `getTargetFrameRate()`, `noLoop()`, `loop()`, `isLooping()`, `redraw(count?)`, `whenReady()`, `remove()`. Leave lifecycle control to host unless deliberately writing a still pattern. CUE uses fresh-frame requests.
- Color/style: `colorMode(RGB|HSB,...)`, `color(...)`, `fill`, `noFill`, `stroke`, `noStroke`, `strokeWeight`, `tint`, `noTint`, `blendMode`, `background`, `clear`. RGB/HSB maxima and alpha are mode-dependent.
- Transforms: `push/pop`, `translate`, `scale`, `rotate`, `rotateX/Y/Z`, `resetMatrix`. 2D origin top-left; WebGL default mesh origin centered.
- Geometry: `rect`, `circle`, `ellipse`, `line`, `triangle`, `beginShape/vertex/endShape`, `rectMode`, `ellipseMode`. WebGL meshes: `box`, `sphere`, `plane`, `cone`; `ambientLight`, `pointLight`, `noLights`.
- Text: `text`, `textAlign`, `textSize`, `textFont`, `textStyle` (Canvas2D). Not full p5 typography/font loading.
- Images/compositing: `image`, `imageMode`, `get`, `copy`, `createImage`, `loadImage(url, success, failure)`. VizImage: `loadPixels`, `pixels`, `updatePixels`, `get`, `set`, `resize`; pixels are RGBA bytes. `createGraphics(w,h)` is **2D only** and has its own canvas/style/density plus drawing API; call its `remove()` in cleanup.
- GLSL: `createShader(vertex,fragment)`, `shader(program)`, `program.setUniform(name,value)`. With custom shader active `rect` draws fullscreen, ignoring rect placement arguments. Vertex attributes `aPosition` (quad 0..1), `aTexCoord`; map positions to -1..1 as in example. Texture uniforms accept supported canvas/image/video/Graphics sources. Shader compile/link failures occur at runtime, not JS syntax check.
- Media: `createVideo(src, callback?)`, `createCapture(constraints,callback?)`. Wrappers expose `elt`, `hide`, `show`, `size`, `play`, `pause`, `stop`, `remove` (methods), `loop`, `muted`, `currentTime`, `playbackRate` (properties) as implemented in core. Use supported local image/video formats; a `.mp4` extension alone does not guarantee codec support. Keep video muted to avoid autoplay/sound surprises. Shared capture is the recommended camera route.
- Math: `random`, `noise`, `noiseSeed`, `noiseDetail`, `map`, `lerp`, `constrain`, `dist`, `mag`, standard trig/power/rounding wrappers, `radians/degrees`. No assumption of p5's entire math API.
- Constants: `P2D`, `WEBGL`, `RGB`, `HSB`, `BLEND`, `ADD`, `LIGHTEST`, `DARKEST`, `MULTIPLY`, `SCREEN`, `CENTER`, `LEFT/RIGHT/TOP/BOTTOM/BASELINE`, `CORNER/CORNERS/RADIUS`, `CLOSE/OPEN`, `PI/TWO_PI/TAU/HALF_PI/QUARTER_PI`.
- `p.mouseX/mouseY` and canvas mouse hooks are available; set needed handlers in setup. Raw Canvas2D/WebGL access remains trusted and your cleanup responsibility.
- `setAttributes`, `smooth`, `noSmooth`, `describe` are compatibility no-ops, **not** full p5 features. No p5.sound, DOM plugin suite, arbitrary WebGL offscreen buffers or unsupported p5 addons. Use the tested examples as starting points.

## Preferred reactive mapping (default)

For new audio-reactive scripts, omit `audio` and use `draw({p, reactive, response, accent})`. The host installs the existing `createFeatureController()` and `FEATURE_SCHEMA` from `src/sketches/feature-controls.js`; there is no new smoothing algorithm or raw-loudness substitute. Scripts that ignore audio still work. No parameters are inserted into existing scripts.

- `reactive.bass`, `reactive.mid`, `reactive.high`, `reactive.energy`: 0..3.2. Use `response(value)` to clamp/normalize to 0..1 (divide by 3.2).
- `reactive.kick`, `reactive.snare`, `reactive.hat`, `reactive.beat`: 0..1.4. Use `accent(value)` to clamp/normalize to 0..1 (divide by 1.4). These are decaying continuous envelopes, not one-shot events or a tempo clock.
- `response` and `accent` are the actual existing helpers, available in renderer context and custom `audio.update` context. Non-finite/missing values normalize to zero. Do not normalize twice.
- Optional declared parameters named `bass`, `mid`, `high` act as responsiveness gains: default 1 when absent/non-finite, bounded 0..2, applied after shaping. Zero removes that range and its associated percussion: bass gates kick/beat, mid gates snare, high gates hat. Do not multiply these gains again in draw. Energy is the gated blend: 0.42 bass + 0.38 mid + 0.20 high. No automatic punch/accents parameter is added.

Give ranges separate jobs: bass expands geometry, mid changes color/shape, high changes detail, and kick/hat provide selective short accents. Keep a base size/brightness so silence has a deliberate visual design. Use the inline `audio.viz.js` as the starting point; reserve raw bins for spectrum/waveform displays or genuinely custom analysis.

### Existing pipeline and provenance

Circles and Techno 3D use capture-side byte-band controllers with independent band-to-geometry mappings, constant structural motion and bounded events (Circles integrates hat spawn rates; Techno integrates rotation with elapsed time). They do not themselves use the newer adaptive feature controller. Ion Tempest maps canonical sustained features and distinct percussion envelopes. The replacement/expansion patterns combine those mapping semantics in the shared feature controller that scripts now reuse; Ion Tempest's fabricated idle beats are deliberately not copied.

The capture owner supplies one cleaned analysis frame and a lazy `SharedAudioAnalysisView` per tick. `makeAudioFeatures()` mixes stereo power, uses Hz ranges, slow level compensation, attack/release followers and positive spectral flux with adaptive thresholds. Kick/snare/hat decay constants are 0.16/0.12/0.075 seconds; beat has a 0.115-second refractory period and 0.21-second decay. Shared feature extraction and integrated band support are cached per tick, not rescanned in each renderer.

`createFeatureController()` combines canonical levels with cleaned integrated band power, then adds positive within-band dB changes and deviation above an adaptive baseline to a bounded sustained component. The baseline chases rises in 1.2 seconds and falls in 3.5 seconds; the dB flux accent decays in 0.12 seconds. Constant passages relax rather than permanently pinning the geometry. This is not simply raw loudness or a new generic smoother. Levels follow the host's current band-split EQ (defaults 180/2800 Hz, outer range 30..16000 Hz). Percussion retains fixed musical ranges: kick 35..180, snare 180..4200, hat 4500..16000 Hz.

### Lifecycle, silence and compatibility

Adaptive state belongs to each capture-owner runtime controller, never a module-global script object or draw frame. Parameter edits keep the existing baseline. Slot retirement, script reload and capture stream restart dispose it; new slots start fresh. Missing/empty analysis frames reset the script helper to eight zeros. Real silent frames retain the existing short envelope/flux release tails and settle to zero; no idle beats are invented. Render bindings retain their existing interpolation and stale-to-neutral decay. Before the first draw, with no binding, or after disposal, renderer `reactive` is zero. Standalone renderers do not open an analyser as a fallback.

`reactive` is a per-draw snapshot of the default transport, refreshed before `draw`; read it each frame rather than caching it in setup. `controls.read()` remains available for the original transport values and freshness. `response`/`accent` only normalize; they do not advance state or apply extra gain.

An explicit `audio: {schema, update, dispose?}` still owns its exact schema, values, arrays and events. No reserved keys are injected or overwritten, even if its custom schema uses `bass`. Its renderer `reactive` stays zero: read your own mapped values from `controls`. Inside its `audio.update` context, `reactive` lazily supplies the same eight built-in channels, computed at most once per update; return the channels you need under your declared schema. Raw-only scripts do not trigger this extra analysis. The inline `audio-advanced.viz.js` demonstrates reactive geometry plus raw spectrum and a threshold-crossing event from the existing beat envelope. No existing script must migrate, and API version remains 1.

## Audio controllers

Audio interpretation happens on the capture owner, once per runtime slot. The renderer receives compact validated controls, avoiding separate audio analysis in output/preview windows.

`audio.update({frame, shared, params, deltaSeconds, captureTime, sequence, reactive, response, accent}, state)` returns `{continuous?, arrays?, events?}`. Missing containers default empty. State is per controller, with seeded `state.rng()` supplied by the engine. Use `deltaSeconds`, not an assumed cadence. Dispose is called when retired/reloaded. All numeric values must match schema; errors are reported and neutral output is substituted.

- `frame`: original cleaned capture analysis frame (or null), with full float dB `left`/`right`, float `waveformLeft`/`waveformRight`, `sampleRate`, `fftSize` and optional `rms`. This is pre-feature data, not pre-noise-cleaning microphone data. Treat frame/shared arrays as read-only; full raw access remains capture-side, not broadcast to remote renderers.
- `shared.getByteFrequencies()` → `{left,right}` byte-frequency arrays (0..255).
- `shared.getByteWaveforms()` → `{left,right}` byte-waveform arrays.
- `shared.getFeatures()` → existing shared feature snapshot; inspect `src/sketches/audio-features.js` and `src/pattern-audio-engine.js` for detailed feature contract. Do not mutate shared arrays.
- `continuous`: max 64 keys, each `{min,max,neutral}`. Values interpolate/decay toward neutral when packets go stale.
- `arrays`: max 64 keys, each `{min,max,minLength?,maxLength?}`. Return numeric typed arrays; max 512 elements each. Not ordinary JS arrays.
- `events`: max 64 declared types, each `{fields:{field:{min,max,required?,integer?}}}`. Return max 16 events per packet, each `{id:'unique-per-controller',type:'declared-type',...numericFields}`. Do not use `id` or `type` as a field name. Use monotonically increasing IDs for new events. Render with `consumeEvents`, not repeated playback from persistent state.
- `schema.neutral` may supply `{continuous,arrays}` overrides, validated against the schema. Arrays use typed arrays.
- Keys start with an ASCII letter then letters/digits/underscore/hyphen (max 64). Unknown schema fields, invalid ranges, hook types and neutral values fail registration. All values finite within absolute 1,000,000. Runtime payload validation is also enforced by the existing protocol.

Start with `audio.viz.js` for preferred reactive mapping; `audio-advanced.viz.js` adds custom transport, raw spectrum and one-shot events. Raw FFT averaging is useful for measurement, but it misses the within-range dynamics and transient semantics of the preferred helper.

## Examples and normal host features

Save any complete example below as its named file in your linked folder, then explicitly Open Script. Optional downloadable copies are also in `public/docs/custom-script-examples/`; navigation is not required. Files can coexist (unique IDs).

| File | Capability |
|---|---|
| `drawing.viz.js` | 2D shapes, text, transforms, HSB, parameters, image pixels, offscreen buffer and cleanup |
| `mesh.viz.js` | WebGL meshes, rotations, lighting |
| `shader.viz.js` | GLSL, fullscreen quad, animated uniforms, offscreen texture |
| `audio.viz.js` | Preferred built-in reactivity, independent geometry/color/detail and kick accent |
| `audio-advanced.viz.js` | Custom controller using reactive helpers plus raw spectrum and events |
| `image.viz.js` | Async local asset load, image tint, additive compositing; add `photo.png` |
| `video.viz.js` | Async video readiness, muted playback, CUE pause/resume, cancellation; add `clip.mp4` |
| `camera.viz.js` | Shared output camera and mirrored image; choose/allow camera |
| `crud-lifecycle.viz.js` | Create/read/update/delete registrations, timers/listener cleanup |

Custom entries are normal registry patterns: click LIVE, Shift-click CUE, Enter TAKE; drag to a pad slot, blend two patterns, use post-processing/screen mapping, and choose as children in Projection Mapping. No separate script-owned preview/output window API is necessary. The host owns these windows, readiness gates and disposals. Scripts cannot use registration API to modify built-in definitions or create special media/projection registry records, but can render media and participate as projection children. Create mappings with the normal mapping editor.

## Reload, Delete and unlink

- Folder reload refreshes the file list and reloads **only opened files**. New/unselected files never execute. Per-script **Reload** in Parameters reloads that file only. Validation or storage failure keeps the last-good selection, patterns and runtime.
- **Delete** in Parameters removes the loaded script and all its patterns from the library, like media removal. Confirmation explicitly says the source file is kept. Reload and restart do not reopen deleted items; use Open Script to restore them. No disk-delete API or UI is provided.
- The folder close icon **unlinks** the directory, clears the persisted selection and removes runtime patterns/resources in all windows. Source files are untouched. This also works with expired permission.
- External disk deletion is noticed on reload and retires the affected selected file's patterns when the reload succeeds. A bad selected file blocks that reload; fix it or Delete its loaded item first.
- Hover the right-aligned folder name to see the full available name; click to copy it. Chrome File System Access does not expose an absolute native path. The tooltip/copy never fabricates one. Find the actual path in your OS/editor.
- On restart, only last-good explicitly opened source snapshots restore, not external edits. Older autoload snapshots are not executed; open their files explicitly once after upgrading.

## Troubleshooting and agent handoff checklist

1. Identify the chosen directory in the operator's OS/editor; Chrome shows its name, not absolute path. Confirm trust, Chrome support and HTTPS/localhost. Do not invent a server-side path.
2. Use a unique `.viz.js` filename and `custom-...` IDs; start with `api.requireVersion(1)`. Bundle any libraries; no import/exports, TS, JSX or `require`.
3. Declare exactly supported metadata, valid numeric parameter/audio schemas, callable hooks. Keep top level deterministic and resource-free. Every file is evaluated per window.
4. Use the real VizCore API, not assumed p5 methods. Select renderer explicitly for GL. Size to `p.width/height`; test high-DPI, resized preview and output.
5. Use capture-owner audio and consumed events; provide neutral values. Test silence/disconnected audio and stale frames.
6. Register cleanup immediately after allocation; handle `ctx.signal.aborted` after every await; close raw media/workers/GL objects. Avoid global state and async draw.
7. Save files; use Open Script for a new file or Reload for an already opened file. Syntax/import errors name the file and parser location. Registration errors name file/field; fix the typo/range/collision and Reload. Entire last-good registry remains on these failures.
8. If permission expired, click Open Script or reload to request read permission. If folder moved/deleted, choose it again. If storage quota/private mode blocks persistence, free space/use a persistent profile; old registrations remain.
9. For setup/draw errors, inspect file-specific status and Chrome console stack (`custom-scripts/<filename>`). For image/video failures add the named local asset, check codecs, allow camera; for shader errors inspect GLSL compiler log. Runtime/global failures cannot be rolled back automatically.
10. Test LIVE, embedded preview, CUE/TAKE, merged output, projection child, output opened before/after reload, repeated reload/removal, no leaked canvases/camera/audio. Reload intentionally cancels CUE/TAKE. Do not assume distributed activation is instantaneous.
11. Use Delete in Parameters for reversible unloading; remove physical files only in your external editor/OS. Keep version-control/backups. Settings export does not package scripts, folder handles or assets; move the OS folder separately and choose it in the destination profile.

## Developer verification

`PLAYWRIGHT_PORT=5183 npx playwright test tests/custom-scripts.spec.js --project=chromium`

Tests use real browser filesystem handles backed by OPFS to automate filesystem operations/IndexedDB cloning, **not** as the production storage backend. Native OS picker UI and persistent permission revocation require a manual desktop Chrome check: link an actual OS folder, Open Script, edit externally, Reload, restart Chrome, renew/deny permission, unlink/relink a moved folder, cancel/confirm library Delete, and verify the OS file is preserved. Automated tests cannot stand in for that manual check.

## Complete examples

### audio.viz.js

```js
api.requireVersion(1);
api.create({
  id: 'custom-audio', name: 'Reactive rings (recommended)',
  params: ['bass', 'mid', 'high'].map(key => ({
    key, label: `${key} responsiveness`, min: 0, max: 2, step: 0.05, default: 1,
  })),
  // Omit audio: the host supplies the existing eight-channel feature controller.
  draw({ p, reactive, response, accent }) {
    const bass = response(reactive.bass);
    const mid = response(reactive.mid);
    const high = response(reactive.high);
    const kick = accent(reactive.kick);
    p.background(8); p.noFill();
    // Structure remains visible in silence; independent ranges have distinct roles.
    p.stroke(80 + mid * 175, 160, 255);
    p.strokeWeight(1 + high * 6);
    p.circle(p.width / 2, p.height / 2, Math.min(p.width, p.height) * (0.2 + bass * 0.5));
    // Selective transient accent, not a second gain or invented beat detector.
    p.stroke(255, 100, 180, kick * 255);
    p.circle(p.width / 2, p.height / 2, Math.min(p.width, p.height) * (0.24 + kick * 0.55));
  },
});
```

### audio-advanced.viz.js

```js
api.requireVersion(1);
api.create({
  id: 'custom-audio-advanced', name: 'Advanced reactive controls / raw spectrum / events',
  params: [{ key: 'gain', label: 'Gain', min: 0, max: 4, step: 0.1, default: 1 }],
  audio: {
    schema: {
      continuous: { level: { min: 0, max: 1, neutral: 0 } },
      arrays: { spectrum: { min: 0, max: 1, minLength: 32, maxLength: 32 } },
      events: { pulse: { fields: { strength: { min: 0, max: 1, required: true } } } },
    },
    update({ shared, params, reactive, response, accent }, state) {
      const freqs = shared?.getByteFrequencies?.().left || [];
      const spectrum = new Float32Array(32);
      for (let i = 0; i < 32; i++) spectrum[i] = Math.min(1, ((freqs[i * 4] || 0) / 255) * params.gain);
      // Raw bins are only for the spectrum display. Geometry uses built-in dynamics.
      const level = response(reactive.bass);
      const beat = accent(reactive.beat);
      const events = [];
      if (beat > 0.3 && (state.previousBeat || 0) <= 0.3) {
        state.count = (state.count || 0) + 1;
        events.push({ id: `pulse-${state.count}`, type: 'pulse', strength: beat });
      }
      state.previousBeat = beat;
      return { continuous: { level }, arrays: { spectrum }, events };
    },
  },
  draw({ p, controls, state }) {
    const packet = controls?.read();
    const level = packet?.continuous.level || 0;
    if (controls?.consumeEvents().length) state.flash = 1;
    state.flash = Math.max(0, (state.flash || 0) - p.deltaTime / 300);
    p.background(5 + state.flash * 80); p.noStroke(); p.fill(50, 200, 255);
    const bins = packet?.arrays.spectrum || [];
    for (let i = 0; i < bins.length; i++) p.rect(i * p.width / 32, p.height, p.width / 32 - 2, -bins[i] * p.height);
    p.fill(255, 100, 180); p.circle(p.width / 2, p.height / 2, 30 + level * 150);
  },
});
```

### camera.viz.js

```js
api.requireVersion(1);
api.create({
  id: 'custom-camera', name: 'Shared camera / mirror', camera: true,
  setup({ state, createCapture }) {
    // Output shares its selected camera across LIVE/CUE. Control preview is
    // intentionally a camera placeholder, matching built-in camera patterns.
    state.capture = createCapture({ video: true, audio: false });
    state.capture.hide();
  },
  draw({ p, state }) {
    p.background(0);
    if (state.capture?.elt.readyState >= 2) {
      p.push(); p.translate(p.width, 0); p.scale(-1, 1);
      p.image(state.capture, 0, 0, p.width, p.height); p.pop();
    }
  },
});
```

### crud-lifecycle.viz.js

```js
api.requireVersion(1);
const id = api.create({
  id: 'custom-crud', name: 'Temporary name',
  setup({ state, onCleanup }) {
    state.tick = 0;
    const timer = setInterval(() => state.tick++, 1000);
    onCleanup(() => clearInterval(timer));
    const listener = () => { state.tick = 0; };
    window.addEventListener('online', listener);
    onCleanup(() => window.removeEventListener('online', listener));
  },
  draw({ p, state }) {
    p.background(15); p.fill(255); p.textSize(22);
    p.text(`Alive ${state.tick}s`, 20, 40);
  },
  dispose({ state }) { state.tick = 0; },
});
api.update(id, { name: 'CRUD / resource lifecycle' });
api.create({ ...api.get(id), id: 'custom-temporary', name: 'Never activated' });
api.delete('custom-temporary'); // Registry only. Never deletes a disk file.
// api.list() returns this file's staged definitions. CRUD is synchronous during
// registration, not callable from draw/timers. Rewrite this file to change it.
```

### drawing.viz.js

```js
api.requireVersion(1);
api.create({
  id: 'custom-drawing', name: 'Drawing / type / pixels',
  params: [{ key: 'speed', label: 'Speed', min: 0, max: 3, step: 0.1, default: 1 }],
  setup({ p, state, onCleanup }) {
    state.buffer = p.createGraphics(160, 100); // Canvas2D offscreen buffer
    const g = state.buffer;
    g.background(20, 40, 70); g.fill(100, 230, 255); g.noStroke();
    g.triangle(10, 90, 80, 10, 150, 90);
    state.image = p.createImage(16, 16);
    state.image.loadPixels();
    for (let i = 0; i < state.image.pixels.length; i += 4) {
      state.image.pixels.set([255, 150, 50, 255], i);
    }
    state.image.updatePixels();
    onCleanup(() => g.remove());
  },
  draw({ p, state, params }) {
    p.background(10); p.image(state.buffer, 10, 10, 160, 100);
    p.image(state.image, 180, 10, 50, 50);
    p.push(); p.translate(p.width / 2, p.height / 2);
    p.rotate(p.millis() * 0.001 * params.speed);
    p.colorMode(p.HSB, 360, 100, 100, 1);
    p.fill((p.frameCount % 360), 80, 100); p.stroke(0, 0, 100); p.strokeWeight(2);
    p.rect(-40, -40, 80, 80); p.circle(70, 0, 20); p.pop();
    p.fill(255); p.noStroke(); p.textSize(18); p.text('VizCore • not full p5', 10, p.height - 20);
  },
});
```

### image.viz.js

```js
// Put photo.png beside this file in the chosen scripts directory.
api.requireVersion(1);
api.create({
  id: 'custom-image', name: 'Local image / compositing',
  async preload(ctx) {
    const url = await ctx.assetURL('photo.png');
    ctx.state.image = await new Promise((resolve, reject) => ctx.p.loadImage(url, resolve, reject));
  },
  draw({ p, state }) {
    p.background(12); p.tint(255, 180);
    p.image(state.image, 0, 0, p.width, p.height); p.noTint();
    p.blendMode(p.ADD); p.fill(40, 50, 80); p.circle(p.width / 2, p.height / 2, 100); p.blendMode(p.BLEND);
  },
});
```

### mesh.viz.js

```js
api.requireVersion(1);
api.create({
  id: 'custom-mesh', name: 'Lit WebGL geometry', renderer: 'webgl',
  draw({ p }) {
    p.background(5, 8, 20); p.noStroke();
    p.ambientLight(70); p.pointLight(255, 220, 180, 100, -100, 200);
    p.push(); p.rotateY(p.millis() / 1500); p.rotateX(0.3);
    p.fill(60, 150, 230); p.box(90); p.pop();
    p.push(); p.translate(120, 0, 0); p.fill(230, 90, 160); p.sphere(40, 16, 12); p.pop();
    p.push(); p.translate(-120, 0, 0); p.fill(100, 230, 120); p.cone(35, 80, 16); p.pop();
  },
});
```

### shader.viz.js

```js
api.requireVersion(1);
api.create({
  id: 'custom-shader', name: 'GLSL with offscreen texture', renderer: 'webgl',
  setup({ p, state, onCleanup }) {
    state.texture = p.createGraphics(64, 64);
    state.texture.background(20, 100, 220); state.texture.fill(250, 200, 40);
    state.texture.circle(32, 32, 32);
    onCleanup(() => state.texture.remove());
    state.shader = p.createShader(`
      precision highp float;
      attribute vec3 aPosition; attribute vec2 aTexCoord;
      varying vec2 uv;
      void main(){ uv=aTexCoord; gl_Position=vec4(aPosition.xy*2.0-1.0,0.0,1.0); }
    `, `
      precision highp float;
      varying vec2 uv; uniform float time; uniform sampler2D image;
      void main(){ vec2 q=fract(uv+vec2(sin(time)*0.1,0.0));
        gl_FragColor=texture2D(image,q)*vec4(0.7+0.3*sin(time+uv.x*6.28),1.0,1.0,1.0); }
    `);
  },
  draw({ p, state }) {
    p.shader(state.shader);
    state.shader.setUniform('time', p.millis() / 1000);
    state.shader.setUniform('image', state.texture);
    p.rect(0, 0, p.width, p.height); // custom shader draws a fullscreen quad
  },
});
```

### video.viz.js

```js
// Put clip.mp4 beside this file. Browser-supported video codec required.
api.requireVersion(1);
api.create({
  id: 'custom-video', name: 'Local video / playback cleanup',
  async setup(ctx) {
    const { p, state, signal, runtime, onCleanup } = ctx;
    const url = await ctx.assetURL('clip.mp4');
    if (signal.aborted) return;
    const video = state.video = p.createVideo(url);
    video.hide(); video.elt.muted = true; video.elt.loop = true;
    onCleanup(() => video.remove());
    runtime.addPlaybackLifecycle?.({ pause: () => video.pause(), resume: () => video.play() });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('clip.mp4: video readiness timed out')), 8000);
      const done = () => { clearTimeout(timer); resolve(); };
      video.elt.addEventListener('loadeddata', done, { once: true, signal });
      video.elt.addEventListener('error', () => { clearTimeout(timer); reject(new Error('clip.mp4: unsupported or broken video')); }, { once: true, signal });
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      if (video.elt.readyState >= 2) done();
    });
    if (!signal.aborted && !runtime.isPaused?.()) await video.elt.play();
  },
  draw({ p, state }) {
    p.background(0);
    if (state.video?.elt.readyState >= 2) p.image(state.video, 0, 0, p.width, p.height);
  },
});
```
