# PR 3 — watch the review agents (plan v2, after the Bounce)

Approved by Cris (v1): sidebar line + live review pane; reviews unchanged; default for new users = sidebar only, pane on for Cris.
v2 answers the Bounce (pr3-bounce.out, Fable: 5 blockers + security) and the identity probe (Explore, this session: real calls to all three CLIs).

## Outcome
While a review runs inside cmux (code review, team lenses, security pass, fix check, slices, dispute verifier; Grade/Bounce/advisor/investigator through ask-model):
1. **Sidebar line** per running reviewer, kept live (elapsed time + current step): `review · sol · 4m · read lib/agent.js`. Cleared when the call ends, on Ctrl-C, and swept after a hard kill.
2. **Review pane** (setting `pane`): one pane per top-level run, one line per step, tagged by reviewer. Closes when the run's process is gone (+30s to read the end).
Reviewers' models, flags, prompts, sandbox, output and parsing do not change.

## Design
**One watcher process per top-level run, following processes, not files.**
- review.mjs / ask-model.mjs, at the start of a top-level run inside cmux with `watch` ≠ off, starts `acs-agent watch --pid <own pid> --kind <kind> --workspace <ws>` detached (stdio ignored; any failure ignored). "Top-level": not when `REVIEW_WATCH_CHILD=1` is set; review.mjs sets that for slice children, eval children and the security worker (env only — no argv change for model CLIs).
- The watcher polls (1s) the process tree under that pid (`ps -axo pid,ppid,command`), finds model CLI processes, and maps each to its transcript (proved live this session):
  - Claude: `~/.claude/sessions/<pid>.json` → sessionId → `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<sessionId>.jsonl` (match by filename, never re-encoding the cwd).
  - Codex: the native child of the launcher pid holds `…/rollout-*-<thread>.jsonl` open for writing → `lsof -p <child>`.
  - Grok: the pid holds `<GROK_HOME>/sessions/<enc cwd>/<id>/events.jsonl` open for writing (`w`; ignore read-only handles of other sessions) → `lsof -p <pid>`; steps from `updates.jsonl` beside it.
  - No transcript found within 10s → the line shows `<kind> · <family> · running` (honest, still live time), never a guess.
- Labels come from the CLI's own argv in the process table (model id → family via model-id) and a small `~/.agent-config-studio/runs/<run id>.json` the gate writes once at start (kind, slice, review intent) — no per-call bookkeeping in the blocking runners.
- Tailing is incremental (keep a byte offset per file), never re-parsing whole transcripts.
- The watcher owns everything visible: `cmux set-status`/`clear-status` with a key unique to the run (`review-<run id>-<n>`), the pane (pane mode: it opens its own pane via `cmux new-pane` without stealing focus, closes it with `close-surface` at the end), and cleanup. It exits when the followed pid is gone and no child CLI remains; on its way out it clears every key it set.
- Hard kills: on start, every watcher sweeps `runs/` for run files whose pid is dead and clears their status keys. Run files carry a version field.
- Ctrl-C: the watcher sees the gate's pid disappear and cleans up — no new signal handler in review.mjs (the gate's own death behaviour is unchanged). A detached security worker that outlives Ctrl-C keeps its line until it really exits (it is real work still running).

## Safety
- Every string shown (pane or sidebar) is stripped of control/escape characters and length-capped; values passed to cmux go after the flags/`--` so text starting with `--` can't become a flag.
- `watch` is a home-config-only key (added to OWN_FILE_KEYS); a tracked repo config can't turn the pane on.
- The gate never waits on the watcher: spawn detached, unref, errors swallowed and silent (no stderr/stdout lines — slice parents and stderr-pinned tests stay byte-identical).
- A missing or old `acs-agent` (no `watch` subcommand): the gate checks `acs-agent watch --version` once (≤1s timeout) and skips watching.

## Acceptance (what must be shown, not claimed)
1. **Output unchanged:** with stub CLIs and a stub cmux, run the same review with `watch` off and on; reports and FINDINGS_JSON equal after normalising review id, timestamps and durations (normaliser written in the test, listed field by field). Existing stub tests and tests/ask-model.mjs exact-argv tests pass untouched; any needed change to them stops the build and asks.
2. **Watcher unit tests** with fake process tables, fake `lsof`/`ps` output and fixture transcripts per harness: concurrent same-cwd calls (two lenses, a same-vendor security pass) each map to their own transcript; Grok under real GROK_HOME; unknown transcript → honest line; escape sequences stripped; a dead run swept.
3. **Live** (orchestrator runs, in cmux): a real review on a real branch with Sol reviewer + Fable security → two live sidebar lines whose steps match each reviewer's transcript; pane shows both, tagged; slices run shows one pane; Ctrl-C mid-run clears lines within 5s; `kill -9` of the gate → next review's watcher sweeps the stale line; `watch: sidebar` shows lines and no pane; one Grade through ask-model shows its line.
4. Timing: the gate's wall time with watch on is within 2s of watch off on the stub run.

## Scope (honest)
review.mjs (watcher start + child env + OWN_FILE_KEYS), ask-model.mjs (watcher start), lib/agent.js + bin/agent.mjs (`watch` subcommand), lib/review-settings.js + its tests + example config + the ACS review settings field for `watch` (off | sidebar | pane), README. One PR: the gate side does nothing without the watcher.

## Out of scope
Reviewer models, prompts, independence or sandbox; typing into reviewers; the ACS board; tmux; showing "findings so far" (the structured answer only exists at the end — the line shows the current step instead).

## Lane
Precise. Builder: opus (builder role) as a native subagent, phases: (1) watcher + unit tests, (2) gate side + output-unchanged test, (3) settings/UI/README. Review + security at the PR tip, cross-vendor; live checks above by the orchestrator.
