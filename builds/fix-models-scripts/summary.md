review.mjs · /Users/cortega/.agent-config-studio/review-gate/review.mjs · head-aware copy
Reviewer: fable (claude-fable-5-2)
Security: no reviewer — not-required (only docs, tests, static or lockfiles changed, none on riskPaths)
Review: 2026-11-17-18-10-45-608ddb
HEAD: fb9d17656eb306166a44d5f431a08613105ae166
Counts: 1 findings; 0 fixed; 0 rejected
Merge tier: HIGH (security pass did not cover logic changed after review (not-required at review; logic or other files: builds/fix-models-scripts/review.out, builds/fix-models-scripts/status.json)). Policy standard: needs a human
Deferred findings
none
Pre-existing (not introduced here)
f1 LOW 6/100 (likelihood 2/10 × impact 3/10) tests/fixtures/model-registry/inspect-scripts.mjs:154 — The fixture's own CLI entry never passes a roles file, so its temp-HOME ('none') runs of review.mjs still stop with no reviewer role. With no roles.json, lib/roles.js leaves the reviewer role unset, `model-id --role reviewer --json` exits 2, and review.mjs's poolOrStop exits 1. The CLI therefore reports all three none/review.mjs scenarios as FAILED and exits 1. The branch fixed this for tests/models-scripts.mjs only, by adding the `rolesFile` option, which the CLI has no flag for. Derived from reading the code; not run.; Trigger: Running the documented CLI by hand: `node tests/fixtures/model-registry/inspect-scripts.mjs out.json` (with or without --home-file). Nothing in the repo calls this entry; tests/models-scripts.mjs imports inspect() directly and is not affected.
