---
name: code-review
description: Single-pass, read-only code review of the current branch's committed diff for correctness — logic bugs, regressions, edge cases, error handling, data integrity. Runs the shared review engine (review.mjs), returns structured findings by severity, fixes every HIGH and MEDIUM without asking, defers what the one fix check leaves, and reports once. The script never fixes; no loop.
---

# code-review — review → fix → one report

Review the committed diff vs the remote's default branch (auto-detected from `origin/HEAD`) for **code correctness only** (not style, not product scope, not a security audit).
One pass, read-only reviewer, findings come back to the seat, every HIGH and MEDIUM is fixed in-context without asking (rule 10 below), then one report.

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

Per-run knobs (env → config file → built-in): `REVIEW_EFFORT=xhigh` (raise codex reasoning), `REVIEW_BASE=origin/master` (non-standard default branch). The config files are `.claude/review-config.json` (this repo) and `~/.agent-config-studio/review-gate/config.json` (all projects). A repo file sets `verifyCmd`, `classifier`, `base` or a `pick` that names a command only while git doesn't track it; otherwise those are ignored with a warning. Check active config: `node "$SCRIPT" --show-config`. The review log is `~/.agent-config-studio/review-log/review-log.jsonl` (an existing older log under `~/.claude` keeps being used until that folder exists).

**Big diffs: review in slices.** The prompt inlines at most 120k characters of diff; over that, the run warns and names the largest top-level folders.
Slice the one commit instead: run the review once per path group with `REVIEW_PATHS=<pathspec>,<pathspec>` (git pathspecs, comma- or newline-separated; config `paths` also works). A list that matches no changed file is refused.
Each slice gets its own record, findings and close, and a sliced close ignores later changes outside its paths. Commit every fix first, then close every slice at the same HEAD.
The slices together must cover every file of the diff, `builds/` included: the push gate and `--summary` accept them only then, and a missing slice blocks the push and names the uncovered files.

## Step 2 — triage, then fix without asking

Verify every finding against the actual code before fixing (you have the diff loaded):
- **Keep the scores and derived severity.** The script derives severity from scores; reviewer labels are comparison text only. Scores cannot change in triage.
- **Derived severity.** Reviewers supply likelihood and impact (integers 1–10), protected (boolean) and a concrete trigger. HIGH is protected or risk ≥ 40; LOW is unprotected risk ≤ 10 and is filed; MEDIUM is the rest. Fix HIGH first, then MEDIUM. HIGH, MEDIUM and all unscored findings block until fixed, REFUTED or waived. Invalid scores are re-asked once; still-unscored findings block as MEDIUM (HIGH if protected). Legacy unscored LOW findings also block. Filed findings need no close status, are already decided, and are fixed only when the operator picks them. Grade criterion FAILs stay HIGH and are never filed.
- **Protected cases.** A demonstrated reachable exploit, stored data lost beyond ordinary undo, wrong money, or a way around the review gate in the gate's own logic: the push check, the close, a dispute or a waiver accepting work it should refuse.
  Guard command phrasings (agent-guard) are not protected; score them by likelihood × impact because the guard is an accident barrier.
- **Reject with a reason and evidence** (file:line or a test). HIGH/MEDIUM and unscored rejections need a REFUTED verdict from --dispute, a prior REFUTED reference on the same branch and repository, or an operator waiver. One real verdict per finding; no back-and-forth. NO-VERDICT means it stands and may be retried. If CONFIRMED, fix it. When the reviewer role has only one family, so no second family can give a verdict, only an operator waiver can reject the finding: --waive from a real terminal is the operator's own tool, and agents never ask for it (rule 9).

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

Close runs the whole test suite using verifyCmd from .claude/review-config.json or --test-cmd. If there are no tests, pass --no-tests "<reason>"; it is logged and appears in the summary. Only when close requires it, the orchestrator runs --fix-check <review-id> once. Fix, dispute or defer its x1… findings, close, then a hard stop, with no further model pass. Commits after the fix check may touch only the paths its fixed x… findings recorded (not builds/ or another test); close still runs the full tests. Close counts a changed file as fixed only when it equals, exactly, the path the script recorded when it checked that finding's quote; a finding with no recorded path (unlocated, ambiguous between a/ or b/ and the bare path, a Grade finding, or one logged before paths were recorded) covers no file. A rename counts as a delete plus an add, so the renamed path is never covered by a finding. A fixed finding covers its whole file, not only the lines it cited. A complete close covers HEAD; a partial close lists outOfScope files and does not cover the tip. Use refutedBy for an already-decided finding rather than reopening its dispute without new evidence. Put --summary output in the PR body. --log-outcome is optional telemetry only; it never closes a review.

## Review policy (rules 1–11)

1. The operator is involved only at PR merge; no agent pauses work to ask the operator to run a command.
2. First round: every HIGH and MEDIUM from the original review is fixed, or rejected with a REFUTED verdict from a different model (`--dispute`). Nothing is deferred in this round; LOWs are filed automatically.
3. One fix round, then one fix check. What the fix check finds (`x…`, any severity) may be deferred: `{"x1":{"status":"deferred","reason":"<why>","fix":"<fix idea>"}}`. The reason is required, `fix` is optional (the reviewer's suggestion shows otherwise), and the reviewer's score stands. The close then completes; there is no second round.
4. Grade: a criterion still failing after one fix round and its one recheck may be deferred as "criterion not met" with the same status shape, and so may the recheck's own `r…` findings. It never silently passes.
5. The PR body (`--summary`) lists, in order: "Acceptance criteria not met", deferred HIGHs, then all other deferred findings; `--deferred` lists them too. The operator's merge is the approval, and the operator can send the branch back.
6. Agents never re-rate a finding (severity and score fields stay refused), defer in the first round, edit, re-log or forge review records, or ask the operator to run `--waive` or `REVIEW_GATE_OVERRIDE`.
7. A history rewrite (squash, split, rebase) after a review or Grade is allowed when the final tree is byte-identical: the gate compares tree hashes with the review, Grade, fix-check, recheck and close heads, and logs the carry-over as `carried`. Any other tree gets a fresh review.
8. An unexpected gate refusal: one fresh review of the final branch through the normal path, then a clean close. If the gate still refuses, stop and tell the operator in chat, quoting the gate's message.
9. `--waive` and `REVIEW_GATE_OVERRIDE` remain the operator's own emergency tools from the operator's terminal; no normal flow uses them.
10. No confirmation before fixing: every HIGH and MEDIUM goes straight to the fix round, or is disputed with proof, without asking. A finding that is really a product choice gets the safe fix by default and is named in the report so the operator can reverse it. The operator hears once, after the fix round and fix check: what was fixed and what was filed. Fixing the filed items is optional.
11. Show the numbers: every finding shown to the operator carries its scores, e.g. `LOW 6/100 (likelihood 2/10 × impact 3/10)`, or `unscored`, never just the word. The report, `--summary` and `--deferred` print them that way, except that filed lines there still read `risk N LOW`.

## Hard rules

- Read-only reviewer; it never edits or commits.
- Never weaken a check to make a finding disappear.
- Prefer a reviewer from another vendor than the author (see Step 1); never wait for one.
- Builders commit at phase end and never run reviews, grades or other models themselves. The orchestrator handles those checks, pushes and opens the PR with the review summary.
- Never merge, never push to a protected branch. Leave that to the operator.

Every PR body must include a section titled exactly **Deferred findings**, using the deferred and filed findings in --summary (or `none` when empty). When chasing a bug, first check `node <review.mjs> --deferred` and merged PR descriptions with `gh pr list --state merged --search "Deferred findings in:body"`. Resolve <review.mjs> repo-first, with the shared runtime fallback above. `--deferred` lists this repo by repoId, newest first; add `--all` for every repo. The trigger is the input or call path named in the issue.

Use `node <review.mjs> --rubric` for the current version and score anchors. `~/.agent-config-studio/review-gate/calibration.md` contains the eight reference cases; run `node <review.mjs> --calibrate` (or `--calibrate copy.md`) after rubric changes or when evaluating a new model. Historical log records retain their stored bands and filing decisions.
