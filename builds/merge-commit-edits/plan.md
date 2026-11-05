# PR: edits inside a merge of main are never hidden (follow-up to #44, deferred x1)

## Problem
x1 from fix check fix-1793908948216-a2f38f, HIGH 21/100 (likelihood 3/10 × impact 7/10, protected). A deletion or a restore of main's copy made inside a default-branch merge commit (`git merge --no-commit origin/main`, then `git rm` a reviewed test or `git checkout origin/main -- <file>`) is hidden:
- branchPaths(merge) lists only both-sides files and files that differ from every parent, and the result equals parent 2;
- so the fix check leaves the file out, close never fires needsFixCheck, closeCoverage drops it as main content, and the gate's base..tip diff omits it.

## Change (review.mjs only)
- `mergeReverts(merge)`: the files only the branch changed since the merge base whose state the merge changed from its first parent (minus both-sides files). branchPaths includes them, so close `files`, the riskPaths scan and rangeTouch see them.
- rangeTouch: `reverted`; mergedLast is never true for a reverted file, so needsFixCheck, the after-fix-check rule and mergeScope treat it as the branch's change.
- fixCheck: keeps reverted files in the fix diff.
- contentCover: the gate and --summary also require a record for every reverted file of a merge after the base. The exception is a whole-branch (unsliced) anchor review made after that merge. The refusal note says a slice review can't see the file, and points to the fix check or a fresh whole-branch review.

## Acceptance
1. A reviewed test deleted inside the merge: close refuses ("run --fix-check first"), the gate names it, the fix check's prompt contains it, then close and push pass.
2. A reviewed test restored to main's copy inside the merge: close refuses, the gate names it.
3. A reviewed logic file restored inside the merge: the re-close is partial naming it, and the gate names it.
4. A slice close at the tip does not hide it; --summary agrees.
5. A clean merge of only main's files still re-closes with zero model calls (BM1). BM1–BM19 pass, and the full suite passes.
