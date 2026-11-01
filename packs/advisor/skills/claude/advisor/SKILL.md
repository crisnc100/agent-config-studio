---
name: advisor
description: "Consult a stronger model for objective, consultant-style feedback on the session's scope and direction — a second brain for the seat, not a code reviewer. Use when the session faces a scope, architecture, or direction call, or when the user asks for 'the advisor's take' / 'a second opinion on the plan' / 'get an advisor read'. The advisor comes from the `advisor` role in ACS (Models → Roles); methods: advisor (the role's family, the default) | second (the role's second opinion) | both (the two blind, in parallel) | a family the user names. Returns a scope verdict, advisory deltas, and ONLY questions that are genuinely undecidable from the repo and conversation."
allowed-tools: Bash, Read, Write, Grep, Glob, AskUserQuestion
---

# /advisor — a stronger brain on scope, on demand

The seat (whatever model is running this session) orchestrates. When the session is at a **scope-shaping moment** — what to build, how far to go, which architecture, what to cut — this skill brings in an outside consultant from the `advisor` role. The advisor reads the ask and the codebase, returns an objective verdict on the direction, and asks **only the questions that cannot be answered by looking**. The seat stays in charge; the advisor advises.

This is NOT a code review (that's `/code-review`), not an evidence investigation, and not the Bounce inside `/build` (Bounce attacks a *written plan.md*; `/advisor` shapes scope *before or outside* a formal plan). It is the consult you'd buy before committing a direction.

## When to use

- The seat is about to commit to a non-trivial direction (scope, architecture, cut lines, sequencing) and a stronger or different brain would help.
- The user asks for it: "what would the advisor say about this scope?", "get a second opinion on the plan", "/advisor".
- A `/build` callback feels mushy — the spec doesn't determine the choice and the seat wants a stronger opinion before taking it to the human.

## When NOT to use

- The direction is already determined by the spec, the repo, or the user's explicit words. Don't buy advice on a settled question.
- Mid-build mechanical choices — that's the implementer's callback contract, answered by the seat.
- When the seat IS the advisor role's family: the same brain advising itself adds nothing. Use **second** (the role's second opinion) instead.

## Method selection

Resolution order: **spoken choice → the `advisor` role in ACS**. The role is the durable setting; change it in ACS → Models → Roles, never here.

| Method | Model | When |
|---|---|---|
| `advisor` | the `advisor` role's family (`family`, `id`, `effort` from `model-id --role advisor`) | **The default.** Scope verdicts, direction, what-to-cut judgment. |
| `second` | the role's second opinion (`alt`, `altId`, `altEffort` from `model-id --role advisor --json`) | When the user names it, or when the seat is the advisor family itself. |
| `both` | both, blind, in parallel | When the user says "both". See Dual advisory below. |
| `<family>` | that family (`model-id <family>`; effort `.flavor.effort` from `model-id --flavor <family> --json`, none when unset) | When the user names one. |

If the role has no second opinion, `second` and `both` are unavailable: say so and offer `advisor`.

### Dual advisory — "both"

"Advisory both" runs the two **blind, in parallel** on the same brief — no rebuttal rounds, no negotiated compromise. The seat then resolves factual disagreements itself against the repo, and presents judgment disagreements to the user steelmanned, both sides — it never picks the winner.

## Step 1 — Build the advisory brief (the quality lever)

The advisor has zero session context. A thin brief produces generic advice; do not skip this. Write `advisor-brief.md` (in the task folder, e.g. `builds/<slug>/`, or a scratch folder) with:

1. **THE ASK** — what the user wants this session, in their terms. One paragraph.
2. **WHAT WE KNOW** — conclusions from the codebase and conversation (never raw file dumps). Include what already exists that overlaps.
3. **CURRENT DIRECTION** — what the seat intends to do, stated as a position the advisor can attack.
4. **DECISIONS IN PLAY** — the 1–4 specific calls the advice should land on.
5. **READ FIRST** — absolute paths to the few files that ground the decision (every method can read the repo; point it at the right places so it doesn't ask questions the code answers).

## Step 2 — Invoke

Every method gets the same prompt contract. **The advisor is read-only** — it never edits, and its output comes back to the seat, not straight to the user.

```bash
METHOD=advisor                                  # advisor | second | the family the user named
case "$METHOD" in
  advisor) who=(--role advisor) ;;
  second)  role=$(model-id --role advisor --json || exit 1) || { echo "model-id failed: run acs install-model-id (see the Agent Config Studio README)" >&2; exit 1; }
           alt=$(printf '%s' "$role" | jq -r .alt); altEffort=$(printf '%s' "$role" | jq -r .altEffort)
           eff=(); [ -z "$altEffort" ] || eff=(--effort "$altEffort")     # no effort set: no --effort at all
           who=(--family "$alt" "${eff[@]}") ;;
  *)       who=(--family "$METHOD") ;;
esac
DIR=<absolute path of the folder holding advisor-brief.md>
{ printf 'Read %s/advisor-brief.md, then the READ FIRST files it names. ' "$DIR"; cat "$HOME/.claude/skills/advisor/advisor-contract.md"; } > "$DIR/advisor-prompt.md"
ask-model "${who[@]}" --investigate --prompt-file "$DIR/advisor-prompt.md"
```
`ask-model` picks the CLI from the model id, keeps MCP out, and checks the answering model where the CLI reports one — always this headless call, **never an in-session subagent**, which may run on a different model than you asked for. `--investigate` lets the advisor run commands to check its points; it still must not change anything. The advice is on stdout; one stderr line names the family, id, effort and mode. Branch on the exit code, and never pipe the call (a pipe masks a failure as exit 0):

- **0** — the advice. Take it to Step 3.
- **2** — another model answered. Never present it as the advisor's; tell the user.
- **3** — that family's CLI is not installed. Say so (see No silent substitute).
- **4** — the call failed; the reason is on stderr. The advisor did not run.
- **5** — files changed during the call. ask-model names them on stderr and reverts nothing: tell the user which files changed, and never revert them yourself. The advice is still printed.
- **64** — the role or family does not resolve: stop and tell the user to set the `advisor` role in ACS → Models → Roles.

For `both`, run each advisor as its own background job, with its output kept outside the repo (a file the other job writes there would show as changed):
```bash
OUT=$(mktemp -d "${TMPDIR:-/tmp}/advisor.XXXXXX")
( ask-model --role advisor --investigate --prompt-file "$DIR/advisor-prompt.md" > "$OUT/advisor.out" 2> "$OUT/advisor.err"; echo $? > "$OUT/advisor.exit" ) &
( ask-model "${who[@]}" --investigate --prompt-file "$DIR/advisor-prompt.md" > "$OUT/second.out" 2> "$OUT/second.err"; echo $? > "$OUT/second.exit" ) &   # who as for second
wait
```
Each `.err` file's first line names the family that answered: label each answer with it. A file changed during `both` shows in both reports; say so rather than guessing which advisor changed it.

## The advisor contract (embed verbatim in the prompt)

The contract lives beside this file as `advisor-contract.md`:

```
You are an outside consultant advising the team running this session. You have NO attachment
to the current direction and no stake in being agreeable. Be objective: if the direction is
right, say so briefly and stop — do not manufacture concerns to look thorough.
You may run commands and tests to verify your advice, but never change any file; if
something should change, say so in ADVISORY.

Deliver exactly three sections:

1. SCOPE VERDICT — one line: right-sized | over-built | under-scoped | wrong problem — and why.

2. ADVISORY — the specific changes you would push for, each with the why and the risk it
   removes. Include what you would CUT. Flag anything that is building for an imagined
   future instead of the stated outcome, and anything the stated outcome needs that is
   missing. Ground claims in the files you read (file:line where it matters).

3. QUESTIONS — only questions that are genuinely undecidable from the repo and this brief.
   THE LOOKUP TEST: if the answer can be found by reading code, running a command, or
   re-reading the brief, it is not a question — it is homework; answer it yourself inside
   ADVISORY instead. Surviving questions are decision-forcing: tradeoffs, priorities, and
   risk tolerance that only the human owns. Max 5. Each question carries your recommended
   answer so the human can reply in one line. If nothing survives, write exactly:
   "No real questions — the scope is determined."
```

## Step 3 — Bring it back (validate, don't relay)

The seat is not a courier. Before showing the user anything:

1. **Validate** each advisory point against the repo and conversation — adopt what's real, push back on opinion-flavored noise, and note where the advisor lacked context you have.
2. **Screen the questions** with the same lookup test. If a question IS answerable from the repo, answer it yourself and drop it — an advisor that asks findable questions gets that flagged in your summary, not passed to the human.
3. Present to the user: which model advised, the verdict, the deltas worth adopting (with your agree/disagree and why), and the surviving questions with the advisor's recommended answers. Scope changes are always the human's call.

## Hard rules

- **Orchestrator-only.** Builders and reviewers never invoke this skill. A builder unsure of direction uses its callback contract; the orchestrator decides whether a consult is worth buying. Nothing routes around the seat.
- **The advisor never edits.** It may read and run commands (`--investigate`); ask-model names any file that changed during the call (exit 5). Report those to the user; never revert them.
- **Prove the model.** ask-model checks the answering model where the CLI reports one (exit 2 when another model answered). A silent downgrade is a failed call, not an answer — report it, don't relabel it.
- **No silent substitute.** If the chosen advisor cannot run, say so; run another only when the user agrees, and name it with the verdict.
- **Questions must pass the lookup test twice** — once by the advisor, once by the seat. Findable answers never reach the human as questions.
- **Advice is input, not instruction.** The seat validates; the human decides scope. Never treat an advisor verdict as authorization to change scope on its own.
