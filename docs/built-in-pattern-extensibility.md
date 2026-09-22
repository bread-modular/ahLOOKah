# Built-in patterns: one implementation and one focused test

**Status:** Implemented and verified (workspace 180, 2026-09-22). Simple Circle is the migrated pilot (`src/sketches/simple-circle.pattern.js` + `tests/patterns/simple-circle.spec.js`); the catalog foundation, discovery, contracts, and decoupled specs are landed.

**§7 extension probe — verified in an isolated project copy:** adding only `src/sketches/probe-dot.pattern.js` + `tests/patterns/probe-dot.spec.js` produced a 73-entry catalog with no registry/count/cohort/smoke/compat/README edit. Evidence: `validate-pattern-catalog` OK (73 built-ins); 22/22 passed (probe spec, `tests/catalog`, both cohort specs, smoke-selection); control-panel/library-search key specs passed unchanged; smoke `--list` showed 73 tests including `renders probe-dot`. Failure modes verified: duplicate IDs and filename/ID mismatches fail validation with origin + field diagnostics (exit 1). Full suites: `@core` 172 passed + 3 pre-existing failures (canvas-density Pendulum + linked-library scrollbar, confirmed identical on pristine base via stash); `@smoke` 25/25; `new-effects-smoke` 72/72 serial (parallel flakes under load are contention, not regressions); `npm run build` green with the catalog gate.

**Inspected baseline:** `62617ff`, including `8b59020` ("Add a simple circle."). Paths and line numbers below refer to that baseline.

## 1. Decision

An ordinary new built-in pattern should require exactly two authored files:

```text
src/sketches/<id>.pattern.js    implementation + its complete descriptor
tests/patterns/<id>.spec.js     focused behavior test
```

There is no registry import to add, total to increment, smoke-test list to extend, historical digest to update, or special insertion point to remember.

Achieve this with self-describing pattern modules, automatic discovery, a shared catalog contract, and tests of behavior rather than the current catalog size. Keep the existing renderer/controller interfaces and the mutable runtime registry. This is an extensibility refactor, not a new plugin platform.

The quoted agent accurately described the current obstacles. Those obstacles are not useful authoring conventions: a one-off preservation audit and duplicated inventory assertions have become permanent extension constraints. Fix the architecture rather than save the workaround as a project trick.

## 2. What the investigation found

### 2.1 The change fan-out is real

`8b59020` changed **10 files** to add Simple Circle: its implementation, its focused test, the central registry, README, five specs containing catalog totals, and a manually maintained smoke list.

| Source | Current coupling | Why an unrelated addition affects it |
| --- | --- | --- |
| [`tests/control-panel.spec.js`](../tests/control-panel.spec.js), lines 43–92, 257, 377 | Literal 72-item assertions, complete group-member lists, per-category counts | A correct new item changes totals and possibly an enumerated category. |
| [`tests/library-search.spec.js`](../tests/library-search.spec.js), lines 21, 37, 62, 158, 250–261 | `72`, `73` after favouriting, and `1 of 72 patterns` | Search/favourite behavior is coupled to catalog size. |
| [`tests/pattern-audio-all.spec.js`](../tests/pattern-audio-all.spec.js), lines 52–54 | Both total and unique-ID count must equal 72 | The test already traverses the library dynamically, but rejects growth first. |
| [`tests/replacement-inventory.spec.js`](../tests/replacement-inventory.spec.js), lines 9–34 | Global total, first-50 positioning, hashes, whole-app group order | A historical replacement mission governs unrelated future additions. |
| [`tests/expansion-inventory.spec.js`](../tests/expansion-inventory.spec.js), lines 10–25 | Global total and whole-app group order | Another historical cohort owns the same global assertions. |
| [`tests/new-effects-smoke.spec.js`](../tests/new-effects-smoke.spec.js), lines 7–61 | Handwritten `NEW_IDS` plus cohort spreads | A new implementation can be registered but omitted from render coverage. |
| [`src/sketch-registry.js`](../src/sketch-registry.js), lines 199–203, 1054–1076 | Implementation import and descriptor live separately; insertion comments mention the hash | Adding a file is insufficient to register it. |
| [`README.md`](../README.md), lines 154–157 | Claims 70 built-ins | The imported registry actually has 72, including the two restored camera patterns. Manual inventory prose has already drifted. |

There are exactly **five specs with current full-catalog total expectations**, plus the separate smoke-list edit. Merely centralizing the number would reduce edits but would not deliver the requested workflow.

### 2.2 The SHA check protects source bytes, not an extension contract

The replacement inventory test reads `src/sketch-registry.js` as text and hashes everything from `export const SKETCHES = [` up to `// Preserve all 50 older entries`. Inserting a descriptor anywhere inside that block, or changing its whitespace, changes the digest even if every existing pattern behaves identically.

The fixture also pins serialized descriptors for the original 50 entries and **54 implementation/helper files**. At the inspected baseline, all those digests match. `JSON.stringify` omits functions, which helps explain the extra source-block hash, but neither mechanism is a durable behavior test.

These constraints came from the preservation scope documented in [`docs/replacement-mission.md`](replacement-mission.md). They were useful evidence for that migration. They should not freeze current source layout or prevent ordinary maintenance of the older implementations.

### 2.3 Existing behavior the refactor must respect

- `SKETCHES` is **not just a built-in catalog**. Media, projections, and node patterns register at module load; custom scripts register through their service. These paths splice or append to the array. Do not freeze or replace the shared runtime array identity.
- Declaration order currently drives library order and default/fallback pad assignment. The first ten IDs are `circles`, `bars`, `techno3d`, `character3d`, `pulse-rings`, `particle-storm`, `chroma-mandala`, `starfield-rush`, `echo-ripples`, `laser-grid`.
- `getGroups()` combines catalog groups with `GROUP_ORDER` and always-present dynamic groups. Production currently ends with `Media`, `Custom Scripts`, `Node Patterns`, `Projection Mapping`.
- Favourites create a second **UI row**, not a second registry entry; that mirror is hidden during search. Dynamic user entries legitimately increase the search denominator.
- Camera patterns intentionally have a placeholder instead of a control-preview canvas. Their real camera/render path belongs on the output screen.
- Non-reactive patterns still use the compact controller transport. Simple Circle calls `runtimeContext.audioControls?.read()` for the consumed-revision barrier. `audioReactive: false` is not permission to bypass CUE/TAKE synchronization.
- Some Playwright specs import the registry in **Node**, while page evaluations import it through **Vite**. These include the replacement/expansion audio and inventory specs, `expansion-restored-camera.spec.js`, and `nodes-wire-selection.spec.js`. Automatic discovery must work before Node test collection as well as in the browser.

Relevant consumers are [`PatternLibrary.jsx`](../src/components/control/PatternLibrary.jsx), [`media-registry.js`](../src/media/media-registry.js), [`projection-registry.js`](../src/projection/projection-registry.js), [`nodes/registry.js`](../src/nodes/registry.js), and [`custom-scripts/service.js`](../src/custom-scripts/service.js).

### 2.4 Baseline verification, before changing code

Ran the following against the unmodified source and tests in an isolated workspace:

```sh
CI=1 PLAYWRIGHT_PORT=5579 npx playwright test \
  tests/replacement-inventory.spec.js tests/expansion-inventory.spec.js \
  tests/simple-circle.spec.js tests/control-panel.spec.js tests/library-search.spec.js \
  --project=chromium --workers=1 \
  --grep 'provenance|Simple Circle|renders a 10-slot|filters by name'
```

**Result: 2 passed, 3 failed.**

- Simple Circle's focused rendering/controller test passed.
- The search/filter/clear test passed.
- Both inventory tests failed on obsolete whole-app group expectations: they omit Node Patterns and expect a different placement of Projection Mapping.
- The control-panel inventory test failed on the same group-order drift. Its later Simple-group name list also omits Simple Circle by source inspection; that assertion was not reached in this run.

A separate Node inspection confirmed 72 unique built-ins, matching declaration/descriptor/file hashes, and that adding one unique in-memory descriptor produces 73 unique entries without damaging uniqueness. A whitespace-only change to the hashed string changes the digest. No source mutation was needed for those probes.

These are baseline failures, not evidence that Simple Circle's renderer is broken. This was a targeted investigation, not a full-suite run.

## 3. Authoring contract

### Pattern file

Each new `src/sketches/**/*.pattern.js` module exports a named `pattern` descriptor. Its file basename must be `<pattern.id>.pattern.js`. The implementation, controller, schema, parameter defaults, and metadata belong together; ordinary helpers may still be imported.

For example, the descriptor portion of a self-contained Simple Circle module would be:

```js
// src/sketches/simple-circle.pattern.js
// factory, createAudioController and AUDIO_CONTROL_SCHEMA are defined above
// in this same file using the existing implementation interfaces.
export const pattern = {
  id: 'simple-circle',
  name: 'Simple Circle',
  group: 'Simple',
  description: 'One centred circle on black, controlled by Radius and Hue.',
  audioReactive: false,
  camera: false,
  factory,
  audioTransport: 'pattern-controls',
  createAudioController,
  audioControlSchema: AUDIO_CONTROL_SCHEMA,
  params: [
    { key: 'radius', label: 'Radius', min: 0.02, max: 1, step: 0.01, default: 0.3 },
    { key: 'hue', label: 'Hue', min: 0, max: 1, step: 0.01, default: 0.6 },
  ],
};
```

This is a proposed export convention, not an implemented API. No extra registration JSON or companion descriptor file is required. Module evaluation must only define metadata/functions: DOM, capture, timers, GPU allocations, and per-instance mutable state belong inside the existing factory/controller lifecycle.

### Focused test

`tests/patterns/<id>.spec.js` is collected by the existing Playwright test directory. It asserts the pattern's intended behavior, explicitly resolves its ID through the real catalog, and renders through the shared fixture where appropriate. For Simple Circle that means geometry, colour, parameter changes, resize, opacity, and non-reactivity—not the number of other patterns.

Use `@patterns` for rendering cases and `@core` for inexpensive contracts as appropriate. One file may contain multiple tests. A generic authoring-contract check verifies that every new-style module has its matching spec; it does not pretend file existence proves meaningful behavior coverage.

A pattern needing new rendering infrastructure, a new transport feature, or assets can legitimately need more work. The two-file contract is for an ordinary pattern using existing capabilities, not a ban on necessary engineering.

## 4. Catalog architecture

### 4.1 Separate built-ins from runtime registrations

Introduce a pure `src/patterns/builtins.js` export, `BUILTIN_PATTERNS`. It contains only shipped patterns, performs no storage/DOM access at module evaluation, and has immutable catalog membership. Its dependency graph must not pull in runtime registration services. Keep `src/sketch-registry.js` as the compatibility facade:

```js
import { BUILTIN_PATTERNS } from './patterns/builtins.js';
export { BUILTIN_PATTERNS } from './patterns/builtins.js';

export const SKETCHES = [...BUILTIN_PATTERNS];
// Keep current helpers and dynamic registration calls after initialization.
```

Keep descriptor metadata read-only without freezing renderer/controller state. Runtime consumers retain the existing `SKETCHES` array reference and registration order. Built-in tests use `BUILTIN_PATTERNS`; live-library tests explicitly account for runtime entries. Do not classify built-ins by an ever-growing list of negated dynamic flags.

For the migration, extract the existing centralized declarations and replacement/expansion imports into `src/patterns/legacy-builtins.js`. This is a temporary adapter for old modules, not the place to add new ones. Move Simple Circle to the new convention immediately and remove its legacy descriptor. Other old modules can migrate later; the two-file authoring path does not require rewriting every renderer first.

### 4.2 Automatic discovery without breaking Node imports

**Selected mechanism: an ignored, automatically generated static ESM import module.**

Add one small Node utility, `scripts/generate-pattern-catalog.mjs`, which recursively discovers only `src/sketches/**/*.pattern.js` and writes `src/patterns/.generated/discovered.js`. Each import carries its repository-relative source path for diagnostics, and exports records containing that path and the module's named descriptor. Do not scan every `.js` file: this tree contains helpers and historical multi-pattern implementations.

The generator has no hand-maintained ID list, no count, and no parsing of descriptor source. Sort normalized paths, emit normal static imports, write only when content changes, and replace the file atomically. Do not swallow missing exports or import errors. The generated directory is ignored by Git and never requires a committed update.

Integrate generation **once**, at the actual entry points:

| Entry point | Required behavior |
| --- | --- |
| `vite.config.js` | Generate before returning the configuration, before app dependency scanning. Works for the existing dev/build commands and direct Vite invocation. |
| Vite development watcher | On matching file add/remove/rename, regenerate and request a full reload. Serialize/coalesce events; do not hot-replace an active renderer. Normal edits must also reach a freshly evaluated catalog. |
| `playwright.config.js` | Generate during configuration loading, before specs are imported and test cases enumerated. Covers all existing npm test aliases and direct `npx playwright test`, including `--list`. Do not rely on the web server or `globalSetup` to precede test collection. |
| Standalone Node tooling | Explicitly await the same preparation utility before dynamically importing the catalog; do not add a different discovery implementation. |
| Clean CI/build | Recreate the ignored file from a clean checkout, then validate the catalog in a fresh Node process before the production bundle is accepted. |

Preparation must not statically import the registry it is about to generate. A validation entry point generates first, then dynamically imports `builtins.js`; the shared assembler validates at import. During development the freshly reloaded browser module runs the same validation. Multiple processes must never observe a partially written generated module; identical concurrent preparation is harmless. Source mutation probes run in separate temporary project roots, not alongside a running test suite in the same root.

This preserves synchronous catalog availability at application boot and the current Node-side registry imports. It adds no runtime filesystem access, asynchronous selection phase, new dependency, or manual "generate before testing" instruction for normal contributors.

**Why not put `import.meta.glob` directly in the shared registry?** That would make the browser path depend on Vite transformation while the existing Node-side imports need a different loader or refactor. A generated ordinary ESM module lets both environments import precisely the same descriptors. Two adapters are possible, but unnecessary for this repository's current test setup. The trade-off is a small generated artifact whose clean-start and watcher behavior must be tested.

### 4.3 Validate once; reject silent omissions

A pure `assembleBuiltinCatalog(legacyRecords, discoveredRecords)` owns validation and ordering. Run it in Node contracts and browser initialization; reuse the result rather than validate per frame.

Reject with an ID, source path, and field-specific error:

- Duplicate IDs across either source, or duplicate discovered IDs; report both origins. Never "last one wins" or deduplicate away a broken entry.
- Malformed IDs, mismatched new-style filename/ID, reserved `__` IDs, and collisions with the runtime namespaces `media-`, `projection-`, `custom-`, and `nodes-`.
- Missing name/group/factory, invalid optional flags, or missing new-style description. Preserve supported legacy optional-field semantics rather than changing existing defaults during extraction.
- Duplicate parameter keys, non-finite bounds/defaults, invalid range/step, or an out-of-range default. Retain existing supported parameter metadata such as option labels.
- Missing compact transport/controller/schema. Validate controller outputs using the existing protocol helpers in tests; retain protocol limits rather than invent a second transport schema.

Empty parameter lists and `audioReactive: false` are valid. Camera effects still need their real lifecycle contracts. New built-ins cannot claim dynamic-only fields such as `media`, `projection`, `customScript`, or `nodesGraph`.

Do not catch a broken built-in and boot a smaller library. The failure should identify the broken module, not later surface as "expected 72, received 71".

### 4.4 Preserve intentional ordering, not source layout

Use a **closed compatibility-order list** of the pre-refactor IDs, captured once from the verified baseline. It is an ordering policy, not a registration list: it imports nothing and accepts no new entries for ordinary additions.

- Existing IDs retain their current relative order, including Simple Circle and restored camera entries.
- IDs absent from that closed list follow it in stable ID order, using a locale-independent comparison. Sorting must not depend on filesystem traversal, import completion, or a contributor picking the next sequence number.
- A missing compatibility ID is a compatibility-test failure; an additional ID is not. Renaming/removing a shipped ID is an explicit compatibility change, not an ordinary addition.
- Preserve current group-order policy, including appended unknown groups and always-present dynamic groups. Put its product contract in one dedicated test, not every historical cohort test.
- Declare the ten `DEFAULT_PAD_IDS` explicitly. Keep saved `viz2_slot_order` assignments and `viz2_effect_order` migration; fill missing slots from the default pad, then valid catalog entries. New library entries cannot silently reassign keyboard shortcuts.

This closed list is not another "72 patterns" expectation: it never grows when a new pattern is added. It can eventually be removed only as an intentional library-order change, separately from extension work.

## 5. Test ownership after the refactor

The goal is stronger relevant coverage with less unrelated coupling, not replacing every assertion with `toBeGreaterThan(0)`.

### 5.1 Shared contracts and real catalog coverage

| Test responsibility | Assertion |
| --- | --- |
| Assembler unit tests (`@core`) | Valid descriptor accepted; duplicate, invalid metadata, and reserved ID rejected; stable ordering regardless of input order. Small synthetic fixture counts are fine. |
| Discovery tests (`@core`) | Known fixture modules are found exactly once; helpers/specs are excluded; add/remove/rename regenerates imports; malformed exports fail; clean Node test collection works. |
| Source-to-catalog completeness (`@core`) | Independently enumerate matching source files and compare their paths/IDs to catalog records. Assert uniqueness against the resulting list length, not a magic total. Check the expected descriptor's factory/controller bindings, not function serialization. |
| Catalog/UI integration | In an empty user profile, compare the complete DOM ID multiset and each category's contents to the built-in catalog. Equal counts alone could hide a duplicate and an omission. |
| Full render coverage (`@patterns`) | Generate a named render test per `BUILTIN_PATTERNS` entry. Replace `NEW_IDS`; test additions are automatic. Keep fake camera setup, page-error checks, real output selection, and teardown. |
| All-pattern transport (`@patterns`) | Assert library/catalog ID equality, then traverse the expected catalog—not just whatever buttons happen to exist. Assert fresh controls and no retired full-frame messages. Preserve camera-preview exclusions and exercise camera output. |
| Pattern's own spec | Independently state its intended ID, metadata/params, and visible/behavioral contract. A module that was not discovered must fail this test. |

Do not use the rendered button count as both actual and expected. A registry omission could otherwise remove the pattern from both the UI and its generated tests. Independent filesystem coverage, a known-ID focused test, and a synthetic extension acceptance test close those gaps.

The bounded `@smoke` representative set is a different contract from full coverage. Keep deliberate inexpensive representatives for established categories; ordinary additions to those categories do not require changing it. For a newly introduced category, use a deterministic fallback representative until deliberately tuned. `smoke-selection.spec.js` must distinguish built-in categories from dynamic utility groups, including Node Patterns.

### 5.2 UI, search, favourites, and dynamic entries

Update the five affected specs and their titles/comments once:

- Control panel: compare catalog IDs and group contents; retain exact **ten-slot** assertions and fixed shortcut semantics. Category membership and camera badges come from descriptors, not fixed `12`/`9` counts or an exhaustive handwritten Simple list.
- Search: test query semantics with a small controlled descriptor fixture in the pure search tests, then test browser wiring with known patterns. Compute the UI denominator from expected runtime entries, not a copied literal or the status text itself. Do not duplicate the production search implementation as the test oracle.
- Favourites: assert the canonical catalog remains unchanged and the mirror contains exactly the requested IDs. If checking all rows, expected rows are canonical rows plus resolved favourites; during search there is no mirror.
- Dynamic-library cases: seed known media/custom/projection/node entries and compare against built-ins plus those explicit fixtures. Adding/removing runtime entries must not mutate `BUILTIN_PATTERNS`.
- Transport: catalog size is not a safety limit. Keep bounded packet/schema/controller assertions, including for non-reactive patterns.

Exact numbers are appropriate for product limits, a deliberately sized test fixture, and historical cohort membership. They are inappropriate as repeated assertions of an open-ended library total.

### 5.3 Retire historical source hashes from normal development

Remove the comment-delimited registry hash, current-source file digests, and serialized-descriptor hash loop from the normal replacement test. Do **not** regenerate their digests after moving code, move the same byte freeze onto `legacy-builtins.js`, or turn it into an opt-out developers must maintain.

Preserve the original inventory and mission evidence as an archive under `docs/history/`, with its baseline revision and corrected documentation links. Git and the archived artifact retain historical provenance; normal CI must test current contracts.

Retain useful protections as readable semantic tests:

- Pre-refactor IDs remain resolvable, with compatible persisted parameter keys/defaults and intentional group membership. Any intentional contract change updates the affected compatibility case, not a global digest.
- Replacement/expansion tests own their named cohorts and their audio, visuals, parameter bounds, and resource lifecycles. They assert their entries are present, not that the whole application contains only a fixed number of entries.
- Keep the existing deliberate removal/restoration policy as an ID-scoped regression: the two restored camera IDs are allowed, other retired IDs are not accidentally rediscovered. Deliberate reuse is a separate compatibility decision.
- Preserve default pad behavior, non-reactive behavior, output/preview policy, and function bindings with targeted assertions and render/controller tests. Do not substitute `typeof factory === 'function'` for verifying the right implementation.

Do not remove unrelated hashes used for node dependency signatures, script identity, or content integrity. This change concerns the replacement mission's whole-source freeze only.

### 5.4 Documentation

Remove manually maintained current-library totals and language such as "exactly two non-reactive patterns" from general feature prose. Keep named examples and genuinely historical measurements clearly scoped. If a complete current catalog is needed, render/generate it from descriptors without committing a second manually maintained inventory. Adding an ordinary pattern should not force a README edit.

## 6. Migration boundaries

The refactor itself necessarily touches shared files once. That is different from requiring every future pattern to touch them.

| Area | One-time change |
| --- | --- |
| `src/sketch-registry.js` | Keep facade/helpers/runtime registrations; initialize from pure built-ins; remove historical insertion markers. |
| New `src/patterns/` modules | Pure assembler/validation, built-in catalog, legacy adapter, closed compatibility order, explicit default pad policy. |
| `scripts/generate-pattern-catalog.mjs`, configs, `.gitignore` | Automatic, deterministic ESM preparation and development watcher; generated output untracked. |
| Simple Circle module/spec | Pilot the new self-contained export and filename convention while retaining the existing pixel/controller assertions. Remove duplicate legacy registration. Update direct imports in that focused spec as needed. |
| Five count-coupled specs | Catalog-relative UI assertions, ID-set coverage, scoped cohort contracts; resolve observed stale group assertions according to current product order. |
| `new-effects-smoke.spec.js`, `smoke-selection.spec.js` | Automatic full-catalog coverage, bounded representative smoke policy, dynamic-group distinction. |
| New catalog/discovery tests and shared helpers | Reusable contracts plus the synthetic extension test below. |
| Historical fixture/docs and README | Archive audit-only digests, preserve semantic compatibility tests, remove live count prose, document authoring once. |

Land the shared test/compatibility changes and catalog foundation as one coherent refactor, then migrate Simple Circle as the proof. Do not leave an intermediate "done" state that still requires a registry entry or count edit. Other legacy renderer migrations are optional follow-up work, not prerequisites for new patterns.

Before deleting digest gates, compare the old and new catalogs by existing ID: metadata, ordered parameters/defaults, controller/schema bindings, and ordering. Use function identity where extraction preserves the module; use the existing focused behavioral tests for a moved implementation. Preserve node dependency signatures by keeping ID/parameter content unchanged. No persisted IDs, storage keys, factory signatures, or audio protocol changes are proposed.

Run catalog contracts, the migrated focused test, control/search/favourite integration, all-pattern coverage, and existing CUE/TAKE, pad persistence, node, media, and projection regressions. Run the existing core/smoke/pattern suites and build before accepting implementation. Resolve or explicitly track baseline failures; do not present the investigation's failing baseline as a green suite.

## 7. Acceptance: prove the next addition costs only two files

The implementation is complete only when an automated extension probe demonstrates the authoring workflow, not just when existing tests pass.

Use an isolated temporary project copy with the real production generator, Vite config, and Playwright config. Add a tiny uniquely named `*.pattern.js` and its focused spec under the normal paths. Do not inject an extra descriptor through a special test-only registry API: that would bypass the discovery being tested.

| Scenario | Required outcome |
| --- | --- |
| Only the probe implementation and spec are added | No registry, count, cohort, smoke list, compatibility-order list, README, or digest changes are needed. |
| Fresh checkout with no generated catalog | Dev startup, build validation, direct Playwright collection, and the focused test discover the probe automatically. |
| Development server already running | Adding/removing/renaming the probe regenerates the catalog and reloads; no manual restart/generation or stale entry remains. |
| Actual control and output windows | Probe appears exactly once in its canonical group, is searchable/selectable, renders on output, stages/takes correctly, and receives existing shared coverage. |
| Existing saved state | Pad assignments, favourites, params, node references, and projection children keep resolving; default ten shortcuts do not change. |
| Duplicate ID, missing export, invalid descriptor | Fail with actionable origin/field diagnostics. Never silently reduce the catalog. |
| Missing companion spec | Authoring-contract check fails. |
| Existing metadata/behavior intentionally broken | Its contract/behavior test still fails, demonstrating that removing hashes did not remove relevant protection. |
| Format or relocate descriptors without semantic change | No provenance failure; discovery and compatibility tests still work. |
| Probe removed | Catalog returns to the original ID set. Generated files remain ignored; temporary resources are cleaned up. |

At the end, inspect the source diff for the probe scenario: **one pattern file and one test file**. No checked-in generated catalog is allowed to turn that into a hidden third edit.

## 8. Non-goals and alternatives rejected

- **One `EXPECTED_PATTERN_COUNT` constant:** still requires bookkeeping and can conceal ID substitutions; does not remove registration or smoke-list work.
- **Only removing the count/hash assertions:** necessary cleanup but leaves the central registration bottleneck and risks weakening coverage.
- **A larger plugin/async-loading system:** unnecessary; preserve eager module loading and the existing factory/controller lifecycle.
- **Moving the byte freeze elsewhere:** preserves the wrong constraint under a new filename.
- **Rewriting all historical renderers at once:** increases regression risk without improving the next contributor's workflow.
- **Trusting one derived total everywhere:** a shrinking catalog can make both implementation and expectation shrink together. Use independent discovery checks and focused behavior tests.

The desired invariant is simple: **a valid pattern module is automatically part of the product and shared tests; its own test describes what it should do.** Historical audits and catalog arithmetic should not be part of authoring a circle.
