# ahLOOKah

**Realtime, audio-reactive VJ visuals for the browser.**

ahLOOKah turns live audio into a fullscreen visual show — a library of
ready-made p5.js sketches spanning rhythmic beat-driven patterns, cinematic
GPU shaders, neon/laser looks, glitch effects, and camera-input video FX. A floating
control panel (a second window) drives everything in realtime: tweak
parameters, morph between effects, key patterns to the number row, and take
cues live with zero blank gaps.

## ✨ Features

- **Audio-reactive sketch library** organized into themed groups:
  *Rhythmic*, *3D*, *Cinematic / Shaders*, *Neon / Lasers*, *Video FX*,
  *Glitch / Effects*, and *Basics*.
- **Dual-window architecture** — a fullscreen output window plus a control
  panel window, synchronized over `BroadcastChannel` (no server state).
- **Live parameter control** — every sketch exposes sliders (bass/mid/high
  responsiveness, kick thresholds, particle counts, shader uniforms…)
  broadcast to the output in real time.
- **Pattern pad & keyboard shortcuts** — assign up to 10 sketches to keys
  `1–9` / `0`; your layout persists in `localStorage`.
- **CUE mode** — `Shift+click` (or `Shift+1–0`) warms the next program in a
  hidden renderer, then `Enter` takes it live instantly. `Esc` cancels.
- **Dual-effect merge** — blend two sketches with a crossfade or additive
  compositing, layered by the GPU instead of per-frame pixel readback.
- **Band-split EQ** — drag bass/mid/high crossover handles to reshape how
  audio drives the visuals.
- **Post-processing trim** — global brightness / contrast / saturation.
- **Screen mapping (opt-in)** — software keystone for projectors: enable it in
  the Screen Mapping section, then drag the four corners while watching the
  projection until the picture forms a true rectangle that fills your physical
  screen. Off by default (full-frame output).
- **Projection mapping patterns** — add reusable patterns containing up to eight
  named, independently warped surfaces. Assign any ordinary pattern, image, or
  video; edit its controls independently in the third column. Projection patterns
  bypass the global screen calibration without deleting it.
- **Camera-input FX** — chroma key, kaleidoscope, pixelate, trails, and more
  (opt-in via browser permissions).
- **Pattern audio engine** — beat/band-driven control with kick/snare/hat
  transient detection.

## 🧰 Tech stack

| Layer | Choice |
| --- | --- |
| UI | React 19 + in-house vanilla store |
| Build | Vite 8 |
| Visuals | p5.js 2.x (2D + WebGL shaders) |
| Audio analysis | Web Audio API (FFT, band energy, transient detection) |
| Cross-window sync | `BroadcastChannel` |
| E2E tests | Playwright |

## 🚀 Getting started

```bash
npm install
npm run dev        # start the dev server
```

Open the printed URL — the app opens a **control window**. Use the
**Open Output** button to launch the fullscreen screen window. Audio from
your system (or an attached device) drives the visuals; pick a device in the
control panel if you have multiple inputs.

### Build & preview

```bash
npm run build       # production build to dist/
npm run preview     # serve the production build
```

Or run everything with one script (builds, frees the port, serves on `PORT`,
default 3000):

```bash
./run.sh
PORT=8080 ./run.sh  # custom port
```

## 🎮 Usage

- **Select a pattern** — click it in the library, or press its pad key
  (`1–9`, `0`).
- **Adjust parameters** — drag any slider; changes apply live on the output.
- **Cue a pattern** — `Shift+click` (or `Shift+1–0`), then `Enter` to take it
  live, `Esc` to cancel.
- **Merge two effects** — toggle merge mode and pick a second sketch; use the
  Blend / Additive slider to crossfade or layer.
- **Remap the pad** — reorder sketches in the pattern library; the pad and
  keyboard shortcuts follow.
- **Screen mapping** — enable the four-corner output mapping for projector
  keystone correction. Mapped output uses a WebGL2 4×4 subpixel sampling pass
  (16 samples per physical output pixel) to antialias sloping edges and gaps,
  after merge and post-FX. It keeps sketch backing resolutions unchanged and
  runs only when mapping is enabled and the quad is warped or edge blurring is on.
  **Edge blurring** (0–25%) gently fades all four edges into black; higher values
  widen the blend without softening the picture itself. At 0% it is off. The
  setting persists with your screen calibration, including across CUE/TAKE, and
  works in full-frame mode too. CSS mapping with an edge mask remains the
  hit-testing/failure fallback; disabling mapping releases the extra GPU resources.

### Projection mapping patterns

In **Pattern Library → Projection Mapping → ADD**, name your pattern. In the
third column, click **Add mapping** to open the mapping editor. Give it a
name (for example, “Left wall”), choose a source pattern, and position its corners. Images and videos loaded through the Media library are also
available. Mapping patterns cannot contain other mapping patterns.

In the popup, drag the four corner handles to place each surface, or open **Corner positions
(%)** for exact coordinates. Focus a handle and use arrow keys for fine placement
(Shift for larger steps). Each mapping has its own complete source-parameter
group, even when multiple mappings use the same source. Corner changes update the
output **in real time**, and valid name/source/corner edits save automatically.
**Edge smoothing** softens each mapping's four edges using the same feathering as
screen mapping (0–25%; off by default), without blurring the picture. It saves
with the mapping, survives source changes, and works in both GPU and CSS fallback.
Overlapping mappings blend through their softened edges; interiors remain opaque by default.
Enable **Alpha Blend** in the projection pattern's panel to make black areas
transparent, revealing earlier mappings or the pattern behind it in a merge.
Non-black colors retain their color and existing transparency; unmapped areas are
transparent too. This mask works in the output, preview, and CSS fallback, and
combines with edge smoothing. It defaults to off and persists with the pattern's
parameters, including across layout/source changes and CUE/TAKE.
Name a new mapping to create it; an unnamed mapping is not added. **Close** or
Escape keeps your changes—there is no separate Save or Cancel. The popup contains no
source parameters. In the sidebar, each mapping has **Edit** and **Remove** actions;
click its title to reveal or hide its parameters (collapsed by default). **Drag a
pattern from the library or pad onto a collapsed mapping** to replace its source
without opening the editor. The mapping stays collapsed and keeps its name,
corners, and edge smoothing; the pad order is unchanged. Source changes are
unavailable during CUE. Newly assigned sources start from that source's current
settings; later edits remain independent.

Layouts and parameters persist locally and sync across the control/output
windows. CUE updates the staged corners, edge smoothing and source controls in real time without
changing LIVE; TAKE applies them
atomically. Finish or cancel CUE before changing names, assignments, or structure.
If a replacement cannot start, the previous output stays intact and the third
column shows **Retry projection layout** (also **Retry output** inside the editor);
saved edits remain pending on the output until it can start successfully. Missing sources are flagged in the editor and render black (transparent with Alpha Blend); inaccessible files
show their existing permission/missing-file message inside their surface.

With **Alpha Blend off**, unmapped areas are black and later surfaces cover
earlier surfaces, including their black backgrounds. Global post-processing still applies. Projection patterns bypass
only their own global screen calibration. When merged with an ordinary pattern,
that ordinary input still uses the saved screen warp and edge blurring (including
antialiasing); its transparent or feathered areas reveal the other input. In mixed
programs, each input is mapped before the shared blend and post-processing. GPU
failure retains a calibrated CSS fallback. Camera sources render only on the
output. Each surface owns a renderer, so reduce surface count or shader complexity
if the projector machine cannot keep up (especially during CUE warm-up).

## 🧪 Testing

```bash
npm test            # Playwright E2E suite
npm test -- tests/screen-mapping*.spec.js --workers=1  # Mapping + pixel coverage
npm test -- tests/projection-mapping.spec.js --workers=1 # Projection patterns
```

Screen-mapping tests scan complete horizontal and vertical bar edges, including
intentional black gaps, at HD, 4K and high-DPI resolutions. They cover both the
software and GPU compositors (using SwiftShader in headless Chromium), as well as
resize, post-processing, merge and CUE transitions. An A/B raster test compares
fractional pixel coverage against the old CSS-only warp (binary edge-position
checks alone cannot detect aliasing). Colour checks cover transparent 2D/WebGL
sources, and lifecycle tests exercise noLoop sources, toggling and context loss.

## 📁 Project layout

```
src/
  app/              Runtime bootstrap, window identity & lifecycle
  components/
    control/        Control panel UI (library, pad, sliders, EQ, CUE)
    screen/         Fullscreen output stage
  input/            Keyboard controller (pad + CUE shortcuts)
  params/           Param repository & persistence
  platform/         BroadcastBus, singleton coordination, window roles
  program/          Program selection & rendering pipeline
  sketches/         The visual sketches + shared audio feature helpers
  state/            Vanilla store (createVizStore + vanillaStore)
  styles/           Design tokens & component CSS
  pattern-audio-*   Pattern audio engine, protocol & controls
docs/               Design docs (CUE mode, audio control plan, refactor)
```

## ⚡ Notes

- The app is a **front-end only** project — no backend. All state syncs
  between windows in the same browser via `BroadcastChannel`.
- Requires a modern browser (WebGL, Web Audio, `BroadcastChannel`).
- Webcam sketches request camera permission when selected.

## 📄 License

[MIT](LICENSE) © Arunoda Susiripal
