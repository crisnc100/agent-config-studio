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

Shipped: **claude**, **grok**. Codex is not wired yet. A descriptor may
declare a buffered decode, but `runContained` refuses to run one: the init
check needs the CLI's init event, so a Codex adapter needs an init-bearing
stream.

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

**Tool-less turns (Models → Describe your models).** `runContained` with
`opts.toolless` uses the descriptor's `toolless.containment` instead:
claude `--tools "" --strict-mcp-config` (probed: init `tools=[]`,
`mcp_servers=[]`), and the init gate then requires both lists present and
empty — a missing `mcp_servers` is refused.
Grok has no tool-less mode, so Describe runs on claude only and composeArgv
refuses `toolless` for grok. Describe also passes `maxOutputBytes` (a raw
stream backstop) and `maxTextBytes` (the reply itself, 64 KB).

`--strict-mcp-config` and grok's `--disallowed-tools search_tool,use_tool` strip
MCP meta-tools that survive `--tools`. They are companions, not the write
allowlist. Do not replace `--tools` with any of the leaky flags above.

One chokepoint (`spawnContained`) is the only spawn site for a harness turn.
Chat and the one-shot Assist both reach it through `runContained`
(`lib/harness.js`). Two more layers sit around it:

- **Before the spawn: the preflight.** grok starts every configured MCP server
  on every run, and no flag or env keeps them out
  (`builds/ready-for-strangers/grok-mcp.md` has the probes).
  - So before each grok run, `inspectGrok` runs `grok inspect --json` in the
    turn's cwd, with the turn's env. The turn is refused when that would load
    any MCP server or plugin server, and also when the answer cannot be read.
  - Every grok Assist spawn gets `GROK_CLAUDE_MCPS_ENABLED=0` and
    `GROK_CURSOR_MCPS_ENABLED=0`, so servers configured for Claude Code or
    Cursor do not count.
  - `spawnContained` refuses without a clearance from `clearForSpawn` /
    `clearNow` for that exact descriptor, binary and cwd.
- **After the spawn: the init gate** (`lib/containment.js`, shared with
  `tests/phase1.mjs`).
  - Every stream event passes through it. A run must report exactly one init,
    before any output, with `tools` equal to the one read tool, no MCP
    servers, and a `toolCount` (if any) that agrees.
  - Anything else refuses the turn. So does no init within 30 s.
  - A refused turn kills the child's process group (it is spawned detached)
    and returns no text, no session id and no proposals. The server parses
    edits only from a turn that succeeded.
  - This is defence in depth, not the containment: it cannot undo what a CLI
    did before it printed init.

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

## Usage tracking

Five spawn sites exist in this repo and `tests/guards.mjs` pins every one:

| Site | May spawn | Pinned to |
|---|---|---|
| `lib/harness.js` `spawnContained` | claude, grok | containment allowlist and a pre-spawn clearance, or it refuses |
| `lib/harness.js` `inspectGrok` | the detected `grok` | argv `['inspect', '--json']` — discovery only, no session |
| `lib/usage/refresh.js` | `process.execPath` | argv `[CLI, '--json']` |
| `lib/usage/connect.js` | the detected `codex` | argv `['login']` / `['login','status']` |
| `lib/usage/grok-billing.js` | the detected `grok` | argv `['agent','stdio']` |

The last two spawn a harness binary, which guard `b` otherwise bans. They are
allowed because neither can run a model turn — but note **pinning argv is not
enough on its own**, and a review found exactly that gap:

- `grok agent stdio` opens a JSON-RPC endpoint. With identical argv, sending
  `session/new` plus a prompt is an uncontained turn. **Guard `e`** pins the
  methods that module may send to `initialize` and `_x.ai/billing`, and rejects
  a method built from a variable.
- `refresh.js` spawns `process.execPath`, so the containment is entirely in
  *which script* it runs. Guard `e` pins `CLI` to a literal
  `path.join(HERE, '..', '..', 'bin', 'usage.mjs')`.
- `bin/` is scanned by the spawn guards. It was not, and it is shipped code the
  studio executes.

Prove the guards still bite before trusting them — each of these must fail
`node tests/guards.mjs`: swapping `_x.ai/billing` for `session/new`; making the
method a variable; pointing `CLI` at another path; adding `'-p'` to the login
argv; adding a harness spawn to `bin/`.

**The studio process must never read a credential.** Codex is credential-free
and refreshed live; Claude and Grok are taken by the CLI child process, which
writes `~/.agent-config-studio/usage-snapshot.json`. If you find yourself adding
a credential read to `server.js` or a `lib/usage` module the server imports
directly, that is the line being crossed.

**Live readings drift.** Codex reports quota only on a turn, so an idle seat's
number is legitimately hours old — the panel says how old. Claude's endpoint is
undocumented and can change shape without notice; a 200 carrying no recognisable
`limits[]` is reported as broken rather than as an empty gauge.

## Codex seats and account attribution

Codex records **no account identity** in its rollout logs, so a home whose
credentials change cannot be told apart from one that did not. Three rules
follow, and each exists because it was measured failing:

- **A reading written before the current login is ignored.** After re-authing a
  seat, the previous account's rollouts are still on disk and would be reported
  as the new account's quota.
- **A session that STARTED before the current login is excluded entirely.** An
  interactive session holds the credentials it began with, so one left open
  across a re-auth keeps writing the old account's quota with timestamps newer
  than the login. Filtering events by time does not catch this; the session has
  to go. Symptom: the seat "resets back" to the old account on every refresh.
- **Two seats on one account are detected and the staler one is demoted**
  (`lib/usage/identity.js`, fingerprints only — see the spawn table above).
  Undetected, the staler reading wins the routing line and sends work to a pool
  that is already exhausted.

**Quota ages out.** Codex writes quota only when a turn runs, so an idle seat
reports the last turn's numbers. A window whose `resets_at` has passed, or whose
reading is older than the window itself, is dropped — reporting a percentage for
a window that no longer exists is how the panel claimed 100% of a 5h limit that
had reset hours earlier and was actually 8%. Beyond `STALE_AFTER_MS` (1h) a
reading is shown but never ranked: window anchors move, so a weekly reading can
belong to a replaced window while its stored `resets_at` is still in the future.
Refresh cannot fix this — only running a turn on that seat records new quota.

## Releasing

Releases go to npm through trusted publishing (`.github/workflows/publish.yml`), so no npm token exists anywhere.

1. Bump `version` in `package.json` in a PR, and merge it.
2. Tag the merged commit and push the tag: `git tag v1.2.3 origin/main && git push origin v1.2.3`.
3. The Publish workflow checks that the tag matches `package.json` and that the commit is on main. It then packs the tarball, runs `tests/package.mjs` against it, and stages that same tarball with `npm stage publish`.
4. Approve the staged release on npmjs.com, or with `npm stage list` then `npm stage approve <id>`, confirming with 2FA. Nothing is public until you approve it.

npm's trusted-publisher settings must name this repository and the workflow file `publish.yml` exactly. Allow `npm stage publish` only, so every release goes through approval. A prerelease version (`1.2.0-beta.1`) is staged under the `next` dist-tag, never `latest`. A version lower than the newest stable release is refused by npm unless it gets its own tag, which this workflow does not do.

## Roles and flavor (`model-id --role`, `--flavor`)

Roles and flavor live in `lib/roles.default.json` and
`~/.agent-config-studio/roles.json`, read by `lib/roles.js`. That is a file
pair apart from `models.json` on purpose: a resolver installed before roles
never reads it, so new data cannot break it.

- `model-id --role <name>` → `family=… id=… effort=… alt=…` (`--json` for the
  whole entry with per-field provenance). `--flavor <family>` → plain text.
  `--roles` lists every role; `--table` stays byte-identical (families only).
- The role flags exit **2** on any failure (unknown role or family, invalid
  `roles.json`, a malformed id anywhere in the role's `use` list or alt).
  `--role` still prints `MODEL-ID-UNRESOLVED-<name>` for every value. Family
  calls keep exit 1, byte for byte (`tests/roles.mjs` compares against the
  pre-roles resolver in `tests/fixtures/pre-roles-resolver/`).
- `bin/model-id.mjs` imports `lib/roles.js` only when a role flag asks. An
  installed copy that lacks it (or `lib/roles.default.json`) still resolves
  families and answers role flags with "run: acs install-model-id". A
  `roles.json` whose `version` is newer than the resolver knows says the same.
  A copy installed before this change has no role flags at all: it answers
  `--role` with its old usage error, exit 1, and `acs` names it as older than
  the package on start.
- Writes go through `lib/roles-panel.js` `writeRoles` only. The
  compare-and-rename runs one at a time in this process (direct edits and
  Accept share the queue); history's baseline and record run outside it, so a
  hung git call (killed by `lib/history.js` after 30 s, returned as a warning)
  never holds later saves. The fixed path, no
  symlink at the file or its folder, an exclusively created temp file. The
  studio folder is pinned by dev/ino; right before the rename, synchronously
  with no await in between, the folder must still be that one, the file not a
  link, and its bytes still the sha256 base (409 otherwise). Node has no
  renameat, so the residual is the syscall gap between the last lstat and
  rename(2). History failures are returned as `warnings`.
- Describe (`lib/describe.js`): one run server-wide (409 for a second; any
  setup failure frees the slot), Cancel kills the process group, 4000
  characters in, a 64 KB reply cap by any output path (deltas, a result
  event, an event still arriving, or a last line with no newline;
  `runContained` `maxTextBytes`, killed the moment it is passed), 120 s, proposals kept 10
  minutes under a random id; Accept writes exactly the stored bytes.


## Model guide block (`lib/model-guide.js`)

- The block is rendered by `guideText` in `lib/roles.js` (pure, id-free, 8 KB
  cap; it refuses rather than escapes text holding `<!--`, `-->` or
  `acs:model-guide`, and refuses while the roles are invalid).
  `model-id --roles` is unchanged.
- Targets are the three keys `claude`, `codex`, `grok`, resolved server-side
  from the harness homes in `lib/paths.js`; a request never names a path.
  Reads go through `openUserFile` (1 MB cap, hard links refused); a file that
  is not UTF-8 is never edited. Bytes outside the block are copied from the
  file's buffer. `sep=` in the start marker records the newlines ACS added, so
  remove gives back the original bytes, also after a restart.
- Any line containing `acs:model-guide` is a marker and must match the grammar
  exactly; otherwise the file is `malformed` and every action is refused with
  the line numbers. install: absent; update: stale or edited; remove: current,
  stale, edited, or an intact block while the roles are invalid.
- Accept: the proposal (random id, 10 minutes, at most 3 live per target) holds
  the real path, (dev, ino) and the raw-bytes sha256. Per real path, one at a
  time: re-resolve, `recordBaseline` (skipped for a new file), then
  synchronously re-resolve, re-read and compare identity and bytes, and write
  through a descriptor opened with O_NOFOLLOW and checked by fstat (or `wx`
  for a new file) — no await between the compare and the write. History
  records the real path, the one the registry and snapshots use; its failures
  come back as `warnings`.
- Tests: `tests/model-guide.mjs` (in-process), `tests/model-guide-routes.mjs`
  (server, temp HOME), `tests/model-guide-ui.mjs` (VM).

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

- Grok has no session flag to skip loading MCP servers, so Grok Assist is
  refused before the spawn whenever `grok inspect` reports one. A server added
  in the milliseconds between that check and the spawn is caught only by the
  init gate, after grok has started it.
- The uncontained-probe guard in the live suite checks cwd. It cannot stop a
  write to an absolute path outside the fixture. Only an OS-level sandbox
  would, and that is not available here.
- No Codex adapter yet. The contract is ready (`streams: false`, buffered
  `decode.parse`, resume as `{kind:'subcommand', argv}`).
