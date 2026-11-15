# Watchable agents — plan

Decided with Cris 2026-11-13. Research: fable.out (Fable's options). Experiments (scratchpad prototypes agent.py, done.py, t1/t2/t4): every harness runs in a cmux pane with the task passed in at launch; 47 KB prompts work; follow-ups keep context; ten workers at once finish correctly; a sandboxed Codex orchestrator can open a Claude worker; a stuck prompt is caught in ~4s and answered in the pane.

## Problem
Workers from another vendor (Codex: Sol, Terra, Astra; Grok), and every review, advisor and security pass, run in a hidden shell. Cris can't see what they do, can't step in when one gets stuck, and some roles are forced onto Claude only because Claude subagents are the only watchable kind.

## Rule (goes into the skills and CLAUDE.md lanes)
| Worker | Runs as |
|---|---|
| Claude model, Claude Code orchestrator, building | native subagent (unchanged) |
| Claude model Cris will want to type to, or a job that should outlive the session | `agent` pane |
| Codex or Grok, any job | `agent` pane |
| Review, security, advisor, grade | headless as today (proven model, exact format, read-only, blind), made visible by the sidebar line and the review pane (PR 3) |

## PRs (each stands alone)

### PR 1 — the `agent` command (ACS repo, installed on PATH like model-id)
- `agent open <family> [--effort e] [--cwd d] [--role r] (--prompt-file f | "<task>")` → prints the worker id. Family → harness through model-id: `gpt-` → `codex -m … -s workspace-write -a never`; `claude-` → `claude --model … --permission-mode auto`; `grok-` → `grok -m … --always-approve`. The prompt never passes through the terminal: a launcher script reads it from a file.
- Layout: workers open as tabs in one "workers" pane beside the orchestrator (created on first use); Grok gets its own visible pane, focused only until its session starts, then focus returns.
- `agent wait <id> [--timeout]` returns `done`, `stuck` (with the prompt text from the screen) or `timeout`. Done is read from each harness's own files (Codex `task_complete` in its rollout, Claude transcript / Stop, Grok `turn_ended`); stuck from cmux PermissionRequest/Notification, ignoring the idle notice sent ~60s after a finished turn.
- `agent send <id> "<text>"` (submit verified from the transcript, not the screen), `agent answer <id>` (final message, exact), `agent close <id>`, `agent list` (this orchestrator's workers).
- Registry: one file per worker in ~/.agent-config-studio/agents/ (orchestrator workspace and pane, family, model, effort, cwd, surface, session, status, times). Feeds the board later.
- Closing: a worker closes when the orchestrator accepts its work (`agent close`), or after 30 idle minutes with its transcript kept. Never on its own while it might get a correction.
- Light on the Mac: workers start with no MCP servers unless the brief asks for one (`--mcp` to opt in), and at most 4 run at once; extra `agent open` calls queue and start as slots free.
- Not in cmux: a plain message saying the command needs cmux; nothing else in ACS depends on it.

### PR 2 — skills use it (Cris's skills on this Mac, Claude and Codex twins)
- The rule above in the delegation and /build skills; the orchestrator runs `agent wait` as a background task, so it is notified on done or stuck, answers routine prompts in the pane and brings Cris only real decisions.
- context-pass: the writer may be any family; a non-Claude writer runs through `agent open` with write access.

### PR 3 — watching judgment agents (review gate: precise lane)
Covers every headless judgment call, not only reviews: code review, security, Grade, advisor, investigator and second opinions (everything through review.mjs and ask-model).
- Sidebar line: each running review, security pass, advisor or grade sets a cmux sidebar status for its workspace ("security · fable · reading server.js", "review · sol · 1 finding so far"), cleared when it ends.
- One review pane: all reviewers of a run stream into a single pane, one line per step, tagged by reviewer; opt-in setting in the review gate (default on for Cris), closes when the run ends.
- Headless calls stay headless: same model proof, same format, same read-only sandbox.

### Later (separate plan)
- ACS Agents board — a window, not a control panel: it shows what each agent is thinking, doing and returning; it does not start, route or manage agents (stop is the only action). Every orchestrator workspace, its native and pane workers, and its reviews, live, with transcripts on click (read-only, localhost).
- Phone access to the board.

## Out of scope
Changing review independence or the read-only sandbox; a warm pool of idle workers; non-cmux terminals.

## Acceptance
- PR 1: tests with a fake cmux and fake transcripts for every command; one live check per harness (Codex, Claude, Grok) on a scratch folder: open → done → send → done → answer → close, no prompts reaching Cris; ten at once.
- PR 2: a real build phase runs a Sol builder in a pane end to end; a docs pass runs on Terra.
- PR 3: a real /pr-review shows sidebar lines and the review pane; summary and findings unchanged byte for byte against a headless run of the same review.

Lanes: PR 1 standard; PR 2 Cris's config (shown and backed up first); PR 3 precise.
