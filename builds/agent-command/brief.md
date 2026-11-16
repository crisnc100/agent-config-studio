You are the builder for PR 1 of builds/agent-command/plan.md ("the `agent` command") in this repo (Agent Config Studio, Node, no new dependencies). Work only in this worktree, branch agent-command.

OBJECTIVE: ship an `agent` CLI that starts any model family as a watchable worker in a cmux pane and lets an orchestrator (Claude Code or Codex) open, wait on, message, read and close it. Exactly the "PR 1" section of the plan, nothing from PR 2/3 or Later.

READ FIRST:
- builds/agent-command/plan.md (spec; PR 1 section is your scope)
- builds/agent-command/prototype/agent.py, done.py, t1.py, t2.py, t4.py: a working Python prototype proven live today. Port its behaviour to Node; do not ship Python.
- builds/agent-command/fable.out (research: transcript locations per harness)
- bin/model-id.mjs, bin/pause.mjs and bin/acs (how a CLI here is structured, dispatched and installed; `acs install-model-id` installs model-id + ask-model onto PATH — install `agent` the same way)
- lib/paths.js (file reads must go through its readers: tests/setup-guards.mjs fails any raw read outside lib/paths.js), lib/roles.js and lib/models.js (vendorOf, family → id)
- ~/.claude/skills/cmux/SKILL.md (cmux CLI rules: prefixed refs, --json, close-surface --force)

FACTS FROM THE LIVE TESTS (design must keep these):
- Launch: write a small launcher script per worker that cd's and execs the harness with the prompt read from a file ("$(cat file)"); pass it to `cmux --json --id-format both new-pane|new-surface ... --command <script>`. Never type the prompt into the terminal.
- Harness flags: gpt-* → `codex -m <id> [-c model_reasoning_effort=<e>] -s workspace-write -a never`; claude-* → `claude --model <id> [--effort <e>] --permission-mode auto`; grok-* → `grok -m <id> --always-approve`.
- Layout: side-by-side splits fail after ~7 with "no_space"; open workers as tabs (`new-surface --pane <workers pane>`) in one workers pane created on first use beside the orchestrator's pane (from `cmux --json identify` caller.pane_ref, or $CMUX_SURFACE_ID's pane). Grok only starts while its pane is visible+focused: give Grok its own new pane with --focus true, wait until its session dir appears under ~/.grok/sessions/<cwd with / as %2F>/ (≤6s), then `cmux focus-pane --pane <orchestrator pane>`.
- Done detection (cmux Stop events are dropped for Codex under load; Grok never sends Stop): Codex → `task_complete` lines in ~/.codex/sessions/Y/M/D/rollout-*.jsonl whose first line's payload.cwd matches (track the specific rollout by session id once known); Claude → agent.hook.Stop for the surface in ~/.cmuxterm/events.jsonl (also usable: the session transcript ~/.claude/projects/<cwd with / → ->/<session>.jsonl); Grok → `turn_ended` in ~/.grok/sessions/<enc cwd>/<id>/events.jsonl.
- Stuck detection: agent.hook.PermissionRequest (and Notification not within ~60s after a finished turn, which is just the idle notice) for that surface_id.
- Final answer: Codex task_complete.last_agent_message; Claude last assistant text in its transcript; Grok: last assistant message in chat_history.jsonl if present, else the screen (`cmux read-screen`).
- Follow-ups: `cmux send` + `send-key enter`; one enter sometimes leaves the text in the composer — verify submission from the harness files (a new user turn), retry enter up to 3 times; screen text alone is not a reliable check (the message stays visible in history).

COMMANDS: agent open | wait | send | answer | close | list, as the plan says; `wait` prints done|stuck|timeout (stuck includes the prompt text from read-screen) and exits 0/3/4; JSON output with --json. Registry: one JSON file per worker in ~/.agent-config-studio/agents/ (written with the repo's safe write pattern). close = cmux close-surface --force + status closed; idle close after 30 minutes is checked lazily by `agent list`/`agent wait` (no daemon). Outside cmux (no CMUX_SOCKET_PATH / socket unreachable): plain error "agent needs cmux…", exit 2.

CONSTRAINTS: no new deps; Node ≥ the repo's engines; no personal paths or names in shipped files; comments only where they say why; the frozen file and review gate untouched; no changes outside what PR 1 needs (bin/, lib/ new module(s), README section, acs help + install, tests/SUITE). Test-first. Tests must not need real cmux or real CLIs: inject a fake `cmux` on PATH and fake transcript folders under a temp HOME (look at how tests/pause-cli.mjs and tests/roles-pause.mjs build temp homes and stubs). Never weaken an existing assertion.

VALIDATE: node tests/<your new test files>, node tests/setup-guards.mjs, node tests/guards.mjs, node tests/suite-coverage.mjs, node tests/readme.mjs, node tests/ui-words.mjs (outside the sandbox if it binds a port). Do NOT run a live check that opens real panes — the orchestrator does that.

COMMITS: commit at the end of each phase (core + open/wait; send/answer/close/list; install + README), build folder included. Never push, open a PR or run reviews or other models.

STOP WHEN: all PR 1 requirements have passing tests and the listed suites pass; then write builds/agent-command/report.md (shas, which test covers what, deviations) and reply DONE with a 5-line summary. If the plan doesn't decide something, choose the simplest option, note it in report.md, and continue (don't stop to ask).
