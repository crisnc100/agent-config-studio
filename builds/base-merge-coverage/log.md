# Build log: base-merge coverage

## Choices

- **One resolver, `defaultTip()`.** Reads only `git symbolic-ref -q refs/remotes/origin/HEAD`; the target must match `refs/remotes/origin/<name>` (not `.../HEAD`) and resolve to a commit. Never reads BASE / REVIEW_BASE / config `base`, never runs `remote set-head`. In `--gate` mode it returns null unless `--remote origin` was passed. Used by contentCover, close (touchedBetween + the fix-check-after commit check), fix check, the risk scan, closeTier, unjudgedStats and closeSummary's tier base.
- **Coverage base (`coverBase`).** merge-base(tip, default) when it is a strict descendant of the review's baseSha, else baseSha. Same helper for contentCover, the tier stats, and the fix check's branch-side scope.
- **Branch-side commits (`branchCommits`).** Prepends `^<default>` to every rev-list range (before any `--not`, so it stays negative). Used in touchedBetween and the gate's risk scan.
- **Merge of the default branch (`branchPaths`).** A merge whose parents after the first are all ancestors of the default tip touches: files changed on 2+ sides since the octopus merge base (computed with the pathspec, so slices work) ∪ files whose merge state differs from every parent (evil-merge edits). Merge base missing → old `commitPaths`. Any other commit → old `commitPaths`.
- **Fix check at a merge tip.** When `coverBase` moved the base, the fix diff is limited to fix-diff files whose state at HEAD differs from the merge base (`:(top,literal)` pathspecs) and the record gets `onlyFiles`; `fixCheckSeen` filters by it so close never counts a main-side file as seen. If nothing branch-side changed: "No fix diff to check".
- **Hook.** `hooks/pre-push` passes `--remote "$1"` when git gives a remote name. `global/push.mjs` now forwards Git's arguments to the shim, and treats a per-repo copy of the *previous* shim (current shim minus the two new lines) as the gate already run, so a legacy per-repo copy does not run a second, old-rule gate that would refuse.
- **Messages.** Clean merge, no close at tip: "re-close the existing review <id> at the tip so the tests run there (no new review ...)". Uncovered files all both-sides of a base merge: "... uncovered: X — it changed on both sides of a merge of the default branch: X. Slice-review just that file at the tip (REVIEW_PATHS=X) and close that slice there; every other file keeps the existing review's coverage ...". Close with fix check refuses with the same note; close without fix check goes partial and prints the same note.

## Deviations

- **Both-sides message wording.** Plan change 4 says the both-sides note should read "re-close the existing review; slice-review these both-sides files at the tip". In the code a re-close of the existing review cannot help there: without a fix check it is partial (both-sides files out of scope), with one it is refused. The slice's own close at the tip is the close the gate needs. So the both-sides note says slice-review + close that slice, and that nothing else needs a review; "re-close the existing review" appears only in the clean-merge note, where it is the actual fix.
- **push.mjs legacy-shim match** (not in the plan): needed so the remote reaches the shim in global installs without making old per-repo shim copies run a second, stricter gate.

## Tests

`packs/review-gate/tests/review.basemerge.test.mjs` (BM1–BM6). Written first; 9 of 10 failed on the old code (BM6, rebase, passes on both by design). BM3/BM4 initially expected only the merged-branch / main file in a partial close's outOfScope; the old rule (kept for non-default merges and a missing origin/HEAD) also lists the branch's own files via the `-m` diff, so those asserts were corrected to the old behavior before commit.
