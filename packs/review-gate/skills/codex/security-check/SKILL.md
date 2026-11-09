---
name: security-check
description: Standalone security check of the current branch's committed diff. A reviewer from the `security` role in ACS (Models → Roles) looks for security holes only, and every finding must quote the code it cites, checked by script. It reports findings and edits nothing. It is logged apart from the review gate, so it never closes a review, covers a push or counts as a PR's security review.
---

# security-check — security findings, nothing else

Look at the committed diff for **security holes only**: trust boundaries crossed without a check, untrusted input reaching a shell, SQL, file paths, eval or HTML, authentication and authorization gaps, secrets in code or output, path traversal, unsafe deserialization, SSRF, and changes to dependencies, install scripts or CI. Correctness, style and performance are out of scope.

It works in any repository, alone: no review-gate config, no reviewer role and no other skill is needed.

## Step 1 — run the check

Commit the work first: the check reads the committed diff against the remote's default branch (auto-detected from `origin/HEAD`; `REVIEW_BASE=origin/<branch>` pins it). Repo copy first, shared runtime as the fallback, and also when the repo copy is too old to support `--security-only` (one line says so):
```bash
SCRIPT=scripts/review.mjs
[ -f "$SCRIPT" ] && ! { grep -q -- --supports "$SCRIPT" && node "$SCRIPT" --supports --security-only; } && echo "scripts/review.mjs does not support --security-only; using the shared runtime" >&2 && SCRIPT=
[ -f "$SCRIPT" ] || SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$SCRIPT" --security-only "<intent: what the branch delivers, and what it must keep safe>"
```
Add `--plan <plan.md>` when there is a plan. `REVIEW_PATHS=<pathspec>,<pathspec>` limits the check to part of the diff. `--security-only` takes nothing else: it refuses `--close`, `--fix-check` and every other command.

**Who checks.** The `security` role's families, in role order, each at its own flavor effort. With `REVIEW_AUTHOR=<family or vendor that built the branch>`, a family from another vendor goes first. `REVIEW_SECURITY_REVIEWER=<family>` pins one for a run. When a family fails, the next one in the role is tried. Each try times out after `security.timeoutMs` (default 15 minutes). It runs whatever `security.run` says: that setting decides only whether a PR review runs the security pass. When `model-id` is missing, the security role is unset, or no family in it has its CLI, the run stops and names the fix, never falling back to another model.

## Step 2 — report the findings

The run prints the findings as JSON after `===FINDINGS_JSON===` and writes `reviews/security/<id>/security-check.md`. Every HIGH also prints as one plain line.

Findings are `s1`, `s2`, … Each carries likelihood and impact (1–10), `protected` and a trigger, and its severity comes from those scores: HIGH when protected or risk ≥ 40, LOW (filed) when risk ≤ 10, MEDIUM otherwise (`node "$SCRIPT" --rubric` prints the scale). A finding whose quote is not at the cited place is listed apart, under "could not be located". Show every finding with its numbers, e.g. `HIGH 42/100 (likelihood 6/10 × impact 7/10)`, its file:line and trigger, HIGHs first.

This skill does not fix anything. A fix the operator asks for is ordinary work on the branch, reviewed like any other change.

## What it never does

The check writes to its own log, `security-log.jsonl` beside the review log, and the review gate never reads it. It never closes a review (`--close` and `--fix-check` refuse its id), never covers a push, `--summary` or `--tier-json`, never moves `reviews/latest`, never counts toward reviewer rotation, and its findings never reach a later review as "already decided".

A PR's security review is the pass that runs inside the PR's own review record. `node "$SCRIPT" --security-findings` lists this branch's standalone findings that are still open (not filed, and their quoted code is still there), so the PR review can be told to check them.
