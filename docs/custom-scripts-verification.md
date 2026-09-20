# Custom Scripts UX revision — verification

## Scope

Inspected main (`16b33fc`) and the existing media management row in `ParameterPanel.jsx`, media removal in `runtime.js`, shared button styles, and modal conventions. Changes remain in the workspace branch; no merge or advisors.

- Unlinked state has one Link Folder button. Linked state has a compact right-aligned folder-name copy control, reload icon, unlink icon, and Open Script.
- Folder tooltips/copy use the full available folder name, never an invented native path. An unobtrusive note explains the Chrome limitation. Long names ellipsize without displacing icons.
- Open Script opens an app-styled native dialog with focus containment, Escape/Cancel, focus restoration, trust warning, file selection, and inline validation errors. Choosing an option is inert; Open validates/activates it.
- Linking/browsing only enumerate filenames. Folder reload reads/evaluates opened files only; per-file reload evaluates only that file. Other selected definitions remain last-good. No file creation, writing or disk-delete workflow remains; folder permissions are read-only.
- Reload and Delete are in Parameters, following the media management row. Delete confirms library removal of all patterns from that source and preserves the physical file. Reload/restart do not reopen deleted items.
- Folder handle, explicit opened source selection, and last-good text persist atomically in one IndexedDB snapshot. Unlink publishes an empty generation, retires runtime resources via the existing reconciliation path, and remains unlinked after restart. Legacy autoload snapshots are not executed; users explicitly open their scripts once after upgrading.
- Existing syntax/definition validation, built-in/media/projection protection, CUE/TAKE cancellation, parameter reconciliation, cleanup and cross-window snapshot restoration are retained.
- `public/docs/custom-scripts.html` now includes the full reference and all eight complete examples inline, with anchor navigation. `custom-scripts-api.md` is a complete single-file agent reference including the same examples. Standalone example downloads remain optional, and tests compare them against both inline copies.

## Final checks

```sh
PLAYWRIGHT_PORT=5194 npx playwright test tests/custom-scripts.spec.js tests/docs.spec.js tests/cue-mode.spec.js tests/media-pattern.spec.js --project=chromium --workers=2
```

**63 passed, no failures/skips/retries:** 23 custom-script tests, 19 documentation tests, 20 CUE tests, 1 media test. Coverage includes selected-only loading (unopened throwing and syntax-invalid files), per-file execution isolation, modal cancel/retry/focus restoration, truthful folder copy/long-name layout, absence of Create UI, Delete cancellation/source preservation, reload and restart selection persistence, unlink cleanup across control/output and late output, stale TAKE prevention, permission/role guards, legacy snapshot migration, syntax/definition/storage rollback, protected IDs, projection/parameter reconciliation, all eight rendered/disposed examples, complete inline docs and valid anchors.

```sh
npm run build
node --check src/custom-scripts/service.js
node --check src/custom-scripts/storage.js
node --check src/input/KeyboardController.js
node --check tests/custom-scripts.spec.js
node --check tests/docs.spec.js
git diff --check
```

After the 63-test run, a CSS-only change restored the file select's native dropdown arrow. The UI test was rerun with `PLAYWRIGHT_PORT=5194 npx playwright test tests/custom-scripts.spec.js -g 'selection modal' --project=chromium --workers=1` (1 passed), followed by another successful build and `git diff --check`.

Build and syntax checks passed. Vite reports a non-blocking bundle-size warning (main JS chunk above 500 kB). No lint/typecheck script exists in package.json. The initial UI test caught incorrect focus restoration after Escape; fixed before the successful final run. Screenshot review caught the generic config-panel button rule overriding folder width/case; fixed with scoped selectors and regression assertions.

## Screenshot evidence

The selection-modal UI test writes these review artifacts under `test-results/custom-scripts-Custom-Scri-0ffa3-opy-unlink-and-no-Create-UI-chromium/`:

- `unlinked.png`
- `selection-modal.png`
- `linked-parameters.png`

Screenshots were captured from the real rendered browser UI; the native OS directory picker was mocked, not the application UI. Folder-name alignment and modal screenshots were visually reviewed and uploaded to the chat. Test artifacts are intentionally not committed.

## Limitations / remaining manual verification

- Automated filesystem tests use real OPFS-backed handles/bytes and IndexedDB cloning to avoid automating an OS picker. Production still uses the native File System Access picker, not OPFS. Actual OS-folder selection, browser-restart permission persistence/revocation, and external-editor saves need a desktop Chrome manual pass.
- Trusted scripts are not sandboxed. Syntax/definition rollback does not undo arbitrary top-level side effects, infinite loops, or hook/GLSL failures after activation. Window synchronization remains eventual, not a distributed transaction.
- No full repository suite or independent mapping suite was rerun for this focused UX revision; custom-script projection reconciliation, CUE and media integration were included above.
- Chrome does not expose absolute native folder paths; folder-name copy is the deliberate fallback.

## Changed files

- `src/components/control/CustomScriptsPanel.jsx`
- `src/components/control/ParameterPanel.jsx`
- `src/custom-scripts/service.js`
- `src/custom-scripts/storage.js`
- `src/input/KeyboardController.js`
- `src/styles/index.css`
- `public/docs/custom-scripts.html`
- `public/docs/custom-scripts-api.md`
- `public/docs/docs.css`
- `tests/custom-scripts.spec.js`
- `tests/docs.spec.js`
- `docs/custom-scripts-verification.md`

The pre-existing `.okbrain/workspace-init.log` modification was left untouched.
