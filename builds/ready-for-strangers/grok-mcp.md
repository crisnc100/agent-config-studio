# Grok and MCP — probe record (build 3, B1)

**Question:** does grok 1.0.x have a per-invocation mechanism that keeps MCP servers out of an Assist run, without losing sign-in?

**Answer: no.** Every candidate either leaves grok-native MCP servers starting, or signs grok out. So the pre-spawn refusal (Cris's decision, 2026-10-06) is the containment. The init check stays as defence in depth.

## Setup

- Binary: `~/.grok/bin/grok` → `grok-1.0.41-macos-aarch64` (`grok 1.0.41 (4220f3b224a6) [stable]`). The `grok` on PATH is a cmux shim, so it was not used.
- Every run happened in a throwaway cwd under `$TMPDIR/grokprobe`. The prompt was harmless (`Reply with the single word ok. Do not use any tools.`), except in probe 6, which asked for a fake MCP tool.
- Base argv: the production containment from `lib/harness.js:62`:
  `--output-format streaming-messages-json -m grok-4.6 --prompt-file p.txt --tools read_file --disallowed-tools search_tool,use_tool`, plus each probe's variant.
- Evidence came from:
  - the stream's `system/init` event (`tools`, `mcp_servers`);
  - grok's own log `~/.grok/logs/unified.jsonl`, the `session.mcp_init` line, whose `server_count` is the number of MCP servers the session started;
  - `~/.grok/logs/mcp/*.stderr.log` mtimes.
  All of these were read only.
- No command wrote to the grok config. Nothing ran `grok mcp add/remove/enable/disable`, `--trust`, or `grok login`. Cris's `~/.grok/config.toml` has one native server (`jev`). `~/.claude.json` adds `Neon`, and `~/.cursor/mcp.json` adds `postgres`.

## What grok discovers (read-only)

| Command | Result |
|---|---|
| `grok mcp list --json` | Only `jev` (scope user). Compat sources are **not** listed, so this is not a complete detector. |
| `grok inspect --json` (44 ms) | `mcpServers`: `Neon` (claudeJson), `jev` (configToml), `postgres` (cursor mcp.json). `plugins[].provides.mcpServers`: vercel=1, vercel-plugin=1. This is grok's own merged view, cwd-aware: it adds a project `.mcp.json` when one exists. |
| `GROK_CLAUDE_MCPS_ENABLED=0 GROK_CURSOR_MCPS_ENABLED=0 grok inspect --json` | `Neon` and `postgres` are reported with `compatibilityStatus: "disabled"`. `jev` stays active, and the plugins are unchanged. |

## Probes

| # | Variant | init `tools` | init `mcp_servers` | `session.mcp_init server_count` | Verdict |
|---|---|---|---|---|---|
| 1 | production containment, ×8 | `["read_file"]` ×8 | `Neon, jev, postgres` all `pending` ×8 | 3 | MCP servers **start** under the shipped flags. `--tools`/`--disallowed-tools` only shape the model's toolset. `~/.grok/logs/mcp/jev.stderr.log` and `postgres.stderr.log` were touched at the probe time. The 134-tool flake did not reproduce in 8 runs, nor in the 145 `tool_prep_done` log lines since 2026-09-25 (all `tool_count: 1`). |
| 2 | `--deny 'MCPTool'` | `["read_file"]` | `Neon, jev, postgres` | 3 | A permission rule gates **calls**. The docs say so (`14-headless-mode.md`: "permission rules leave tools available but gate their execution"). Servers still start. Does not keep MCP out. |
| 3 | `--deny 'mcp__*'` | `["read_file"]` | `Neon, jev, postgres` | 3 | Same as probe 2. |
| 4 | `GROK_CLAUDE_MCPS_ENABLED=0 GROK_CURSOR_MCPS_ENABLED=0` | `["read_file"]` | `jev` | **1** | A real mechanism, but only for the compat sources (`~/.claude.json`, Cursor). Grok-native `config.toml` servers still start. |
| 5 | `GROK_HOME=<empty temp>` (+ probe 4's env) | `[]` | `[]` | n/a | **Signs grok out**: exit 1, `Not signed in. To authenticate without a browser, run: grok login --device-code`. Keeping auth would mean copying or linking `auth.json`. ACS does not handle credentials, so this was rejected. The init it emits (`tools: []`, `model: "unknown"`) must be refused, and the shared rule refuses it. |
| 6 | Production containment, cwd with a project `.mcp.json` pointing at a fake stdio server that logs its own start | `["read_file"]` | `…, probe` `pending` | 3 | The fake server **never started**: grok skips repo-local servers in an untrusted folder. The model then spent 55 `read_file` calls looking for the tool (stopped by hand). Trusting the folder (`--trust`) writes `~/.grok/trusted_folders.toml`, so it was not probed. |

Ruled out from the docs and `--help`, without a run:
- There is no `--strict-mcp-config`, `--no-mcp` or `--mcp-config` flag (`grok --help`, 1.0.41).
- The `GROK_CONFIG` / `GROK_CONFIG_PATH` overlay is confined to an allowlist (`models`, `features`, a narrowed `toolset`, `shell_environment_policy`). Per `05-configuration.md`: "every other table is dropped … cannot … add a discovery source". It cannot set `mcp_servers`, `disabled_mcp_servers` or `allowed_mcp_servers`.
- `allowed_mcp_servers = []` / `allowManagedMcpServersOnly` would block every server, but only from `requirements.toml` / `managed_config.toml` under `$GROK_HOME` or `/etc/grok`. Both are persistent, machine-wide policy files, not a per-invocation switch.
- `--sandbox read-only|strict` restricts filesystem and network for tools. It does not stop MCP servers from loading (`18-sandbox.md`).

## Conclusion and design it decides

1. **No mechanism (b).** Per Cris's decision, Grok Assist is **refused before spawn** whenever grok would load any MCP server.
2. **Detector: `grok inspect --json`, run in the Assist cwd with the same env the Assist spawn gets.** It is grok's own merged discovery, and it is fast. Refuse when either:
   - an `mcpServers` entry is not `compatibilityStatus: "disabled"` and not `enabled: false`; or
   - an enabled plugin has `provides.mcpServers > 0`.
   Also refuse (fail closed) when inspect exits non-zero, times out, or returns unparseable or unexpectedly shaped JSON.
3. **Also set `GROK_CLAUDE_MCPS_ENABLED=0` and `GROK_CURSOR_MCPS_ENABLED=0` on the Assist spawn and on the inspect run** (probe 4). Most people with Claude Code have servers in `~/.claude.json`. Without these vars, Grok Assist would refuse for nearly everyone. With them, it refuses only for grok's own servers and plugin servers.
4. **The init check is defence in depth, never the containment claim.**
   - It fails the turn and kills the process group when `tools` is not exactly `["read_file"]`, when `mcp_servers` is non-empty, when `toolCount` contradicts the list, or when the init is missing, malformed, repeated, or arrives after output.
   - It cannot stop what grok did before printing init. That is why it does not count as the containment.
5. **Residual, stated:** a config change in the milliseconds between inspect and spawn is caught only by the init check.
