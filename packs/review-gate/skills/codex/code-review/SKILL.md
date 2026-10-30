---
name: code-review
description: Single-pass, read-only code review of the current branch's committed diff for correctness — logic bugs, regressions, edge cases, error handling, data integrity. Runs the shared review engine (review.mjs), returns structured findings by severity, and applies only the fixes the user confirms. No auto-fix, no loop.
---

# code-review — review → you confirm → I fix

Review the committed diff vs the remote's default branch (auto-detected from `origin/HEAD`) for **code correctness only** (not style, not product scope, not a security audit).
One pass, read-only reviewer, findings come back to the seat, the human decides what to fix, fixes applied in-context.

## Step 1 — run the shared engine

Commit the work first, including the build folder (it reviews the committed diff). Then run the same `review.mjs` every tool shares — repo copy first, shared runtime as the fallback:
```bash
SCRIPT=scripts/review.mjs
[ -f "$SCRIPT" ] || SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$SCRIPT" "<intent: what the branch delivers, its acceptance criteria, and anything deliberately out of scope>"
```
Context comes from files: the orchestrator's plan via --plan <plan.md> or REVIEW_PLAN, the builder's adjacent log.md if present, and already-decided findings from the review log. Inside a build loop, pass the plan; a missing plan file refuses. The optional intent string supplements those files. Decided stays decided: same-branch, same-repository rejections arrive as "already decided; don't re-raise without new evidence".
It writes `reviews/<ts>/code-review.md` and prints findings as JSON after a `===FINDINGS_JSON===` marker. Parse that block; keep reviewId and each finding's id, including disputed and carried unlocated findings, for the status file. All retain their stored derived severity; every non-filed finding needs a status.

**Who reviews.** The `reviewer` role in ACS (Models → Roles; `model-id --role reviewer --json`) is the pool, each family at its own flavor effort. A family's CLI follows its model id (`claude-…` → claude, `gpt-…` → codex, `grok-…` → grok); families whose CLI is not installed are skipped and one line names them. The run stops with a message naming the fix — never trying another vendor — when `model-id` is missing (`acs install-model-id`), the role is missing, no family in it has its CLI, or a named reviewer has no CLI.

**Cross-family is preferred, never a blocker:** a different vendor than whoever wrote the code is best when it's available. Pass `REVIEW_AUTHOR=<family or vendor that built the branch>` and `crossFamily: "prefer"` (the default) skips the author's vendor when the pool has another. If no other vendor can run, review with what is available — never wait — and say so.
To name one reviewer for a run: `REVIEW_REVIEWER=<family>` (or `codex`, `claude` for the Claude multi-agent team on the role's Claude families, `grok`). Say which reviewer ran.

Per-run knobs (env → config file → built-in): `REVIEW_EFFORT=xhigh` (raise codex reasoning), `REVIEW_BASE=origin/master` (non-standard default branch). The config files are `.claude/review-config.json` (this repo) and `~/.agent-config-studio/review-gate/config.json` (all projects). Check active config: `node "$SCRIPT" --show-config`. The review log is `~/.agent-config-studio/review-log/review-log.jsonl` (an existing older log under `~/.claude` keeps being used until that folder exists).

**Big diffs: review in slices.** The prompt inlines at most 120k characters of diff; over that, the run warns and names the largest top-level folders.
Slice the one commit instead: run the review once per path group with `REVIEW_PATHS=<pathspec>,<pathspec>` (git pathspecs, comma- or newline-separated; config `paths` also works). A list that matches no changed file is refused.
Each slice gets its own record, findings and close, and a sliced close ignores later changes outside its paths. Commit every fix first, then close every slice at the same HEAD.
The slices together must cover every file of the diff, `builds/` included: the push gate and `--summary` accept them only then, and a missing slice blocks the push and names the uncovered files.

## Step 2 — triage, then show findings

Verify every finding against the actual code before presenting (you have the diff loaded):
- **Keep the scores and derived severity.** The script derives severity from scores; reviewer labels are comparison text only. Scores cannot change in triage.
- **Derived severity.** Reviewers supply likelihood and impact (integers 1–10), protected (boolean) and a concrete trigger. HIGH is protected or risk ≥ 40; LOW is unprotected risk ≤ 10 and is filed; MEDIUM is the rest. Fix HIGH first, then MEDIUM. HIGH, MEDIUM and all unscored findings block until fixed, REFUTED or waived. Invalid scores are re-asked once; still-unscored findings block as MEDIUM (HIGH if protected). Legacy unscored LOW findings also block. Filed findings need no close status, are already decided, and are fixed only when the operator picks them. Grade criterion FAILs stay HIGH and are never filed.
- **Protected cases.** A demonstrated reachable exploit, stored data lost beyond ordinary undo, wrong money, or a way around the review gate in the gate's own logic: the push check, the close, a dispute or a waiver accepting work it should refuse.
  Guard command phrasings (agent-guard) are not protected; score them by likelihood × impact because the guard is an accident barrier.
- **Reject with a reason and evidence** (file:line or a test). HIGH/MEDIUM and unscored rejections need a REFUTED verdict from --dispute, a prior REFUTED reference on the same branch and repository, or an operator waiver. One real verdict per finding; no back-and-forth. NO-VERDICT means it stands and may be retried. If CONFIRMED — or when the reviewer role has only one family, so no second family can give a verdict — the operator waiver is the path: only the operator can accept the bug using --waive with a nonempty reason from a real terminal.

Present findings grouped by **HIGH / MEDIUM / LOW**, each with `file:line` and the suggested fix. Ask: fix all HIGH+MEDIUM (usual), fix a chosen subset, or reject with evidence. Clean reviews still need --close and tests; a clean report alone is not done.

## Step 3 — apply confirmed fixes in-context

Fix the real cause directly (you have the diff loaded; do NOT re-spawn a model to fix). Keep fixes minimal and faithful; never suppress or paper over. Then run the repo's linter/formatter on the changed files and commit before --close, never afterward. Fixes never get a full re-review. Every non-filed finding needs a fixed or rejected status; unknown keys and any severity field refuse:

```json
{"f1":{"status":"fixed"},"f2":{"status":"rejected","reason":"<why>","evidence":"<file:line or test>","refutedBy":{"review":"<prior review id>","finding":"<prior finding id>"}}}
```

Omit refutedBy for this review's own REFUTED verdict or a waiver. The orchestrator disputes serious rejections and closes against the committed fixes:

```bash
node "$SCRIPT" --dispute <review-id> <finding-id> --reason "<why>" --evidence "<file:line or test>"
node "$SCRIPT" --close <review-id> --status builds/<slug>/status.json
node "$SCRIPT" --summary
```

Close runs the whole test suite using verifyCmd from .claude/review-config.json or --test-cmd. If there are no tests, pass --no-tests "<reason>"; it is logged and appears in the summary. Only when close requires it, the orchestrator runs --fix-check <review-id> once. Resolve its x1… findings with the same statuses, disputes and waivers, close, then a hard stop; unresolved work goes to the operator, with no further model pass. Commits after the fix check may touch only the paths its fixed x… findings recorded (not builds/ or another test); close still runs the full tests. Close counts a changed file as fixed only when it equals, exactly, the path the script recorded when it checked that finding's quote; a finding with no recorded path (unlocated, ambiguous between a/ or b/ and the bare path, a Grade finding, or one logged before paths were recorded) covers no file. A rename counts as a delete plus an add, so the renamed path is never covered by a finding. A fixed finding covers its whole file, not only the lines it cited. A complete close covers HEAD; a partial close lists outOfScope files and does not cover the tip. Use refutedBy for an already-decided finding rather than reopening its dispute without new evidence. Put --summary output in the PR body. --log-outcome is optional telemetry only; it never closes a review.

## Hard rules

- Read-only reviewer; it never edits or commits.
- Never weaken a check to make a finding disappear.
- Prefer a reviewer from another vendor than the author (see Step 1); never wait for one.
- Builders commit at phase end and never run reviews, grades or other models themselves. The orchestrator handles those checks, pushes and opens the PR with the review summary.
- Never merge, never push to a protected branch. Leave that to the operator.

Every PR body must include a section titled exactly **Deferred findings**, using the filed findings in --summary (or `none` when empty). When chasing a bug, first check `node <review.mjs> --deferred` and merged PR descriptions with `gh pr list --state merged --search "Deferred findings in:body"`. Resolve <review.mjs> repo-first, with the shared runtime fallback above. `--deferred` lists this repo by repoId, newest first; add `--all` for every repo. The trigger is the input or call path named in the issue.

Use `node <review.mjs> --rubric` for the current version and score anchors. `~/.agent-config-studio/review-gate/calibration.md` contains the eight reference cases; run `node <review.mjs> --calibrate` (or `--calibrate copy.md`) after rubric changes or when evaluating a new model. Historical log records retain their stored bands and filing decisions.
