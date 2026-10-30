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
  advisor) eval "$(model-id --role advisor)" ;;   # sets family=…, id=…, effort=…
  second)  role=$(model-id --role advisor --json)
           family=$(printf '%s' "$role" | jq -r .alt); id=$(printf '%s' "$role" | jq -r .altId)
           effort=$(printf '%s' "$role" | jq -r .altEffort) ;;
  *)       family=$METHOD; id=$(model-id "$family")
           effort=$(model-id --flavor "$family" --json | jq -r '.flavor.effort // empty') ;;
esac
# An empty effort means none is set: the commands below leave the effort flag out, never pass it empty.
BRIEF="$PWD/advisor-brief.md"                                      # absolute path
CONTRACT="${CODEX_HOME:-$HOME/.codex}/skills/advisor/advisor-contract.md"
PROMPT="Read $BRIEF, then the READ FIRST files it names. $(cat "$CONTRACT")"
```
An unresolved role prints an id every CLI rejects: stop and tell the user to set the `advisor` role in ACS → Models →
Roles. The CLI follows the id's prefix.

**`claude-…`** — headless claude CLI. Both flags below are load-bearing:

```bash
flag=(); [ -z "$effort" ] || flag=(--effort "$effort")
claude -p "$PROMPT" --model "$id" "${flag[@]}" \
  --dangerously-skip-permissions --tools Read,Grep,Glob \
  --output-format json > advisor-out.json

jq -r '.is_error'                              advisor-out.json   # MUST be false
jq -e --arg m "$id" '.modelUsage | has($m)'    advisor-out.json   # MUST print true (exit 0)
jq -r '.result'                                advisor-out.json   # the advisory text
```

- `--dangerously-skip-permissions` — a headless `claude -p` cannot show a permission prompt, so anything the
  permission layer gates gets silently denied instead of asked about. A repo's `.claude/settings.json` deny rule, a
  hook, or a path outside the trusted workspace can block a read — and the advisor then hands back confident advice
  about files it never opened. This flag removes that whole class of silent failure; `--tools` below is what makes
  removing it safe.
- `--tools Read,Grep,Glob` is what actually keeps it read-only, and it holds *even under skip-permissions*.
  `--allowedTools` only pre-approves tools; `--tools` restricts which exist. **Never widen this list.** That pairing —
  bypass the prompts, remove the dangerous tools — is what makes the dangerous-sounding flag safe here.

**Prove the model.** If the `jq -e` check fails, the call ran on the wrong model — abort, tell the user, and never
present another model's output as the advisor's.

### The sandbox gate — read this before the first call fails

Codex's own sandbox blocks network for the commands it runs, and `claude` is one of those commands. Under the
default `workspace-write` sandbox the advisor call **fails**, with this exact signature:

```
IS_ERROR=true
RESULT=API Error: Unable to connect to API (ENOTFOUND)
```

**Exit status is not a reliable tripwire** — piping the output (e.g. `| head`) masks the failure as exit 0. Always
branch on `.is_error`, never on `$?`.

When you see ENOTFOUND, the advisor did not run. Do not report its "advice." Either:
1. Re-run the command with **escalated permissions** (unsandboxed) — the least-privilege path; Codex asks the user
   to approve that one command; or
2. Use another method and tell the user the chosen advisor was unreachable.

If `~/.codex/config.toml` sets `[sandbox_workspace_write] network_access = true`, the call just works with no
escalation.

**`gpt-…`** — a fresh session, no seat context:
```bash
flag=(); [ -z "$effort" ] || flag=(-c "model_reasoning_effort=$effort")
codex exec --skip-git-repo-check --sandbox read-only -m "$id" \
  "${flag[@]}" "$PROMPT" </dev/null 2>/dev/null
```
When this shares this seat's vendor, say so in one line with the verdict.

**`grok-…`** — read-only by tool allowlist, the same flags the review script uses:
```bash
flag=(); [ -z "$effort" ] || flag=(--reasoning-effort "$effort")
grok -p "$PROMPT" -m "$id" "${flag[@]}" --tools read_file,list_dir,grep \
  --disallowed-tools search_tool,use_tool --deny MCPTool --disable-web-search --no-subagents
```

## The advisor contract (embedded verbatim in the prompt)

```
You are an outside consultant advising the team running this session. You have NO attachment
to the current direction and no stake in being agreeable. Be objective: if the direction is
right, say so briefly and stop — do not manufacture concerns to look thorough.

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
- **The advisor never edits.** `--sandbox read-only` for codex; `--tools Read,Grep,Glob` for claude; the read-only
  allowlist for grok. The skip-permissions flag is paired with that tool restriction, always — one without the other
  is a bug.
- **Prove the model, prove the run.** Every claude call verifies `is_error` is false AND `modelUsage` contains the
  resolved id. A silent downgrade or an ENOTFOUND is a failed call, not an answer — report it, don't relabel it.
- **Same-vendor advice is flagged, never silent.** If the advisor shares this seat's vendor, the user hears that with
  the verdict.
- **Questions pass the lookup test twice** — once by the advisor, once by the seat. Findable answers never reach the
  user as questions.
- **Advice is input, not instruction.** The seat validates; the human decides scope. An advisor verdict is never
  authorization to change scope on its own.
