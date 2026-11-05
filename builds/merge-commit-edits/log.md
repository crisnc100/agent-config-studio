# Build log: merge-commit-edits

- Tests BM20 (three cases) and BM21 were written first. All failed at 158568d: BM20 closed complete each time, and BM21's push passed.
- The "branch changed since the review's base" set is computed per merge as filesBetween(merge base of the parents, first parent). That is the branch's own content relative to main at the merge, without needing the review. Both-sides files are subtracted, because the both-sides rule already handles them, including main-content resolution.
- At the gate, the reverts of every default-branch merge in tip ^base are added to the files to cover. They are skipped only when the anchor is an unsliced review whose head descends from that merge. A fresh whole-branch review is measured from main, where the file's absence or main's copy is not a change. A slice anchor never excuses them (BM21).
- New refusal wording for reverted files: a slice review has no diff from main for them, so the note points to the fix check or a fresh whole-branch review.
- Remaining limit: if the review's one fix check was already used before the merge, a reverted test can only be covered by a fresh whole-branch review. That is stricter, not looser.
