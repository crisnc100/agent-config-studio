# Agent command — builder report

DONE with the requested follow-up. The orchestrator committed the initial implementation as `b4001bb`; these follow-up edits are uncommitted for the orchestrator to split and commit. No live worker panes, reviews, model turns, pushes or PRs were started.

- Guard b permits only `spawnSync` with the literal `cmux` in `lib/agent.js`. A separate import-graph assertion prevents the server from reaching that module through static imports, dynamic imports or re-exports; computed imports fail closed. Negative controls reject harness/other binaries, computed executable names, other subprocess functions, and direct/transitive worker imports. No existing assertion was changed.
- `--mcp` is accepted and recorded. Claude defaults to `--strict-mcp-config`, without `--mcp-config`; opt-in removes that restriction. Grok is unchanged because it has no no-MCP switch. **Codex also retains configured MCP servers: no global run-only disable key was verified.** README documents both exceptions.
- Codex launchers resolve `git rev-parse --git-common-dir` after changing cwd and add the physical common directory with `--add-dir` when it is outside cwd. The launcher tests use real temporary Git metadata, including a linked worktree path containing spaces and an apostrophe, plus an ordinary repository that must receive no extra directory.

## MCP verification

`codex --help` documents generic `-c` overrides but no global MCP-off option. The installed CLI is 0.160.0; its installed README contains no such setting. The version-matched [configuration schema](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/config.schema.json) and [config implementation](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/config/mod.rs) were downloaded to temporary files and inspected. `orchestrator.mcp.enabled` concerns orchestrator-owned tools, not all configured servers.

A read-only CLI probe used a temporary HOME with one fixture server; `codex mcp list --json` does not start a model turn:

| Override | Fixture server enabled |
| --- | --- |
| `-c mcp_servers={}` | true |
| `-c orchestrator.mcp.enabled=false` | true |
| `-c mcp_servers.fixture.enabled=false` | false |

No ineffective global override was added. Per-server enumeration/config rewriting is outside this follow-up.

## Validation

| Command | Result |
| --- | --- |
| `node tests/agent-cli.mjs` | PASS, including all harness launcher argv, MCP opt-in/default, shared Git metadata, all commands and queue coverage |
| `node tests/agent-install.mjs` | PASS, including installed open/wait lifecycle |
| `node tests/guards.mjs` | 11 passed, 0 failed |
| `node tests/setup-guards.mjs` | 54 passed, 0 failed |
| `node tests/suite-coverage.mjs` | 33 passed, 0 failed |
| `node tests/readme.mjs` | 53 passed, 0 failed |
| `git diff --check` | PASS |

## Commit grouping

- Guard-only test commit: `tests/guards.mjs`, `tests/setup-guards.mjs`. Existing assertions are intact; additions pin the cmux exception and server isolation.
- Launcher assertion test commit: `tests/agent-cli.mjs`. Assertions are appended; none are weakened.
- Implementation/documentation commit: `bin/agent.mjs`, `lib/agent.js`, `README.md`, this report.

Live pane acceptance remains with the orchestrator, as requested. The frozen review test and review-gate files are untouched.

## Phase 2

DONE. Reliability changes are uncommitted, grouped below for the orchestrator. No live panes or fault-rig scenarios were run, and the existing guards were not edited.

- `wait` exposes `state` alongside the compatible `status`: done/0, stuck/3, timeout/4, unsent/5, no_start/6, stalled/7. It recognizes final `QUESTION:` lines, retains exact question-answer text, watches the 10-second submission and 60-second startup deadlines, and checks transcript growth with a default 300-second stall threshold. Stalled diagnostics retain up to three available steps (up to 2,000 characters each), including Grok chat-history tools.
- `send` requires Codex `task_started`, Claude user text, or Grok `turn_started`; a Codex user-message record alone does not prove submission. Four Enter presses are the maximum, followed by a failure at 10 seconds if no start is confirmed. The pending attempt persists so a separate waiter wakes with unsent. Messages over 400 characters are atomically saved in the worker run directory and replaced with a short file instruction in the composer.
- Launchers write `harness.pid` before exec and start exactly one `caffeinate -i -w <pid>` per process. Caffeinate output is retained in the run directory; its assertion ends with the target process. README states that a closed lid on battery still sleeps. Interactive stdin is preserved. No non-interactive Codex calls were introduced; the sole Node subprocess (cmux) explicitly ignores stdin.
- `builds/agent-command/rig/run.mjs` creates a scratch Git repo, checks long follow-up/done, permission/stuck, silent sleep/stalled, missing binary/no_start and QUESTION/done. It prints a results table and closes its workers in finally, including orphan records from interrupted opens. Extra harness args and binary replacement require the explicit test-only `AGENT_TEST_MODE=1` gate. The rig was syntax-checked only; live timing acceptance remains with the orchestrator.

### Coverage and checks

| Check | Result / coverage |
| --- | --- |
| `node tests/agent-reliability.mjs` | PASS: fake-clock boundaries, background wait waking at startup deadline, all fault states and exit codes, oldest overdue signal, growth resets, default stall threshold, last-three-step diagnostics, all-vendor question detection, Grok screen/history fallbacks, task-start proof and short/long sends |
| `node tests/agent-cli.mjs` | PASS: all Phase 1 assertions retained; fake transcript starts added; actual launcher execution against fake caffeinate verifies one assertion per recorded harness PID; test-only launch overrides and ignored overrides without the gate |
| `node tests/agent-install.mjs` | PASS: installed CLI open/wait lifecycle and existing install/refusal checks |
| `node tests/guards.mjs` | 11 passed, 0 failed |
| `node tests/setup-guards.mjs` | 54 passed, 0 failed |
| `node tests/suite-coverage.mjs` | 33 passed, 0 failed; new reliability test is in the offline suite |
| `node tests/readme.mjs` | 53 passed, 0 failed |
| `node --check builds/agent-command/rig/run.mjs` | PASS; the rig itself was not run |
| `git diff --check` | PASS |

### Choices and commit grouping

- Exit codes 5/6/7 cover the three new failure states; send failure retains its Phase 1 exit code 1. `--stall-after 0` checks a running turn immediately. Runtime clock/sleep injection is a library test seam; CLI time is real.
- Unsent includes a best-effort composer line plus the full screen, since terminal output does not provide a structured input-box boundary. Transcript signals, not this screen heuristic, determine submission.
- No daemon was added. Caffeinate is tied to the launcher/harness PID rather than the short-lived `agent open` process. The prior MCP limitations remain unchanged.
- Test-only commit group: `tests/agent-reliability.mjs`, additions to `tests/agent-cli.mjs`, `tests/fixtures/agent-cmux.mjs`, `tests/SUITE`, and the fault rig. Existing assertions are unchanged.
- Implementation/docs group: `lib/agent.js`, `bin/agent.mjs`, `README.md`, this report.
- **The rig is ignored by the repository's `builds/` rule. Include it explicitly with `git add -f builds/agent-command/rig/run.mjs` when committing.** No `.gitignore` or review-gate changes were made.

## Phase 3 — trust dialogs and thinking indicators

Base: `60cfb79` (brief), following implementation `25334ab` and tests `23fb6f0`.
Changes remain uncommitted for the orchestrator, as instructed.

- `wait` reads pre-session screens every three seconds and returns `stuck`, exit 3, `kind: "trust"`, with ANSI-free dialog lines. Header and choice text must both match. Visible trust takes precedence over `no_start`; a session start invalidates the cached startup dialog. No trust responses or CLI configuration writes were introduced.
- Bundled text was checked locally in Codex 0.160.0, Claude Code 2.1.325 and Grok 1.0.77. The per-harness fixtures record their exact trust strings; their README distinguishes reconstructed running-status examples from live captures. Grok's full dialog says “Do you trust the contents of this directory?”, with “Yes, proceed” / “No, quit”.
- Elapsed running indicators are sampled every three seconds and refreshed before a stall decision. The worker record persists the turn, elapsed seconds and last advance time across invocations. Transcript growth or advancing elapsed time resets the stall deadline. Frozen/disappearing indicators and timer resets do not extend it. Choice where unspecified: the first elapsed reading gets one observation window before it can be called frozen.
- Permission-timeout evidence: the installed cmux Claude wrapper's standard hook settings wire `PermissionRequest` directly to `hooks feed --source claude` (lines 2056 and 2172), independently of the queued `SessionStart` hook. There is no session prerequisite in that wiring. This supports the orchestrator's confirmed cause: folder trust blocks startup before Claude reaches a tool permission request. Offline coverage verifies both pre-session trust and the post-start PermissionRequest path. Live timing after inherited trust still belongs to the orchestrator's rerun.
- The rig creates a detached worktree of this repository under TMPDIR, runs the existing five scenarios there, and removes it after closing workers. Its sixth scenario initializes a separate new repository and requires `stuck` with `kind: "trust"` within 15 seconds. The permission scenario explicitly rejects trust as a substitute for its tool prompt. Cleanup retains the scratch path and fails if workers cannot close or worktree removal fails. The rig was not executed.

Validation: `node tests/agent-screens.mjs` passes fake-clock dialog latency for all three harnesses, CLI exit 3, no typing, startup-deadline precedence, session-start cache invalidation, post-start permission, persistent/continuous advancing timers beyond two stall windows, frozen/disappearing indicators, minute formatting and reset rejection. `node tests/agent-reliability.mjs`, `node tests/agent-cli.mjs`, `node tests/agent-install.mjs`, `node tests/guards.mjs` (11), `node tests/setup-guards.mjs` (54), `node tests/suite-coverage.mjs` (33), and `node tests/readme.mjs` (53) pass. Rig syntax and `git diff --check` pass.

Commit-ready groups: tests/fixtures/SUITE plus the development rig; separately `lib/agent.js`, README and this report. Existing assertions, guard files, the frozen review test and review gate are untouched. No new dependencies, live panes, reviews or other models. No scope deviations beyond the documented initial-indicator observation window.

## Phase 3b — manually removed panes and surfaces

Base `b0eda8c`; Phase 3 implementation `ad36dc4`, tests `7c71004`. Changes remain uncommitted for the orchestrator.

- Shared-pane reuse checks `list-pane-surfaces` with explicit workspace and pane refs, using the most recent eligible worker. A missing pane is discarded. A `not_found` race during `new-surface` gets exactly one fresh `new-pane --command` attempt; other errors propagate.
- `wait` probes the surface on every poll, including completed workers whose transcripts remain. Missing surfaces, explicit closures and idle closures return `state`/`status: "closed"`, `closed: true`, exit 8. Detected disappearance persists in the registry. Closing a manually removed surface is idempotent.
- `tests/agent-surfaces.mjs` first reproduced the failed second open, then passed: pane removed between opens, valid-pane reuse, workspace-scoped validation, creation race recovery, bounded failed recovery, unrelated creation/screen/socket errors, vanished completed surface, disappearance during a running wait, repeated wait, explicit close, manual removal followed by close, and idle-close exit 8.
- Existing assertion change: `tests/agent-cli.mjs`'s idle-wait assertion still requires `closed: true`; it now parses the exit-8 result directly instead of the exit-0 JSON helper, and additionally requires state `closed` and exit 8. No assertion was loosened. Suggested test commit message: “Test: preserve idle closed:true, require closed state and exit 8; cover removed panes and surfaces”.

Validation passed: `agent-surfaces`, `agent-cli`, `agent-install`, `agent-reliability`, `agent-screens`, `guards` (11), `setup-guards` (54), `suite-coverage` (33), `readme` (53), rig syntax, and `git diff --check`. All named tests run as `node tests/<name>.mjs`. The rig was not run; no real panes were opened.

Commit groups: test-only (`tests/agent-surfaces.mjs`, `tests/agent-cli.mjs`, `tests/fixtures/agent-cmux.mjs`, `tests/SUITE`); implementation/docs (`lib/agent.js`, `bin/agent.mjs`, README, this report). Guards, frozen tests and review gate untouched; no dependencies or scope deviations.

## Phase 3c — open tools use a command deadline

Base `6274ed0`; Phase 3b implementation `d25d3f8`, tests `24db042`. Changes remain uncommitted for the orchestrator.

- `wait --command-after <seconds>` defaults to 600 and reports `long_command`, exit 9, with `command` in JSON and plain output. An unfinished tool prevents `stalled`; an advancing UI timer does not extend its command deadline. `stalled` applies only when no tool is open, no transcript grows and no thinking indicator advances.
- Calls/results are paired by id: Claude `tool_use`/`tool_result`; Codex function/custom calls and outputs plus exec begin/end events; Grok `assistant.tool_calls`/`tool_result.tool_call_id`, direct tool records and terminal call updates. Local Grok records confirmed the assistant-array and result-id shape (only schema keys/types were inspected). Parallel calls retain individual ages; failed results close calls too. Turn boundaries discard previous calls.
- Tool ages persist across waits. Transcript timestamps establish age when available; undated calls use their first observation. Records without ids are tracked by transcript position, and unidentified results close the oldest unidentified call. Grok falls back to explicit `Running:`/`Executing:` command rows only when structured call records are unavailable. Grok history growth also counts as transcript activity.
- The rig's existing silent Python command now expects `long_command` with `--command-after 30`. No live `stalled` scenario was added: a quiet turn without an open tool is not reliably provoked by this rig. True stalls remain covered offline. The rig was syntax-checked, not run.

`tests/agent-commands.mjs` first failed on the missing long-command state and now passes all three vendors, threshold boundaries/default 600, advancing timers during open tools, persistent undated ages, unrelated transcript growth, mismatched/error results, parallel ages, unidentified calls/results, Codex custom/exec records, Grok screen fallback, post-result true stalls, JSON/plain exit 9 and invalid options. Existing reliability assertions are unchanged: their stall fixtures now include matching tool results, preserving last-three-command diagnostics and true-stall checks with no tool left open. New tests separately require unfinished calls, including calls without ids, to use the command deadline.

Validation passed: `node tests/agent-commands.mjs`, `node tests/agent-reliability.mjs`, `node tests/agent-screens.mjs`, `node tests/agent-surfaces.mjs`, `node tests/agent-cli.mjs`, `node tests/agent-install.mjs`, `node tests/guards.mjs` (11), `node tests/setup-guards.mjs` (54), `node tests/suite-coverage.mjs` (33), `node tests/readme.mjs` (53), rig syntax and `git diff --check`.

Commit groups: tests only (`tests/agent-commands.mjs`, fixture updates in `tests/agent-reliability.mjs`, `tests/SUITE`, rig); implementation/docs (`lib/agent.js`, `bin/agent.mjs`, README, this report). Suggested test commit: “Test: separate unfinished command deadlines from stalls after matched tool results”. No assertion was weakened; guards, frozen tests and review gate are untouched. No dependencies, live panes, reviews or other models. Choices where unspecified are recorded above.

## Phase 3d — decode feed sessions and expose missing transcripts

Base `c1da8b0`; Phase 3c implementation `c77122b`, tests `f63dfb7`. Changes remain uncommitted for the orchestrator.

- Session ids normalize from `cmux-feed-v1:<base64 vendor>:<base64 id>` at hook ingestion, registry reads (including already pinned records), and Codex metadata matching. Both components are decoded; malformed encodings and foreign vendors cannot pin a worker. Plain harness ids remain valid.
- Claude resolves the session filename across the direct project directories under `.claude/projects`, without reconstructing project-directory encoding. When no session id is known, fallback discovery still requires transcript cwd evidence, baseline exclusion and an unambiguous match. Claimed files remain excluded.
- A known session whose transcript remains unresolved for 30 seconds adds `transcriptMissing: true` to returned wait JSON, including timeout and hook-derived completion. Hook timestamps establish session start; absent/invalid timestamps use persistent first observation. The flag clears once the file resolves. This is an annotation, with no new exit state or shortened wait deadline.
- Why Codex appeared healthy: prior discovery returned immediately once a transcript was pinned. With no hook yet, a unique cwd match pinned the raw rollout id. An encoded hook arriving first instead blocked raw-id matching. Read-only inspection of recent real rig records found six pinned Codex workers with raw registry ids matching rollout metadata, despite encoded SessionStart hooks. Their prior success therefore depended on discovery order. Available encoded hook vendor components decode to `codex` and `claude`, matching the normalization. No real Grok worker registry records were present; its encoded hook path is covered offline. Inspection printed only aggregate forms/counts, not paths, ids, prompts or answers.

`tests/agent-sessions.mjs` first reproduced the exact live encoded Claude value failing to expose its open tool; it now resolves that filename and returns long_command. It also covers encoded Codex/Grok hooks, nested hook payloads, both Codex arrival orders, saved and already pinned encoded registry records, punctuation in cwd with a differently named Claude project directory, malformed/foreign encodings, all-vendor 29.999s/30s boundaries, late recovery, timestamp fallback, hook-derived done diagnostics and actual CLI timeout JSON. Existing assertions are untouched.

Validation passed: `node tests/agent-sessions.mjs`, `node tests/agent-cli.mjs`, `node tests/agent-install.mjs`, `node tests/agent-reliability.mjs`, `node tests/agent-commands.mjs`, `node tests/agent-screens.mjs`, `node tests/agent-surfaces.mjs`, `node tests/guards.mjs` (11), `node tests/setup-guards.mjs` (54), `node tests/suite-coverage.mjs` (33), `node tests/readme.mjs` (53), rig syntax and `git diff --check`. The rig was not run; no panes were opened.

Commit groups: tests only (`tests/agent-sessions.mjs`, `tests/SUITE`); implementation/docs (`lib/agent.js`, README, this report). Guards, frozen tests and review gate are untouched. No dependencies, reviews or other models. Conservative timing fallback and unchanged wait deadlines are the choices where the brief did not specify behavior.

## Fix round — review 2026-11-16-13-41-58-58110b

Base `bd3317d`; preceding implementation `b71e620`, tests `15815ab`. All five findings were reproduced as failing cases before implementation in `tests/agent-review-fixes.mjs`; all five now pass. Changes remain uncommitted for the orchestrator.

| Finding | Result and regression |
| --- | --- |
| f1 MEDIUM | Fixed (`agent-review-fixes.mjs`, case `f1`): launch records the effective harness home, discovery uses that record, and the launcher preserves explicit CODEX_HOME / CLAUDE_CONFIG_DIR / GROK_HOME overrides. Unset overrides remain unset. Wait/answer succeed in private homes even when the later caller's environment points elsewhere; executing each launcher against a stub verifies the pinned launch environment. |
| f2 MEDIUM | Fixed (`agent-review-fixes.mjs`, case `f2`): latest transcript start/end ordering determines whether the worker is running. Directly submitted turns update activity, remain open, occupy the four-worker limit and retain stall/long-command checks. Claude end-turn records take precedence over delayed/duplicate Stop hooks. The regression covers all vendors, manual follow-up completion, idle-close prevention, late Stop hooks and a queued fifth worker. |
| f3 MEDIUM | Fixed (`agent-review-fixes.mjs`, case `f3`): permission events retire on matching results, later turns, timestamped subsequent results when no dialog remains, or an observed approval dialog disappearing. Requests without enough resolution evidence remain pending. A new request gets its own age, and unrelated results cannot resolve an identified request. Tests cover later long commands, newly pending requests, dismissed dialogs with a still-open command, and hooks without call ids. |
| s1 HIGH | Fixed (`agent-review-fixes.mjs`, case `s1`): every launcher places the end-of-options delimiter `--` before prompt contents. Actual launcher execution against fake harnesses proves an option-shaped `--config=mcp_servers.evil=...` brief remains the exact final positional argument for Codex, Claude and Grok. Existing model, sandbox, effort and permission flags stay before the delimiter. Only installed CLI help was inspected; no model was run. |
| s2 HIGH | Fixed (`agent-review-fixes.mjs`, case `s2`): send rejects stuck workers with exit 3 and a named stuck state, checking fresh screen/hook state before text, before each Enter, and during submission verification. All three vendors' already-open trust/permission dialogs receive zero text or keys. Dialogs appearing after text or after the first Enter stop retries before a subsequent Enter can answer them. CLI refusal and input-call counts are asserted. |

Validation passed: `node tests/agent-review-fixes.mjs`, `node tests/agent-cli.mjs`, `node tests/agent-install.mjs`, `node tests/agent-reliability.mjs`, `node tests/agent-commands.mjs`, `node tests/agent-screens.mjs`, `node tests/agent-surfaces.mjs`, `node tests/agent-sessions.mjs`, `node tests/guards.mjs` (11), `node tests/setup-guards.mjs` (54), `node tests/suite-coverage.mjs` (33), `node tests/readme.mjs` (53), rig syntax and `git diff --check`. The live rig was not run.

`node tests/ui-words.mjs` is not green in this environment: 556 passed, 35 failed, with fetch failures and resulting UI/Packs assertions. It was repeated on the working tree and an isolated archive of committed HEAD, without changing this worktree or Git metadata. Both runs produced the exact same 35 failure lines. Logs: `/tmp/acs-agent-ui-working.log` and `/tmp/acs-agent-ui-baseline.log`. No UI or server code was changed, and the failures were not altered or waived.

Test-only commit group: new `tests/agent-review-fixes.mjs`, `tests/SUITE`, `tests/fixtures/agent-cmux.mjs`, and `tests/agent-cli.mjs`. The fixture models custom homes and changing approval screens. Five existing exact argv assertions changed: default Claude, MCP-opt-in Claude, MCP-opt-in Codex, MCP-opt-in Grok, and the initial Grok launcher. Each still pins all previous flags and exact task text, and additionally requires `--` immediately before the task. No assertion was weakened. Suggested message: “Test: require literal prompt delimiters in all five launcher argv cases; cover private homes, direct turns and approval safety”.

Implementation/docs group: `lib/agent.js`, README and this report. No new dependencies, panes, reviews or model calls. The frozen test, guards and review gate are untouched. The orchestrator owns the separate test-change check, fix check and commits.

## Fix check — brief 5

Base `eb3bafc`; implementation under test `600fb4f`, preceding tests `8ca06a0`. Changes remain uncommitted for the orchestrator.

- **x1 HIGH: fixed.** Unresolved permission hooks and visible permission dialogs make wait report `stuck` ahead of command/stall deadlines. Send also checks a separate approval-pending flag and a fresh screen, independently of the selected wait state, before text and every Enter. Claude edit/create/write/overwrite/fetch questions are recognized with Yes/No choices. Regression case `x1` covers a 610-second parallel command using the default 600-second deadline with a newer edit approval, zero text/keys, observed dismissal, a subsequent hook without a screen dialog, screen-only approvals, and a visible trust dialog after SessionStart even when wait has invalidated its startup state.
- **x2 MEDIUM: fixed.** Screen detection requires a question and both choice rows in the bottom 20 lines after removing terminal decorations and trailing blank lines. The fixed size is the simplest interpretation of “bottom region”; longer approval content needs the header and choices within that region, while hooks remain independent evidence. Case `x2` verifies successful follow-ups after an ordinary standalone question and after a past dialog above 30 answer lines. Existing tests still require all three vendors' real trust labels, polling behavior and SessionStart invalidation.
- **g1 live: fixed.** Grok startup trust uses the surviving header prefix plus both choice rows. Case `g1` reads the exact narrow screen fixture supplied in the brief, requires stuck rather than no_start at 150 seconds, and confirms no sends. The fixture retains the supplied displayed path as explicitly requested; production code contains no personal path. `answer` requires a completed current turn before returning transcript text or Grok's screen fallback; an unfinished worker exits nonzero with `no answer yet (state …)` and no stdout. Cases `g1answer` and `g1` cover CLI/library refusal, never-finished and active follow-up turns for all vendors, and preservation of the completed Grok fallback. Completed transcript answers remain readable after closure.

Test-first evidence: the added cases were run before implementation, then copied into an isolated `git archive 600fb4f` with the new fixture. That exact baseline failed `x1` (missing refusal), `x2` (false stuck), `g1answer` (raw screen returned) and `g1` (no_start instead of stuck); its five preceding review cases passed. Current code passes all nine cases. Baseline logs: `/tmp/acs-agent-brief5-baseline.log` and `/tmp/acs-agent-brief5-x1-baseline.log` (explicit default-deadline reproduction). The archive was temporary; the worktree and Git metadata were not changed by the baseline check.

Read-only inspection of the installed Claude Code 2.1.325 bundle confirmed the shared renderer `Do you want to ` + verb phrase + filename + `?`, edit verb `make this edit to`, write verbs `create`, `write to` and `overwrite`, the literal fetch question `Do you want to allow Claude to fetch this content?`, and Yes/No labels. No harness session or model was started for this inspection.

Validation passed: `node tests/agent-review-fixes.mjs`, `node tests/agent-cli.mjs`, `node tests/agent-install.mjs`, `node tests/agent-reliability.mjs`, `node tests/agent-commands.mjs`, `node tests/agent-screens.mjs`, `node tests/agent-surfaces.mjs`, `node tests/agent-sessions.mjs`, `node tests/guards.mjs` (11), `node tests/setup-guards.mjs` (54), `node tests/suite-coverage.mjs` (33), `node tests/readme.mjs` (53), syntax checks for `lib/agent.js` and the rig, and `git diff --check`. Individual rerun logs are `/tmp/acs-agent-brief5-<test-name>.log` (screen checks printed directly).

`node tests/ui-words.mjs` remains 556 passed / 35 failed (fetch failures and consequent UI/Packs assertions). This run's 35 failure lines exactly match both saved working-tree and isolated baseline logs from the preceding round. Current log: `/tmp/acs-agent-brief5-ui.log`; comparison baseline: `/tmp/acs-agent-ui-baseline.log`. No UI/server changes or weakened checks.

Test-only commit group: `tests/agent-review-fixes.mjs`, `tests/agent-reliability.mjs`, `tests/fixtures/agent-screens/grok-trust-narrow.txt` and its fixture README. Exactly one existing assertion changes: reliability's five-second-stall scenario now requires `stuck`, rather than `stalled`, when a newer permission request is pending. It continues to guard first-fault selection and additionally enforces the approval-priority rule explicitly required by brief 5; separate stall tests remain intact. All other existing assertions are unchanged. Suggested message: “Test: require pending permissions to outrank older stalls; cover edit approvals, answer questions and narrow Grok trust”. The orchestrator owns the separate test-change check and commit.

Implementation/docs commit group: `lib/agent.js`, README and this report. Approval states take precedence over overdue faults; non-approval fault ordering is unchanged. Cached startup trust still invalidates on SessionStart, while send independently checks any visible dialog. No dependencies, live panes, rig runs, reviews or other models. Guards, the frozen test and the review gate are untouched.
