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
| `camera` | Optional boolean; true enables output camera readiness and disables control camera preview, like built-ins. |
| `params` | Optional array of at most 16 numeric sliders. Unique safe keys. |
| `preload(ctx)` | Optional sync or async hook, before canvas/setup; suitable for asset loading. |
| `setup(ctx)` | Optional sync or async hook, after automatic host-sized canvas creation. |
| `draw(ctx)` | Required synchronous function, called per frame. |
| `resize(ctx)` | Optional synchronous hook after automatic resizing. |
| `dispose(ctx)` | Optional synchronous hook, once per renderer instance before core removal. |
| `audio` | Optional capture-owner controller definition: `{schema, update(frame,state), dispose(state)?}`. |

Generators are unsupported. Drawing/disposal/audio hooks must not be async. A synchronous hook returning a Promise is also inappropriate except preload/setup; async work must honor cancellation and explicitly handle rejection.

```js
params: [{ key: 'speed', label: 'Speed', min: 0, max: 4, step: 0.1, default: 1 }]
```

All six fields required. `key`: starts with ASCII letter, then letters/digits/underscore/hyphen, max 64; no `constructor`/`prototype`/`__proto__`. `label`: nonblank max 80. All numbers finite with absolute value <= 1,000,000; min <= max, step > 0, default inside range. Read `ctx.params.speed` on every draw; do not copy once during setup. The host maintains mutable parameter banks across live edits, cue/take, preview and output. Do not write directly to them to change UI state.

## Renderer context and cleanup

| Member | Meaning |
|---|---|
| `p` | Actual VizCore instance, full existing rendering API, no proxy/security membrane. |
| `params` | Current host-owned parameter object. |
| `state` | Fresh mutable object for this renderer instance; separate for each output, CUE, preview and projection child. |
| `controls` | Compact audio binding. `read()` returns continuous/arrays and freshness; `consumeEvents()` drains fresh events once. |
| `onCleanup(fn)` | Register synchronous cleanup, reverse order, once. If already disposed, runs immediately. |
| `signal` | AbortSignal aborted before dispose/cleanup. Async work must check it before using p/state/resources. |
| `assetURL(filename)` | Promise of a blob URL from this generation's real folder. Immediate filename only, no paths. Automatically revoked on disposal. Does not execute JS. Permission errors instruct reconnect. |
| `createCapture(constraints, callback?)` | Output's shared camera factory (selected camera device), fallback to VizCore capture outside ProgramRuntime. Use instead of opening your own stream. |
| `videoDeviceId` | Selected output device ID, null in control preview. |
| `runtime` | Existing integration callbacks: `audioSlot`, `audioControls`, `createCapture(p, constraints, callback)`, `isPaused()`, `addPlaybackLifecycle({pause,resume})`, `reportMediaReady()`, `reportMediaSettled()`, `addCleanup(fn)` where supplied. Some are absent in embedded preview; use optional chaining. Prefer `ctx.onCleanup` for portable teardown. |
| `audio` | Existing legacy audio object, not a guaranteed raw capture stream in remote windows. For reliable audio use controller `shared` and renderer `controls`. |

The adapter handles canvas sizing, graphics mode, lifecycle error reporting, loop stop on draw failure and exactly-once cleanup. VizCore removal stops rAF, removes canvas/media/listeners and releases GL. You **must** clean up timers, external listeners, fetched resources, workers, offscreen Graphics, raw GL resources and manually owned MediaStreams. Do not remove the host canvas, replace the host draw loop or use page reload as cleanup. Do not allocate on every frame. Disposal also happens on ordinary pattern switches, not just script reload.

```js
setup({state, onCleanup, signal}) {
  state.count = 0;
  const timer = setInterval(() => state.count++, 1000);
  onCleanup(() => clearInterval(timer));
  window.addEventListener('online', () => { state.count = 0; }, {signal});
}
```

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

## Audio controllers

Audio interpretation happens on the capture owner, once per runtime slot. The renderer receives compact validated controls, avoiding separate audio analysis in output/preview windows.

`audio.update({frame, shared, params, deltaSeconds, captureTime, sequence}, state)` returns `{continuous?, arrays?, events?}`. Missing containers default empty. State is per controller, with seeded `state.rng()` supplied by the engine. Use `deltaSeconds`, not an assumed cadence. Dispose is called when retired/reloaded. All numeric values must match schema; errors are reported and neutral output is substituted.

- `shared.getByteFrequencies()` → `{left,right}` byte-frequency arrays (0..255).
- `shared.getByteWaveforms()` → `{left,right}` byte-waveform arrays.
- `shared.getFeatures()` → existing shared feature snapshot; inspect `src/sketches/audio-features.js` and `src/pattern-audio-engine.js` for detailed feature contract. Do not mutate shared arrays.
- `continuous`: max 64 keys, each `{min,max,neutral}`. Values interpolate/decay toward neutral when packets go stale.
- `arrays`: max 64 keys, each `{min,max,minLength?,maxLength?}`. Return numeric typed arrays; max 512 elements each. Not ordinary JS arrays.
- `events`: max 64 declared types, each `{fields:{field:{min,max,required?,integer?}}}`. Return max 16 events per packet, each `{id:'unique-per-controller',type:'declared-type',...numericFields}`. Do not use `id` or `type` as a field name. Use monotonically increasing IDs for new events. Render with `consumeEvents`, not repeated playback from persistent state.
- `schema.neutral` may supply `{continuous,arrays}` overrides, validated against the schema. Arrays use typed arrays.
- Keys start with an ASCII letter then letters/digits/underscore/hyphen (max 64). Unknown schema fields, invalid ranges, hook types and neutral values fail registration. All values finite within absolute 1,000,000. Runtime payload validation is also enforced by the existing protocol.

See the inline `audio.viz.js` example below for a working parameterized spectrum + continuous level + one-shot pulse implementation.

## Examples and normal host features

Save any complete example below as its named file in your linked folder, then explicitly Open Script. Optional downloadable copies are also in `public/docs/custom-script-examples/`; navigation is not required. Files can coexist (unique IDs).

| File | Capability |
|---|---|
| `drawing.viz.js` | 2D shapes, text, transforms, HSB, parameters, image pixels, offscreen buffer and cleanup |
| `mesh.viz.js` | WebGL meshes, rotations, lighting |
| `shader.viz.js` | GLSL, fullscreen quad, animated uniforms, offscreen texture |
| `audio.viz.js` | Capture-owner controls, frequency arrays, events, parameters |
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
  id: 'custom-audio', name: 'Audio controls / spectrum / events',
  params: [{ key: 'gain', label: 'Gain', min: 0, max: 4, step: 0.1, default: 1 }],
  audio: {
    schema: {
      continuous: { level: { min: 0, max: 1, neutral: 0 } },
      arrays: { spectrum: { min: 0, max: 1, minLength: 32, maxLength: 32 } },
      events: { pulse: { fields: { strength: { min: 0, max: 1, required: true } } } },
    },
    update({ shared, params, deltaSeconds }, state) {
      const freqs = shared?.getByteFrequencies?.().left || [];
      const spectrum = new Float32Array(32);
      for (let i = 0; i < 32; i++) spectrum[i] = Math.min(1, ((freqs[i * 4] || 0) / 255) * params.gain);
      const level = spectrum.reduce((sum, x) => sum + x, 0) / 32;
      state.elapsed = (state.elapsed || 0) + deltaSeconds;
      const events = [];
      if (level > 0.3 && state.elapsed > 0.2) {
        state.elapsed = 0; state.count = (state.count || 0) + 1;
        events.push({ id: `pulse-${state.count}`, type: 'pulse', strength: level });
      }
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
