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

## Open points for review

- Pre-existing, not loosened here: a both-sides file that is in close scope for another reason (a finding on it marked fixed, or a fix check that saw it before the merge, without a fix check after) is covered by the re-close at its merged state without anyone reviewing the resolution. The same held for a merge before this change (touchedBetween listed it and fixedFiles/seen put it in scope).
- Old per-repo shim copies run directly by git (no global dispatcher) still call `--gate` without a remote, so they keep the full rule until reinstalled (stricter, not looser).
- `packs/build/skills/*/build/SKILL.md` carries the same rule 8 sentence; left alone (plan scope is the code-review twins).
- Full suite: 604/604 outside the sandbox (594 before + 10 new).

## Fix round (Sol review 2026-11-05-18-09-47-0a4347, Astra Grade grade-1793902425898-8d1fc1)

Tests BM7–BM10 written first; 7 of 8 failed at 89e41ec (BM7 "fix check saw it at the merge tip" is a positive guard that passes on both).

1. **Merge-touched files at close.** Files `branchPaths` returns for a merge of the default branch in review.head..HEAD skip the fixedFiles / test-file / pre-merge-seen exemptions. In scope only if (a) the state at HEAD equals the merge base with the default branch (main's own content), or (b) a fix check whose head descends from every merge that touched the file saw it, and its state at the check head equals HEAD. Otherwise outOfScope (partial; refusal when the fix-check-after rule applies).
   - Deviation from the brief ("must be seen ... or partial"): case (a) is in scope but **never stamped** in coverage. Making it partial would leave no way out: a slice review of a file whose tip state is main's has an empty diff. Not stamping it means a push to origin trusts it as main content, and any other push still needs coverage (BM7 mirror push asserts this).
   - closeCoverage never stamps a file whose HEAD state is the merge base's, nor a file a merge-tip fix check left out of `onlyFiles` (fixCheckSeen now returns `left`).
2. **Exact ref.** defaultTip resolves the origin/HEAD target with `git show-ref --verify --hash -- <full ref>`, then peels that sha; a tag named `refs/remotes/origin/<x>` no longer matches (it did via rev-parse's lookup rules; reproduced).
3. **Snapshot.** origin/HEAD is read once at startup (ORIGIN_HEAD), before BASE initialisation can run `remote set-head`; defaultTip uses only that snapshot. A later run in the same repo does see a set-head created origin/HEAD (it came from the remote).
4. **Message.** sidesNote now says "...; slice-review just that file at the tip (REVIEW_PATHS=…) and close that slice; review <id> keeps covering every other file, ...". Gate uses the anchor close's review id; close uses the review being closed.

Full suite: 612/612 outside the sandbox.

## Merge of main (#41, #42) and leftovers

- Merge 072fd1d: conflicts in VALUE_FLAGS (kept --security-worker and --remote), unjudgedStats (main's same-state rule, measured from coverBase, deletion check against that base) and closeSummary (main's tipTier/tierLines with coverBase). Suite 656/656.
- a. A Grade recheck counts as having seen its graded files for mergeScope (head descends from every touching merge, same state at HEAD) and for closeCoverage. Test BM11.
- b. detectDefaultBase no longer runs `remote set-head`; the warning now says to run it once by hand. Claude code-review skill "Portable" paragraph says so (the codex twin has no such paragraph). Test BM12.
- c. closeCoverage drops main-equal files only when no record (review, fix check, recheck) saw that exact state. Test BM13.
- d. packs/build/skills/{claude,codex}/build/SKILL.md rule 8 carries the merge-not-rebase / re-close wording.
- Tests BM11-BM13 failed at 072fd1d; full suite 659/659 outside the sandbox.
