# Phase 2 — reliability: no worker stalls without the orchestrator knowing

Read first: builds/watchable-agents evidence copied here as builds/agent-command/stalls-summary.md (real stalls, causes, signals). Keep everything from phase 1. Same constraints as brief.md (no new deps, tests with fake cmux and fake transcripts, guards untouched except as already done, no live panes — the orchestrator runs live checks). You cannot commit (sandbox); leave work uncommitted and grouped as before: test-only changes separate from code. If git add/commit works for you now, commit at the end of each item instead.

## 1. `agent wait` reports every way a worker goes quiet
Return (and exit code, and JSON field `state`) one of:
- `done` — finished its turn (as now); include `question: true` and the text when the final message's last non-empty line starts with `QUESTION:`.
- `stuck` — permission prompt (as now), with the prompt text.
- `unsent` — after an `agent send`, no new turn started within 10s (Codex: no new `task_started` event_msg in its rollout; Claude: no new user entry in its transcript; Grok: no new `turn_started`), even after the Enter retries. Include the screen's input-box line.
- `no_start` — `agent open` happened ≥60s ago and the harness has produced no session/transcript at all.
- `stalled` — a turn is running (started, not ended) and its transcript file has not grown for `--stall-after` seconds (default 300). Include the last 3 steps (tool calls/commands) read from the transcript.
- `timeout` — as now.
`wait` returns the FIRST of these to happen, so an orchestrator running `agent wait` in the background is woken by any of them. Test each with fake transcripts/clock.

## 2. `agent send` never reports success without proof
Success only when the harness file shows a new turn (the signals above). Long messages: if the text is over 400 characters, write it to a file in the worker's run folder and send a short line instead: `Read <path> and follow it.` (Codex collapses long pastes into a placeholder that one Enter does not submit — that was a real stall.) Test both paths.

## 3. Keep the Mac awake while workers run
While any worker in the registry is open and not closed, hold `caffeinate -i -w <pid>` (pid = the harness process in that pane, found via the launcher script writing `$$` to the run folder before exec) — one caffeinate per worker, ends with the process. Test with a fake caffeinate on PATH recording its argv. Document that a closed lid on battery still sleeps.

## 4. Launchers can't wait for stdin
Any non-interactive codex use in lib/agent.js passes stdin from /dev/null. Interactive panes are fine as they are.

## 5. A fault rig the orchestrator can run live
Add builds/agent-command/rig/run.mjs (not shipped) that, in a scratch git repo it creates under $TMPDIR, uses the real `agent` command to provoke each failure and asserts the right `wait` state within the stated time: (a) a long message to Codex → must be `done`, never silently `unsent`; (b) a Claude worker started with `--permission-mode default` told to run a shell command → `stuck` within 15s; (c) a worker told to run `sleep 600` with `--stall-after 30` → `stalled` within 45s (b and c use a test-only `--launch-extra` / env hook you add for the rig, documented as test-only); (d) a launcher pointed at a missing binary → `no_start` within 75s; (e) a worker ending with `QUESTION: …` → `done` with question. It prints a table: scenario, harness, expected, got, seconds, pass/fail, and closes every pane it opened. Do not run it — the orchestrator will.

## Done when
Unit tests for 1–4 pass, the listed suites pass (tests/agent-cli.mjs, agent-install.mjs, guards.mjs, setup-guards.mjs, suite-coverage.mjs, readme.mjs), README documents the states, and report.md gains a "Phase 2" section (what covers what, deviations). Reply DONE.
