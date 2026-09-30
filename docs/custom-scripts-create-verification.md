# Custom Scripts ADD hand-off — verification

## Scope

Inspected `CustomScriptsPanel.jsx`, the shared folder controls/dialogs
(`FolderControls.jsx`, `DirectoryPicker.jsx`, `Select.jsx`), the Node Patterns and
Media ADD gating they established, `src/styles/patterns.css`, and the four specs
that pin the Scripts header contract. The linked folder stays read-only: this change
adds no file writing, no folder scan and no new storage.

## What changed

- **ADD beside OPEN.** Custom Scripts now carries the same linked-folder action pair
  as Node Patterns and Media: **ADD** then **OPEN**, both rendered but disabled with
  a one-line hint until a folder is linked — the established convention for this
  header, not a hidden control. OPEN is unchanged — it is still the explicit trust
  gesture that lists the folder and validates the file it opens.
- **`CreateScriptModal.jsx` (new).** A native `<dialog>` in the shared
  `key-map-modal-card` chrome that presents the hand-off to an external coding
  agent: the one-line promise (*ahLOOKah does not write code or files. Use a coding
  agent & then OPEN the created script.*) and links to the desktop apps of Codex
  (`openai.com/codex`), Claude (`claude.com/download`) and OpenCode
  (`opencode.ai/download`) — links, not install commands, because the operator
  installs and signs in themselves; then one line each to open the linked folder in
  a coding editor and to paste the copyable prompt. The closing line is only *The
  agent saves a `.viz.js` file. Once done, OPEN it as a script.* — the sandbox and
  Reload detail live in this document and in the OPEN trust dialog, not in the modal.
  It installs nothing, opens nothing and writes nothing — the app cannot perform any
  of those steps, and a first-time reader is told so in the first sentence.
- **Pattern / FX select.** The `Select` control switches both the prompt's task line
  and the reference it links: *Pattern* asks for a source-rendering script and
  starts at `https://ahlookah.com/docs/custom-scripts.html`; *FX (image input)*
  additionally requires `fx: { input: 'image' }` and drawing from `ctx.imageInput`
  and links `…#api-image-input-fx-opt-in-graph-contract` directly, because a
  connected image input — not a saved mode flag — selects FX at runtime.
- **Copy prompt.** Clipboard copy with an explicit failure line; switching kinds
  resets the button so the copied text always matches the visible prompt.
- **Docs.** `public/docs/custom-scripts.html` gains an *Add a script with a coding
  agent* section (TOC entry included) and the **image-input FX contract the FX
  prompt links**: an `Image-input FX (opt-in graph contract)` section plus the
  `fx`, `inputMode` and `imageInput` rows the page's tables were missing while
  calling itself the complete inline reference. Its API contract bullet no longer
  claims there is no ADD workflow. `public/docs/custom-scripts-api.md` documents the
  ADD hand-off and both prompt kinds, and `README.md` no longer claims the app has no
  create control or that ADD writes a starter `.viz.js`.

## Verification

```sh
PLAYWRIGHT_PORT=5194 npx playwright test --project=chromium --grep @core --workers=3
PLAYWRIGHT_PORT=5194 npx playwright test tests/custom-scripts.spec.js tests/linked-library.spec.js \
  tests/folder-linking.spec.js tests/docs.spec.js --project=chromium --workers=3
npm run build
node --check tests/custom-scripts.spec.js
git diff --check
```

**251 passed** on the full `@core` suite and **51 passed** on the focused
custom-scripts/docs run after the copy simplification, with no failures, skips or
retries. Build and `git diff --check` are clean (Vite's pre-existing
bundle-size warning is unchanged).

New coverage (`tests/custom-scripts.spec.js`, "ADD hands off to a coding agent once
a folder is linked"): ADD's disabled→enabled gate on the linked folder and the exact
`['ADD', 'OPEN']` header set; that the dialog carries the simplified one-line promise
and the one-line step 2 ("Open the linked folder as a project in your coding
editor.") with no folder name or absolute-path explanation, offers exactly three
agent links (`Codex`, `Claude`, `OpenCode` → their desktop app pages, all
`target="_blank"`) with no install commands anywhere in the dialog, and closes on
`The agent saves a .viz.js file. Once done, OPEN it as a script.`; that the Pattern
prompt carries the guide URL and its placeholder; that **Copy prompt** writes exactly
the visible prompt to the clipboard; that switching to FX swaps the task line to
`fx: { input: 'image' }` / `ctx.imageInput`, moves the link to the FX anchor and
requires a fresh copy; that the dialog fits inside a 1280×900 window without
scrolling; that Escape closes it, restores focus to ADD, and leaves the folder's
file list untouched. A new `tests/docs.spec.js` test pins the HTML page's
image-input FX contract (heading, anchor, `fx`/`inputMode`/`imageInput` rows and the
same wording the Markdown edition carries) so the FX prompt can never link a section
the page does not have. Updated pins: `linked-library.spec.js` button set,
`folder-linking.spec.js` Scripts header set and title, `custom-scripts.spec.js`
panel button counts (2 → 3), and the now-stale "Custom Scripts is Open-only"
comment in `nodes-audio.spec.js`.

## Screenshot evidence

`test-results/custom-scripts-Custom-Scri-*/create-script-pattern.png` and
`create-script.png` capture the real dialog (Pattern and FX) at 1280×900; the
agent links, folder name, prompt block and action row were visually reviewed.
Test artifacts are intentionally not committed.

## Limitations / remaining manual verification

- The dialog documents the hand-off only. Whether a given agent finds the folder,
  follows the prompt and writes a valid `.viz.js` file is external to the app and
  needs a manual pass with a real OS folder and a real agent.
- Clipboard copy is asserted through a stubbed `navigator.clipboard`; a real
  Chromium write needs a real click, which the automated test already performs but
  cannot verify end to end.
- Agents are third-party software with their own installers, licence and network
  behaviour; the app never installs, launches or supervises them, and the
  desktop-app links are documentation, not a managed dependency.
- The prompt links the deployed docs site, so the FX anchor resolves in production
  only once this `public/docs/custom-scripts.html` revision is deployed; locally the
  page's own anchor test proves the section and id exist.
