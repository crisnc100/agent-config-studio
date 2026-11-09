---
name: pr-review
description: Make a finished branch ready for its pull request, in one fixed order. The code review and the security pass run together in one review record, then one fix round, one fix check and the close, then the push, and /pr writes the description. Use when a branch, or a /build tip, is finished and being made ready for a PR, or when asked to "review this for the PR". It owns the order of the steps; the reviews themselves follow the code-review skill's rules.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, AskUserQuestion
---

# /pr-review — from a finished branch to an open PR

This skill owns the order. Each step below runs once, in this order, and never per build phase:

```
SETTING  read security.run, and say plainly when it is off
REVIEW   code + security in parallel → one record (open standalone security findings go in as context)
FIX      one fix round → one fix check → close
CONTEXT  the context pass: not built yet, skipped (say so)
SHIP     push → /pr writes the description → the operator merges
```

Triage, fixes, statuses, disputes, deferrals and the close follow the **code-review skill's** Steps 2–3 and its review policy (rules 1–11). `s…` findings follow exactly the same rules as `f…` findings.

## Step 1 — Read the security setting

```bash
SCRIPT=scripts/review.mjs
[ -f "$SCRIPT" ] && ! { grep -q -- --supports "$SCRIPT" && node "$SCRIPT" --supports --security-findings; } && echo "scripts/review.mjs does not support --security-findings; using the shared runtime" >&2 && SCRIPT=
[ -f "$SCRIPT" ] || SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$SCRIPT" --show-config
```

Its `security` field is `security.run` as this review will use it. A repo copy of the script too old to support `--security-findings` is skipped for the shared runtime, and one line says so.

- **Security pass.** Config `security.run`: `"off"` (default) | `"required"` | `"always"`, plus `security.timeoutMs` (default 15 minutes). The operator sets it in ACS → Packs → Review gate, which writes the home config. When on, and the change is not docs, tests, static or lockfiles only (or it touches riskPaths; `always` runs every time), a reviewer from the `security` role (ACS → Models → Roles; `REVIEW_SECURITY_REVIEWER=<family>` pins one for a run) reviews the same diff with a security-only prompt, in parallel with the code reviewer, preferring a vendor other than the code reviewer's and trying the next role member when one fails. The code review's reviewer, pick, routing, force and team settings never apply to it. Its findings come back in the same review record and FINDINGS_JSON as `s1`, `s2`, … (`source: "security"`), scored by the same rubric, and go through the same fix round, fix check, close, dispute and `--summary`. A tracked repo config or `REVIEW_CONFIG` may only raise `security.run` above the home config's, and `REVIEW_SECURITY=<level>` only raises it for one run. A required pass that failed or was skipped, or logic changed after a review the pass did not cover, makes the merge tier HIGH.
- **When it is off, say so.** Write `Security: not reviewed (security.run is off)` in the report and in the PR description. A PR never reads as security-reviewed when no security pass ran. Never raise the setting on your own; it is the operator's.
- When it is on but the run says the pass was not required (only docs, tests or static files changed), say that instead, with its reason.

## Step 2 — The review: code and security in one record

Commit the work first, including the build folder. Collect the branch's open standalone security findings, then run the review **without** `--code-only`, so the security pass runs beside the code reviewer:

```bash
OPEN=$(node "$SCRIPT" --security-findings)
node "$SCRIPT" --plan <plan.md> "<intent: what the branch delivers, its acceptance criteria, and anything deliberately out of scope>" "$OPEN"
```

Drop `--plan` when there is no plan; pass `REVIEW_AUTHOR=<family or vendor that built the branch>` when known. `--security-findings` lists findings from earlier `/security-check` runs on this branch that are still open; they reach both reviewers as context to check, never as decided. A big diff is sliced as the code-review skill says (`--slices`, without `--code-only`).

**From /build.** A /build tip arrives with its Grade (and, for risk-area work, a review) already closed. Run `node "$SCRIPT" --tier-json`: when the tip is covered and security.run is off, go straight to Step 5. With security.run on, run this step at the tip anyway: a Grade carries no security pass, and only a review record does.

## Step 3 — One fix round, one fix check, close

1. **Fix round.** Every HIGH and MEDIUM, `f…` and `s…`, goes to the fix round without asking (rule 10): to the builder that wrote the branch, or applied here when no builder did. LOWs are filed. Commit the fixes.
2. **Fix check.** When the fix round changed any code, run `node "$SCRIPT" --fix-check <review-id>` once, so the fixes get one look. Fix, reject or defer each `x…` finding once, then stop: no second check.
3. **Close.** `node "$SCRIPT" --close <review-id> --status builds/<slug>/status.json` (with `--test-cmd`, or `--no-tests "<reason>"`). A clean review closes too.

## Step 4 — Context pass (not built yet)

The context pass, a review of comments and technical docs against the final code, is planned but not built yet. Skip this step, and say in the report that it was skipped.

## Step 5 — Push, then /pr

1. `node "$SCRIPT" --summary` must succeed at the tip; its output goes in the PR body.
2. Push the branch. With the push gate installed, a refusal names the uncovered files: follow the code-review skill's slice rule, never an override.
3. Run `/pr` to write the description from the close. Without the pr skill, open the PR with `gh pr create`, putting the `--summary` output, the **Deferred findings** section and the security line from Step 1 in the body.
4. Agent merge, if the operator turned it on, follows rule 5 of the review policy (`node ~/.agent-config-studio/review-gate/merge.mjs`). Otherwise the operator merges.

## One report

Report once, after the close: what was fixed, what was deferred and what was filed, each with its numbers (rule 11); the security line from Step 1; that the context pass was skipped; and the PR link.
