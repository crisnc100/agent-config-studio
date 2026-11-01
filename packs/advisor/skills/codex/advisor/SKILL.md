---
name: advisor
description: "Bring in a stronger or cross-vendor brain for scope and direction before committing — a second brain for the codex seat, not a code reviewer. Use at scope-shaping moments (what to build, how far, which architecture, what to cut) or when the user asks for 'the advisor's take' / 'an advisor read'. The advisor comes from the `advisor` role in ACS (Models → Roles); methods: advisor (the role's family, the default) | second (the role's second opinion) | both | a family the user names. Returns a scope verdict, advisory deltas, and ONLY the questions a human must decide."
---

# advisor — a stronger brain on scope, on demand (Codex seat edition)

Codex is the seat: it orchestrates, and it often implements. That makes it the wrong brain to grade its own
direction. At a **scope-shaping moment** — what to build, how far to go, which architecture, what to cut — this
skill brings in an outside consultant from the `advisor` role, reads back an objective verdict, and asks only the
questions that cannot be answered by looking. The seat stays in charge; the advisor advises.

This is NOT a code review (`code-review`), NOT an evidence investigation, and NOT the Bounce inside `build` (Bounce
attacks a written `plan.md`; advisor shapes scope *before or outside* a formal plan). It is the consult you'd buy
before committing a direction.

## When to use / not

Use when: about to commit to a non-trivial direction (scope, architecture, cut lines, sequencing); the user asks for
it ("what would the advisor say about this scope?", "get an advisor read"); a `build` phase feels mushy and the spec
doesn't determine the call.

Don't use when: the direction is already determined by the spec, the repo, or the user's explicit words (never buy
advice on a settled question); or for mid-build mechanical choices (that's the implementer's callback, answered by
the seat).

## Method selection

Resolution order: **spoken choice → the `advisor` role in ACS**. The role is the durable setting; change it in
ACS → Models → Roles, never here. A different vendor than this seat is the most useful advisor; when the role's
family shares this seat's vendor, prefer its second opinion if that is from another vendor, and say which ran.

| Method | Model | When |
|---|---|---|
| `advisor` | the `advisor` role's family (`model-id --role advisor`) | **The default.** Scope verdicts, direction, what-to-cut judgment. |
| `second` | the role's second opinion (`altId`, `altEffort` from `model-id --role advisor --json`) | When the user names it, or the role's family shares this seat's vendor. |
| `both` | both, blind, in parallel, no seat context | When the user says "both". Resolve factual disagreements against the repo yourself; present judgment disagreements to the user steelmanned, both sides — never pick the winner. |
| `<family>` | that family (`model-id <family>`; effort `.flavor.effort` from `model-id --flavor <family> --json`, none when unset) | When the user names one. |

If the chosen advisor cannot run, report the advice as **NOT RUN** and offer the other method — never substitute a
model silently.

## Step 1 — Build the advisory brief (the quality lever)

The advisor has zero session context. A thin brief produces generic advice; do not skip this. Write
`advisor-brief.md` (in the task folder, e.g. `builds/<slug>/`, else a scratch dir) with:

1. **THE ASK** — what the user wants this session, in their terms. One paragraph.
2. **WHAT WE KNOW** — conclusions from the codebase and conversation (never raw file dumps). Include what already
   exists that overlaps.
3. **CURRENT DIRECTION** — what the seat intends to do, stated as a position the advisor can attack.
4. **DECISIONS IN PLAY** — the 1–4 specific calls the advice should land on.
5. **READ FIRST** — absolute paths to the few files that ground the decision. Every method can read the repo; point
   it at the right places so it doesn't ask questions the code answers.

## Step 2 — Invoke (read-only, always)

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
BRIEF="$PWD/advisor-brief.md"                                      # absolute path
CONTRACT="${CODEX_HOME:-$HOME/.codex}/skills/advisor/advisor-contract.md"
PROMPT_FILE="$PWD/advisor-prompt.md"
{ printf 'Read %s, then the READ FIRST files it names. ' "$BRIEF"; cat "$CONTRACT"; } > "$PROMPT_FILE"
ask-model "${who[@]}" --investigate --prompt-file "$PROMPT_FILE"
```
`ask-model` picks the CLI from the model id (a fresh session, no seat context), keeps MCP out, and checks the
answering model where the CLI reports one. `--investigate` lets the advisor run commands to check its points; it still
must not change anything. The advice is on stdout; one stderr line names the family, id, effort and mode. Branch on
the exit code:

- **0** — the advice. Take it to Step 3.
- **2** — another model answered. Abort, tell the user, and never present another model's output as the advisor's.
- **3** — that family's CLI is not installed: report the advice as **NOT RUN** and offer the other method.
- **4** — the call failed; the reason is on stderr (see the sandbox gate below). The advisor did not run.
- **5** — files changed during the call. ask-model names them on stderr and reverts nothing: tell the user which
  files changed, and never revert them yourself. The advice is still printed.
- **64** — the role or family does not resolve: stop and tell the user to set the `advisor` role in ACS → Models →
  Roles.

When the stderr line names a `gpt-…` id, the advisor shares this seat's vendor: say so in one line with the verdict.

For `both`, run each advisor as its own background job, with its output kept outside the repo (a file the other job
writes there would show as changed):
```bash
OUT=$(mktemp -d "${TMPDIR:-/tmp}/advisor.XXXXXX")
( ask-model --role advisor --investigate --prompt-file "$PROMPT_FILE" > "$OUT/advisor.out" 2> "$OUT/advisor.err"; echo $? > "$OUT/advisor.exit" ) &
( ask-model "${who[@]}" --investigate --prompt-file "$PROMPT_FILE" > "$OUT/second.out" 2> "$OUT/second.err"; echo $? > "$OUT/second.exit" ) &   # who as for second
wait
```
Each `.err` file's first line names the family that answered: label each answer with it. A file changed during
`both` shows in both reports; say so rather than guessing which advisor changed it.

### The sandbox gate — read this before the first call fails

Codex's own sandbox blocks network for the commands it runs, and `ask-model` (with the CLI it starts) is one of those
commands. Under the default `workspace-write` sandbox the advisor call **fails** (exit 4), with this signature on
stderr for a claude advisor:

```
ask-model: claude returned an error: API Error: Unable to connect to API (ENOTFOUND)
```

**Branch on ask-model's exit code, and never pipe the call** — piping the output (e.g. `| head`) masks the failure
as exit 0.

When you see ENOTFOUND, the advisor did not run. Do not report its "advice." Either:
1. Re-run the command with **escalated permissions** (unsandboxed) — the least-privilege path; Codex asks the user
   to approve that one command; or
2. Use another method and tell the user the chosen advisor was unreachable.

If `~/.codex/config.toml` sets `[sandbox_workspace_write] network_access = true`, the call just works with no
escalation.

## The advisor contract (embedded verbatim in the prompt)

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

1. **Validate** each advisory point against the repo and conversation — adopt what's real, push back on
   opinion-flavored noise, note where the advisor lacked context you have.
2. **Screen the questions** with the same lookup test. If a question IS answerable from the repo, answer it yourself
   and drop it — an advisor asking findable questions gets that flagged in your summary, not passed to the user.
3. Present: which model advised, the verdict, the deltas worth adopting (with your agree/disagree and why), and the
   surviving questions with the advisor's recommended answers. **Scope changes are always the user's call.**

## Hard rules

- **Orchestrator-only.** Implementers and reviewers never invoke this skill. An implementer unsure of direction uses
  its callback contract; the seat decides whether a consult is worth buying. Nothing routes around the seat.
- **The advisor never edits.** It may read and run commands (`--investigate`); ask-model names any file that
  changed during the call (exit 5). Report those to the user; never revert them.
- **Prove the model, prove the run.** ask-model checks both: exit 2 is another model, exit 4 a failed call. A silent
  downgrade or an ENOTFOUND is a failed call, not an answer — report it, don't relabel it.
- **Same-vendor advice is flagged, never silent.** If the advisor shares this seat's vendor, the user hears that with
  the verdict.
- **Questions pass the lookup test twice** — once by the advisor, once by the seat. Findable answers never reach the
  user as questions.
- **Advice is input, not instruction.** The seat validates; the human decides scope. An advisor verdict is never
  authorization to change scope on its own.
