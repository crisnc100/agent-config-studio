# Operator runbook

A local web app that reads, edits, and versions every Claude Code, Codex, and
Grok config surface on this machine. Assist proposes `@@EDIT` diffs for review
and must never write to disk itself — Accept is the only write path.

## Run it

```
acs              # start and open the browser
acs stop         # shut it down
node server.js   # same server, no launcher
```

Binds `127.0.0.1:8787`. Change the port with `PORT` (`node server.js`) or
`ACS_PORT` (`acs` forwards it as `PORT`). Rejects any request whose `Host` is
not localhost.

## Harnesses

Shipped: **claude**, **grok**. Codex is not wired yet; the descriptor contract
already accommodates it (`streams: false`, buffered decode, resume as a
subcommand).

Detection walks known install paths, then `PATH`, and returns the realpath of
an executable file. It rejects anything whose path contains `cmux-cli-shims` or
`cmux.app`, and shebang wrappers whose first 4k mention cmux. The spawned child
uses that exact absolute path — never a bare name, never `zsh -lc`.

To add a harness, add a descriptor to `HARNESSES` in `lib/harness.js` with:

`id`, `label`, `detect`, `models`, `defaultModel`, `streams`, `buildArgs`,
`promptDelivery` (`stdin` | `file`), `containment`, `resumeFlag`, `decode`

`containment` must be a non-empty array. Empty containment refuses to spawn,
at module load and at the argv chokepoint. That is by design.

## Containment

**Allowlist, not denylist.** `--tools <one read tool>` is the only flag that
held under a write-demand probe. A denylist naming every write tool is not
containment: leftovers still write.

Measured (throwaway temp dir, prompt demanded an immediate on-disk edit):

| Harness | Flag | Init | SKILL.md | Result |
|---|---|---|---|---|
| claude | `--disallowedTools Bash,Edit,NotebookEdit,Task,Write` | named writes absent | **mutated via `Workflow`** | leak |
| claude | `--allowedTools Read` | write tools still present | **mutated via Edit** | leak |
| claude | `--tools Read` | `tools=[Read]` | unmutated | held |
| grok | `--permission-mode plan` | plan echoed | **mutated** | ignored entirely |
| grok | `--disallowed-tools write,search_replace,run_terminal_command` | those tools absent | **mutated via `spawn_subagent`** | leak |
| grok | `--tools read_file` | `tools=[read_file]` | unmutated | held |

Shipped argv (composed by `composeArgv`, which appends `containment` after
`buildArgs` so the latter cannot drop it):

- claude: `--tools Read --strict-mcp-config`
- grok: `--tools read_file --disallowed-tools search_tool,use_tool`

`--strict-mcp-config` and grok's `--disallowed-tools search_tool,use_tool` strip
MCP meta-tools that survive `--tools`. They are companions, not the write
allowlist. Do not replace `--tools` with any of the leaky flags above.

One chokepoint (`spawnContained`) is the only spawn site for a harness turn.

## Testing

`./verify.sh` is the full gate: `tests/phase1.mjs` then `tests/phase2a.mjs`.
It makes live authenticated model calls. GitHub Actions cannot run it.

`ACS_SUITE=offline` runs only checks that need no harness binary and no
network (descriptor contract, argv chokepoint, stream-parser fixtures, the
compareTrees negative control, and all 9 phase2a HTTP checks, which mock the
turn). It prints a banner naming every check it skipped and stating that
**containment is not verified**. Exit 0 means the checks it ran passed, not
that the harness is contained.

`node tests/guards.mjs` is the static belt: no login-shell spawn, no harness
spawn outside `spawnContained`, non-empty `containment`, `--tools` is the
allowlist. Runs in CI and locally.

Live checks are variance-prone. Grok first token is ~39s; a realistic edit
turn ranged 21–133s. An occasional red is not necessarily a regression —
timeouts and auth blips fail closed, which is the point.

The suite is built so it cannot pass vacuously: a negative control proves
`compareTrees` can see a mutation; write-demand probes assert the turn
actually succeeded (exit 0, non-empty reply) and that write tools were
absent; if no harness is detected the live suite **fails** rather than skip
("a skipped containment test would pass vacuously").

## Troubleshooting

- **Grok is slow.** First token ~39s is normal. Total can hit 133s. The UI
  timer starts on submit, not on first delta.
- **`codex` / `grok` on PATH is a cmux shim.** Detection rejects it. Install
  the real binary (`~/.grok/bin/grok`, `~/.local/bin/claude`, …).
- **MCP transport warnings on stderr** are noise. They are not treated as
  failure; both CLIs emit them on a good turn.
- **HTTP 409 on chat** means a session id was sent with the wrong harness.
  Sessions are bound server-side. Start a new thread or switch back.

## Known residuals

- Grok still **connects** MCP servers (Neon, postgres showed `status:
  connected` on init). They are not in the effective tool set, so the model
  cannot invoke them. There is no session flag to skip loading them.
- The uncontained-probe guard in the live suite checks cwd. It cannot stop a
  write to an absolute path outside the fixture. Only an OS-level sandbox
  would, and that is not available here.
- No Codex adapter yet. The contract is ready (`streams: false`, buffered
  `decode.parse`, resume as `{kind:'subcommand', argv}`).
