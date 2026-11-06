---
name: code-review
description: Single-pass code review of the current branch's diff. The reviewer comes from the `reviewer` role in ACS (Models → Roles), each family at its own flavor effort; name any family, "premium", "both" or "claude" (the multi-agent team) to choose for one run. Every finding must quote the code it cites, checked by script. Every HIGH and MEDIUM goes to one fix round without asking, applied by the builder that wrote the branch (or the agent, when no builder did); a fix check follows once, what it leaves is deferred, and the outcome is logged and reported once. The script never fixes; no loop.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, AskUserQuestion
---

# /code-review — review → fix → one report

Review the committed diff for **code correctness** — bugs, regressions, edge cases, error handling, data integrity — judged against what the branch was supposed to do. **One review pass** by a reviewer from the pool; every HIGH and MEDIUM then goes straight to one fix round, without asking (rule 10 below). Fixes go to the builder subagent that wrote the branch, or I apply them in-context when no builder did — no loop.

**Reference:** [reference.md](reference.md), beside this file, holds the rest word for word: routing by size, the security pass, `--eval`, grok runs, slices, what the push gate accepts, triage details, the full review policy (rules 1–11), the reviewer tiers and the config. Read it before acting on anything this file only names.

## Step 1 — Run the review (single pass, read-only)

Commit the work first, including the build folder (it reviews the committed diff vs the remote's default branch, auto-detected), then run the reviewer — **repo copy first, shared runtime as the fallback**:
```bash
REVIEW_SCRIPT=scripts/review.mjs
[ -f "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$REVIEW_SCRIPT" "<intent: what the branch delivers, its acceptance criteria, and anything deliberately out of scope>"
```
Context comes from files: the orchestrator's plan via --plan <plan.md> or REVIEW_PLAN, the builder's adjacent log.md if present, and already-decided findings from the review log. Inside /build, pass the plan; a missing plan file refuses. The optional intent string can supplement those files. Decided stays decided: closed rejections on the same branch and repository are passed in as "already decided; don't re-raise without new evidence".
- **Who reviews.** Reviewers come from the `reviewer` role in ACS (Models → Roles; `model-id --role reviewer --json`) — an unranked pool. Each family runs at its own flavor effort (`model-id --flavor <family> --json`), and its CLI follows its model id: `claude-…` → claude, `gpt-…` → codex, `grok-…` → grok. Families whose CLI is not installed are skipped, and one line names them. With no reviewer named, hard rules run first — `crossFamily`, then any config `force` rule (e.g. `{ "paths": ["**/auth/**", "**/payments/**"], "family": "<family>" }`, or `"paths": "risk"` for the `riskPaths` list) — then `pick` chooses: `first` (default, pool order), `rotate` (the family with the fewest logged reviews), a family name, or the command of an optional local classifier (it sees the diff's paths and line counts plus each family's flavor likes/quirks — never code; below confidence 0.7, or if it fails, the first family is used; its probabilities are printed and logged). `crossFamily: "prefer"` (default) skips pool members from the author's vendor when another remains — **pass `REVIEW_AUTHOR=<family or vendor that built the branch>`** when you know it; unknown, nothing is filtered and the run says so. The run prints one line naming the reviewer and why.

Parse the `===FINDINGS_JSON===` block (and/or read `reviews/latest/code-review.md`). Keep reviewId and each finding's id for the status file.

## Step 2 — Triage, then fix without asking

**Done means:** every non-filed finding has a fixed or rejected status (or, for fix-check and recheck findings, deferred), fixes are committed, and --close succeeds as a complete close at HEAD. Clean reviews close too and run the full tests. A partial close lists outOfScope files and covers nothing.

**No confirmation (rule 10).** Send every HIGH and MEDIUM straight to the fix round, or dispute it with proof; never ask which to fix. A finding that is really a product choice (bug or feature?) gets the safe fix by default and is named in the report so the operator can reverse it. LOWs are filed.

**One report, after the fix round and the fix check:** what was fixed, what was deferred and what was filed, each with its numbers (rule 11), plus any product-choice fix the operator may reverse. Fixing the filed items is optional.

## Step 3 — Apply the fixes

If a builder subagent wrote the branch, send it the HIGH and MEDIUM findings and have it fix the **real cause**. Otherwise fix the real cause directly with Edit/Write — you already have the diff loaded. Keep fixes minimal and faithful to the finding; don't suppress or paper over.

Then run the project's linter/formatter on the changed files (whatever the repo uses — e.g. `npm run lint`) and commit the fixes before closing, never after. Fixes never get a full re-review. Write a status file keyed by finding id; unknown keys and any severity field refuse:

```json
{"f1":{"status":"fixed"},"f2":{"status":"rejected","reason":"<why>","evidence":"<file:line or test>","refutedBy":{"review":"<prior review id>","finding":"<prior finding id>"}}}
```

After the fix check, its x… findings (and a Grade recheck's r… findings, or a criterion still failing its recheck) may instead be deferred: `{"x1":{"status":"deferred","reason":"<why>","fix":"<fix idea>"}}`. The reason is required; any severity or score field refuses; an original finding can't be deferred.

Omit refutedBy when using this review's own REFUTED verdict or a waiver. To dispute a serious finding, the orchestrator runs the first command below once for a real verdict. Then close against the committed fixes:

```bash
node "$REVIEW_SCRIPT" --dispute <review-id> <finding-id> --reason "<why>" --evidence "<file:line or test>"
node "$REVIEW_SCRIPT" --close <review-id> --status builds/<slug>/status.json
node "$REVIEW_SCRIPT" --summary
```

Close uses verifyCmd from .claude/review-config.json or --test-cmd. When there are no tests, pass --no-tests "<reason>"; that reason is logged and printed in the summary. If close says a fix check is needed, the orchestrator runs --fix-check <review-id> once, fixes, disputes or defers its x1… findings, then closes. Config `fixCheck`: `"risk"` (default: a fix touching tests, verify scripts or riskPaths needs a fix check) | `"always"` (the risk rule, plus any other code fix after the review; other docs, static, coverage-exempt and `builds/` files never need one, so it is never looser than "risk"; for a Grade, its recheck counts as the check when nothing either rule counts changed after it). The home config is the floor: a repo file, `REVIEW_CONFIG` or `REVIEW_FIX_CHECK` may raise it, never lower it. Fixes land before the fix check: commits after it may touch only `builds/` and test files, and close still runs the full tests. A file the fix check saw is in scope at close, so a fix to a sibling file is fine once the fix check has seen it. Close counts a changed file as fixed only when it equals, exactly, the path the script recorded when it checked that finding's quote; a finding with no recorded path (unlocated, ambiguous between a/ or b/ and the bare path, a Grade finding, or one logged before paths were recorded) covers no file. A rename counts as a delete plus an add, so the renamed path is never covered by a finding. A fixed finding covers its whole file, not only the lines it cited. Deal with fix-check findings once (fix, reject or defer each), then a hard stop, with no further model pass. An earlier REFUTED verdict can settle a re-raised finding through refutedBy; do not reopen the dispute without new evidence. Put the --summary output in the PR body. Builders commit at phase end and never run reviews, grades or other models themselves; the orchestrator handles them and opens the PR.

## Never (from the review policy)
6. Agents never re-rate a finding (severity and score fields stay refused), defer in the first round, edit, re-log or forge review records, or ask the operator to run `--waive` or `REVIEW_GATE_OVERRIDE`.
9. `--waive` and `REVIEW_GATE_OVERRIDE` remain the operator's own emergency tools from the operator's terminal; no normal flow uses them.

Every PR body must include a section titled exactly **Deferred findings**, using the deferred and filed findings in --summary (or `none` when empty). When chasing a bug, first check `node <review.mjs> --deferred` and merged PR descriptions with `gh pr list --state merged --search "Deferred findings in:body"`. Resolve <review.mjs> repo-first, with the shared runtime fallback above. `--deferred` lists this repo by repoId, newest first; add `--all` for every repo. The trigger is the input or call path named in the issue.
