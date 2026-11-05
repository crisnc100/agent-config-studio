# Build log: agent merge

## PR A (branch agent-merge)
- Test first: 11 new tests appended to tests/review.tier.test.mjs (A1 x3, A2, A3 x7). Before the change 10 failed;
  "A1 a file whose tip state is the state its close judged stays judged" passed before and after (regression guard).
- x1 test needed the old close to stay in the summary's `closes`: a close only counts there while it covers some file
  (coveredBy filters `used`), so the scenario keeps docs/guide.md as the first close judged it.
- x1: unjudgedStats compares each own-diff path's state (mode blob, or absent) at the close's head with the tip, via
  treeStates; both names of a rename are compared. builds/ files (every name under builds/) are dropped from the
  unjudged set before anything else, as contentCover does.
- x2: the unreadable-own-diff fallback returns the same { ...stats, paths } shape (builds/ still skipped).
- Single source: tierSummary became tipTier() -> { tier, reasons, policy, merges, docsTestsOnly }; tierLines() formats
  it. closeSummary / slicedSummary / coveredBy / coverSummary / carriedSummary now return { text, tier, base, deferred }
  instead of a string; printSummary and pushGate print `.text`. Names kept to keep the diff small.
- headSummary() is the one lookup (contentCover -> legacyClose -> carriedCover) for --summary and --tier-json.
- tier null: reasons name each close ("the close of review <id> has no merge tier (logged before tiers)").
- deferred: the finding ids as the summary lists them (f1, x1, ...), not review-qualified; same ids as the tier reasons.
- --tier-json exits 3 only for "not covered"; any other error throws as --summary does.
- Suite: 605/605 outside the sandbox (PTY tests fail with openpty inside it). review.test.mjs unchanged.
