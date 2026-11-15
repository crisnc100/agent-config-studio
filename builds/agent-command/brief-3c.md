# Phase 3c — live rig: 5 of 6 pass; the silent-command case is hidden by the thinking rule

Rig now (orchestrator ran it): long follow-up done 16.1s PASS · permission stuck 5.4s PASS · missing binary no_start 60.6s PASS · question done 7.1s PASS · fresh folder trust stuck 3.6s PASS · silent running turn expected stalled, got timeout 45.3s FAIL.
The orchestrator changed the rig's sleep scenario: Claude Code blocks a standalone `sleep 600` ("Blocked: standalone sleep 600..."), so it now runs `python3 -c "import time; time.sleep(600)"` (committed with this brief). The command now really runs, but Claude's on-screen running timer keeps advancing while the tool runs, so the phase-3 "advancing indicator = thinking" rule keeps it from ever being called stalled. A hung test at 0% CPU (a real stall cause in the evidence) looks exactly like this.

Do:
1. Tell thinking from a running command: a tool call is open when the transcript has a tool use with no result yet (Claude: tool_use without matching tool_result; Codex: an exec/custom_tool_call begin without its output; Grok: its tool call record without a result, else screen). While a tool call is open, the advancing indicator does NOT reset the stall clock.
2. New state `long_command` (exit 9): a tool call has been open longer than `--command-after` seconds (default 600; the rig passes 30), with the command text. Distinct from `stalled` (no tool open, no growth, no advancing indicator).
3. Rig: the silent scenario expects `long_command` (pass `--command-after 30`), and keep a separate `stalled` check only if you can provoke a true no-progress state reliably; otherwise cover `stalled` in unit tests only and say so.
4. README: the states table gains long_command.
Same constraints and commit grouping; don't run the rig. Reply DONE.
