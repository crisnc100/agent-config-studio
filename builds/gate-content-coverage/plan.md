# PR A: content-based review coverage

Source: `skills-work/plans/gate-speed-plan.md`, decisions 1–4, the PR A line of 6, and 7.

## Evaluator (one function, `contentCover(entries, tip, risk)`)
1. **Tip close** (decision 3): a complete close with content data, made in this repo, whose closeHead is the tip or an
   ancestor followed only by `builds/` commits. Its review's `baseSha` (an ancestor of the tip) sets the base.
2. **Needed files:** `git diff --name-only --no-renames <base> <tip>`, minus `builds/`. A file equal to the base needs nothing.
3. **Covered:** a needed file's state at the tip (mode + blob, or absent) equals the state a coverage record logged, and
   - the record is a complete close, or a clean fix check (no finding that needs a status);
   - the record and its review were logged in this repo (`repoId`), and the record's head is an ancestor of the tip;
   - when pushed commits touch riskPaths, or the file is a riskPaths file, the record's review is of kind `review`;
   - no merge between the record's head and the tip (and after the base) changed the file on two or more sides.
4. Anything else is uncovered; the refusal lists the files and says to review them as a slice and close at the tip.

Tree-identical carry-over stays: a rewritten tip whose tree equals a logged head's is covered when that head is.

## Record fields added
- review: `truncated` (paths whose diff the 120k cap cut; `[]` when none).
- fix check: `truncated`, `coverage` (`[[path, "mode blob" | null], …]` at its head for the fix diff minus truncated), `durationMs`.
- close: `repoId`, and on a complete close `coverage` at closeHead: the review's files (net diff from baseSha, or the
  slice's recorded files) plus every file touched since the review head, minus files the cap truncated that the fix check
  did not see in full.
- Grade records add `truncated: []` (a Grade has no inlined diff).

## Legacy
- A close without `coverage` gives no content coverage. The old whole-tip rule (one unsliced complete close at the tip,
  then `builds/` commits only) still applies to such closes only, so nothing is allowed that wasn't before.
- A review without `truncated` (old copies): at close, its diff is recomputed; over the cap, the close records no coverage.
  A review without `baseSha`, or a sliced one without `files`, gives no coverage.

## Close changes
- Fix-check allowance removed: commits after the fix check may touch only `builds/` and test files (`isTestFile`).
- Files the fix check saw in full are in scope at close (a sibling fix seen by the fix check no longer makes it partial).
- Partial closes keep `outOfScope`/`partial` and give no coverage.

## Removed
`slicedCover` (same-head slice grouping) and the fixed-path allowance after the fix check. `coveringClose` remains only as
the legacy rule.

## Tests (new file `review.coverage.test.mjs`)
sibling fix seen by a clean fix check; late one-file commit needs one slice + one tip close; merge of two reviewed branches
refused for the overlapping file only; deletion and chmod-only uncovered until reviewed; truncated file uncovered; unrelated
branch and other repo give nothing; legacy close gives no content coverage; code commit after the fix check refused at close
and uncovered at the gate; durationMs on fix checks.
