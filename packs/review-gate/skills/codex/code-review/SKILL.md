---
name: code-review
description: Single-pass, read-only code review of the current branch's committed diff for correctness — logic bugs, regressions, edge cases, error handling, data integrity. Runs the shared review engine (review.mjs), returns structured findings by severity, fixes every HIGH and MEDIUM without asking, defers what the one fix check leaves, and reports once. The script never fixes; no loop.
---

# code-review — review → fix → one report

Review the committed diff vs the remote's default branch (auto-detected from `origin/HEAD`) for **code correctness only** (not style, not product scope); an optional **security pass** runs beside it (below).
One pass, read-only reviewer, findings come back to the seat, every HIGH and MEDIUM is fixed in-context without asking (rule 10 below), then one report.

**Reference:** [reference.md](reference.md), beside this file, holds the rest word for word: routing by size, the security pass, `--eval`, grok runs, slices, what the push gate accepts, triage details, the full review policy (rules 1–11), the reviewer tiers and the config. Read it before acting on anything this file only names.

## Step 1 — run the shared engine

Commit the work first, including the build folder (it reviews the committed diff). Then run the same `review.mjs` every tool shares — repo copy first, shared runtime as the fallback:
```bash
SCRIPT=scripts/review.mjs
[ -f "$SCRIPT" ] || SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$SCRIPT" "<intent: what the branch delivers, its acceptance criteria, and anything deliberately out of scope>"
```
Context comes from files: the orchestrator's plan via --plan <plan.md> or REVIEW_PLAN, the builder's adjacent log.md if present, and already-decided findings from the review log. Inside a build loop, pass the plan; a missing plan file refuses. The optional intent string supplements those files. Decided stays decided: same-branch, same-repository rejections arrive as "already decided; don't re-raise without new evidence".
It writes `reviews/<ts>/code-review.md` and prints findings as JSON after a `===FINDINGS_JSON===` marker. Parse that block; keep reviewId and each finding's id, including disputed and carried unlocated findings, for the status file. All retain their stored derived severity; every non-filed finding needs a status.

**Who reviews.** The `reviewer` role in ACS (Models → Roles; `model-id --role reviewer --json`) is the pool, each family at its own flavor effort. A family's CLI follows its model id (`claude-…` → claude, `gpt-…` → codex, `grok-…` → grok); families whose CLI is not installed are skipped and one line names them. The run stops with a message naming the fix — never trying another vendor — when `model-id` is missing (`acs install-model-id`), the role is unset (you choose it at install: `acs packs install review-gate --set-role reviewer=<family>[,…]`) or missing, no family in it has its CLI, or a named reviewer has no CLI.

## Step 2 — triage, then fix without asking

**No confirmation (rule 10).** Send every HIGH and MEDIUM straight to the fix round, or dispute it with proof; never ask which to fix. A finding that is really a product choice (bug or feature?) gets the safe fix by default and is named in the report so the operator can reverse it. LOWs are filed. **One report, after the fix round and the fix check:** what was fixed, what was deferred and what was filed, each with its numbers (rule 11), plus any product-choice fix the operator may reverse; fixing the filed items is optional. Clean reviews still need --close and tests; a clean report alone is not done.

## Step 3 — apply the fixes in-context

Fix the real cause directly (you have the diff loaded; do NOT re-spawn a model to fix). Keep fixes minimal and faithful; never suppress or paper over. Then run the repo's linter/formatter on the changed files and commit before --close, never afterward. Fixes never get a full re-review. Every non-filed finding needs a fixed or rejected status; unknown keys and any severity field refuse:

```json
{"f1":{"status":"fixed"},"f2":{"status":"rejected","reason":"<why>","evidence":"<file:line or test>","refutedBy":{"review":"<prior review id>","finding":"<prior finding id>"}}}
```

After the fix check, its x… findings (and a Grade recheck's r… findings, or a criterion still failing its recheck) may instead be deferred: `{"x1":{"status":"deferred","reason":"<why>","fix":"<fix idea>"}}`. The reason is required; any severity or score field refuses; an original finding can't be deferred.

Omit refutedBy for this review's own REFUTED verdict or a waiver. The orchestrator disputes serious rejections and closes against the committed fixes:

```bash
node "$SCRIPT" --dispute <review-id> <finding-id> --reason "<why>" --evidence "<file:line or test>"
node "$SCRIPT" --close <review-id> --status builds/<slug>/status.json
node "$SCRIPT" --summary
```

Close runs the whole test suite using verifyCmd from .claude/review-config.json or --test-cmd. If there are no tests, pass --no-tests "<reason>"; it is logged and appears in the summary. Only when close requires it, the orchestrator runs --fix-check <review-id> once. Fix, dispute or defer its x1… findings, close, then a hard stop, with no further model pass. Config `fixCheck`: `"risk"` (default: a fix touching tests, verify scripts or riskPaths needs a fix check) | `"always"` (the risk rule, plus any other code fix after the review; other docs, static, coverage-exempt and `builds/` files never need one, so it is never looser than "risk"; for a Grade, its recheck counts as the check when nothing either rule counts changed after it). The home config is the floor: a repo file, `REVIEW_CONFIG` or `REVIEW_FIX_CHECK` may raise it, never lower it. Fixes land before the fix check: commits after it may touch only `builds/` and test files, and close still runs the full tests. A file the fix check saw is in scope at close, so a fix to a sibling file is fine once the fix check has seen it. Close counts a changed file as fixed only when it equals, exactly, the path the script recorded when it checked that finding's quote; a finding with no recorded path (unlocated, ambiguous between a/ or b/ and the bare path, a Grade finding, or one logged before paths were recorded) covers no file. A rename counts as a delete plus an add, so the renamed path is never covered by a finding. A fixed finding covers its whole file, not only the lines it cited. A complete close covers what it saw at HEAD (see what the push gate accepts, above); a partial close lists outOfScope files and covers nothing. Use refutedBy for an already-decided finding rather than reopening its dispute without new evidence. Put --summary output in the PR body. --log-outcome is optional telemetry only; it never closes a review.

## Hard rules

- Read-only reviewer; it never edits or commits.
- Never weaken a check to make a finding disappear.
- Prefer a reviewer from another vendor than the author (see Step 1); never wait for one.
- Builders commit at phase end and never run reviews, grades or other models themselves. The orchestrator handles those checks, pushes and opens the PR with the review summary.
- Never merge, never push to a protected branch. Leave that to the operator.

Every PR body must include a section titled exactly **Deferred findings**, using the deferred and filed findings in --summary (or `none` when empty). When chasing a bug, first check `node <review.mjs> --deferred` and merged PR descriptions with `gh pr list --state merged --search "Deferred findings in:body"`. Resolve <review.mjs> repo-first, with the shared runtime fallback above. `--deferred` lists this repo by repoId, newest first; add `--all` for every repo. The trigger is the input or call path named in the issue.
