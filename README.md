# ahLOOKah

**Realtime, audio-reactive VJ visuals for the browser.**

ahLOOKah turns live audio into a fullscreen visual show — a library of
ready-made p5.js sketches spanning rhythmic beat-driven patterns, cinematic
GPU shaders, neon/laser looks, glitch effects, and camera-input video FX. A floating
control panel (a second window) drives everything in realtime: tweak
parameters, morph between effects, key patterns to the number row, and take
cues live with zero blank gaps.

## ✨ Features

- **Audio-reactive sketch library** (plus non-reactive Simple patterns such as Checkerboard and Simple Circle) organized into themed groups:
  *Simple* (first), *Rhythmic*, *3D*, *Cinematic / Shaders*, *Neon / Lasers*, *Video FX*,
  *Glitch / Effects*, *Basics*, and *Alphas* (grayscale-on-black looks built for
  Alpha Blend projection mapping).
- **Dual-window architecture** — a fullscreen output window plus a control
  panel window, synchronized over `BroadcastChannel` (no server state).
- **Live parameter control** — every sketch exposes sliders (bass/mid/high
  responsiveness, kick thresholds, particle counts, shader uniforms…)
  broadcast to the output in real time.
- **Pattern pad & keyboard shortcuts** — assign up to 10 sketches to keys
  `1–9` / `0`; press `/` to jump to the library search box. Layout, favourites,
  and collapsed groups persist in `localStorage`.
- **Searchable library** — filter all groups by pattern name, id, group,
  description, or type keyword (`camera`, `media`, `projection`). Matching groups
  expand automatically while you type; clearing the box restores your collapsed
  groups exactly as they were.
- **Favourites** — star any pattern to pin it in a **Favourites** group at the
  top of the library (in the order you added them). Stars live on the library
  items only, so the pad, key assignments, and pattern order stay untouched.
  Favourites travel with exported settings.
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
- **Projects** — the app menu's **Save Project** writes a whole project
  (parameters, pad order, EQ/noise floor, screen + projection calibration, media
  references and the identity of each linked Scripts / Node Patterns / Media
  directory) to a file you choose, **Open Project** brings one back anywhere, and
  **New Project** clears this browser to start fresh. On the computer it came
  from, the linked directories resume without re-linking; on another computer a
  blocking dialog links each missing directory before the project completes.
  Missing *files* never block: those patterns are marked red in the library and
  pad. Media files are never copied.
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
- **Find a pattern** — press `/` (or click the search box) and type. Terms are
  case-insensitive and all of them must match, so `video glitch` narrows the
  list. Every matching group is revealed while searching; `Esc` in the field
  clears the query, then leaves the field.
- **Favourite a pattern** — click the ☆ at the right of any library item. It
  turns ★ and the pattern is pinned in the **Favourites** group at the top of
  the library; click it again to remove it. Favourites are per-browser UI state
  (like collapsed groups), never a saved pattern parameter, and they are
  included in settings export/import.
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

### Pattern library search and favourites

The search box sits above the scrolling list, so it stays visible while you
scroll. Matching is case-insensitive across each pattern's name, id, group,
description, and type keywords: `camera` finds every Video FX pattern, `media`
the loaded image/video patterns, `mapping` the projection patterns. All
whitespace-separated terms must match (`video tiles` narrows instead of
widening), a count line reports how many patterns matched, and an empty result
offers **Clear search**. Groups that match are expanded while the query is
active; your saved collapsed groups are never overwritten.

**Favourites** are starred with ☆/★ on each library item and pinned in a
**Favourites** group above the themed groups, in the order you added them. The
mirror is hidden while a query is active so a search result never appears twice.
Patterns stay in their own group as well, so pad keys, drag-and-drop ordering,
and CUE/Shift-click behave identically in both copies. Stored ids are kept as
stable pattern ids (`localStorage` key `viz2_library_favourites`), so they
survive reloads and travel with exported settings; an unreadable value simply
falls back to no favourites.

While the search field (or any text field) has focus, `Enter` and `Esc` belong
to that field: `Enter` cannot take a staged CUE live and `Esc` cannot cancel it
by accident. Move focus out of the field first for those CUE gestures.

### Replacement VJ patterns and camera FX

The library ships the older entries (including Ion Tempest and Checkerboard)
plus Simple Circle, 8 replacements, and 7 expansion patterns with 2 restored
legacy camera looks. The rejected 60-pattern expansion is removed, not hidden.
Category labels/order, Media, custom Projection Mapping, and older
controls/renderers are unchanged. (Historical inventory digests from that
migration are archived under `docs/history/`; current contracts live in
`tests/catalog/` and the scoped cohort specs.)

**Simple Circle** (Simple group) is the smallest drawing in the library: one filled
circle dead centre on black, with exactly two sliders — **Radius** (1 = the circle
fills the shorter screen edge) and **Hue**. Like Checkerboard it is deliberately not
audio reactive, so it is a steady base layer for merge/Alpha Blend and a handy
calibration target when aligning a projector.

| Group | Replacement patterns |
| --- | --- |
| Simple | Truchet Relay |
| Rhythmic | Membrane Modes |
| 3D | Voxel Cascade, Gyro Lattice |
| Cinematic / Shaders | Schlieren Flow, Tidal Glass, Godray Forge |
| Neon / Lasers | — |
| Video FX | — (older camera effects and the restored pair remain) |
| Glitch / Effects | Bitplane Rewire, Riso Misprint, VHS Head Switch, DCT Blocks |
| Basics | Test Card |
| Alphas | Iris Diaphragm, Cellular Gate, Blinder Matrix |

Every replacement has independent **Bass / Mid / High Responsiveness** controls.
Zero disables exactly that band, including with other bands active. The sliders
scale capture-side bands before bounded geometric mapping; they are not brightness
knobs. Hover a pattern for its three structural mappings. Baseline animation has
its own Motion Speed and never fabricates audio during silence.

The retained replacements combine Canvas2D mechanisms, projected 3D faces,
independent shader fields, and a bounded glass raymarch. The remaining camera
effects use the existing output-window capture lease and remain placeholders in
the control preview, not additional camera captures.
Alphas output opaque white/gray-on-black; the existing projection **Alpha Blend**
keys black out (it is not a proportional luminance-to-opacity conversion).

See [design, research and validation](docs/replacement-mission.md). Reproduce the
synchronized animated A/B evidence without running the whole suite:

```sh
PLAYWRIGHT_PORT=5273 npx playwright test tests/replacement-*.spec.js --workers=2 --output=test-results/replacement-run
python3 scripts/replacement-contact-sheets.py # optional, requires Pillow
```

Artifacts live in `test-results/replacement-evidence/` (ignored by Git): two
contact sheets, two short silent A/B/difference GIFs, per-pattern PNGs, metrics,
and an HTML gallery. `REPLACEMENT_ARTIFACTS` overrides the test evidence directory.

**Checkerboard is deliberately not audio reactive.** It defaults to stationary
black-and-white squares and exposes cell size, two hues, saturation, lightness,
and optional manual drift. It ignores old saved audio-pulse settings and audio
loss cannot move it. Static frames reuse a cached tile without repainting the
canvas; manual changes and resize still update live.

### Projection mapping patterns

In **Pattern Library → Projection Mapping → ADD**, name your pattern. In the
third column, click **Add mapping** to open the mapping editor. New mappings
default to **Checkerboard** from the **Simple** category for easy alignment. Give
it a name (for example, “Left wall”), keep Checkerboard or choose another source,
and position its corners. Existing mappings keep their chosen sources. Images
and videos loaded through the Media library are also
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
parameters, including across layout/source changes and CUE/TAKE. The **Alphas**
library group is purpose-built for this mode: three grayscale-on-black mattes
(Iris Diaphragm, Cellular Gate, Blinder Matrix) whose brightness
reads as opacity once the black background keys out.
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

### Performance budget and media playback

LIVE patterns show CPU-budget badges in the pad/library and on individual mapping
rows. The parameter panel adds a budget bar and output FPS; the status line shows
the total. These are main-thread rendering measurements against a 16.67 ms target,
**not GPU or video-decoder utilization**. CUE is measured once taken LIVE, and
stale measurements disappear automatically.

Mapping passes are bounded to each surface, full-frame edge smoothing has a
single-sample fast path, and unchanged images/video frames reuse their existing
textures. Warped/minified surfaces keep 4×4 antialiasing; output resolution is not
reduced. Parked CUE videos pause decoding until resumed. See
[performance findings and benchmark](docs/render-performance.md) for details and
hardware limitations.

## 🧪 Testing

```bash
npm test                         # Fast core: 21 tests (also npm run test:core)
npm run test:smoke               # 26 tests: critical journeys + one pattern per group
npm run test:full                # Everything, including edge cases and performance
npm run test:patterns            # Exhaustive individual-pattern tests, on demand
npm run test:full -- tests/expanded-patterns.spec.js --workers=1
npm run test:full -- tests/new-effects-smoke.spec.js --grep liquid-chrome
npm run test:full -- tests/settings-portability.spec.js --workers=1
npm run test:full -- tests/project-relink.spec.js --workers=1
npm run test:full -- tests/library-search.spec.js --workers=1
npm run test:full -- 'tests/screen-mapping*.spec.js' --workers=1
npm run test:full -- tests/projection-mapping.spec.js --workers=1
npm run test:full -- 'tests/*performance.spec.js' --workers=1
PLAYWRIGHT_PORT=5273 npm test     # Isolate a worktree from another server on 5173
```

Docs screenshots (`public/docs/shots/*.jpg`) are regenerated on demand with
`node scripts/docs-screenshots.mjs`. It boots its own isolated dev server, drives
the real control and output windows with Playwright (stubbing only the file
picker), and writes whole-window figures at 2× device pixels for the
`public/docs/*.html` pages — no cropped element shots, so the guide always shows
where each control lives. `DOCS_SHOTS_ONLY=nodes,projects` regenerates just those
scenario groups while iterating on a figure.

`test:all` and `test:e2e` remain aliases for the full suite. No tests are deleted
for speed: only explicitly tagged `@core` tests run by default. Untagged edge
cases, pixel/4K rendering, GPU recovery, performance budgets, and exhaustive
state combinations remain in the full suite. Use `test:full`, not `npm test`,
when targeting an entire file, otherwise the core filter still applies.

### Smoke coverage contract

The core budget is 20 critical behavior checks plus one library-group guard.
Smoke includes 17 of those 20 checks (85%, exceeding the 80% target), the guard,
and nine representative pattern renders. This is **selected behavior coverage,
not measured line/branch coverage**, nor exhaustive coverage of every edge case.

The shared checks cover startup, keyboard switching, pad assignment/persistence,
live sliders, embedded 2D/WebGL preview, device setup, live audio transport,
EQ crossover sync, audio-control interpolation/events, CUE/TAKE isolation,
CUE cancellation, merge activation/exit, post-processing, global screen mapping,
projection rendering/persistence/resize, media lifecycle, and singleton ownership.
Core additionally checks frequency/transient extraction, silence gating, and
noise-floor subtraction. Smoke leaves those three deeper audio checks to core.

`tests/smoke-patterns.js` selects one current pattern per built-in group.
Media and Projection Mapping are covered by their real lifecycle/render tests.
The registry guard fails if a group or representative becomes stale; the render
loop includes every representative even when it is not in the historical list.
Add `@core` / `@smoke` only to budgeted essential tests; new untagged regressions
are automatically included in the full suite without slowing the default run.

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

### Custom Scripts (desktop Chrome)

Choose a real local directory under **Custom Scripts**, write `.viz.js` files with
your own editor, then **Open Script** to activate one and **Reload** to pick up its
later edits. There is no create control in the app: the library only loads files
that already exist in the linked folder.
Scripts are trusted JavaScript, **not a sandbox**. The complete tutorial is
[Custom Scripts](public/docs/custom-scripts.html); the agent-facing contract is
[API v1](public/docs/custom-scripts-api.md), with runnable examples alongside it.

## Node graph patterns

Choose **ADD** (New Node Pattern) in the main **Node Patterns** category. The
dependency-free React/DOM + SVG editor composes source pixels through chained Blend
nodes, Color filters and a Transform image node, and wires scalar Script nodes into
any numeric parameter
(existing files that contain legacy Math nodes keep loading, rendering and saving).
Blend nodes offer TouchDesigner's Composite TOP operation list in two groups: 21
canvas modes the browser composites itself (Normal/Over, Add, Multiply, Screen,
Overlay, Darken, Lighten, Color Dodge, Color Burn, Hard Light, Soft Light,
Difference, Exclusion, Under, Inside, Outside, Xor, Hue, Saturation, Color,
Luminosity) and 15 modes with no canvas equivalent that run in the graph's shared
WebGL2 compositor (Subtract, Divide, Average, Linear Burn, Vivid Light, Linear
Light, Pin Light, Hard Mix, Negate, Reflect, Glow, Freeze, Heat, Darker Color,
Lighter Color). Opacity scales the layer only; a transparent base passes the layer
through instead of blending it against black; a mode without a GPU falls back to
Normal with a visible note rather than quietly rendering something else. The
**Transform** node moves, scales and rotates its input in X, Y and Z with true
perspective (nine mappable sliders, identity by default as a pixel-exact copy), and
blends its transparent surroundings like any other layer. See
[the mode and transform reference](docs/blend-modes-and-transform.md) for the
formulas, units and failure behavior.
Script nodes offer two languages: the new **body** language (`return`, `let`/`const`
locals with lexical block scope, `if`/`else`, comparisons, short-circuit `&&`/`||` and
`?:`, compiled once by Acorn-checked bytecode — no `eval`/`Function`, no loops, no
globals) and the legacy single-value **expression** language that graphs saved before it
still use unchanged. Sources are approved per exact text *and* language in this browser,
so an imported file can never carry trust with it.
The main **Node Patterns** category owns **Link Folder**, **Open Pattern**,
**Refresh folder**, and **New Node Pattern**. Select a graph, then use the sidebar’s
**Edit Pattern** to open it in the editor; the sidebar’s **Delete** removes it from
the library without touching the file on disk (Open Pattern restores it). One graph is edited at a time and the editor
replaces the main view in the same window — no popup, no tab rail, no draft list; its
toolbar **Back to Main** returns to the main app, asking first when the draft is dirty.
Reopening always loads the saved graph instead of reviving a hidden draft. The editor
reads that exact disk graph via shared handles, reports unavailable files
without a fallback, and focuses on editing, **Save**, and **Reload from disk**. A draft
saves before it is fully wired: an unconnected Output is kept, and reopens as saved. A draft
that *cannot* be saved is outlined in red — the editor and every offending node — with the
blocking reasons listed in the inspector, and its dependency manifest follows the graph, so
deleting the last node that used a removed or changed source clears the block. The
standalone `/?role=nodes&graph=<id>` URL remains the legacy compatibility path.
Disk-authoritative `.nodes.json` patterns stay synchronized across same-origin tabs. Browser storage holds handles and filename metadata only;
the open draft stays in memory. Confirmed overwrites update selected patterns, while
unsaved edits never change LIVE. See the [Node Patterns guide](public/docs/nodes.html) for connections,
shortcuts, source support, JSON dependency manifests and resource limits.

LIVE selections carry stable IDs for library clicks, pad slots and merges. If the
output has not loaded a selected node pattern yet, it retains the current output,
refreshes disk records and prepares the latest selection. A library refresh also
re-prepares an incoming selection instead of discarding the operator's choice.
Newer selections and CUE entry cancel pending LIVE requests; missing, invalid or
inaccessible files do not revive later without another selection.

The output's fresh-frame check accepts a drawn, current controls revision at least
as new as the requested one. Node modulation can advance that revision during
warm-up; waiting for the obsolete exact revision would time out while preview
keeps drawing. Draw receipts remain ordered across parameter, plan and audio
stream resets, without accepting stale packets or controls that have not drawn.

```sh
PLAYWRIGHT_PORT=5186 npx playwright test tests/nodes.spec.js tests/nodes-scalar.spec.js tests/nodes-script-body.spec.js --no-deps
# Deterministic cross-window disk/render race regressions, including output pixels:
PLAYWRIGHT_PORT=5186 npx playwright test tests/nodes-output-selection.spec.js --workers=2 --repeat-each=3
# Blend-mode table/shaders and the Transform node (identity, perspective, no-GPU fallback):
PLAYWRIGHT_PORT=5186 npx playwright test tests/nodes-blend-transform.spec.js --no-deps
```

The graph tests cover blend pixels (every canvas mode plus the exact WebGL2 mode
formulas, transparent operands and opacity), the Transform node (identity copy,
perspective projection, save/reload and a no-WebGL2 fallback that still draws the
picture), Color filter pixels (identity/alpha/chaining),
chained DAGs, scalar Script wiring with per-frame fanout and safe fallbacks, legacy
Math graphs (including clamp's third input) still loading/rendering/saving,
Script body language safety/budgets/scope/short-circuits, save/reload approval binding,
live audio → body script → mapping pixels,
real 2D/WebGL/projection/media/
custom sources, editor gestures, disk save/open/reload, permissions and overwrite safety, cross-tab library
updates, LIVE/CUE isolation, independent audio slots, resize and disposal.

### Linked library folders

Custom Scripts, Node Patterns and Media share **Link Folder**, then a **Linked**
badge beside the category name. The badge opens compact folder details with
**Refresh**, **Relink**, and **Unlink**. Full paths are not exposed by the browser.
Handles stay in IndexedDB; no server or new UI package is involved. Folder selection
requires desktop Chrome on HTTPS or localhost. Linking also remembers the directory's
project identity (see [Projects](#projects-save-project--open-project--new-project)), which is
what lets a saved project resume its folders without re-linking.

- **Custom Scripts:** **ADD** creates a starter `.viz.js` without overwriting an
  existing file. **OPEN** is still the explicit trust gesture, and linking never
  executes folder contents. Opening a saved project reopens the scripts it names
  whose code still matches the fingerprint it recorded; an edited, renamed or new
  file needs **OPEN** again. Scripts run with app privileges, not in a sandbox.
- **Node Patterns:** **ADD** opens a new editor. When linked, **OPEN** lists only
  direct-child `.nodes.json` files and adds the one you pick; linking a folder never
  loads it. Linked patterns remain disk-authoritative, including saves/conflicts.
- **Media:** **ADD** is the only path that creates a pattern. Linked, it lists the
  folder’s supported images and videos (excluding subfolders and audio/text files)
  in the in-app directory picker; unlinked controls keep the native picker/file-input
  fallback. Linking a folder and Refresh only re-point the media this library already
  has — matched by recorded name and id, never hashed — so a directory of clips never
  floods the library. Unlink keeps loaded media references.

`src/platform/folderAccess.js` shares permissions, filtered scans and safe child
resolution. `DirectoryPicker.jsx` shares loading/empty/error/selection states and
uses the same `Select` chrome as `ParamSelect`. `FolderControls.jsx` shares the
badge/details/actions. Background restoration never requests permission.

#### Projects (Save Project / Open Project / New Project)

The app menu has three project actions. The complete walkthrough, including what a
project file carries and how another computer re-links it, is the
[Projects guide](public/docs/projects.html).

- **Save Project** writes one JSON file — `ahlookah-project-YYYY-MM-DD.json` by
  default, at a **location and file name you pick** (File System Access save
  picker; a browser without it, or a location that refuses the write, falls back
  to a normal download of the same file). It contains every persisted setting plus
  a `folders` section for Scripts, Node Patterns and Media — `folderName`, a
  `folderId` directory identity, and the relevant `fileName` references (plus IDs
  for node/media patterns). It contains **no native handles, script source, graph
  source or media bytes**.
- **Open Project** opens such a file: the destination mirrors it, unlinking what
  the file omits. Each section is then resolved by directory identity. The native
  handle lives in IndexedDB under that `folderId` (`platform/project-folders.js`);
  the current id per section is machine-local (`viz2_project_folders`, deliberately
  never exported). So:
  - **Same computer** — a directory the project was saved from is adopted
    directly (name verified), Media files inside it are re-pointed automatically,
    and nothing is re-picked. Switching between projects therefore keeps every
    linked directory working.
  - **Another computer** — the id has no handle. A blocking `ProjectRelinkModal`
    lists each missing directory with **Link Folder** (and **Reconnect** when the
    directory is remembered but browser access expired). The project does not
    complete — no summary, no reload — until every directory is linked. A wrong
    folder name is an explicit error and is never silently substituted; a
    same-named folder is verified by identity first and only then by you.
  - **Missing files** inside a linked directory never block anything: the
    reference stays listed, the affected patterns are marked red in the library and
    pad (`Relink File` for media), and the section panel names the missing file.
  - **Scripts** are fingerprinted, not copied: for every script file the project
    lists, Save Project records a SHA-256 of the source **instead of the source
    itself**. On Open Project each listed file is re-read and, when its bytes still
    match, loaded automatically — so a project comes back with its custom patterns
    without re-opening anything, on any computer that has the same code in the
    linked folder. A file edited, renamed or added since is left for the explicit
    **OPEN**, with the panel saying which and why: `Changed since this project was
    saved: …` or `Open trusted script: … (this project recorded no code fingerprint
    for it)`. A project file still carries no code and no trust, and a listed file
    without a fingerprint never runs by itself.
  - **Only the files the project had** — the `folders` section names the files each
    section actually holds (node patterns and media by name + id, scripts by
    fingerprint), never a directory listing. Opening a project therefore restores
    exactly those and nothing else: files that merely exist in the linked folder
    stay out until **ADD**/**OPEN**. Media is matched by recorded name and id —
    never read or hashed — and a linked folder is never scanned into the library
    (`platform/folder-portability.js`, `nodes/repository.js`,
    `media/folderService.js`). Restoration resolves each recorded name directly, so
    a directory holding more files than the OPEN/ADD picker caps (64 node patterns,
    256 media files) still reopens a project's own files.
  - **Permission lapse** — if the browser wants the folder re-granted at startup
    (common after a restart), the startup message names the scripts waiting and
    **Linked → Refresh** both renews access and finishes the reopen; no second save
    or reload is needed.
- **New Project** clears this browser back to a fresh project: every
  project-scoped setting, all media patterns, the portable folder hints and the
  current directory identities, then it unlinks Scripts, Node Patterns and Media.
  It asks for confirmation first, refuses while a CUE is staged, and keeps the
  per-machine device choices and setup state. Remembered directory handles are kept
  (bounded, keyed by id), so re-opening an older project file still resumes its
  folders here without re-linking.

Node Patterns reuse the project's identity as the folder id, so node pattern ids
— and therefore pad slots, merges and parameter references — stay stable across
machines. Expired permissions require a user gesture (Linked → Refresh); renewing
access never runs anything by itself.

Old exports (`kind: ahlookah-settings`, version 1) still load and behave exactly
as before: no identities, so every linked folder is confirmed by hand. Legacy
individually opened files keep their filenames but require explicit re-opening.
Saving/opening a project and relinking never overwrite or delete source files.

Focused coverage (use a free isolated port):

```sh
PLAYWRIGHT_PORT=5188 npx playwright test tests/linked-library.spec.js tests/folder-linking.spec.js tests/settings-portability.spec.js tests/project-relink.spec.js tests/custom-scripts.spec.js --project=chromium --workers=2
PLAYWRIGHT_PORT=5188 npx playwright test tests/nodes.spec.js --project=chromium --workers=2 --grep 'disk persistence|new drafts save|stale drafts|denied save|outside picker|background reload|folder switch|category owns|linked folder text'
npm run build
```

### Internal node editor

Node Patterns **ADD**, **OPEN**, and **Edit Pattern** open the editor in place over the
main app view — no popup window, no right-side tab rail, no draft list. Exactly one
editor session exists: **Back to Main** in the editor toolbar returns to the main app in
the same browser window and unmounts the editor. Leaving or replacing a dirty graph (and
**Reload from disk**) asks for confirmation first, and leaving during a save is disabled.
Save adopts the repository ID and updates the main library and external output using the
existing repository notifications. The open draft is in memory only; nothing is retained
as a hidden second draft, so reopening reads the saved graph from disk.

The editor reuses `NodesEditor` and borrows the main runtime's AudioManager,
PatternAudioControlStore, and existing audio engine/clock directly. It does not create an
audio channel, capture, ownership handoff, or program canvas host. Main stays mounted at
the same dimensions, and external screen/output communication remains unchanged.
Unmounting the editor disposes its preview runtimes; the main runtime keeps rendering.

Media uses the existing same-document media store/cache and per-renderer playback
lifecycle, so leaving and reopening the editor reuses the persisted records (the editor's
own decoders may be recreated; main decoders keep playing). Independent graph
renderers still have independent video playback elements. Camera preview remains
an explicit placeholder: `SharedCameraSource` is owned by the separate output
screen and cannot be borrowed directly by the main document. Editors never open
a second camera capture. Legacy `?role=nodes&graph=…` URLs remain supported as the
standalone compatibility path; main app actions open the editor in place instead.

Focused validation (isolated dev-server port):

```sh
PLAYWRIGHT_PORT=5184 npx playwright test tests/nodes-internal.spec.js tests/nodes.spec.js tests/nodes-audio.spec.js tests/nodes-audio-background.spec.js tests/audio-input.spec.js tests/media-pattern.spec.js tests/control-panel.spec.js --workers=2
npm run build
```
