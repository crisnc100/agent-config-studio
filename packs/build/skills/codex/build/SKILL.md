---
name: build
description: Build something through Frame → Bar → Judge from a Codex seat. Codex orchestrates; a builder-role family implements; the advisor role attacks the plan (Bounce) and the judge role grades the result (Grade), cross-vendor preferred; the human judges. State lives in files. Use for any real build where being correct matters — not a two-minute edit.
---

# build — Frame, Bar, Judge (Codex seat edition)

The driver makes three moves: **Frame** the outcome, set the **Bar** (how they'll know it's right), **Judge** the result. The agents do the producing and the checks; a different model does the adversarial checks. If the driver is exploring, planning, or verifying by hand, the loop is mis-run.

The Grade and the close use the review gate's installed runtime (the review-gate pack), `~/.agent-config-studio/review-gate/review.mjs`, never a copy in the checkout, which is the branch's own code and could write false review evidence.

## When to use / not

Use for a real feature, script, tool, or change where correctness matters. NOT for a two-minute edit (just do it), NOT for a pure question (investigate it or answer it plainly).

## Who runs each stage

Families come from the ACS roles (`model-id --role <role>`); the CLI follows the model id's prefix: `claude-…` → `claude`, `gpt-…` → `codex`, `grok-…` → `grok`, `gemini-…` → `agy`.

| Stage | Runner | How |
|---|---|---|
| Understand | codex (this seat) | read the code, map it, write `context.md` — conclusions, not dumps |
| Shape: draft plan + bar | codex | native |
| Shape: **Bounce** (attack the plan) | the `advisor` role's family, read-only | gate commands below |
| Build | the family recorded for this task | the phase loop below |
| **Grade** (verify vs bar) | the `judge` role's family, read-only, cross-vendor preferred | gate commands below |
| Judge | the driver | yes/no against the bar |

**Grader swap.** Cross-vendor checks follow the review gate's crossFamily setting (default prefer: another vendor when available, never a blocker; the run names who checked and why). Read it once with the gate commands below (`CROSS_FAMILY`). With `prefer`, the grader should not share the builder's vendor: if the `judge` family does, prefer the `advisor` role's second opinion (`alt` in `model-id --role advisor`) when it is from the other vendor. Never wait on a grader: if the preferred one is unavailable, use the other at once. With `off`, grade with the `judge` role's family. Say in the handoff which one ran and, when it was same-vendor, why. If no gate can run at all, the gate is **NOT RUN** — report it that way, never as a pass. Judgment-role families never build.

## Choose the builder once per task

First read the task's plan and latest handoff. If either has a builder record, load the current record into `BUILDER_RECORD` before routing any phase, fix or resume. A fresh worker still uses the same family and effort. An explicit operator change or a recorded replacement updates that record.

For a new task, an operator-named member of the configured builder lineup wins (`/build <family> [effort]` or plain English). An explicit name follows the direct-family pause behavior. Otherwise use the configured picker once. At Frame, set `NEW_VISUAL_DESIGN=true` only if the task needs genuinely new frontend visual direction. Frontend logic, implementation of a settled design, backend and database work use the regular strategy. When the task-fit strategy is configured, set `TASK_SUMMARY` to the absolute path of a short regular file with the objective and constraints, using the existing build materials.

The commands use Bash or zsh and jq. If jq is unavailable, run the same resolver commands and read their JSON directly. Set `NAMED_BUILDER` and `NAMED_EFFORT` only from the operator's explicit request. Initialize `EXCLUDED=()` for a new task or fill it with the recorded family exclusions for a replacement. Leave `BUILDER_RECORD` empty only when choosing a new owner. Run the selection and record checks in the same shell.

```bash
builder_lineup_state() {
  local role_report
  role_report=$(model-id --roles --json) || true
  jq -er --arg family "$1" '.roles.builder |
    if ((.use // []) | index($family)) != null then "active"
    elif ([.skipped[]?.family] | index($family)) != null then "paused"
    else empty end' <<< "$role_report"
}

if [ -z "${BUILDER_RECORD:-}" ]; then
  if [ -n "${NAMED_BUILDER:-}" ]; then
    BUILDER=$NAMED_BUILDER
    if ! builder_lineup_state "$BUILDER" >/dev/null; then
      printf '%s\n' 'Choose a member of the configured builder lineup in ACS → Models → Roles.' >&2
      exit 2
    fi
    BUILDER_ID=$(model-id "$BUILDER" || echo "MODEL-ID-UNRESOLVED-$BUILDER")
    case "$BUILDER_ID" in MODEL-ID-UNRESOLVED-*|'') exit 2 ;; esac
    EFFORT=${NAMED_EFFORT:-}
    [ -n "$EFFORT" ] || EFFORT=$(model-id --effort "$BUILDER" --role builder --no-alt) || exit 2
    BUILDER_RECORD=$(jq -nc --arg family "$BUILDER" --arg id "$BUILDER_ID" --arg effort "$EFFORT" \
      '{family:$family,id:$id,effort:$effort,mode:"explicit",reason:"operator named this builder",operatorNamed:true}')
  else
    PICK_ARGS=(--pick builder --json)
    [ "${NEW_VISUAL_DESIGN:-}" != true ] || PICK_ARGS+=(--design)
    [ -z "${TASK_SUMMARY:-}" ] || PICK_ARGS+=(--task-file "$TASK_SUMMARY")
    for EXCLUDED_FAMILY in "${EXCLUDED[@]}"; do
      PICK_ARGS+=(--exclude "$EXCLUDED_FAMILY")
    done
    PICK_STATUS=0
    PICK=$(model-id "${PICK_ARGS[@]}") || PICK_STATUS=$?
    if ! jq -e '.role == "builder"' >/dev/null 2>&1 <<< "$PICK"; then
      printf '%s\n' 'Builder picker unavailable. Run acs install-model-id.' >&2
      exit 2
    fi
    if [ "$PICK_STATUS" -ne 0 ]; then
      printf '%s\n' "$PICK" >&2
      exit "$PICK_STATUS"
    fi
    BUILDER_RECORD=$(jq -c '. + {operatorNamed:false}' <<< "$PICK")
  fi
fi
```

When choosing an owner, apply the operator's requested effort when it applies to that family. Otherwise follow any existing seat rule for that family, such as a medium/xhigh choice. Use the picker's effort when no override applies. If applying an override, put it in `EFFORT_OVERRIDE` and update the record before saving it.

```bash
BUILDER_RECORD=$(jq -ce --arg effort "$EFFORT_OVERRIDE" '. + {effort:$effort,effortOverride:$effort}' <<< "$BUILDER_RECORD") || exit 2
```

Save the JSON from `BUILDER_RECORD` in `plan.md` or the existing handoff. It records the family, model ID, effective effort, mode, reason and `operatorNamed`. Keep the Frame decision and cumulative exclusions there as well. In lightweight mode use the existing task brief or handoff. Before dispatch or review attribution, check the record against the currently configured lineup and registry. The membership check includes paused members and excludes the second opinion. Keep the saved effective effort even when it is empty. A failed record check stops routing until the orchestrator reconciles it with the task handoff and configuration.

```bash
BUILDER=$(jq -er '.family | strings | select(length > 0)' <<< "$BUILDER_RECORD") || exit 2
BUILDER_ID=$(jq -er '.id | strings | select(length > 0)' <<< "$BUILDER_RECORD") || exit 2
if ! BUILDER_LINEUP_STATE=$(builder_lineup_state "$BUILDER"); then
  printf '%s\n' 'Recorded builder is outside the configured builder lineup.' >&2
  exit 2
fi
if ! CURRENT_BUILDER_ID=$(model-id "$BUILDER" || exit 2) ||
   ! jq -e --arg family "$BUILDER" --arg id "$CURRENT_BUILDER_ID" '.family == $family and .id == $id' >/dev/null <<< "$BUILDER_RECORD"; then
  printf '%s\n' 'Recorded builder family or model ID does not match the current registry.' >&2
  exit 2
fi
if ! EFFORT=$(jq -er '.effort | select(IN("", "low", "medium", "high", "xhigh", "max"))' <<< "$BUILDER_RECORD"); then
  printf '%s\n' 'Recorded builder effort is invalid.' >&2
  exit 2
fi
if ! OPERATOR_NAMED=$(jq -er 'select(.operatorNamed == (.mode == "explicit")) | .operatorNamed | booleans | tostring' <<< "$BUILDER_RECORD"); then
  printf '%s\n' 'Recorded builder selection is invalid.' >&2
  exit 2
fi
```

Before dispatching a worker, check the recorded owner's availability. When an automatic owner is confirmed paused, use the replacement procedure below. For a named override, confirm the explicit request from the task context. Review attribution uses the checked owner record even if that family has since been paused.

```bash
if [ "$BUILDER_LINEUP_STATE" = paused ] && [ "$OPERATOR_NAMED" = false ]; then
  printf '%s\n' 'Recorded automatic builder is paused. Follow the recorded replacement procedure.' >&2
  exit 2
fi
```

Log a confirmed pause, quota limit or startup failure before replacing a builder. Check the tool's diagnostics and the worktree. Generic errors, timeouts and cancellation can leave edits. Hand off completed commits, checks and results, remaining work and any partial changes (including untracked files) before dispatching a replacement. Preserve earlier exclusions, add the failed family with the evidence, clear the current record and named-family input for the new pick, and use every exclusion with the original Frame decision. Save the replacement record and report the change. Each failed family is tried at most once in the automatic replacement chain. When the picker reports no eligible builder, show its reasons and stop that chain.

For quality escalation, first fix any gap in the brief and re-issue it to the same family. If an adequate brief still misses the same criterion twice, use another eligible family with the same handoff and record the quality reason. Switch automatically when the picker chose the family. For a quality switch away from an operator-named family, preserve the operator's existing choice to escalate or hold. If both builders miss the criterion, surface the scope issue to the operator.

## Dispatch the recorded builder

Give each worker the objective, read-first files, constraints, validation and stop condition. The worker runs the checks and commits the phase. The orchestrator handles reviews, model calls, pushes and PRs. The worker never merges. Point `BRIEF_FILE` at that complete phase brief. A new phase uses a fresh worker with the plan and handoff. For a callback or an unfinished phase, use its saved worker session when the route supports resume. Otherwise hand off the checkpoint using the same family and effort. Fixes use the active task owner and the same dispatch rules.

- For a `gpt-…` model, use a native Codex subagent on the recorded model and effort. Select those explicitly in the native agent controls and give the worker the self-contained brief. Use fresh context if required to set model and effort. If the native controls cannot honor the recorded settings, surface that blocker.
- For a `claude-…` model, use the cross-vendor CLI from the worktree. Leave `CLAUDE_SESSION_ID` unset for a fresh worker. On a callback or resume, use the `session_id` identified in that worker's JSON result.

The orchestrator writes the exact validation, staging and commit commands in the brief. Add a `Bash(...)` rule for each command in `CLAUDE_BASH_RULES` before launching the worker. Specify the staging paths and use a fixed commit message. For example, a fixture phase that edits `outcome.txt` could use these rules.

```bash
CLAUDE_BASH_RULES=(
  'Bash(node --test phase.test.mjs)'
  'Bash(git add -- outcome.txt)'
  'Bash(git commit -m builder-permission-smoke)'
)
```

Use only the phase's commands. If a command needs variable arguments, scope its rule to the known command prefix with a trailing space and `*`. Keep the test runner, staging paths and commit command specific to the brief.

```bash
if [ "${#CLAUDE_BASH_RULES[@]}" -eq 0 ]; then
  printf '%s\n' 'Set the headless builder Bash rules from the phase brief.' >&2
  exit 2
fi
EFFORT_FLAG=()
[ -z "$EFFORT" ] || EFFORT_FLAG=(--effort "$EFFORT")
SESSION_FLAG=()
[ -z "${CLAUDE_SESSION_ID:-}" ] || SESSION_FLAG=(--resume "$CLAUDE_SESSION_ID")
claude -p "$(cat "$BRIEF_FILE")" --model "$BUILDER_ID" "${EFFORT_FLAG[@]}" "${SESSION_FLAG[@]}" --allowedTools "${CLAUDE_BASH_RULES[@]}" --permission-mode acceptEdits --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format json </dev/null
```

**Antigravity builder.** For a `gemini-…` model, run the recorded family and effort through the native builder wrapper:

```bash
WORKTREE=$(git rev-parse --show-toplevel) || exit 2
WORKTREE=$(cd "$WORKTREE" && pwd -P) || exit 2
ask-model --family "$BUILDER" --build --cwd "$WORKTREE" --effort "$EFFORT" --prompt-file "$BRIEF_FILE" --json
```

A successful call exits 0 with `build.execution: "native"`, `build.completed: true` and `served.verified: false`. It uses normal agy permissions. Inspect the actual worktree and commits after a call. A failed call can leave edits. Record the dispatched family as the builder and report the served model as unverified.

Grok is a judgment lane. If the recorded ID has no supported builder route, report the configuration blocker.

## The four phases (state in `builds/<slug>/`, re-read each pass)

plan.md must name the phases and their pass/fail criteria. End a phase before later work builds on it (database changes, data passed between parts or shared code), whenever it touches riskPaths (sign-in, money, deleting data, migrations or security), or after over 400 changed lines since the last review. Everything else waits for the one review at the PR. Builders commit the code and build folder before each review; they never push, open a PR, or run reviews, grades or other models themselves. The orchestrator runs the checks below.

1. **Understand.** If the idea rests on unknowns, explore the code and write `context.md`. Show the driver a short summary; confirm the one-sentence outcome (**Frame**).
2. **Shape.** Draft `plan.md`: the outcome, named phases, the steps, and acceptance criteria where **every criterion is checkable by a command, test, or observable behavior**. Run the **Bounce** (below), fold its real gaps in, and show the driver the criteria to sharpen and approve (**Bar**). This is the highest-leverage moment.
3. **Build.** Implement against `plan.md`; build for the cases it names, not rare or future ones nobody asked for. After each step run the deterministic checks (`verify.sh` / tests) in the foreground, never as a background job you wait on, read pass/fail, fix, repeat. Log decisions to `log.md` and commit the phase, including the build folder. When the checks pass, the orchestrator runs the **Grade** (below), records it with --log-grade, then follows Record and close below. Recheck failed criteria once with --recheck-of; new recheck findings receive scores under the same rubric and the script derives their severity. Existing severity never changes in triage. Respect the pass limits and hard stop. **QA option:** when acceptance criteria include browser-observable behavior a script can't assert, a browser QA pass (your QA skill, if you have one) fits between Grade and Judge — hand it the target URL, the browser-checkable criteria verbatim, and setup steps. Not mandatory: run it when manual verification would cost the driver real time; skip it when Grade plus the deterministic checks already cover the bar — and state which in the Judge handoff, so a skipped QA run is a visible choice, never a silent one.
4. **Judge.** Hand the driver the green checklist with evidence, the result, the Grade verdict and which grader ran, and anything UNVERIFIED. The driver judges against the bar.

## The gate commands (read-only, always)

Resolve the gate from its role — never type a model id — and point `PROMPT_FILE` at that gate's own prompt:
```bash
GATE=bounce                                     # the Bounce; GATE=grade for the Grade
case "$GATE" in
  bounce) eval "$(model-id --role advisor || echo 'echo "model-id failed: run acs install-model-id (see the Agent Config Studio README)" >&2; exit 1')" ;;
  grade)  eval "$(model-id --role judge || echo 'echo "model-id failed: run acs install-model-id (see the Agent Config Studio README)" >&2; exit 1')" ;;
esac
PROMPT_FILE="builds/<slug>/$GATE-prompt.md"     # bounce-prompt.md or grade-prompt.md: each gate reads its own
# eval sets family=…, id=…, effort=… (and alt=…, the second opinion): the Grade contract's family and model id,
# and the vendors (the id's prefix) the grader swap compares.
```
The grader swap's setting, read once before the Grade:
```bash
REVIEW_SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
# prefer unless the runtime supports --cross-family and answers prefer or off: a runtime too old for --supports runs a
# review on an unknown flag, so it is never asked.
CROSS_FAMILY=prefer
if grep -q -- --supports "$REVIEW_SCRIPT" 2>/dev/null && node "$REVIEW_SCRIPT" --supports --cross-family 2>/dev/null; then
  ANSWER=$(node "$REVIEW_SCRIPT" --cross-family 2>/dev/null)
  case "$ANSWER" in prefer|off) CROSS_FAMILY=$ANSWER ;; esac
fi
```

Write the gate's prompt (below) to `$PROMPT_FILE`, then ask — a fresh session with no build context, read-only, no MCP:
```bash
ask-model --role advisor --prompt-file "$PROMPT_FILE"     # GATE=bounce
ask-model --role judge --prompt-file "$PROMPT_FILE" --schema "${CODEX_HOME:-$HOME/.codex}/skills/build/grade.schema.json"       # GATE=grade
```
GATE=grade swapped to the advisor role's second opinion, when the grader swap picks it:
```bash
ask-model --second --role advisor --prompt-file "$PROMPT_FILE" --schema "${CODEX_HOME:-$HOME/.codex}/skills/build/grade.schema.json"   # its alt at its altEffort; none set: no effort flag
```
Exit **64** from this call means the `advisor` role has no second opinion set: say so, skip the swapped Grade, never substitute another model silently, and tell the user to set the `advisor` role's second opinion in ACS → Models → Roles.
ask-model picks the CLI from the model id and checks the answering model where the CLI reports one. A role or family
that does not resolve exits 64: stop and fix the role in ACS → Models → Roles rather than running something else.

**Bounce prompt** (critique a plan, no code yet): "Read plan.md and context.md in this folder. You are an adversarial reviewer with no attachment to this plan. Attack it: what's missing, what will break, what edge cases and failure modes did the author miss, where is the acceptance bar too weak to catch a bad build? Be concrete. List the gaps and why each matters; do not rewrite the plan."

**Grade prompt** (verify the finished build against the bar): "Read the changed files and grade against this bar. For EACH criterion output PASS or FAIL with specific evidence (file/line or behavior). Be strict: not clearly met = FAIL. Also flag any real bug outside the criteria. Return exactly one JSON object, no Markdown or prose, in the shape below. Criteria: <paste criteria from plan.md>", followed by this output contract verbatim, with the resolved grader family and model id substituted:

```json
{"family":"<resolved grader family>","model":"<resolved model id>","criteria":[{"id":"<plan criterion id>","criterion":"<exact criterion text>","verdict":"PASS","evidence":"<file:line or test evidence>"}],"findings":[{"likelihood":5,"impact":5,"protected":false,"trigger":"<concrete normal-use input, command or call path>","issue":"<real bug outside the criteria>","file":"<path>","line":"<line>","evidence":"<evidence>"}]}
```

family, model and non-empty criteria are required. Optional top-level keys: vendor (codex, claude or grok), effort and findings; vendor is derived from the model id when absent. Omit findings or use [] for no extra bugs; file and line are optional. Every criterion and finding requires evidence. Only PASS or FAIL verdicts. Finding scores are likelihood/impact integers 1–10, protected boolean and nonempty trigger; optional severity is ignored comparison text. Missing or invalid scores are unscored and block as MEDIUM, without a grader re-ask; no unknown keys and no quotes to locate. Keep criterion ids and text unchanged in a recheck and include only original FAIL criteria. New recheck findings are scored with the same rubric and their severity is derived. Save the returned JSON, including evidence for every criterion.

**Branch on ask-model's exit code, and never pipe the call** — piping the output masks a failure as exit 0. 0 is the verdict; 2 means another model answered (not a gate result); 3 means the gate's CLI is not installed (use the other judgment family at once); 4 means the call failed. A call that never reached the API fails with `API Error: Unable to connect to API (ENOTFOUND)` on stderr, which means Codex's sandbox denied it network (`network_access` under `[sandbox_workspace_write]` in `~/.codex/config.toml`, or run the call escalated). That is a gate that **did not run**: fix it, use the other judgment family, or report NOT RUN — never report it as a pass.

## Record and close (orchestrator only)

For a phase review or a finished-build review, use the recorded family that actually authored the reviewed work. Log each phase author and include any earlier authors in the review handoff when a replacement contributed to the branch. The grader swap compares the vendor of that builder's recorded model ID. Use the installed review runtime and the review skill's normal flags. Set `PLAN_FILE` and `REVIEW_INTENT` from the task. For a task without a plan, omit the plan flag.

```bash
REVIEW_AUTHOR="$BUILDER" node "$REVIEW_SCRIPT" --plan "$PLAN_FILE" "$REVIEW_INTENT"
```

Use the installed runtime. Record the Grade against the same committed HEAD it saw. Commit fixes before the one recheck of failed criteria, then record it. Close once, at the tip: no phase Grade is closed mid-build, and no phase record grants coverage. The last phase's Grade gets a criteria close at the tip, after the tip review is recorded: its findings are `carried` to that review, which reads them as open findings, and the last phase's review stays findings-only the same way:

```bash
REVIEW_SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$REVIEW_SCRIPT" --log-grade builds/<slug>/grade.json
node "$REVIEW_SCRIPT" --log-grade builds/<slug>/recheck.json --recheck-of <grade-id>
```

Skip recheck when there were no failed criteria. It needs no close of its own. A criterion needs a recheck PASS to be fixed; a remaining FAIL is disputed, or deferred as criterion not met with a reason (rule 4), never waived on request. Use the code-review skill's status-file shape and resolution commands. The one close at the tip (`--close <grade-id> --status builds/<slug>/status.json`) runs the whole test suite, even for a clean Grade: configure verifyCmd, pass --test-cmd, or give --no-tests a reason when there are no tests. Its --summary output goes in the PR body.

One review per phase; fixes never get a full re-review. Run --fix-check once after a fix round: a close accepts a fixed blocking or protected finding only when the fix check was asked about it and read its files. Deal with its findings once (reject or defer each; a fix to one is sliced at the tip, since no later pass reads it), then a hard stop. At most two review passes per phase; risk-area /build work allows three (Grade, /code-review, fix check). Risk-area work that went through /build gets both a Grade and /code-review. Stop before exceeding the limit.

**Hand-off to the PR.** When the last phase's Grade (and any /code-review) is recorded and rechecked, hand the finished tip to the pr-review skill, with nothing closed. It owns the rest, in order: the security pass when `security.run` is on, the fix round, the context pass, the one fix check (which also reviews the context commit), the one close at the tip, then the last Grade's criteria close (findings `carried`), the push, and the PR description. The context pass runs once, at the PR, never per phase or per fix.

## Hard rules

- The verifier never edits — all gate calls are read-only.
- The grader is never the author's context. Cross-vendor per crossFamily (the grader swap above); a same-vendor grader is allowed and named in the handoff; if no gate can run, it is NOT RUN.
- Never delete, skip, weaken, or narrow a test to make a criterion pass. A gamed check is a failed build.
- A FAIL from Grade is not optional: fix it, or surface to the driver why the criterion is wrong.
- Builders commit at every phase end; never push or open a PR. The orchestrator pushes and opens the PR with the review summary. Agents merge only through merge.mjs, which follows the review gate's merge policy (default off: the operator merges). Never gh pr merge, auto-merge or the merge button. Builders never run reviews, grades or other models themselves.

## Stop condition

Every criterion is resolved, the deterministic checks pass, the Grade is logged, rechecked and closed once, at the tip, and the result is in front of the driver. One failed-criterion recheck; at most two review passes per phase, or three for risk-area /build work (Grade, /code-review, fix check). After dealing with fix-check findings once, hard stop. Stop early the moment progress needs a human decision; a criterion still failing after its recheck is deferred and goes on top of the PR body for the driver.

## Review policy (rules 1–11)

1. The operator is involved only at PR merge; no agent pauses work to ask the operator to run a command.
2. First round: every HIGH and MEDIUM from the original review is fixed, or rejected with a REFUTED verdict from a different model (`--dispute`). Nothing is deferred in this round; LOWs are filed automatically.
3. One fix round, then one fix check. What the fix check finds (`x…`, any severity) may be deferred: `{"x1":{"status":"deferred","reason":"<why>","fix":"<fix idea>"}}`. The reason is required, `fix` is optional (the reviewer's suggestion shows otherwise), and the reviewer's score stands. The close then completes; there is no second round.
4. Grade: a criterion still failing after one fix round and its one recheck may be deferred as "criterion not met" with the same status shape, and so may the recheck's own `r…` findings. It never silently passes.
5. The PR body (`--summary`) lists, in order: "Acceptance criteria not met", deferred HIGHs, then all other deferred findings; `--deferred` lists them too. Agents merge only through merge.mjs, which follows the review gate's merge policy (default off: the operator merges). Never gh pr merge, auto-merge or the merge button. The merge is the approval, and the operator can send the branch back.
6. Agents never re-rate a finding (severity and score fields stay refused), defer in the first round, edit, re-log or forge review records, or ask the operator to run `--waive` or `REVIEW_GATE_OVERRIDE`.
7. A history rewrite (squash, split, rebase) after a review or Grade is allowed when the final tree is byte-identical: the gate compares tree hashes with the review, Grade, fix-check, recheck and close heads, and logs the carry-over as `carried`. Any other tree gets a fresh review.
8. An unexpected gate refusal: one fresh review of the final branch through the normal path, then a clean close. Update a reviewed branch by merging the default branch into it, never by rebasing. A refusal after that merge is not unexpected: re-close the existing review at the merge tip, and slice-review only the both-sides files it names (`REVIEW_PATHS`) and close that slice there; never a fresh review of the whole branch. If the gate still refuses, stop and tell the operator in chat, quoting the gate's message.
9. `--waive` and `REVIEW_GATE_OVERRIDE` remain the operator's own emergency tools from the operator's terminal; no normal flow uses them.
10. No confirmation before fixing: every HIGH and MEDIUM goes straight to the fix round, or is disputed with proof, without asking. A finding that is really a product choice gets the safe fix by default and is named in the report so the operator can reverse it. The operator hears once, after the fix round and fix check: what was fixed and what was filed. Fixing the filed items is optional.
11. Show the numbers: every finding shown to the operator carries its scores, e.g. `LOW 6/100 (likelihood 2/10 × impact 3/10)`, or `unscored`, never just the word. The report, `--summary` and `--deferred` print them that way.

Every PR body must include a section titled exactly **Deferred findings**, using the deferred and filed findings in --summary (or `none` when empty). When chasing a bug, first check `node <review.mjs> --deferred` and merged PR descriptions with `gh pr list --state merged --search "Deferred findings in:body"`. <review.mjs> is the installed `~/.agent-config-studio/review-gate/review.mjs`. `--deferred` lists this repo by repoId, newest first; add `--all` for every repo. The trigger is the input or call path named in the issue.

The script derives severity from scores; scores cannot be changed in triage. Fix HIGH first, then MEDIUM; LOW is filed. Unscored findings block. Use `node <review.mjs> --rubric` and `~/.agent-config-studio/review-gate/calibration.md`, then `node <review.mjs> --calibrate` to check the reference cases. Filed findings (unprotected risk ≤ 10, or protected with likelihood 1) need no close status and may be fixed when the operator picks them; missing or invalid scores never file a finding. Grade criterion FAILs are never filed.
