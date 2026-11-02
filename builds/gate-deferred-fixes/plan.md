# Deferred fix-check findings from PR A

## x1: a move hides content no model read
The fix check's diff detects renames, so moving a file the original review truncated shows as a short rename section,
and the new path's blob got covered.
- New fix checks diff with `--no-renames`: a move shows the whole new file and goes through the normal cap check
  (over the cap, the file is cut and uncovered). The record logs `noRenames: true`.
- Fix-check records without `noRenames` (from PR A's runtime) never cover a rename or copy destination of their fix
  range: in `fixCheckSeen` (close) and in the fix check's own coverage at the gate.

## x2: a blank verifyCmd ran nothing and passed
- An untrusted repo config loses every own-file key that is present, whatever its value.
- A whitespace-only `verifyCmd` (config or env) and `--test-cmd` count as unset, so close asks for `--test-cmd` or
  `--no-tests`.

## Tests
`review.coverage.test.mjs`: a move of a truncated file after the review stays uncovered (new record, and a PR-A-style
record without `noRenames`); a tracked config with blank own-file keys is stripped; blank `verifyCmd` / `--test-cmd`
make close ask for a test command.
