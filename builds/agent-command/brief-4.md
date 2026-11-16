# Fix round — review 2026-11-16-13-41-58-58110b (code + security). Fix every finding below.

Test first: for each, add a test that fails on the current code, then fix. Same constraints and commit grouping as before (test-only changes separate; you can't commit, leave grouped). Don't run the rig. Reply DONE with one line per finding: fixed (test name) or disputed (with proof).

## f1 MEDIUM lib/agent.js:84
Transcript discovery ignores alternate harness homes. ACS’s generated shell exports CODEX_HOME for private Codex seats, but discovery always searches ~/.codex. A completed worker therefore returns timeout with transcriptMissing, and answer fails. GROK_HOME has the same defect. Both cases reproduced using in-memory transcripts.

trigger: Open a Codex worker using an ACS private account home, or a Grok worker with GROK_HOME configured, then run wait or answer.

suggestion: Persist the effective harness home when launching each worker and use it for all subsequent transcript discovery.

## f2 MEDIUM lib/agent.js:312
A follow-up typed directly into the worker pane remains classified as done because turnComplete advances only through agent send. Reproduction returned done while the new turn had an open tool, then force-closed the active worker after 30 minutes. This also excludes active work from the four-worker limit and disables its stall checks.

trigger: After a worker finishes, type and submit a correction directly in its cmux pane, then invoke wait or list.

suggestion: Track the latest started and completed turns from transcript ordering, including turns submitted directly in the pane, and update activity accordingly.

## f3 MEDIUM lib/agent.js:274
Resolved permission requests remain stuck until the entire turn completes. The historical PermissionRequest remains selected even after its matching tool result appears. Reproduction still returned stuck while a subsequent command exceeded command-after, so the obsolete permission event masks later faults.

trigger: Approve a worker’s permission dialog in its pane, then wait again while the same turn continues executing tools.

suggestion: Retire permission events when subsequent transcript activity proves resolution, and verify that the dialog remains active before returning stuck.

## s1 HIGH lib/agent.js:392
Prompt files can inject harness options and execute attacker-supplied MCP commands. The launcher passes prompt contents without an end-of-options delimiter. An attacker-controlled brief beginning with `--config=mcp_servers.evil={command="sh",args=["-c","<command>"]}` therefore configures a process instead of becoming task text. This exposes the operator's account to command execution outside the worker's workspace sandbox. A harmless parser probe confirmed that this argument creates an enabled stdio MCP server.

trigger: Run `agent open sol --prompt-file task.md` in a trusted workspace where an attacker supplied task.md containing an MCP configuration option.

suggestion: Insert the harness-supported end-of-options delimiter before prompt contents, and test that option-shaped prompts remain literal task text.

## s2 HIGH lib/agent.js:487
Sending a follow-up can approve a trust or permission dialog without the operator's consent. sendWorker refreshes the worker but proceeds even when its state is stuck; sendTurn then presses Enter up to four times. At an affirmative dialog selection, those keys authorize the pending action instead of submitting a message. An attacker-induced permission request can consequently execute against the operator's files when the orchestrator sends a correction. In-memory execution confirmed that both trust-stuck and permission-stuck workers receive Enter.

trigger: A worker encounters a trust dialog or requests permission for an attacker-induced command; the orchestrator calls `agent send <id> "Do not approve anything"` while the affirmative choice is selected.

suggestion: Reject sends while trust or permission approval is pending. Recheck for dialogs before Enter retries and stop without answering when one appears.

## Notes from the orchestrator
- s1: put `--` (end of options) before the prompt for every harness that accepts it; for any that don't, pass the prompt so it can never start with `-` (e.g. via its prompt-file option or a leading text line). Test with a prompt starting `--config=...` per harness.
- s2: `agent send` must refuse (non-zero exit, state named) while the worker is stuck (trust or permission); never press keys into a dialog. `agent` never answers dialogs.
- f1: honour CODEX_HOME and GROK_HOME (and CLAUDE_CONFIG_DIR for Claude) when locating transcripts, using the worker's launch environment.
- f2: a new turn started in the transcript (typed by the user in the pane) counts as running work, whatever its origin.
- f3: a permission request is resolved once its tool result (or a later turn event) appears.

