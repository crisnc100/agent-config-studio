---
name: advisor
description: Consult a stronger model for objective, consultant-style feedback on the session's scope and direction — a second brain for the seat, not a code reviewer. Use when the session faces a scope, architecture, or direction call, or when the user asks for "the advisor's take" / "a second opinion on the plan" / "get an advisor read". The advisor comes from the `advisor` role in ACS (Models → Roles); methods: advisor (the role's family, the default) | second (the role's second opinion) | both (the two blind, in parallel) | a family the user names. Returns a scope verdict, advisory deltas, and ONLY questions that are genuinely undecidable from the repo and conversation.
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
| `<family>` | that family (`model-id <family>`, effort from `model-id --flavor <family>`) | When the user names one. |

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
eval "$(model-id --role advisor)"     # sets family=…, id=…, effort=…; for `second` use altId/altEffort from --json
PROMPT="Read <absolute path>/advisor-brief.md, then the READ FIRST files it names. $(cat "$HOME/.claude/skills/advisor/advisor-contract.md")"
```
An unresolved role prints an id every CLI rejects: stop and tell the user to set the `advisor` role in ACS → Models → Roles. The CLI follows the id's prefix.

**`claude-…`** — headless CLI, **never an in-session subagent**, which may run on a different model than you asked for:
```bash
claude -p "$PROMPT" --model "$id" --effort "$effort" --output-format json \
  --dangerously-skip-permissions --tools Read,Grep,Glob
```
Parse the JSON envelope: the advisory text is `.result`, and the `modelUsage` keys **must include the resolved id** — check it, never eyeball it: `jq -e --arg m "$id" '.modelUsage | has($m)'` on the envelope. If it fails, the call ran on the wrong model — abort, tell the user, and never present another model's output as the advisor's. Check `.is_error` is false before trusting `.result`, and never branch on `$?` — piping the output masks a failed call as exit 0.

**Why those two flags:** `--tools Read,Grep,Glob` is what keeps the advisor read-only — it removes Write/Edit from existence rather than merely gating them (`--allowedTools` only pre-approves), and it holds even under skip-permissions. That restriction is what makes skipping the prompts safe. A headless `claude -p` can't show a permission prompt, so without the skip flag a repo `.claude/settings.json` deny-rule or hook blocks a read silently and the advisor returns confident advice about files it never opened.

**`gpt-…`** (verdict on stdout, logs on stderr):
```bash
codex exec --skip-git-repo-check --sandbox read-only -m "$id" -c model_reasoning_effort="$effort" \
  "$PROMPT" </dev/null 2>/dev/null
```

**`grok-…`** — read-only by tool allowlist, the same flags the review script uses:
```bash
grok -p "$PROMPT" -m "$id" --reasoning-effort "$effort" --tools read_file,list_dir,grep \
  --disallowed-tools search_tool,use_tool --deny MCPTool --disable-web-search --no-subagents
```

## The advisor contract (embed verbatim in the prompt)

The contract lives beside this file as `advisor-contract.md`:

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

1. **Validate** each advisory point against the repo and conversation — adopt what's real, push back on opinion-flavored noise, and note where the advisor lacked context you have.
2. **Screen the questions** with the same lookup test. If a question IS answerable from the repo, answer it yourself and drop it — an advisor that asks findable questions gets that flagged in your summary, not passed to the human.
3. Present to the user: which model advised, the verdict, the deltas worth adopting (with your agree/disagree and why), and the surviving questions with the advisor's recommended answers. Scope changes are always the human's call.

## Hard rules

- **Orchestrator-only.** Builders and reviewers never invoke this skill. A builder unsure of direction uses its callback contract; the orchestrator decides whether a consult is worth buying. Nothing routes around the seat.
- **The advisor never edits.** Read-only sandbox for codex; `--tools Read,Grep,Glob` for claude; the read-only allowlist for grok.
- **Prove the model.** Every claude call verifies the envelope's `modelUsage` contains the resolved id. A silent downgrade is a failed call, not an answer — report it, don't relabel it.
- **No silent substitute.** If the chosen advisor cannot run, say so; run another only when the user agrees, and name it with the verdict.
- **Questions must pass the lookup test twice** — once by the advisor, once by the seat. Findable answers never reach the human as questions.
- **Advice is input, not instruction.** The seat validates; the human decides scope. Never treat an advisor verdict as authorization to change scope on its own.
