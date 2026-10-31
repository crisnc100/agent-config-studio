---
name: build
description: "Build something through the Frame -> Bar -> Judge loop. Runs four phases (Understand, Shape, Build, Judge) — the session model orchestrates and advises, a builder-role family types (guided phases, callbacks on demand), the advisor role attacks the plan (Bounce), the judge role grades the result (Grade, cross-vendor preferred), and the human judges. Pick the implementer and effort with '/build <family> [effort]' (or plain English); unspecified means the orchestrator picks from the builder role. Use for any real build where you want it done right and self-correcting. Scales down: a lightweight mode handles small single-outcome work (one implementer call, no plan/Bounce/Grade scaffold) so small-but-real tasks route here too — only true two-minute edits stay out."
---

# /build — the Frame, Bar, Judge build loop

You (the driver) make three moves and nothing else: **Frame** the outcome, set the **Bar** (how you'll know it's right), and **Judge** the result against that bar. The agents do all the producing and checking in between. If the driver is exploring, planning, coding, or verifying by hand, the loop is mis-run.

The Grade and the close use the review gate's script (the review-gate pack): `scripts/review.mjs` in the repo when present, otherwise `~/.agent-config-studio/review-gate/review.mjs`.

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
| Build (guided steps) | `builder` role; the user's named family and effort win (below) | the guided-step loop below |
| **Grade** (verify build vs bar) | `judge` role, read-only, cross-vendor preferred (below) | gate command below |
| Judge | the human | yes/no against the bar |

### Choosing the implementer — `/build <family> [effort]`

Name a builder-role family and it wins for this run: `/build <family>`, `/build <family> <effort>`, or plain English ("build this with <family>"). **A named lane is binding for the entire run — every phase, start to finish.** The orchestrator does not re-route mid-build, does not "upgrade" a phase it finds hard, and does not silently fall back. No lane named → pick from the `builder` role using each family's flavor (`model-id --flavor <family>`: what it is good at and what to watch for — an over-builder needs boundaries; taste matters for frontend, design and copy), and say which and why in one line. Record which lane won or lost — the ranking earns itself.

**Effort** comes from the builder role in ACS (that family's effort there, else its flavor effort) unless the user names one; a named effort wins for the run. It is resolved once, before the first build call (below).

The one exception is the standing escalation rule below, and with a named lane it is **not** silent: if the implementer misses the same criterion twice after the brief has been sharpened, the orchestrator says so and asks before changing lanes. The user chose the lane; leaving it is the user's call.

- The choice picks the **implementer only**. The orchestrator, the Bounce, and the human Judge don't move.
- **Grader swap (cross-vendor preferred, never a blocker).** Grade with the `judge` role's family unless it shares the builder's vendor; then prefer the `advisor` role's second opinion when it is from the other vendor. **Never wait on a grader:** if the preferred one is out of quota or unavailable, use the other right away. The Judge handoff says which grader ran and, when it was same-vendor, why.
- Judgment-role families never build: they type specs and verdicts, not code. An explicit user demand still wins, but the skill never routes there on its own.
- A one-run lane choice never changes the durable routing; change defaults in ACS.

### The guided-phase loop (advisor on demand, not a micromanager)

The orchestrator plans in phases and advises when asked; the implementer works autonomously inside a phase. Feedback happens when the implementer NEEDS it, not on every step.

**Phase rule.** plan.md must name the phases and their pass/fail criteria. End a phase before later work builds on it (database changes, data passed between parts or shared code), whenever it touches riskPaths (sign-in, money, deleting data, migrations or security), or after over 400 changed lines since the last review. Everything else waits for the one review at the PR.

1. The orchestrator groups plan steps into **phases** (a coherent chunk with one checkpoint). Each phase goes to the implementer subagent as a self-contained brief: goal, the steps with their pass/fail checks, files in scope, constraints (no scope creep, no new deps unless the plan names them), and the callback contract below.
2. The implementer proceeds through the phase on its own, running the deterministic checks (`verify.sh` / tests) after each step and writing deliberate choices to log.md. Builders commit at every phase end, including the build folder before each review; they never push, open a PR, or run reviews, grades or other models themselves. The orchestrator handles those checks.
3. **Callback contract — the implementer comes back ONLY when:**
   - the spec does not determine a choice it must make;
   - it needs to deviate from the plan;
   - a check has failed twice on the same step;
   - it hits a scope or architecture decision;
   - the phase is complete (the normal checkpoint).
   Every callback carries a **recommended answer** so the orchestrator can reply in one line. Anything derivable from the brief, the plan, or the repo: resolve it and keep moving.
4. The orchestrator answers callbacks (the agent continues with its context intact), reviews the phase checkpoint against `plan.md` — right direction? bar still reachable? — then dispatches the next phase, or corrects course and re-issues this one. Callback frequency is itself a signal: three or more callbacks in one phase means the plan under-specified it — fix `plan.md` and re-issue rather than answering one-offs; zero callbacks through a genuinely complex phase means review that checkpoint harder, not lighter.
5. **Codex-lane steering uses session resume, not re-invocation.** Capture the `thread_id` from the first phase's `--json` output and keep it for the whole build. Every callback answer and every subsequent phase goes through `codex exec resume <thread_id>` — codex continues with its full context intact, so a one-line answer stays a one-line answer instead of a rebuilt brief. Only start a fresh session if you are deliberately resetting a poisoned context.

**Advisor consult points (orchestrator only).** When the advisor skill is installed, use it at exactly two moments: (a) Understand/Shape while scope is still being set, before `plan.md` exists — once the plan is written, the Bounce is the adversarial gate, don't double-spend; (b) a builder callback raises a scope/architecture call the orchestrator itself is unsure of — consult `/advisor`, validate the advice, answer the builder in one line. Builders never invoke /advisor; a builder's route to advice IS the callback contract. One chain of command.

This keeps the expensive model's tokens on judgment (briefs, callback answers, checkpoint reviews — all small) and the volume tokens on the implementer. **Standing escalation — but fix the brief before the builder:** if the implementer misses the bar twice on the same step, first re-read the phase brief; if the spec under-determined the choice, sharpen the brief and re-issue at the same lane (a better brief is cheaper than a bigger model). If the brief was adequate, redo the step on another builder-role family; if both miss the same criterion, that is the mis-scope signal — stop and surface it to the driver rather than climbing further. Judge the output, not the price tag. **Without asking when the orchestrator picked the lane; ask first when the user named it** (`/build <family>`) — a named lane is the user's decision, so surface the stuck criterion and let them choose to escalate or hold.

The gate model is called at the **gates** (once after the plan is drafted, once after the build completes), never inside the per-step build loop. The cheap, fast, deterministic `verify.sh` / tests are what the builder loops against; the gate model is the expensive, independent, reasoned check on top. Two layers, not one.

### Exact commands

No command names a model. Resolve the family, its id and its effort from the role; the CLI follows the id's prefix: `claude-…` runs on `claude`, `gpt-…` on `codex`, `grok-…` on `grok`. The gates go through `ask-model`, which does both; the role lookups below give the grader swap its vendors (the id's prefix) and the Grade contract its family and model id.

```
eval "$(model-id --role advisor || echo 'echo "model-id failed: run acs install-model-id (see the Agent Config Studio README)" >&2; exit 1')"   # Bounce: sets family=…, id=…, effort=… (alt=… is the second opinion)
eval "$(model-id --role judge || echo 'echo "model-id failed: run acs install-model-id (see the Agent Config Studio README)" >&2; exit 1')"     # Grade: the same, swapped per the grader rule
BUILDER=<family>                    # `model-id --role builder`, or the family the user named; its id: "$(model-id "$BUILDER" || echo "MODEL-ID-UNRESOLVED-$BUILDER")"
EFFORT=<effort>                     # the effort the user named; none named: EFFORT= and resolve it below
```

Verdict comes back on **stdout**; ask-model's one status line goes to **stderr**. Capture stdout. A role that does not resolve exits 64 — stop and fix the role in ACS → Models → Roles rather than running something else.

**The gate command** — read-only, headless, never an in-session subagent (which may run on a different model). Write the gate's prompt (below) to its file first:
```
ask-model --role advisor --prompt-file builds/<slug>/bounce-prompt.md     # Bounce
ask-model --role judge --prompt-file builds/<slug>/grade-prompt.md        # Grade
ask-model --family <alt> --effort <altEffort> --prompt-file builds/<slug>/grade-prompt.md   # Grade on the advisor role's second opinion, when the grader swap picks it (alt, altEffort: model-id --role advisor --json)
```
ask-model picks the CLI from the id, keeps it read-only with no MCP, and checks the answering model where the CLI reports one. Branch on its exit code: 0 the verdict; 2 another model answered — not a gate result; 3 the grader's CLI is not installed — use the other judgment family at once and say which ran; 4 the call failed, so the gate did not run — fix it, use the other judgment family, or report it NOT RUN, never a pass.

**Bounce prompt** (critique a plan, no code yet): "Read plan.md and context.md in this folder. You are an adversarial reviewer with no attachment to this plan. Attack it: what is missing, what will break, what edge cases and failure modes did the author miss, and where is the acceptance bar too weak to catch a bad build? Be concrete. Do not rewrite the plan; list the gaps and why each matters."

**The builder's effort** — set once, before the first build call, and used by every build call below:
```bash
# A named effort wins; else that family's effort in the builder role (its members[] entry, else the role's
# effort); else the family's flavor effort. Still empty: none is set, so the calls leave the flag out.
[ -n "$EFFORT" ] || EFFORT=$(model-id --role builder --json | jq -r --arg f "$BUILDER" '
  [(.members // [])[] | select(.family == $f) | .effort][0]
  // (if .family == $f or ((.provenance.effort == "default" or .provenance.effort == "user") and any(.use[]; . == $f))
      then .effort else null end) // empty')
[ -n "$EFFORT" ] || EFFORT=$(model-id --flavor "$BUILDER" --json | jq -r '.flavor.effort // empty')
EFFORT_FLAG=(); [ -z "$EFFORT" ] || EFFORT_FLAG=(-c "model_reasoning_effort=$EFFORT")   # never an empty effort
```

**Build — phase 1 on a codex-CLI builder (the only call that starts a session).** `--json` so you can capture the `thread_id`; `-o` so the checkpoint lands in a file instead of buried in event noise. This is the ONLY codex call that gets `--sandbox workspace-write`:
```
codex exec --skip-git-repo-check --sandbox workspace-write -m "$(model-id "$BUILDER" || echo "MODEL-ID-UNRESOLVED-$BUILDER")" "${EFFORT_FLAG[@]}" \
  --json -o builds/<slug>/phase1-result.md \
  "Objective: <what exists when this phase is done>
   Read first: plan.md, context.md, <relevant files>
   Steps: <each step with its pass/fail check>
   Constraints: <files in scope; no new deps unless plan.md names them; no scope creep; commit at phase end; never push, open a PR or run reviews, grades or other models>
   Validate: ./verify.sh — run after every step, read the failure, fix, re-run
   Stop when: every check in this phase passes, OR a choice is not determined by this brief —
              then stop and state the choice with your recommended answer.
   Do not delete, skip, weaken, or narrow tests or checks to make something pass." </dev/null 2>/dev/null
```
Grab the session id from the first JSONL line: `{"type":"thread.started","thread_id":"<uuid>"}`. Pipe through `head -1` or parse with `jq -r 'select(.type=="thread.started").thread_id'`. Read the checkpoint from the `-o` file.

**Build — every later phase, and every callback answer** (same session, context intact):
```
codex exec resume <thread_id> --skip-git-repo-check -m "$(model-id "$BUILDER" || echo "MODEL-ID-UNRESOLVED-$BUILDER")" "${EFFORT_FLAG[@]}" \
  -o builds/<slug>/phase<N>-result.md \
  "<the next phase brief, or the one-line answer to the callback>" </dev/null 2>/dev/null
```
`resume` does NOT accept `-s/--sandbox` — it inherits the sandbox policy from the session it resumes, which is why phase 1 must be the one that sets `workspace-write`. It does accept `-m`, `-c`, `-o`, `--json`, `--skip-git-repo-check`. Prefer an explicit `thread_id` over `--last`: the Bounce and Grade gates run in the same cwd, so `--last` can silently resume the wrong session. On a claude-CLI builder the phases go to a subagent on that family at the run's effort instead of these codex calls; the gates stay on their roles regardless of lane.

**Grade prompt** (verify the finished build against the bar, through the gate command for the grader the swap rule picked): "Read the changed files (e.g. the source files and verify.sh) and grade against this bar. For EACH criterion output PASS or FAIL with specific evidence (file/line or behavior). Be strict: if not clearly met, FAIL. Also flag any real bug outside the criteria. Return exactly the JSON specified below, no Markdown or prose. Criteria: <paste the criteria from plan.md here>". The orchestrator appends this output contract verbatim to every Grade and recheck prompt, substituting the resolved grader family and model id:

```json
{"family":"<resolved grader family>","model":"<resolved model id>","criteria":[{"id":"<plan criterion id>","criterion":"<exact criterion text>","verdict":"PASS","evidence":"<file:line or test evidence>"}],"findings":[{"likelihood":5,"impact":5,"protected":false,"trigger":"<concrete normal-use input, command or call path>","issue":"<real bug outside the criteria>","file":"<path>","line":"<line>","evidence":"<evidence>"}]}
```

family, model and a non-empty criteria array are required. vendor (codex, claude or grok) and effort are optional; vendor is derived from the model id when absent. findings is optional; omit it or use [] when there are no extra bugs. Only id, criterion, verdict and evidence belong in each criterion; verdict is exactly PASS or FAIL. A finding has likelihood and impact (integers 1–10), protected (boolean), trigger (nonempty text), issue and evidence; file and line are optional. severity is optional comparison text, stored as reviewerSeverity and ignored when deriving severity. Missing or invalid scores are logged unscored and block as MEDIUM (HIGH when protected is exactly true), without a grader re-ask. Evidence is required for every criterion and finding. No unknown keys and no quotes to locate. Keep criterion ids and text unchanged in the single recheck, which covers only the original FAIL criteria. New recheck findings receive scores under the same rubric and the script derives their severity; existing finding severity never changes in triage.

`codex review` does NOT accept `-m`, and its positional-prompt parsing is unreliable, so a codex-CLI grade goes through ask-model like any other.
The verdict prints on stdout; logs go to stderr. (A read-only sandbox can't run a `verify.sh` that writes temp files, which is fine: the deterministic checks already ran; the grade is the independent reasoned review on top.)

**Record and close (orchestrator only).** Use the repo's scripts/review.mjs, otherwise the shared runtime. Save the Grade's JSON to builds/<slug>/grade.json and record it against the same committed HEAD. Commit fixes before the one failed-criterion recheck, then record that JSON and close the original Grade:

```bash
REVIEW_SCRIPT=scripts/review.mjs
[ -f "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$REVIEW_SCRIPT" --log-grade builds/<slug>/grade.json
node "$REVIEW_SCRIPT" --log-grade builds/<slug>/recheck.json --recheck-of <grade-id>
node "$REVIEW_SCRIPT" --close <grade-id> --status builds/<slug>/status.json
node "$REVIEW_SCRIPT" --summary
```

Skip the recheck command when there were no failed criteria. A recheck needs no close of its own. A criterion needs a recheck PASS to be fixed; a remaining FAIL is disputed, or deferred as criterion not met with a reason (rule 4), never waived on request. Use the code-review skill's status-file shape and resolution commands. The close runs the whole test suite, even for a clean Grade; configure verifyCmd or pass --test-cmd, or --no-tests with a reason when there are no tests. Put --summary output in the PR body.

**Pass limits.** One review per phase; fixes never get a full re-review. Recheck failed criteria once. Run --fix-check only when close requires it because fixes changed tests, test settings, verify scripts or riskPaths. Deal with its findings once (fix, reject or defer each), then a hard stop. At most two review passes per phase; risk-area /build work allows three (Grade, /code-review, fix check). Risk-area work that went through /build gets both a Grade and /code-review. Stop before exceeding the limit.

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
3. **Build** (builder role, or the user's `/build <family>` choice). Implement against `plan.md`. After each step, run the deterministic checks (`verify.sh` / tests), read pass/fail, fix, repeat. Log decisions to `log.md` and commit the phase, including the build folder. When the deterministic checks pass, the orchestrator runs the **Grade** (gate command above), records it with --log-grade, and follows Record and close above. Fix failed criteria, recheck them once with --recheck-of, then --close; respect the pass limits and hard stop. **QA option:** when acceptance criteria include browser-observable behavior a script can't assert, a browser QA pass (your QA skill, if you have one) fits between Grade and Judge — hand it the target URL, the browser-checkable criteria verbatim, and setup steps. Not mandatory: run it when manual verification would cost the driver real time; skip it when Grade plus the deterministic checks already cover the bar — and state which in the Judge handoff, so a skipped QA run is a visible choice, never a silent one.
4. **Judge** (human). Hand the driver: the green checklist with evidence, the result, the Grade verdict and which grader ran, the orchestrator's own take on the diff, and anything tagged UNVERIFIED. The driver judges against the bar. Yes -> done. No -> point at the failed criterion (or the wrong bar) and return to Build or Bar.

## Hard rules

- **The verifier never edits.** Every gate call — Bounce and Grade — is read-only: an `ask-model` call, never with `--investigate`. The grader observes; it does not fix. `--sandbox workspace-write` appears exactly once in a run: the phase-1 Build call on the codex lane (later phases inherit it via `resume`). If you are writing `workspace-write` on a Bounce or a Grade, you have wired the loop wrong.
- **The builder never grades its own work.** The implementer subagent builds; a judgment-role model grades — cross-vendor preferred, same-vendor allowed per the grader swap rule, and the Judge handoff says which grader ran. The orchestrator that guided the build is not the sole grader either; self-critique is the weak version the whole design avoids.
- **Never delete, skip, weaken, or narrow tests or checks to make a criterion pass.** A gamed check is a failed build, not a passed one. If a check seems wrong, surface it to the driver instead of dodging it.
- **Deterministic checks first, the gate model second.** The builder loops against fast local checks; the gate model is the reasoned check on top, called sparingly to control cost.
- **A FAIL from Grade is not optional.** Either fix it, or surface to the driver why the criterion is wrong. Do not silently accept a FAIL; after its one recheck it may only be deferred as criterion not met.
- **Builders commit at every phase end; never push or open a PR.** The orchestrator pushes and opens the PR with the review summary; the driver alone merges. Builders never run reviews, grades or other models themselves.

## Stop condition

Stop when every acceptance criterion is resolved, the deterministic checks pass, the Grade is logged and closed, and the result is handed to the driver to judge. One failed-criterion recheck; at most two review passes per phase, or three for risk-area /build work (Grade, /code-review, fix check). After dealing with fix-check findings once, hard stop. Surface a needed human decision; never declare done with an unresolved FAIL, and a criterion deferred after its recheck goes on top of the PR body.

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
5. The PR body (`--summary`) lists, in order: "Acceptance criteria not met", deferred HIGHs, then all other deferred findings; `--deferred` lists them too. The operator's merge is the approval, and the operator can send the branch back.
6. Agents never re-rate a finding (severity and score fields stay refused), defer in the first round, edit, re-log or forge review records, or ask the operator to run `--waive` or `REVIEW_GATE_OVERRIDE`.
7. A history rewrite (squash, split, rebase) after a review or Grade is allowed when the final tree is byte-identical: the gate compares tree hashes with the review, Grade, fix-check, recheck and close heads, and logs the carry-over as `carried`. Any other tree gets a fresh review.
8. An unexpected gate refusal: one fresh review of the final branch through the normal path, then a clean close. If the gate still refuses, stop and tell the operator in chat, quoting the gate's message.
9. `--waive` and `REVIEW_GATE_OVERRIDE` remain the operator's own emergency tools from the operator's terminal; no normal flow uses them.
10. No confirmation before fixing: every HIGH and MEDIUM goes straight to the fix round, or is disputed with proof, without asking. A finding that is really a product choice gets the safe fix by default and is named in the report so the operator can reverse it. The operator hears once, after the fix round and fix check: what was fixed and what was filed. Fixing the filed items is optional.
11. Show the numbers: every finding shown to the operator carries its scores, e.g. `LOW 6/100 (likelihood 2/10 × impact 3/10)`, or `unscored`, never just the word. The report, `--summary` and `--deferred` print them that way.

Every PR body must include a section titled exactly **Deferred findings**, using the deferred and filed findings in --summary (or `none` when empty). When chasing a bug, first check `node <review.mjs> --deferred` and merged PR descriptions with `gh pr list --state merged --search "Deferred findings in:body"`. Resolve <review.mjs> repo-first, with the shared runtime fallback. `--deferred` lists this repo by repoId, newest first; add `--all` for every repo. The trigger is the input or call path named in the issue.

The script derives severity from scores; scores cannot be changed in triage. Fix HIGH first, then MEDIUM; LOW is filed. Unscored findings block. Use `node <review.mjs> --rubric` and `~/.agent-config-studio/review-gate/calibration.md`, then `node <review.mjs> --calibrate` to check the reference cases. Filed findings (risk ≤ 10, protected false) need no close status and may be fixed when the operator picks them; missing or invalid scores never file a finding. Grade criterion FAILs are never filed.
