# Agent merge (review gate): two stacked PRs

Decided by Cris 2026-11-05 (`~/Documents/Projects/personal/skills-work/builds/review-vs-anthropic/decisions.md`). Plan approved by Cris; revised after the Bounce (bounce.out in this folder). Read context.md first.

## Outcome
After a PR is opened from a reviewed and closed branch, one command (`node merge.mjs`) reads the branch's merge tier and the configured merge policy and does exactly one thing: merges the PR (merge commit, only when every safety check passes), or labels it `needs-human` and comments once, or does nothing. Policy `off` (the default) does nothing and never calls gh. The two tier bugs deferred from #40 are fixed first.

Shipped as two PRs, stacked: **PR A** (review.mjs only: x1, x2, tier as data) on branch `agent-merge`; **PR B** (merge.mjs + wiring) on branch `agent-merge-run`, branched from `agent-merge`. Cris merges A with a merge commit first. Same worktree.

## PR A — tier correctness and tier as data (review.mjs)
- x1: a path counts as judged by a close only when its blob and mode at the tip equal the state that close judged; else unjudged. A `builds/`-only commit after a classifier-LOW close keeps LOW (builds/ is skipped, as in contentCover).
- x2: the unreadable-diff fallback returns the same shape as unjudgedStats (with `paths`); no TypeError.
- Single source: refactor so `closeSummary`, `slicedSummary` and `coveredBy` each build one `tipTier` object `{tier, reasons, policy, merges, docsTestsOnly}` and format the line from it; `--summary` text unchanged.
- `--tier-json`: the same lookup as `printSummary` (contentCover → legacyClose → carriedCover) returning that same object plus `{tip, covered: true, base, deferred: [ids], logPath}`. Not covered → `{tip, covered: false, reason, logPath}`, exit 3. No tier on any covering close → `tier: null, merges: false, reasons: ["…has no merge tier"]`.
- PR A criteria (tests): A1 x1 incl. the builds/-only case; A2 x2 via --summary and the push gate; A3 `--tier-json` equals the summary line's tier and policy decision in all three branches (single close, sliced, content coverage with linked fix check) and the carried branch; uncovered → exit 3; A4 existing `--summary` tests unchanged.

## PR B — runtime/merge.mjs
`node merge.mjs [--pr <n>] [--dry-run]`, run by the orchestrator after the PR is open. Exit codes and one stable stdout line per outcome: `merged` 0, `labeled` 10, `none` 0 (policy off) / 11 (onHuman none), `refused` 2.
1. Write an intent record to the merge log first (logPath from --tier-json), then the outcome record; every exit path logs.
2. Resolve the review script (repo `scripts/review.mjs`, else the shared runtime beside merge.mjs); run `--tier-json`. Not covered → refused. Policy `off` → `none`, exit 0, before any gh call.
3. `gh pr view [<n>] --json number,state,isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,labels,url`. Refused (no gh writes) unless: open, not draft, headRefOid == local HEAD == tier tip, clean tree, baseRefName equals the review's base branch, mergeStateStatus not DIRTY/BLOCKED/UNKNOWN, reviewDecision not CHANGES_REQUESTED. A gh read failure → refused.
4. Would merge (`merges: true`) only when also: no `needs-human` label on the PR (the label is a human veto); mergeStateStatus is not BEHIND (main moved since review: the combination is unreviewed → needs human, reason "base moved"; config `merge.allowBehind: true` home-only allows it); `gh pr checks <n> --json name,state,bucket`: every check `pass` or `skipping`, none `fail`/`pending`/`cancel`; zero checks → needs human ("no CI checks") unless `merge.requireChecks: false` (home-only), which never lets a failing/pending check through. Then `gh pr merge <n> --merge --match-head-commit <local HEAD>`. Never `--auto`, `--admin`, `--squash`, `--rebase`. Merge command fails → `refused` with gh's message, no label/comment.
5. Otherwise needs a human: `merge.onHuman` `"comment"` (default) → create the label only if missing, add it, post one comment (`merge.humanComment`, home-only, default "Needs human approval before merging.") plus the tier line and reasons; skip the comment if the label was already present. `"none"` → no writes.
6. `--dry-run`: steps 2–4 read-only, logs the would-be action with `dryRun: true`.
- Config (`merge`): `onHuman` (repo may set), `humanComment`, `requireChecks`, `allowBehind` (home or untracked config only; a tracked repo config may only tighten).
- Wiring: pack.json lists runtime/merge.mjs; skill text (claude + codex twins): after opening the PR the orchestrator runs merge.mjs once; agents never merge any other way; what each policy does; review-config.example.json gains the keys.
- Not in scope: listing the config in ACS (the ACS file API refuses ~/.agent-config-studio; a settings form is a later PR, edited by hand until then); an agent-guard hook blocking direct `gh pr merge` (follow-up).

## PR B criteria (tests; gh is a PATH stub that logs argv and refuses unexpected calls; real `gh pr view/checks --json` output captured once as fixtures)
B1 policy off → zero gh calls, `none`, exit 0. B2 standard + LOW + all checks pass/skipping + CLEAN → checks called before merge; exactly one `gh pr merge <n> --merge --match-head-commit <HEAD sha>`. B3 MEDIUM → label + one comment, exit 10; second run with label present → no new comment. B4 LOW but a fail/pending/cancel check, zero checks, BEHIND, or a `needs-human` label → needs-human path with the reason. B5 requireChecks false + failing check → still not merged. B6 refused (no writes, exit 2, logged) for: head ≠ HEAD, draft, closed, dirty tree, uncovered tip, base mismatch, DIRTY/BLOCKED, CHANGES_REQUESTED, gh read failure, merge command failure. B7 tier null → needs-human naming the untiered close. B8 dry-run → no writes, logs would-be action. B9 tracked repo config can't set requireChecks/allowBehind/humanComment or a looser policy. B10 intent + outcome records written on every path, beside the review log. B11 pack tests pass with merge.mjs listed.

## Both PRs
No existing test assertion changes; `review.test.mjs` byte-identical; full suite passes. No new dependencies.

## Note on the parallel security PR
It also edits review.mjs; whichever merges second needs main merged in and a review of review.mjs before its close.
