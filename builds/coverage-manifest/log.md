# Build log: coverage-manifest PR 1

- Tests first: `review.manifest.test.mjs` (M1–M10) fails on main: every test, for want of a manifest, `--manifest`, or a fail-closed findings check.
- `--full-index` does not lengthen `--raw` blob ids; `--no-abbrev` does. Without it every raw state disagreed with ls-tree.
- An uninitialised gitlink needs its empty folder in the work tree, or `git status` reports it deleted and the review refuses.
- Property (b) under the old inference: a close also covers a submodule, an opaque asset and a deleted binary that no pass read. PR 1 keeps that (no behavior change); the test names exactly those three exemptions. PR 2 makes them unreadable and tier HIGH.
