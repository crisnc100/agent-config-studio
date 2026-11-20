# Build log: coverage-manifest PR 1

- Tests first: `review.manifest.test.mjs` (M1–M10) fails on main: every test, for want of a manifest, `--manifest`, or a fail-closed findings check.
- `--full-index` does not lengthen `--raw` blob ids; `--no-abbrev` does. Without it every raw state disagreed with ls-tree.
- An uninitialised gitlink needs its empty folder in the work tree, or `git status` reports it deleted and the review refuses.
- Property (b) under the old inference: a close also covers a submodule, an opaque asset and a deleted binary that no pass read. PR 1 keeps that (no behavior change); the test names exactly those three exemptions. PR 2 makes them unreadable and tier HIGH.
- Review 0dc15f fix round. s2: the old inference's credit (`truncated`, `security.saw`) now comes only from a manifest's read list at the head state, plus the unread entries it always counted (submodule, opaque or deleted binary); a file in neither list gets nothing, which closes the restored-file credit in the fix check's security pass. s3/f3: a section that is not valid UTF-8 is unread as `encoding` and cut, never sent lossily, so promptSha256 is over exactly the bytes sent. f1/s1: a gitlink replaced by a file (or the reverse) is read only when its text section is inlined; a binary replacement is `submodule-change` and cut. Section diffs add `--ignore-submodules=none --submodule=short`.

# Build log: coverage-manifest PR 2

- The first PR 2 builder was stopped by a machine restart after 6 commits, leaving the skill text uncommitted. This builder audited the branch against the 10 decisions and finished the work.
- M10's slice lookup called the slice review inside `records().find`, after the log was read, so the new record was never found. The review now runs first.
- Decision 9 clashed with the rule that a fix-check security finding outside the fix is never deferred: together they left only dispute or waive. The orchestrator chose to lift that rule (option A).
- Decision 6 made paths P5 and P6 pass by accident, because their cited files came from main and so sat at their base state. The cited files now change on the branch, and the fix check sees them as oversize.
- While the machine slept, test durations ran to 900 s or more and several unrelated suites failed (guard, routing). Rerun awake, they pass.

## PR 2 fix round

- I committed the s3/s4/f1/s2/s6 code after running only coverrule, so defer D17 failed until its test-only fix (df0f397). Now the full set of suites runs before every code commit.
- s1 uses the advisor's rule: the fix round's files belong to the fix check. If a close's chain has a fix check, an entry from the original review counts only while the file is still in that state at the fix check's head. This rule is keyed on tree states, not on statuses or cited paths, so it also catches a fix landing in another file being reverted, and a no-path finding's fix being reverted.
- Decided: after a revert, a fresh read of the reverted file by a tip slice is enough. The old finding is not handed to that slice, and its stored status still says fixed.
- Accepted residual: a fix that landed in another slice's file, where that slice has no fix check, can still be reverted unseen.
- Known limit, filed: the build skill's "Record and close" checks only `--cross-family` before using a repo's scripts/review.mjs. A pre-manifest copy there would close a Grade under the old rules. The close then refuses `carried`, and a Grade covers nothing at the push.
