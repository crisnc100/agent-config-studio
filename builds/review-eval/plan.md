# PR D: bug test set (review gate eval)

From the review-vs-Anthropic comparison, approved by Cris 2026-11-05. Anthropic scores every reviewer change against past incidents; we have no such check. One PR: a runner and case format. Seeding real cases is a separate step after merge.

## Outcome
`node review.mjs --eval [--family <f>,...] [--cases <dir>]` runs each chosen reviewer family against a folder of cases (known bugs plus known-clean changes) and prints, per family: bugs caught, bugs missed, false alarms on clean cases, and time. Results are appended to `eval-log.jsonl` beside the review log so models can be compared over time.

## Design
- **Case format**, one folder per case: `case.json` `{id, kind: "bug"|"clean", intent, expect?: [{file, lines: [from, to], what}]}`, `base/` (the files before) and `change.patch` (the change to review, applied as one commit). The runner builds a throwaway git repo in a temp folder, base commit + change commit, with a bare remote as origin, and runs the normal review there (`REVIEW_REVIEWER=<family>`, no shadows, no pick shadows, no security pass, no log writes to the real review log: `REVIEW_LOG_DIR` pointed at the temp folder, or the equivalent existing switch).
- **Scoring:** a bug case is caught when a located finding's file matches and its line is inside `lines` ± 5. A clean case counts each located HIGH or MEDIUM as a false alarm (LOW findings are noted, not counted). Unlocated findings are counted separately.
- **Where cases live:** `~/.agent-config-studio/review-gate/eval/cases/` by default (the operator's own data, never shipped); `--cases` overrides. The pack ships two tiny example cases (one bug, one clean) under `packs/review-gate/eval/examples/` for tests and as templates.
- **Cost guard:** prints how many reviews it will run before starting; `--yes` to proceed when there are more than 10.

## Acceptance criteria (each checked by a test with stub reviewers)
1. The example bug case with a stub that reports the expected line → caught; a stub that reports another file → missed; the example clean case with a stub MEDIUM → one false alarm, with a stub LOW → none.
2. Two families → two result rows; `eval-log.jsonl` gains one record per family per run with case-level results.
3. The real review log, shadow log and `reviews/` folder of the operator are untouched by an eval run.
4. A malformed case (missing base/, bad patch, bad case.json) is skipped with a named error; the run continues.
5. More than 10 reviews without `--yes` → prints the count and stops.
6. Skill text (both twins): one short paragraph on --eval. `review.test.mjs` byte-identical; no existing assertion changes; full suite passes.

## Out of scope
Seeding real cases (next step: an agent mines reverts, "fix" commits for deferred findings, and Cris's flags in his repos and writes 10+ cases for him to confirm); scoring security findings; any change to reviewer selection.

## Revisions after the Bounce (Fable, bounce.out) — these override the sections above
- **Isolation by a real eval mode.** `--eval` spawns one child per case (own cwd, the runSlices pattern) with an eval marker env. In eval mode the child: writes only to the eval run's own temp log dir (a new explicit log-dir override honoured ONLY with the eval marker; --gate, --close and --summary refuse to run with the marker); disables shadows, pick shadows, verifyCmd, second-opinion verify and the security pass; never runs set-head; sets REVIEW_BASE to the temp repo's base branch explicitly. No bare remote. Model auth and roles still come from the real HOME.
- **Case format:** `case.json` + `base/` + `head/` trees (no patch file); the runner builds base and head commits. `expect: [{file, side: "head"|"base", lines: [a,b], what}]` (all must be caught); clean cases may list `allow: [{file, lines}]`. Validation before anything runs: unique ids, kind/expect consistency, non-empty expect for bug cases, head differs from base.
- **Scoring:** reads the log record's resolvedPaths and parsed line (ranges → their start..end). Caught = a located finding on the expected side's file whose line range overlaps `lines` ± 3; records the catching finding's severity. On bug cases, findings matching no expect are counted as extra; on clean cases, HIGH/MEDIUM/unscored outside `allow` are false alarms. Unlocated findings counted apart. Outcomes per case: caught | missed | errored (child failure, quota, timeout, missing FINDINGS_JSON) — errored never counts as missed.
- **Timeout** per case review (default 15 min, `--timeout`). A family whose CLI is missing is reported once and skipped before the cost guard.
- **Cost guard** counts families × valid cases and notes multipliers (claude team = several calls); `--yes` above 10.
- **Record:** per family per run: family, model id, effort, modelUsed when reported, rubricVersion, runtime file hash, prompt hash, case ids and per-case outcome/severity/duration. `--repeat N` runs each case N times; output says n.
- **Examples** listed in pack.json, written to pass the personal-text and model-name sweeps.
- **Added acceptance:** window boundary, b/ prefix, a LOW catch reported with its severity, extra findings on a bug case, no-op head = invalid case, errored child, operator repo's .git byte-identical and planted shadow/security/verify/verifyCmd never fire, --gate/--close refuse with the eval marker, row A ran family A's model.
