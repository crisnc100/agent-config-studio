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
