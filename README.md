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
  runs only for an enabled, non-identity mapping. CSS mapping remains the
  hit-testing/failure fallback; disabling mapping releases the extra GPU resources.

## 🧪 Testing

```bash
npm test            # Playwright E2E suite
npm test -- tests/screen-mapping*.spec.js --workers=1  # Mapping + pixel coverage
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
