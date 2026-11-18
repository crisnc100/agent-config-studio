# Coverage manifest, PR 1: record manifests

Design: /Users/cortega/Documents/Projects/personal/skills-work/builds/coverage-manifest/design.md (sections 1, 3.3 and 6).

## Two PRs

Two PRs, and this is the first. PR 1 only adds: every reviewer diff is built from per-file sections, and each code and security pass records which sections it inlined. The old coverage inference still decides every close, tier and push, so main keeps working on its own after PR 1 merges. PR 2 switches the close, the summary and the push gate to the manifests and deletes the inference; it cannot be split further, because the new rule and the old inference contradict each other. Keeping PR 1 apart lands the risky builder alone, with its property test, and lets real runs show manifest sizes before the switch.

## PR 1 scope

- `buildSections(base, head, scope, cap)`: the change list from `git diff --raw -z --no-renames --no-abbrev`, binaries from `--numstat -z`, gitlinks by mode 160000, and one fixed-flag `git diff` per remaining path. Both states of every path are checked against `ls-tree`. Sections are packed whole, in priority order (riskPaths, logic, other, tests, docs, static, coverage-exempt and builds/), and a section over the cap on its own is `oversize`, one that no longer fits is `capped`.
- Every reviewer prompt is built from those sections, verbatim, followed by the list of what it was not shown: the review's code and security passes, the `--since-close` delta and its whole-slice security pass, the fix check's code pass and its security pass, `--security-only`, disputes, the second opinion and (through the review path) the eval child. `clip()` is gone.
- Records: `manifest` (role code) on every review and fix check; `security.manifest` only when `security.status` is `ran`. A fix check also records `asked`, the finding ids its prompt listed.
- A code answer with no findings array throws (single reviewer, every team lens, fix check): no record, no manifest.
- `--manifest <id>` prints a review's or fix check's manifests.
- `REVIEW_TEST_DIFF_CAP`: tests only, and it can only lower the cap.
- The old `truncated` list and `security.saw` are now derived from the manifest (`legacyCut`): what the cap left out, plus binaries other than opaque assets and deletions. Submodules, opaque assets and binary deletions stay as the old inference counted them. `truncatedFiles`, `binaryFiles`, `fileSection` and `cappedFiles` are removed, since nothing parses diff text any more.

Out of scope (PR 2): the coverage rule, the fix check's coverage block, the widened findings note, the fixed rule, `carried`, `--open-findings`, every deletion in design 3.1, retiring `fixCheck`, the skill text.

## Tests

New `packs/review-gate/tests/review.manifest.test.mjs`, failing on main before the code: the manifest fields per pass (review and fix check), failed and timed-out security passes, a missing findings array (single, team, fix check), unread reasons (binary, oversize, capped, submodule), renames and type changes, quoted and non-ASCII names, user git config, an empty-tree base, and the seeded property test (50 seeds; `PROPERTY_SEEDS` or `PROPERTY_SEED` narrows it).

## Acceptance

Every packs/review-gate and packs/pr test, plus the listed repo suites, pass at the tip. The frozen `review.test.mjs` is untouched.
