---
name: build
description: "Build something through the Frame -> Bar -> Judge loop. Runs four phases (Understand, Shape, Build, Judge) — the session model orchestrates and advises, a builder-role family types (guided phases, callbacks on demand), the advisor role attacks the plan (Bounce), the judge role grades the result (Grade, cross-vendor preferred), and the human judges. Pick the implementer and effort with '/build <family> [effort]' (or plain English); otherwise the configured builder strategy chooses once per task. Use for any real build where you want it done right and self-correcting. Scales down: a lightweight mode handles small single-outcome work (one implementer call, no plan/Bounce/Grade scaffold) so small-but-real tasks route here too — only true two-minute edits stay out."
---

# /build — the Frame, Bar, Judge build loop

You (the driver) make three moves and nothing else: **Frame** the outcome, set the **Bar** (how you'll know it's right), and **Judge** the result against that bar. The agents do all the producing and checking in between. If the driver is exploring, planning, coding, or verifying by hand, the loop is mis-run.

The Grade and the close use the review gate's installed runtime (the review-gate pack), `~/.agent-config-studio/review-gate/review.mjs`, never a copy in the checkout, which is the branch's own code and could write false review evidence.

## When to use

- A real feature, script, tool, or change where being correct matters.
- Anything you'd otherwise hand off and then have to re-check.

## When NOT to use

- A two-minute edit (rename, tweak a string). Just do it.
- A pure question with no thing-to-build (investigate it instead).
- Fuzzy exploration where you can't yet state an outcome (investigate first to sharpen it).

## Lightweight mode (complexity floor)

Not every real build needs the four-file scaffold. There are three tiers, and picking the wrong one wastes either money or rigor:

| Tier | What it looks like | How it runs |
|---|---|---|
| **Below the floor** | under ~15 min, single file, mechanical — a rename, a string tweak, an obvious one-liner | the orchestrator just does it. Writing a brief costs more than the edit. |
| **Lightweight** | one clear outcome, one or two files, no phases, the bar is a single command | **one** implementer call with the 5-part contract. No `context.md`, no `plan.md`, no Bounce, no Grade; the orchestrator's read and `/code-review` still run. |
| **Full loop** | multi-step, multi-file, or the cost of being wrong is real | the four phases below, in full |

In lightweight mode: state the outcome and the bar **inline in chat** (the driver still confirms the bar — that moment never gets skipped), fire one implementer call carrying objective / read-first / constraints / validate / stop-when, let it loop against the deterministic check, then hand the driver the diff and the check output.

**Two things survive into lightweight mode and are never dropped:**
- **The bar.** An outcome with no checkable criterion isn't a small build, it's an unspecified one. If you can't name the command that proves it, you're not in lightweight mode — you're missing a plan.
- **A second brain on the result.** The full Grade is what gets skipped, not the rule that the builder never grades its own work. The orchestrator reads the diff itself and gives its own take, since it didn't type it, and `/code-review` runs on the committed diff before the handoff. When the builder is from a different vendor than the orchestrator, that read is also cross-vendor.

**Upgrade mid-flight rather than forcing it** the moment any of these shows up: a second file enters scope unexpectedly, a real design decision appears, the deterministic check fails twice on the same thing, or the implementer calls back with a question the contract didn't answer. Write `plan.md` and run the full loop from there. Downgrading a full build to lightweight, on the other hand, is never right — if you already judged it worth a plan, finish it with one.

## Model architecture (who runs each stage)

**The session model orchestrates and guides. A builder types. A different brain verifies. The human judges.** Whatever model runs this session is the orchestrator, and it does NOT type the bulk of the code. Families come from the ACS roles (`model-id --role <role>`); your own instruction file may add rules the roles can't express. Whoever implements never grades their own work.

| Stage | Runner | How |
|---|---|---|
| Understand (explore) | orchestrator + read-only exploration subagents | conclusions only come back; bulk file dumps stay out of the orchestrator's context |
| Shape: draft spec + bar | orchestrator | native |
| Shape: **Bounce** (attack the plan) | `advisor` role, read-only | gate command below |
| Build (guided steps) | `builder` role; the recorded family and effort (below) | the guided-step loop below |
| **Grade** (verify build vs bar) | `judge` role, read-only, cross-vendor preferred (below) | gate command below |
| Judge | the human | yes/no against the bar |

**Grader swap.** Cross-vendor checks follow the review gate's crossFamily setting (default prefer: another vendor when available, never a blocker; the run names who checked and why). Read it once, below (`CROSS_FAMILY`). With `prefer`, grade with the `judge` role's family unless it shares the builder's vendor; then prefer the `advisor` role's second opinion when it is from the other vendor. **Never wait on a grader:** if the preferred one is out of quota or unavailable, use the other right away. With `off`, grade with the `judge` role's family. The Judge handoff says which grader ran and, when it was same-vendor, why.

### Choose the builder once per task

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

When output misses the bar, check the brief first. Fix any gap and re-issue it to the same family. If the brief was adequate, automatically redo the work with another eligible builder-role family. Carry forward the handoff and record the reason for the switch. Honor an explicit operator constraint to use only the named family. If the second builder also misses the criterion, surface the scope issue to the operator.

### The guided-phase loop (advisor on demand, not a micromanager)

The orchestrator plans in phases and advises when asked; the implementer works autonomously inside a phase. Feedback happens when the implementer NEEDS it, not on every step.

**Phase rule.** plan.md must name the phases and their pass/fail criteria. End a phase before later work builds on it (database changes, data passed between parts or shared code), whenever it touches riskPaths (sign-in, money, deleting data, migrations or security), or after over 400 changed lines since the last review. Everything else waits for the one review at the PR.

1. The orchestrator groups plan steps into **phases** (a coherent chunk with one checkpoint). Each phase goes to the implementer subagent as a self-contained brief: goal, the steps with their pass/fail checks, files in scope, constraints (no scope creep, no new deps unless the plan names them), and the callback contract below.
2. The implementer proceeds through the phase on its own, running the deterministic checks (`verify.sh` / tests) after each step and writing deliberate choices to log.md. Tests and suites run in the foreground, with a timeout long enough to finish; a builder never ends a turn waiting on a background job. Builders commit at every phase end, including the build folder before each review; they never push, open a PR, or run reviews, grades or other models themselves. The orchestrator handles those checks.
3. **Callback contract — the implementer comes back ONLY when:**
   - the spec does not determine a choice it must make;
   - it needs to deviate from the plan;
   - a check has failed twice on the same step;
   - it hits a scope or architecture decision;
   - the phase is complete (the normal checkpoint).
   Every callback carries a **recommended answer** so the orchestrator can reply in one line. Anything derivable from the brief, the plan, or the repo: resolve it and keep moving.
4. The orchestrator answers callbacks (the agent continues with its context intact), reviews the phase checkpoint against `plan.md` — right direction? bar still reachable? — then dispatches the next phase, or corrects course and re-issues this one. Callback frequency is itself a signal: three or more callbacks in one phase means the plan under-specified it — fix `plan.md` and re-issue rather than answering one-offs; zero callbacks through a genuinely complex phase means review that checkpoint harder, not lighter. A builder that goes idle without a callback or a phase-complete report is stalled: message it then, rather than waiting on it.
5. Give a fresh worker the plan and handoff at each phase boundary. For a callback or an unfinished phase, use its saved worker session when the route supports resume. Otherwise hand off the checkpoint using the same family and effort. Fixes use the active task owner and the same dispatch rules.

**Advisor consult points (orchestrator only).** When the advisor skill is installed, use it at exactly two moments: (a) Understand/Shape while scope is still being set, before `plan.md` exists — once the plan is written, the Bounce is the adversarial gate, don't double-spend; (b) a builder callback raises a scope/architecture call the orchestrator itself is unsure of — consult `/advisor`, validate the advice, answer the builder in one line. Builders never invoke /advisor; a builder's route to advice IS the callback contract. One chain of command.

The gate model is called at the **gates** (once after the plan is drafted, once after the build completes), never inside the per-step build loop. The cheap, fast, deterministic `verify.sh` / tests are what the builder loops against; the gate model is the expensive, independent, reasoned check on top. Two layers, not one.

### Exact commands

No command names a model. Resolve the family, its id and its effort from the role; the CLI follows the id's prefix: `claude-…` runs on `claude`, `gpt-…` on `codex`, `grok-…` on `grok`, `gemini-…` on `agy`. The gates go through `ask-model`, which does both; the role lookups below give the grader swap its vendors (the id's prefix) and the Grade contract its family and model id.

```
eval "$(model-id --role advisor || echo 'echo "model-id failed: run acs install-model-id (see the Agent Config Studio README)" >&2; exit 1')"   # Bounce: sets family=…, id=…, effort=… (alt=… is the second opinion)
eval "$(model-id --role judge || echo 'echo "model-id failed: run acs install-model-id (see the Agent Config Studio README)" >&2; exit 1')"     # Grade: the same, swapped per the grader rule
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

Verdict comes back on **stdout**; ask-model's one status line goes to **stderr**. Capture stdout. A role that does not resolve exits 64 — stop and fix the role in ACS → Models → Roles rather than running something else.

**The gate command** — read-only, headless, never an in-session subagent (which may run on a different model). Write the gate's prompt (below) to its file first:
```
ask-model --role advisor --prompt-file builds/<slug>/bounce-prompt.md     # Bounce
ask-model --role judge --prompt-file builds/<slug>/grade-prompt.md --schema "$HOME/.claude/skills/build/grade.schema.json"        # Grade
```
The Grade on the advisor role's second opinion, when the grader swap picks it:
```bash
ask-model --second --role advisor --prompt-file builds/<slug>/grade-prompt.md --schema "$HOME/.claude/skills/build/grade.schema.json"   # its alt at its altEffort; none set: no effort flag
```
Exit **64** from this call means the `advisor` role has no second opinion set: say so, skip the swapped Grade, never substitute another model silently, and tell the user to set the `advisor` role's second opinion in ACS → Models → Roles.
ask-model picks the CLI from the id, keeps it read-only with no MCP, and checks the answering model where the CLI reports one. Branch on its exit code: 0 the verdict; 2 another model answered — not a gate result; 3 the grader's CLI is not installed — use the other judgment family at once and say which ran; 4 the call failed, so the gate did not run — fix it, use the other judgment family, or report it NOT RUN, never a pass.

**Bounce prompt** (critique a plan, no code yet): "Read plan.md and context.md in this folder. You are an adversarial reviewer with no attachment to this plan. Attack it: what is missing, what will break, what edge cases and failure modes did the author miss, and where is the acceptance bar too weak to catch a bad build? Be concrete. Do not rewrite the plan; list the gaps and why each matters."

**Dispatch the recorded builder.** Give each worker the objective, read-first files, constraints, validation and stop condition. The worker runs the checks and commits the phase. The orchestrator handles reviews, model calls, pushes and PRs. The worker never merges. Point `BRIEF_FILE` at that complete phase brief and `PHASE_RESULT` at the checkpoint output file. Use the model ID's prefix to route.

- For a `claude-…` model, use a native Claude subagent on the recorded model and effort. Set both through the native agent controls or the agent's model and effort configuration. If the native controls cannot honor the recorded settings, surface that blocker.
- For a `gpt-…` model, use the cross-vendor CLI from the worktree. Start a fresh session for every fresh worker with `workspace-write`.

```bash
EFFORT_FLAG=()
[ -z "$EFFORT" ] || EFFORT_FLAG=(-c "model_reasoning_effort=$EFFORT")
```

```bash
codex exec --skip-git-repo-check --sandbox workspace-write -m "$BUILDER_ID" "${EFFORT_FLAG[@]}" \
  --json -o "$PHASE_RESULT" "$(cat "$BRIEF_FILE")" </dev/null
```

Record the `thread_id` from the `thread.started` JSONL event. For a callback or resume within that phase, `THREAD_ID` is that worker's saved identifier. The session inherits its sandbox. Use its explicit ID so a gate session in the same worktree cannot be selected by mistake.

```bash
codex exec resume "$THREAD_ID" --skip-git-repo-check -m "$BUILDER_ID" "${EFFORT_FLAG[@]}" \
  -o "$PHASE_RESULT" "$(cat "$BRIEF_FILE")" </dev/null
```

**Antigravity builder.** For a `gemini-…` model, run the recorded family and effort through the native builder wrapper:

```bash
WORKTREE=$(git rev-parse --show-toplevel) || exit 2
WORKTREE=$(cd "$WORKTREE" && pwd -P) || exit 2
ask-model --family "$BUILDER" --build --cwd "$WORKTREE" --effort "$EFFORT" --prompt-file "$BRIEF_FILE" --json
```

A successful call exits 0 with `build.execution: "native"`, `build.completed: true` and `served.verified: false`. It uses normal agy permissions. Inspect the actual worktree and commits after a call. A failed call can leave edits. Record the dispatched family as the builder and report the served model as unverified.

Grok is a judgment lane. If the recorded ID has no supported builder route, report the configuration blocker.

**Grade prompt** (verify the finished build against the bar, through the gate command for the grader the swap rule picked): "Read the changed files (e.g. the source files and verify.sh) and grade against this bar. For EACH criterion output PASS or FAIL with specific evidence (file/line or behavior). Be strict: if not clearly met, FAIL. Also flag any real bug outside the criteria. Return exactly the JSON specified below, no Markdown or prose. Criteria: <paste the criteria from plan.md here>". The orchestrator appends this output contract verbatim to every Grade and recheck prompt, substituting the resolved grader family and model id:

```json
{"family":"<resolved grader family>","model":"<resolved model id>","criteria":[{"id":"<plan criterion id>","criterion":"<exact criterion text>","verdict":"PASS","evidence":"<file:line or test evidence>"}],"findings":[{"likelihood":5,"impact":5,"protected":false,"trigger":"<concrete normal-use input, command or call path>","issue":"<real bug outside the criteria>","file":"<path>","line":"<line>","evidence":"<evidence>"}]}
```

family, model and a non-empty criteria array are required. vendor (codex, claude or grok) and effort are optional; vendor is derived from the model id when absent. findings is optional; omit it or use [] when there are no extra bugs. Only id, criterion, verdict and evidence belong in each criterion; verdict is exactly PASS or FAIL. A finding has likelihood and impact (integers 1–10), protected (boolean), trigger (nonempty text), issue and evidence; file and line are optional. severity is optional comparison text, stored as reviewerSeverity and ignored when deriving severity. Missing or invalid scores are logged unscored and block as MEDIUM, without a grader re-ask. Evidence is required for every criterion and finding. No unknown keys and no quotes to locate. Keep criterion ids and text unchanged in the single recheck, which covers only the original FAIL criteria. New recheck findings receive scores under the same rubric and the script derives their severity; existing finding severity never changes in triage.

`codex review` does NOT accept `-m`, and its positional-prompt parsing is unreliable, so a codex-CLI grade goes through ask-model like any other.
The verdict prints on stdout; logs go to stderr. (A read-only sandbox can't run a `verify.sh` that writes temp files, which is fine: the deterministic checks already ran; the grade is the independent reasoned review on top.)

### Record and close (orchestrator only)

For a phase review or a finished-build review, use the recorded family that actually authored the reviewed work. Log each phase author and include any earlier authors in the review handoff when a replacement contributed to the branch. The grader swap compares the vendor of that builder's recorded model ID. Use the installed review runtime and the review skill's normal flags. Set `PLAN_FILE` and `REVIEW_INTENT` from the task. For a task without a plan, omit the plan flag.

```bash
REVIEW_AUTHOR="$BUILDER" node "$REVIEW_SCRIPT" --plan "$PLAN_FILE" "$REVIEW_INTENT"
```

Use the installed runtime. Save the Grade's JSON to builds/<slug>/grade.json and record it against the same committed HEAD. Commit fixes before the one failed-criterion recheck, then record that JSON. Close once, at the tip: no phase Grade is closed mid-build, and no phase record grants coverage. The last phase's Grade gets a criteria close at the tip, after the tip review is recorded: its findings are `carried` to that review, which reads them as open findings, and the last phase's review stays findings-only the same way:

```bash
REVIEW_SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$REVIEW_SCRIPT" --log-grade builds/<slug>/grade.json
node "$REVIEW_SCRIPT" --log-grade builds/<slug>/recheck.json --recheck-of <grade-id>
```

Skip the recheck command when there were no failed criteria. A recheck needs no close of its own. A criterion needs a recheck PASS to be fixed; a remaining FAIL is disputed, or deferred as criterion not met with a reason (rule 4), never waived on request. Use the code-review skill's status-file shape and resolution commands. The one close at the tip (`--close <grade-id> --status builds/<slug>/status.json`) runs the whole test suite, even for a clean Grade: configure verifyCmd, pass --test-cmd, or give --no-tests a reason when there are no tests. Its --summary output goes in the PR body.

**Pass limits.** One review per phase; fixes never get a full re-review. Recheck failed criteria once. Run --fix-check once after a fix round: a close accepts a fixed blocking or protected finding only when the fix check was asked about it and read its files. Deal with its findings once (reject or defer each; a fix to one is sliced at the tip, since no later pass reads it), then a hard stop. At most two review passes per phase; risk-area /build work allows three (Grade, /code-review, fix check). Risk-area work that went through /build gets both a Grade and /code-review. Stop before exceeding the limit.

**Hand-off to the PR.** When the last phase's Grade (and any /code-review) is recorded and rechecked, hand the finished tip to `/pr-review`, with nothing closed. It owns the rest, in order: the security pass when `security.run` is on, the fix round, the context pass, the one fix check (which also reviews the context commit), the one close at the tip, then the last Grade's criteria close (findings `carried`), the push, and the PR description. The context pass runs once, at the PR, never per phase or per fix.

## What the driver provides

Just the rough idea to start. The skill then stops at exactly three moments for the driver:
1. **Frame** — confirm the one-sentence outcome.
2. **Bar** — sharpen and approve the acceptance criteria. This is the highest-leverage moment; the criteria are the contract everything downstream builds and grades against.
3. **Judge** — yes/no on the graded result.

Everything else runs without the driver.

## The four phases

Work in a folder for the task (e.g. `builds/<slug>/`). Files hold state so each pass re-reads them.

1. **Understand** (orchestrator + exploration subagents). If the idea rests on unknowns, explore: read the relevant code, list paths, find how it connects — conclusions come back, not file dumps. Write `context.md`. Show the driver a short summary and confirm the **one-sentence outcome** (Frame).
2. **Shape** (orchestrator drafts, the advisor role attacks). Draft `plan.md`: the outcome, named phases, the steps, and a checklist of acceptance criteria where **each criterion is checkable by a command, test, or observable behavior**, plus how each will be verified. Then run the **Bounce** (gate command above), fold its real gaps into the plan, and show the driver the criteria to sharpen and approve (Bar).
3. **Build** (builder role, or the user's `/build <family>` choice). Implement against `plan.md`. After each step, run the deterministic checks (`verify.sh` / tests), read pass/fail, fix, repeat. Log decisions to `log.md` and commit the phase, including the build folder. When the deterministic checks pass, the orchestrator runs the **Grade** (gate command above), records it with --log-grade, and follows Record and close above. Fix failed criteria and recheck them once with --recheck-of; the Grade stays open until the one close at the tip. Respect the pass limits and hard stop. **QA option:** when acceptance criteria include browser-observable behavior a script can't assert, a browser QA pass (your QA skill, if you have one) fits between Grade and Judge — hand it the target URL, the browser-checkable criteria verbatim, and setup steps. Not mandatory: run it when manual verification would cost the driver real time; skip it when Grade plus the deterministic checks already cover the bar — and state which in the Judge handoff, so a skipped QA run is a visible choice, never a silent one.
4. **Judge** (human). Hand the driver: the green checklist with evidence, the result, the Grade verdict and which grader ran, the orchestrator's own take on the diff, and anything tagged UNVERIFIED. The driver judges against the bar. Yes -> done. No -> point at the failed criterion (or the wrong bar) and return to Build or Bar.

## Hard rules

- **The verifier never edits.** Every gate call — Bounce and Grade — is read-only: an `ask-model` call, never with `--investigate`. The grader observes; it does not fix. Use `--sandbox workspace-write` when starting each fresh cross-vendor Codex builder session. Resume inherits that session’s sandbox for callbacks or unfinished work in the same phase.
- **The builder never grades its own work.** The implementer subagent builds; a judgment-role model grades — cross-vendor preferred, same-vendor allowed per the grader swap rule, and the Judge handoff says which grader ran. The orchestrator that guided the build is not the sole grader either; self-critique is the weak version the whole design avoids.
- **Never delete, skip, weaken, or narrow tests or checks to make a criterion pass.** A gamed check is a failed build, not a passed one. If a check seems wrong, surface it to the driver instead of dodging it.
- **Deterministic checks first, the gate model second.** The builder loops against fast local checks; the gate model is the reasoned check on top, called sparingly to control cost.
- **A FAIL from Grade is not optional.** Either fix it, or surface to the driver why the criterion is wrong. Do not silently accept a FAIL; after its one recheck it may only be deferred as criterion not met.
- **Builders commit at every phase end; never push or open a PR.** The orchestrator pushes and opens the PR with the review summary. Agents merge only through merge.mjs, which follows the review gate's merge policy (default off: the operator merges). Never gh pr merge, auto-merge or the merge button. Builders never run reviews, grades or other models themselves.

## Stop condition

Stop when every acceptance criterion is resolved, the deterministic checks pass, the Grade is logged, rechecked and closed once, at the tip, and the result is handed to the driver to judge. One failed-criterion recheck; at most two review passes per phase, or three for risk-area /build work (Grade, /code-review, fix check). After dealing with fix-check findings once, hard stop. Surface a needed human decision; never declare done with an unresolved FAIL, and a criterion deferred after its recheck goes on top of the PR body.

## Definition of done (how we judge this skill worked)

- `plan.md` exists with checkable criteria the driver approved.
- A Bounce ran on the plan and its real gaps were folded in.
- The deterministic checks pass and `log.md` shows the build's decisions.
- A Grade ran and its verdict (with evidence and the grader's name) is in front of the driver.
- The driver made a clean yes/no against the bar.

If any of those is missing, the loop is not done, regardless of how finished the build looks.

**In lightweight mode**, the list is shorter but not optional: the driver approved a checkable bar, the deterministic check passes with its output shown, the orchestrator read the diff and gave its take, `/code-review` ran on the committed diff, and the driver made a clean yes/no. `plan.md`, Bounce, `log.md`, and Grade are the parts lightweight mode is allowed to skip — the bar, the check, the second brain, and the driver's judgment are not.

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
