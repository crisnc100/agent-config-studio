---
name: build
description: Build something through Frame → Bar → Judge from a Codex seat. Codex orchestrates; the builder role's family implements; the advisor role attacks the plan (Bounce) and the judge role grades the result (Grade), cross-vendor preferred; the human judges. State lives in files. Use for any real build where being correct matters — not a two-minute edit.
---

# build — Frame, Bar, Judge (Codex seat edition)

The driver makes three moves: **Frame** the outcome, set the **Bar** (how they'll know it's right), **Judge** the result. The agents do the producing and the checks; a different model does the adversarial checks. If the driver is exploring, planning, or verifying by hand, the loop is mis-run.

The Grade and the close use the review gate's script (the review-gate pack): `scripts/review.mjs` in the repo when present, otherwise `~/.agent-config-studio/review-gate/review.mjs`.

## When to use / not

Use for a real feature, script, tool, or change where correctness matters. NOT for a two-minute edit (just do it), NOT for a pure question (investigate it or answer it plainly).

## Who runs each stage

Families come from the ACS roles (`model-id --role <role>`); the CLI follows the model id's prefix: `claude-…` → `claude`, `gpt-…` → `codex`, `grok-…` → `grok`.

| Stage | Runner | How |
|---|---|---|
| Understand | codex (this seat) | read the code, map it, write `context.md` — conclusions, not dumps |
| Shape: draft plan + bar | codex | native |
| Shape: **Bounce** (attack the plan) | the `advisor` role's family, read-only | gate commands below |
| Build | the `builder` role's family (this seat when it is that family), or the one the driver names | the phase loop below |
| **Grade** (verify vs bar) | the `judge` role's family, read-only, cross-vendor preferred | gate commands below |
| Judge | the driver | yes/no against the bar |

**Cross-vendor preferred, never a blocker:** the grader should not share the builder's vendor. If the `judge` family does, prefer the `advisor` role's second opinion (`alt` in `model-id --role advisor`) when it is from the other vendor. Never wait on a grader: if the preferred one is unavailable, use the other at once and say in the handoff which one ran and, when it was same-vendor, why. If no gate can run at all, the gate is **NOT RUN** — report it that way, never as a pass. Judgment-role families never build.

## The four phases (state in `builds/<slug>/`, re-read each pass)

plan.md must name the phases and their pass/fail criteria. End a phase before later work builds on it (database changes, data passed between parts or shared code), whenever it touches riskPaths (sign-in, money, deleting data, migrations or security), or after over 400 changed lines since the last review. Everything else waits for the one review at the PR. Builders commit the code and build folder before each review; they never push, open a PR, or run reviews, grades or other models themselves. The orchestrator runs the checks below.

1. **Understand.** If the idea rests on unknowns, explore the code and write `context.md`. Show the driver a short summary; confirm the one-sentence outcome (**Frame**).
2. **Shape.** Draft `plan.md`: the outcome, named phases, the steps, and acceptance criteria where **every criterion is checkable by a command, test, or observable behavior**. Run the **Bounce** (below), fold its real gaps in, and show the driver the criteria to sharpen and approve (**Bar**). This is the highest-leverage moment.
3. **Build.** Implement against `plan.md`; build for the cases it names, not rare or future ones nobody asked for. After each step run the deterministic checks (`verify.sh` / tests), read pass/fail, fix, repeat. Log decisions to `log.md` and commit the phase, including the build folder. When the checks pass, the orchestrator runs the **Grade** (below), records it with --log-grade, then follows Record and close below. Recheck failed criteria once with --recheck-of; new recheck findings receive scores under the same rubric and the script derives their severity. Existing severity never changes in triage. Respect the pass limits and hard stop. **QA option:** when acceptance criteria include browser-observable behavior a script can't assert, a browser QA pass (your QA skill, if you have one) fits between Grade and Judge — hand it the target URL, the browser-checkable criteria verbatim, and setup steps. Not mandatory: run it when manual verification would cost the driver real time; skip it when Grade plus the deterministic checks already cover the bar — and state which in the Judge handoff, so a skipped QA run is a visible choice, never a silent one.
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
Write the gate's prompt (below) to `$PROMPT_FILE`, then ask — a fresh session with no build context, read-only, no MCP:
```bash
ask-model --role advisor --prompt-file "$PROMPT_FILE"     # GATE=bounce
ask-model --role judge --prompt-file "$PROMPT_FILE"       # GATE=grade
ask-model --family <alt> --effort <altEffort> --prompt-file "$PROMPT_FILE"   # GATE=grade, swapped to the advisor role's second opinion (alt, altEffort: model-id --role advisor --json)
```
ask-model picks the CLI from the model id and checks the answering model where the CLI reports one. A role or family
that does not resolve exits 64: stop and fix the role in ACS → Models → Roles rather than running something else.

**Bounce prompt** (critique a plan, no code yet): "Read plan.md and context.md in this folder. You are an adversarial reviewer with no attachment to this plan. Attack it: what's missing, what will break, what edge cases and failure modes did the author miss, where is the acceptance bar too weak to catch a bad build? Be concrete. List the gaps and why each matters; do not rewrite the plan."

**Grade prompt** (verify the finished build against the bar): "Read the changed files and grade against this bar. For EACH criterion output PASS or FAIL with specific evidence (file/line or behavior). Be strict: not clearly met = FAIL. Also flag any real bug outside the criteria. Return exactly one JSON object, no Markdown or prose, in the shape below. Criteria: <paste criteria from plan.md>", followed by this output contract verbatim, with the resolved grader family and model id substituted:

```json
{"family":"<resolved grader family>","model":"<resolved model id>","criteria":[{"id":"<plan criterion id>","criterion":"<exact criterion text>","verdict":"PASS","evidence":"<file:line or test evidence>"}],"findings":[{"likelihood":5,"impact":5,"protected":false,"trigger":"<concrete normal-use input, command or call path>","issue":"<real bug outside the criteria>","file":"<path>","line":"<line>","evidence":"<evidence>"}]}
```

family, model and non-empty criteria are required. Optional top-level keys: vendor (codex, claude or grok), effort and findings; vendor is derived from the model id when absent. Omit findings or use [] for no extra bugs; file and line are optional. Every criterion and finding requires evidence. Only PASS or FAIL verdicts. Finding scores are likelihood/impact integers 1–10, protected boolean and nonempty trigger; optional severity is ignored comparison text. Missing or invalid scores are unscored and block as MEDIUM (HIGH if protected), without a grader re-ask; no unknown keys and no quotes to locate. Keep criterion ids and text unchanged in a recheck and include only original FAIL criteria. New recheck findings are scored with the same rubric and their severity is derived. Save the returned JSON, including evidence for every criterion.

**Branch on ask-model's exit code, and never pipe the call** — piping the output masks a failure as exit 0. 0 is the verdict; 2 means another model answered (not a gate result); 3 means the gate's CLI is not installed (use the other judgment family at once); 4 means the call failed. A call that never reached the API fails with `API Error: Unable to connect to API (ENOTFOUND)` on stderr, which means Codex's sandbox denied it network (`network_access` under `[sandbox_workspace_write]` in `~/.codex/config.toml`, or run the call escalated). That is a gate that **did not run**: fix it, use the other judgment family, or report NOT RUN — never report it as a pass.

## Record and close (orchestrator only)

Use the repo copy first, the shared runtime as the fallback. Record the Grade against the same committed HEAD it saw. Commit fixes before the one recheck of failed criteria, then close the original Grade:

```bash
REVIEW_SCRIPT=scripts/review.mjs
[ -f "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/.agent-config-studio/review-gate/review.mjs"
node "$REVIEW_SCRIPT" --log-grade builds/<slug>/grade.json
node "$REVIEW_SCRIPT" --log-grade builds/<slug>/recheck.json --recheck-of <grade-id>
node "$REVIEW_SCRIPT" --close <grade-id> --status builds/<slug>/status.json
node "$REVIEW_SCRIPT" --summary
```

Skip recheck when there were no failed criteria. It needs no close of its own. A criterion needs a recheck PASS to be fixed; a remaining FAIL is disputed, or deferred as criterion not met with a reason (rule 4), never waived on request. Use the code-review skill's status-file shape and resolution commands. Close runs the whole test suite, even for a clean Grade: configure verifyCmd, pass --test-cmd, or give --no-tests a reason when there are no tests. Put --summary output in the PR body.

One review per phase; fixes never get a full re-review. Run --fix-check only when close requires it because fixes changed tests, test settings, verify scripts or riskPaths. Deal with its findings once (fix, reject or defer each), then a hard stop. At most two review passes per phase; risk-area /build work allows three (Grade, /code-review, fix check). Risk-area work that went through /build gets both a Grade and /code-review. Stop before exceeding the limit.

## Hard rules

- The verifier never edits — all gate calls are read-only.
- The grader is never the author's context. Cross-vendor preferred; a same-vendor grader is allowed and named in the handoff; if no gate can run, it is NOT RUN.
- Never delete, skip, weaken, or narrow a test to make a criterion pass. A gamed check is a failed build.
- A FAIL from Grade is not optional: fix it, or surface to the driver why the criterion is wrong.
- Builders commit at every phase end; never push or open a PR. The orchestrator pushes and opens the PR with the review summary; the driver alone merges. Builders never run reviews, grades or other models themselves.

## Stop condition

Every criterion is resolved, the deterministic checks pass, the Grade is logged and closed, and the result is in front of the driver. One failed-criterion recheck; at most two review passes per phase, or three for risk-area /build work (Grade, /code-review, fix check). After dealing with fix-check findings once, hard stop. Stop early the moment progress needs a human decision; a criterion still failing after its recheck is deferred and goes on top of the PR body for the driver.

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
