---
name: pr-review
description: Make a finished branch ready for its pull request, in one fixed order. The code review and the security pass run together in one review record, then one fix round, the context pass, one fix check that also reviews the context commit, and one close at the tip, then the push, and /pr writes the description. Use when a branch, or a /build tip, is finished and being made ready for a PR, or when asked to "review this for the PR". It owns the order of the steps; the reviews themselves follow the code-review skill's rules.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, AskUserQuestion
---

# /pr-review — from a finished branch to an open PR

This skill owns the order. Each step below runs once, in this order, and never per build phase:

```
SETTING  read security.run, and say plainly when it is off
REVIEW   code + security in parallel → one record (open standalone security findings go in as context)
FIX      one fix round, committed
CONTEXT  /context-pass on the fixed code, before any close
CHECK    one --fix-check per review, with --focus docs when the context pass committed: it reviews the fix round and the context commit
CLOSE    one close at the tip: the tests run once, nothing is closed before it
SHIP     push → /pr writes the description → merged per the merge policy (merge.mjs, or the operator)
```

Triage, fixes, statuses, disputes, deferrals and the close follow the **code-review skill's** Steps 2–3 and its review policy (rules 1–11). `s…` findings follow exactly the same rules as `f…` findings.

## Step 1 — Read the security setting

```bash
SCRIPT=scripts/review.mjs
[ -f "$SCRIPT" ] || SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
[ "$SCRIPT" = scripts/review.mjs ] && ! ( grep -q -- --supports "$SCRIPT" && for f in --open-findings --focus '--fix-check --focus' --context-commit; do node "$SCRIPT" --supports "$f" || exit 1; done ) && echo "scripts/review.mjs does not support every flag this flow uses; using the shared runtime" >&2 && SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$SCRIPT" --show-config
```

Its `security` field is `security.run` as this review will use it. A repo copy of the script too old to support every flag this flow uses (`--open-findings`, `--focus`, `--focus` with `--fix-check`, and `--context-commit`) is skipped for the shared runtime, and one line says so.

- **Security pass.** Config `security.run`: `"off"` (default) | `"required"` | `"always"`, plus `security.timeoutMs` (default 15 minutes). The operator sets it in ACS → Packs → Review gate, which writes the home config. When on, and the change is not docs, tests, static or lockfiles only (or it touches riskPaths; `always` runs every time), a reviewer from the `security` role (ACS → Models → Roles; `REVIEW_SECURITY_REVIEWER=<family>` pins one for a run) reviews the same diff with a security-only prompt, in parallel with the code reviewer, preferring a vendor other than the code reviewer's and trying the next role member when one fails. The code review's reviewer, pick, routing, force and team settings never apply to it. Its findings come back in the same review record and FINDINGS_JSON as `s1`, `s2`, … (`source: "security"`), scored by the same rubric, and go through the same fix round, fix check, close, dispute and `--summary`. A tracked repo config or `REVIEW_CONFIG` may only raise `security.run` above the home config's, and `REVIEW_SECURITY=<level>` only raises it for one run. A required pass that failed or was skipped, or a file it owed that no security pass read, makes the merge tier HIGH.
- **When it is off, say so.** Write `Security: not reviewed (security.run is off)` in the report and in the PR description. A PR never reads as security-reviewed when no security pass ran. Never raise the setting on your own; it is the operator's.
- When it is on but the run says the pass was not required (only docs, tests or static files changed), say that instead, with its reason.

## Step 2 — The review: code and security in one record

Commit the work first, including the build folder. Run the review **without** `--code-only`, so the security pass runs beside the code reviewer:

```bash
node "$SCRIPT" --plan <plan.md> "<intent: what the branch delivers, its acceptance criteria, and anything deliberately out of scope>"
```

Drop `--plan` when there is no plan; pass `REVIEW_AUTHOR=<family or vendor that built the branch>` when known. The review reads the branch's open findings itself, the open standalone security findings and the blocking or protected findings of phase reviews and Grades that no close has judged, and hands them to both reviewers as checks to make, never as decided; `node "$SCRIPT" --open-findings` prints them. A big diff is sliced as the code-review skill says (`--slices`, without `--code-only`).

**From /build.** A /build tip gets the same single review as any branch, run at the tip in this step: it reads the phase reviews' and Grades' open findings itself. Phase reviews and Grades are never closed, except the last Grade's criteria close, which marks its findings `carried`: run it after this review is recorded (`--close <grade-id>`), since a carried finding needs the review that lists it.

## Step 3 — One fix round, the context pass, one fix check, one close

Close once, at the tip: no `--close` runs before the fix check, so every fix is in the one close's view; a commit after the fix check is unseen until a slice reads it.

1. **Fix round.** Every HIGH and MEDIUM, `f…` and `s…`, goes to the fix round without asking (rule 10): to the builder that wrote the branch, or applied here when no builder did. LOWs are filed. Commit the fixes.
2. **The context pass.** Run `/context-pass` in PR mode on the fixed code: write `builds/<slug>/context-brief.json` and check it with `--check-brief`, run the writer, then check its commit with `--check-commit` (it refuses a commit that changes a code line). Its docs table goes to `builds/<slug>/docs-table.json`, which `pr-facts --check` reads.
3. **One fix check.** When the fix round or the context pass committed anything, run it once; with the context commit, add the docs focus:
   ```bash
   node "$SCRIPT" --fix-check <review-id> --focus docs --context-commit <the context pass's commit>
   ```
   Drop `--focus docs` and `--context-commit` when the context pass made no commit. The prompt names that commit and its files, and asks for any code-line change in it; the rest of the diff is the fix round. Its reviewer reads the fix round and the context commit together: the fix as code, and every changed doc line and comment against the code, reporting untrue or unbacked claims. It reads the full change from the base of every file changed since the review that the review did not read, and of every file a finding cites; its security pass reads the owed ones, and one that failed or was skipped makes the merge tier HIGH. Reject or defer each `x…` finding once, then stop: no second check. No later pass reads a fix to one, so `fixed` on a blocking or protected `x…` finding is refused: fix it, defer it, and slice its files at the tip. Its docs findings follow the same rule: deferred ones reach the PR body's **Deferred findings** with their numbers.
4. **Close, once.** At the tip, after every fix is committed: `node "$SCRIPT" --close <review-id> --status builds/<slug>/status.json` (with `--test-cmd`, or `--no-tests "<reason>"`). A clean review with no context commit closes here too. A sliced review closes every slice at this same HEAD, one after another; a close lists what no pass read (`unseen`): slice exactly those files at the tip (`REVIEW_PATHS=…`) and close the slice.

## Step 4 — Nothing left between the close and the push

The close is the last gate step. When something has to change after it, the code-review skill's slice rule covers just those files; the context pass never runs a second time.

## Step 5 — Push, then /pr

1. `node "$SCRIPT" --summary` must succeed at the tip; its output goes in the PR body.
2. Push the branch. With the push gate installed, a refusal names the uncovered files: follow the code-review skill's slice rule, never an override.
3. Run `/pr` to write the description from the close; it reads the docs table at `builds/<slug>/docs-table.json` (pass `--docs-table` to pr-facts when the table lives elsewhere). Without the pr skill, open the PR with `gh pr create`, putting the `--summary` output, the **Deferred findings** section and the security line from Step 1 in the body.
4. Agent merge: read the merge policy from `--tier-json`; unless it is `off`, run `node ~/.agent-config-studio/review-gate/merge.mjs` once, as rule 5 of the review policy says, and report the one line it prints. A runtime whose `--tier-json` has no `policy` field counts as not off, and merge.mjs decides. Agents merge only through merge.mjs, which follows the review gate's merge policy (default off: the operator merges). Never gh pr merge, auto-merge or the merge button.
   ```bash
   POLICY=$(node "$SCRIPT" --tier-json 2>/dev/null | jq -r '.policy // "unknown"')
   [ "$POLICY" = off ] || node ~/.agent-config-studio/review-gate/merge.mjs
   ```

## One report

Report once, after the close: what was fixed, what was deferred and what was filed, each with its numbers (rule 11); the security line from Step 1; what the context pass changed (or that it changed nothing) and the changes it proposes for instruction files; and the PR link.
