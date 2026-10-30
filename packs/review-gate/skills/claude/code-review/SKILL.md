---
name: code-review
description: Single-pass code review of the current branch's diff. The reviewer comes from the `reviewer` role in ACS (Models → Roles), each family at its own flavor effort; name any family, "premium", "both" or "claude" (the multi-agent team) to choose for one run. Every finding must quote the code it cites, checked by script. It reports findings; you confirm which to fix, the builder that wrote the branch applies them (or the agent, when no builder did), then the outcome is logged. No auto-fix, no loop.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, AskUserQuestion
---

# /code-review — review → you confirm → I fix

Review the committed diff for **code correctness** — bugs, regressions, edge cases, error handling, data integrity — judged against what the branch was supposed to do. **One review pass** by a reviewer from the pool, then the findings come back to *me* and **you decide what to fix**. Confirmed fixes go back to the builder subagent that wrote the branch, or I apply them in-context when no builder did — no loop.

Scope: code correctness vs. what was built. **Not** product direction. **Not** a security audit.

Why no loop: the loop's cost is re-reviewing the whole diff after every fix and re-spawning a fixer each round — that compounds to many minutes on a big diff. One review + human-confirmed in-context fixes is about one review's worth of time, and you stay in control.

## Step 1 — Run the review (single pass, read-only)

Commit the work first, including the build folder (it reviews the committed diff vs the remote's default branch, auto-detected), then run the reviewer — **repo copy first, shared runtime as the fallback**:
```bash
REVIEW_SCRIPT=scripts/review.mjs
[ -f "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$REVIEW_SCRIPT" "<intent: what the branch delivers, its acceptance criteria, and anything deliberately out of scope>"
```
Context comes from files: the orchestrator's plan via --plan <plan.md> or REVIEW_PLAN, the builder's adjacent log.md if present, and already-decided findings from the review log. Inside /build, pass the plan; a missing plan file refuses. The optional intent string can supplement those files. Decided stays decided: closed rejections on the same branch and repository are passed in as "already decided; don't re-raise without new evidence".
The repo's own scripts/review.mjs is the execution source when present. The first line names the copy and its path; an old copy that cannot log head is labelled and cannot cover a close.
- **Who reviews.** Reviewers come from the `reviewer` role in ACS (Models → Roles; `model-id --role reviewer --json`) — an unranked pool. Each family runs at its own flavor effort (`model-id --flavor <family> --json`), and its CLI follows its model id: `claude-…` → claude, `gpt-…` → codex, `grok-…` → grok. Families whose CLI is not installed are skipped, and one line names them. With no reviewer named, hard rules run first — `crossFamily`, then any config `force` rule (e.g. `{ "paths": ["**/auth/**", "**/payments/**"], "family": "<family>" }`, or `"paths": "risk"` for the `riskPaths` list) — then `pick` chooses: `first` (default, pool order), `rotate` (the family with the fewest logged reviews), a family name, or the command of an optional local classifier (it sees the diff's paths and line counts plus each family's flavor likes/quirks — never code; below confidence 0.7, or if it fails, the first family is used; its probabilities are printed and logged). `crossFamily: "prefer"` (default) skips pool members from the author's vendor when another remains — **pass `REVIEW_AUTHOR=<family or vendor that built the branch>`** when you know it; unknown, nothing is filtered and the run says so. The run prints one line naming the reviewer and why.
- **No silent fallback.** The run stops with a message naming the fix — never trying another vendor — when `model-id` is missing (`acs install-model-id`), the reviewer role is missing or broken, no family in the role has its CLI installed, or a reviewer you named has no CLI (ACS → Models → Roles).
- **Naming a reviewer** (`REVIEW_REVIEWER` or config `reviewer`) bypasses the pool: `codex` (the role's first codex family unless `REVIEW_MODEL` pins one), `claude` (the team), `grok`, or any family name. A config `model` alone also pins a codex reviewer; a raw model id there passes through as given.
- **Findings must be provably real.** Every finding carries a `quote` copied from the file. After the review a script checks the quote is in the file (at HEAD) starting within ±5 lines of the cited line, normalizing whitespace only. A finding that fails is marked `unverified-quote`, kept out of the findings, and listed under "could not be located in the code" (and counted in the log). Optional `verify: "second-opinion"` (`REVIEW_VERIFY=second-opinion`, off by default) sends only located, unfiled findings (skipping legacy reviewer-LOW findings) to one other pool family — another vendor when the pool has one — which answers CONFIRMED / REFUTED with one line of evidence; REFUTED findings move to a "disputed" section, never dropped. A verifier failure keeps every finding and warns.
- **Grok is read-only by tool allowlist** (`--tools read_file,list_dir,grep`) — its plan mode and `--disallowed-tools` do not stop writes, so the allowlist is the only guard. The run fails loudly if grok's `modelUsage` names no grok model.
- **Portable — configure, don't fork.** The same script runs in any repo. The base branch is **auto-detected** from `origin/HEAD`, so `staging`/`master`/`develop` repos need no setup; `REVIEW_BASE=origin/<branch>` still pins it for one run. If `origin/HEAD` can't be resolved it warns loudly before falling back to `origin/main` — never a silent wrong-base review. One gap it can't catch: an `origin/HEAD` that is set but *stale* (the remote renamed its default branch after you cloned) resolves silently to the old branch — the run banner prints the resolved base, so check it, and re-run `git remote set-head origin --auto` if it looks wrong.
- **Optional per-repo gate.** Set `verifyCmd` in `.claude/review-config.json` (e.g. `"npm run type-check"`) and it runs *before* the reviewer, with its pass/fail fed in as context. It never blocks — a failing build is something for the reviewer to explain, not a reason to skip the review. Unset (the default) changes nothing.
- It's **read-only** — it never fixes or commits. It writes `reviews/<ts>/code-review.md`, prints the findings as JSON after a `===FINDINGS_JSON===` marker, and appends one line to the review log, `~/.agent-config-studio/review-log/review-log.jsonl` (an existing older log under `~/.claude` keeps being used until that folder exists).

**Big diffs: review in slices.** The prompt inlines at most 120k characters of diff; over that, the run warns and names the largest top-level folders.
Slice the one commit instead: run the review once per path group with `REVIEW_PATHS=<pathspec>,<pathspec>` (git pathspecs, comma- or newline-separated; config `paths` also works). A list that matches no changed file is refused.
Each slice gets its own record, findings and close, and a sliced close ignores later changes outside its paths. Commit every fix first, then close every slice at the same HEAD.
The slices together must cover every file of the diff, `builds/` included: the push gate and `--summary` accept them only then, and a missing slice blocks the push and names the uncovered files.

Parse the `===FINDINGS_JSON===` block (and/or read `reviews/latest/code-review.md`). Keep reviewId and each finding's id for the status file.

## Step 2 — Triage, then show the findings, get the user's call

The JSON splits three lists: `findings` (quote located), `disputed` (a second opinion REFUTED it, with its evidence) and `unverified` (the quote isn't in the code). Show disputed findings with both sides, and unverified ones as carried unlocated findings with their stored severity. Every non-filed finding in all three lists needs a status at close.

Verify every remaining finding against the actual code before presenting (you have the diff loaded):
- **Keep the scores and derived severity.** The script derives severity from scores; reviewer labels are comparison text only. Scores cannot change in triage.
- **Derived severity.** Reviewers supply likelihood and impact (integers 1–10), protected (boolean) and a concrete trigger. HIGH is protected or risk ≥ 40; LOW is unprotected risk ≤ 10 and is filed; MEDIUM is the rest. Fix HIGH first, then MEDIUM. HIGH, MEDIUM and all unscored findings block until fixed, REFUTED or waived. Invalid scores are re-asked once; still-unscored findings block as MEDIUM (HIGH if protected). Legacy unscored LOW findings also block. Filed findings need no close status, are already decided, and are fixed only when the operator picks them. Grade criterion FAILs stay HIGH and are never filed.
- **Protected cases.** A demonstrated reachable exploit, stored data lost beyond ordinary undo, wrong money, or a way around the review gate in the gate's own logic: the push check, the close, a dispute or a waiver accepting work it should refuse.
  Guard command phrasings (agent-guard) are not protected; score them by likelihood × impact because the guard is an accident barrier.
- **Reject with evidence.** Record a reason and file:line or test evidence. A blocking finding (HIGH, MEDIUM or unscored) rejection needs a REFUTED verdict from --dispute, an earlier REFUTED verdict referenced on the same branch and repository, or an operator waiver. One real verdict per finding; no back-and-forth. NO-VERDICT means it stands and may be retried. If CONFIRMED — or when the reviewer role has only one family, so no second family can give a verdict — the operator waiver is the path: only the operator can accept the bug with --waive from a real terminal and a nonempty reason.

**Done means:** every non-filed finding has a fixed or rejected status, fixes are committed, and --close succeeds as a complete close at HEAD. Clean reviews close too and run the full tests. A partial close lists outOfScope files and does not cover the tip.

Present the survivors grouped by severity (**HIGH / MEDIUM / LOW**), each with `file:line` and the suggested fix. Then ask what to do — typically:
- **Fix all HIGH + MEDIUM** (the usual)
- **Fix only these:** … (the user picks)
- **Skip** — "none are real" / "I'll handle it"

If **no findings survive triage**, still close the review after recording any rejections; a clean report alone is not ready for a PR.

**Log the outcome** optionally for telemetry — confirmed = findings the user agreed were real, rejected = the rest. --log-outcome is telemetry only; it never closes a review. This is how the unranked pool earns a ranking:
```bash
node "$REVIEW_SCRIPT" --log-outcome <reviews-ts> <confirmed> <rejected>   # e.g. 2026-10-14-11-46-58 2 1
```
For `both`, log each run's folder with its own counts.

## Step 3 — Apply the confirmed fixes

If a builder subagent wrote the branch, send it the confirmed findings and have it fix the **real cause**. Otherwise fix the real cause directly with Edit/Write — you already have the diff loaded. Keep fixes minimal and faithful to the finding; don't suppress or paper over.

Then run the project's linter/formatter on the changed files (whatever the repo uses — e.g. `npm run lint`) and commit the fixes before closing, never after. Fixes never get a full re-review. Write a status file keyed by finding id; unknown keys and any severity field refuse:

```json
{"f1":{"status":"fixed"},"f2":{"status":"rejected","reason":"<why>","evidence":"<file:line or test>","refutedBy":{"review":"<prior review id>","finding":"<prior finding id>"}}}
```

Omit refutedBy when using this review's own REFUTED verdict or a waiver. To dispute a serious finding, the orchestrator runs the first command below once for a real verdict. Then close against the committed fixes:

```bash
node "$REVIEW_SCRIPT" --dispute <review-id> <finding-id> --reason "<why>" --evidence "<file:line or test>"
node "$REVIEW_SCRIPT" --close <review-id> --status builds/<slug>/status.json
node "$REVIEW_SCRIPT" --summary
```

Close uses verifyCmd from .claude/review-config.json or --test-cmd. When there are no tests, pass --no-tests "<reason>"; that reason is logged and printed in the summary. If close says a fix check is needed, the orchestrator runs --fix-check <review-id> once, resolves its x1… findings with the same statuses, disputes and waivers, then closes. Commits after the fix check may touch only files its fixed x… findings name (not builds/ or another test); close still runs the full tests. Deal with fix-check findings once, then a hard stop; unresolved work goes to the operator, with no further model pass. An earlier REFUTED verdict can settle a re-raised finding through refutedBy; do not reopen the dispute without new evidence. Put the --summary output in the PR body. Builders commit at phase end and never run reviews, grades or other models themselves; the orchestrator handles them and opens the PR.

## Commands (reviewer tiers)

| Command | Reviewer | When |
|---|---|---|
| `/code-review` | The pool pick — **one agent** (no `REVIEW_REVIEWER`; pass `REVIEW_AUTHOR` when known) | The default. Everyday PRs. |
| `/code-review premium` | **The `judge` role's family — ONE agent, one comprehensive pass, never a team** (`REVIEW_REVIEWER=<judge family>`) at its flavor effort | The premium judgment pass. Reserve for changes where being wrong is expensive (payments, order logic, auth, migrations). |
| `/code-review both` | The pool pick, then the `judge` role's family as double-check | Maximum confidence: run both, present ONE merged list — findings both flagged first (near-certain real), then each one's uniques. If the pool pick is already that family, the second run is the first pool family on another vendor. |
| `/code-review claude` | Claude multi-agent team (`REVIEW_REVIEWER=claude`; its lenses run on the reviewer role's Claude families, in role order) — the ONLY multi-agent tier | Only when the user names it. With no Claude family in the reviewer role, it stops and says so. |
| `/code-review <family>` | That family, one agent (`REVIEW_REVIEWER=<family>`) | When the user names one. |

Resolve the judge family with `eval "$(model-id --role judge)"` (it sets `family`, `id` and `effort`).

**Plain English works too** — "code review this with <family>", "review it with both" — the phrase picks the tier for that run via the env overrides. These one-run choices never change the durable default (env var → config file → built-in default precedence).

**Auto-routing by complexity (when the user doesn't name a tier).** The orchestrator picks objectively, never by model preference:
- Risk paths (payments, money math, auth, migrations, order-correctness, security) or >400 changed lines → **premium**; the very highest stakes → **both**.
- Everything else → **the pool pick** (the default).
Say which tier was picked and why in one line. The user's spoken choice always overrides the routing.

For `both`: run the script twice (once with no reviewer named, once with `REVIEW_REVIEWER=<judge family>` — each writes its own `reviews/<ts>/` report), then merge the two findings lists in-context before Step 2. Do not double-fix: one merged list, one confirmation round.

**The second run double-checks; it does not open a second hunt.** A finding only one model raised survives triage only if it names a concrete trigger (input or call path) you confirm in the code — otherwise record a rejection through the resolution rules above. Never run a third pass to settle a disagreement; present it to the user.

**Effort comes from each family's flavor** in ACS — change it there, not here. For one run: `REVIEW_EFFORT` (codex), `REVIEW_GROK_EFFORT` (grok), `REVIEW_CLAUDE_EFFORT` (a single Claude reviewer), `REVIEW_TEAM_EFFORT` (the claude team).

## Changing the model or reviewer (no script edits)

The skills and the loop **never change** — you swap settings in one small JSON file:

- **All your projects:** `~/.agent-config-studio/review-gate/config.json` (an older `~/.claude/review-config.json` is still read when that file is absent)
- **Just this repo:** `.claude/review-config.json` (per-user; git-ignored)

Copy `~/.agent-config-studio/review-gate/review-config.example.json`, rename it to one of the above, and edit the values. Precedence is **env var → that config file → built-in default**, so a quick `REVIEW_MODEL=…` still overrides for one run, and `/code-review claude` switches the reviewer for one run.

- **The pool (default):** leave `reviewer` and `model` out; set `"pick"` (`first` | `rotate` | a family | a classifier command), `"crossFamily"` (`prefer` | `off`), optional `"force"` rules (`[{ "paths": ["<glob>", …] | "risk", "family": "<family>" }]`, first match wins) and `"riskPaths"` (globs: `**` spans directories, `*` stays in one; a pattern with no `/` matches any path segment, like .gitignore). Env: `REVIEW_PICK`, `REVIEW_CROSS_FAMILY`, `REVIEW_AUTHOR`.
- **Second opinion:** `"verify": "second-opinion"` (env `REVIEW_VERIFY`); default off — the quote check always runs. A `reviewer` or `model` key pins a reviewer and bypasses the pool.
- **Who is in the pool, and at what effort:** the `reviewer` role and each family's flavor in ACS (Models → Roles) — never this file. A new model is one registry edit (`model-id --table`).
- **Claude team:** `{ "reviewer": "claude" }` — `claudeModel` `"team"` (the default) runs the lenses on the reviewer role's Claude families; a family name or id in `claudeModel` runs **one comprehensive agent** on that model instead.
- **Optional classifier:** `"classifier": "<command>"` names a local classifier a dispute may ask to choose its verifier; `"pick": "<command>"` lets it choose the reviewer.

Check what's active any time: `node <review.mjs> --show-config` (the repo path `scripts/review.mjs` or the shared `~/.agent-config-studio/review-gate/review.mjs`) — it prints the resolved pool and efforts, pick, crossFamily, the reviewer it would pick and why, the config file, the log path, and reviews logged per family.

Every PR body must include a section titled exactly **Deferred findings**, using the filed findings in --summary (or `none` when empty). When chasing a bug, first check `node <review.mjs> --deferred` and merged PR descriptions with `gh pr list --state merged --search "Deferred findings in:body"`. Resolve <review.mjs> repo-first, with the shared runtime fallback above. `--deferred` lists this repo by repoId, newest first; add `--all` for every repo. The trigger is the input or call path named in the issue.

Use `node <review.mjs> --rubric` for the current version and score anchors. `~/.agent-config-studio/review-gate/calibration.md` contains the eight reference cases; run `node <review.mjs> --calibrate` (or `--calibrate copy.md`) after rubric changes or when evaluating a new model. Historical log records retain their stored bands and filing decisions.
