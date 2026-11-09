---
name: security-check
description: Standalone security check of the current branch's committed diff. A reviewer from the `security` role in ACS (Models → Roles) looks for security holes only, and every finding must quote the code it cites, checked by script. It reports findings and edits nothing. It is logged apart from the review gate, so it never closes a review, covers a push or counts as a PR's security review. Use when asked to "security check this", "look for security holes", or before trusting a risky change.
allowed-tools: Bash, Read, Grep, Glob
---

# /security-check — security findings, nothing else

Look at the committed diff for **security holes only**: trust boundaries crossed without a check, untrusted input reaching a shell, SQL, file paths, eval or HTML, authentication and authorization gaps, secrets in code or output, path traversal, unsafe deserialization, SSRF, and changes to dependencies, install scripts or CI. Correctness, style and performance are out of scope.

It works in any repository, alone: no review-gate config, no reviewer role and no other skill is needed.

## Step 1 — Run the check

Commit the work first: the check reads the committed diff against the remote's default branch (auto-detected from `origin/HEAD`; `REVIEW_BASE=origin/<branch>` pins it). Use the repo's copy of the script first, the shared runtime as the fallback:
```bash
SCRIPT=scripts/review.mjs
[ -f "$SCRIPT" ] || SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$SCRIPT" --security-only "<intent: what the branch delivers, and what it must keep safe>"
```
Add `--plan <plan.md>` when there is a plan. `REVIEW_PATHS=<pathspec>,<pathspec>` limits the check to part of the diff. `--security-only` takes nothing else: it refuses `--close`, `--fix-check` and every other command.

- **Who checks.** The `security` role's families, in role order, each at its own flavor effort. With `REVIEW_AUTHOR=<family or vendor that built the branch>`, a family from another vendor goes first. `REVIEW_SECURITY_REVIEWER=<family>` pins one for a run. When a family fails, the next one in the role is tried. Each try times out after `security.timeoutMs` (default 15 minutes).
- **It runs whatever `security.run` says.** That setting decides only whether a PR review runs the security pass; asking for this check is the decision here.
- **No reviewer, no check.** When `model-id` is missing, the security role is unset, or no family in it has its CLI, the run stops and names the fix. It never falls back to another model.

## Step 2 — Report the findings

The run prints the findings as JSON after `===FINDINGS_JSON===` and writes a report to `reviews/security/<id>/security-check.md`. Every HIGH also prints as one plain line.

- Findings are `s1`, `s2`, … Each carries likelihood and impact (1–10), `protected` and a trigger, and its severity comes from those scores: HIGH when protected or risk ≥ 40, LOW (filed) when risk ≤ 10, MEDIUM otherwise. `node "$SCRIPT" --rubric` prints the scale.
- A finding whose quote is not at the cited place in the code is listed apart, under "could not be located", never as a finding.
- Show every finding with its numbers, e.g. `HIGH 42/100 (likelihood 6/10 × impact 7/10)`, with its file:line and trigger. Lead with the HIGHs.

This skill does not fix anything. If the operator wants a finding fixed, that is ordinary work on the branch, reviewed like any other change.

## What it never does

The check writes to its own log, `security-log.jsonl` beside the review log, and the review gate never reads it:
- it never closes a review, and `--close` and `--fix-check` refuse its id;
- it never covers a push, `--summary` or `--tier-json`, so a PR needs its own review and close;
- it never moves `reviews/latest` and never counts toward reviewer rotation;
- its findings never reach a later review as "already decided".

A PR's security review is the pass that runs inside the PR's own review record. When a branch is made ready for a PR, `node "$SCRIPT" --security-findings` lists this branch's standalone findings that are still open (not filed, and their quoted code is still there), so the PR review can be told to check them.
