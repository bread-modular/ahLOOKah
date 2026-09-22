# Historical audit archive

These artifacts are **evidence of past migrations**, preserved for provenance.
They are not live test fixtures: normal CI must test current contracts, not
historical source bytes.

- `replacement-inventory-62617ff.json` — the replacement-mission inventory as of
  baseline `62617ff` (including `8b59020` "Add a simple circle."): the 60
  removed IDs, serialized descriptors of the 50 retained entries, the retained
  declaration-block SHA-256, and SHA-256 digests of 54 implementation/helper
  files. Retired from `tests/replacement-inventory.spec.js` by the built-in
  pattern extensibility refactor (see
  [built-in-pattern-extensibility.md](../built-in-pattern-extensibility.md)
  §5.3): the comment-delimited source hash and descriptor/file digest loops
  froze source layout and blocked ordinary additions, so they were replaced by
  readable semantic compatibility tests (`tests/catalog/compatibility.spec.js`
  plus the scoped replacement/expansion cohort specs). Git retains the full
  history; this file retains the exact audit that migration was accepted
  against.
