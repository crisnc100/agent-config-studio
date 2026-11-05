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

## PR B (branch agent-merge-run, from agent-merge)
- Test first: tests/review.merge.test.mjs, 23 tests; all 23 failed before merge.mjs existed.
- gh fixtures: real read-only calls on 2026-11-05 (gh 2.83.2) against crisnc100/agent-config-studio PR #40:
  `gh pr view 40 --json number,state,isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,labels,url` and
  `gh pr checks 40 --json name,state,bucket`. `pr checks --json` exited 0 with a pending check (exit 8 is not
  relied on: merge.mjs reads buckets from the JSON whatever the exit). Label objects: gh's documented
  {id,name,description,color} (no labeled PR in the repo to capture). Zero checks: not captured; merge.mjs treats `[]`
  and a "no checks reported" error alike as zero checks (unverified which one gh 2.83 emits).
- Deviation (reported): the four new merge keys live in review.mjs's mergeSettings/stricterMerge, so the tracked-file
  trust rule stays single-source; --tier-json now also emits `merge: {onHuman, humanComment, requireChecks,
  allowBehind}` and `baseRef` (the review record's base name). PR B therefore touches review.mjs.
- Tracked repo config: onHuman allowed; humanComment always ignored (warned); requireChecks only true, allowBehind only
  false (looser values warned and ignored).
- Example config: the four keys documented in `_merge_help` only (option a), because test 8 in review.tier.test.mjs
  deepEquals example.merge to the four #40 keys. Pending the lead's answer.
- Base check: tier.baseRef with refs/heads/, refs/remotes/<r>/ or <remote>/ stripped must equal baseRefName. A base
  pinned to a sha never matches (refused).
- Order: tier-json -> intent record -> covered? -> policy off (none, no gh) -> HEAD == tier tip -> clean tree ->
  gh pr view -> refusals -> (merges) label veto, BEHIND, gh pr checks -> merge | needs-human path.
  Before --tier-json answers, the log falls back to ~/.agent-config-studio/review-log/merge-log.jsonl.
- Needs-human path does `gh label list --search needs-human` (read) before `label create`; a comment failure after the
  label was added is `refused` naming that the label is on.
- Stdout: `<action>[ (dry run)]: <detail>`; exit merged 0, labeled 10, none 0 (policy off) / 11 (onHuman none),
  refused 2. Dry run exits with the would-be action's code.
- Suite: 628/628 outside the sandbox; tests/packs-catalog.mjs 49/49. review.test.mjs unchanged.
## PR A fix round (review 2026-11-05-17-57-16-b13bed)
- f1 MEDIUM 21/100: test A1f1 (subdirectory, diff.relative=true) failed at e25a9b1 (summary said LOW), passes now.
- Fix: diffStats always runs `git -C TOP diff --no-relative`, so every path is repository-relative (this also corrects
  review stats/routing run from a subdirectory). TOP moved above diffStats because diffStats runs at load.
- "A missing state never matches": absent at both the close's head and the tip counts as judged only when the path
  existed at the review's base (a real deletion). Guarded by a second test (a judged deletion stays LOW).
- Suite 607/607.
