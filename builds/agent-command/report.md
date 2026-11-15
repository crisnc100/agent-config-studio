# Agent command — builder report

Status: blocked, not ready for PR review. No live worker panes were opened, no reviews or other models were run, and nothing was pushed.

## Commits

Base / current HEAD: `d01632121bf4f98e23eb8d7610656aabf6abbfe5`.

No implementation commits were possible. The phase-one `git add` and `git commit` both failed because this sandbox cannot create the worktree's `index.lock`: the shared Git directory is outside its writable roots. All implementation changes remain in the worktree, on `agent-command`.

## Implemented

- `bin/agent.mjs`: open, wait, send, answer, close, list, JSON output and exit codes.
- `lib/agent.js`: private atomic worker records and launcher/prompt files, model registry resolution, harness launch flags, shared worker tabs, Grok startup focus, session discovery and pinning, transcript completion and submission checks, blocked-screen capture, exact answers, forced close and lazy idle cleanup.
- Four running/stuck workers across registry entries; additional `open` processes and follow-ups to finished workers poll for a slot under the shared launch lock. Finished workers retain their tabs. The queue exists in waiting CLI processes, not a daemon.
- `acs agent` dispatch, help, install/update reminders, and installation alongside the resolver and ask-model. Installed copies include their read-safety dependencies and do not import this checkout.
- README command documentation and test-suite registration.

## Validation

| Command | Result / coverage |
| --- | --- |
| `node tests/agent-cli.mjs` | Pass. All six commands against fake cmux; all three harness transcript layouts; 47 KB prompt file; executable launcher quoting and exact argv; tab reuse; Grok focus return; done/stuck/timeout; Enter retry verified by a new user turn; failed submission; exact answer bytes; screen fallback; owner filtering; forced/idempotent close; idle close via list and wait; running worker preservation; pinned same-cwd rollouts; partial JSONL; invalid inputs; idle notifications; ten retained workers; fifth open and a follow-up queue until a completion frees capacity. |
| `node tests/agent-install.mjs` | Pass. Temp-HOME install through acs; copied modules; PATH link; installed help and open/wait lifecycle; reinstall; refusal to replace an unrelated regular file. Fake cmux is copied outside the checkout for the installed lifecycle. |
| `node tests/setup-guards.mjs` | 44 pass, 1 fail: its unchanged guard-b control rejects the new cmux subprocess site. The file-read checks pass; all new production reads use `readUserText`. |
| `node tests/guards.mjs` | 9 pass, 1 fail: guard b rejects `spawnSync('cmux', ...)` in `lib/agent.js`. |
| `node tests/suite-coverage.mjs` | 33 pass, 0 fail. |
| `node tests/readme.mjs` | 53 pass, 0 fail. |
| `node tests/ui-words.mjs` | 556 pass, 35 fail in this sandbox, with fetch failures and subsequent missing-view assertions. An unchanged HEAD archive in a temporary folder also fails: 555 pass, 36 fail, including the same fetch/missing-view failures. An unrestricted run remains required. |
| `git diff --check` | Pass. |

## Blockers and unfinished scope

1. The existing subprocess guard has an explicit per-module allowlist and rejects even a literal cmux executable in a new module. No test or guard was weakened or bypassed. A question is pending about allowing a narrow cmux-only exception with negative controls. The frozen review test and review gate remain untouched.
2. Git metadata is read-only under this execution profile, so the three requested phase commits cannot be created here.
3. `plan.md` was edited externally during this run to add MCP-off by default (`--mcp` opt-in) and the four-worker queue. The queue is implemented and tested. **MCP-off and `--mcp` are not implemented.** Current launchers inherit the harness's configured MCP servers. Local Grok help has no no-MCP switch; its configuration guide says `GROK_CONFIG` is a restricted deep-merged overlay that cannot reach the MCP table. A safe per-session approach needs to be resolved before this requirement can be called complete. Do not treat the current CLI as meeting that new default.
4. Live acceptance (each harness, follow-ups, simultaneous workers) belongs to the orchestrator, per the brief. No live acceptance is claimed here.

## Choices where the plan was silent

- `--timeout` is seconds, default 600; zero performs one check.
- Worker ids are UUIDs. `--role` is metadata; the explicit family controls model resolution. Effort is passed only when supplied.
- Registry timestamps are epoch milliseconds. Prompt/registry files use mode 0600; launcher scripts use 0700. Temporary writes use exclusive creation and atomic rename.
- A closed worker's wait returns done with `closed: true` in JSON. Close is idempotent for a record already marked closed.
- A four-Enter submission failure exits 1; the message is not automatically typed again. This avoids duplicating an uncertain submission.
- Session discovery ignores pre-existing transcript paths and other workers' claimed files. Without a SessionStart hook, unresolved same-cwd peers prevent speculative claiming. Ambiguous ownership waits instead of consuming another worker's completion.
- JSONL parsing ignores malformed/partial records. Claude tool-result-only user entries do not count as follow-up submission. Exact duplicate hooks are deduplicated.
- The open lock has a 30-second acquisition deadline; a crashed opener can leave `.open-lock`, requiring inspection before removing it. There is no lock-recovery daemon.
- The installed CLI pins the Node executable used during installation. Reinstall after moving Node.

## Files retained from the orchestrator

The pre-existing plan, research and Python prototypes remain as build evidence. The externally changed plan was not reverted. No Python runtime or shipped Python command was added.
