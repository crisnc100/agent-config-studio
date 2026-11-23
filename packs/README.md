# Packs

A pack is a small, ready-made set of agent skills (and, for some, the scripts and settings they need) that
Agent Config Studio can install for you. Each pack explains itself in plain words before anything is installed:
what it is, what it does day to day, every file and setting it will change, and how to undo it.

| Pack | What it gives you |
|---|---|
| `review-gate` | the code-review skill and its shared review script; optional agent guard, push gate and Codex log access |
| `build` | the /build loop (needs `review-gate` for its Grade and close) |
| `advisor` | an outside verdict on scope and direction from your advisor role |
| `second-opinion` | other models' views on an answer, side by side |
| `handoff` | a resume-here file for the next agent session |
| `flag` | redacted field reports when the agent workflow goes wrong, and a review that proposes rule fixes from them |
| `pr` | PR descriptions in your own style, from the branch's real facts, checked before the PR opens |
| `worktree` | zsh commands for a parked trunk checkout plus one worktree per goal |
| `cursor` | a session-start hook that reads your live working agreement and adds the Cursor note; a local count of completed turns for the Usage page |

No pack names a model, and none ships one: you choose which model does each job when you install.
`acs packs install <pack>` asks for every role the pack uses that is not set yet, offering only the
families whose CLI is installed here, none put forward (`--set-role <role>=<family>[,<family>…]` answers
ahead of time; Enter leaves a role unset). With `--yes` and no `--set-role`, the pack installs and the roles stay
unset: the output and `acs packs status` name each one and the command that sets it, and a skill that needs
one stops with that line until it is set. Skills read the families from your ACS roles
(`model-id --role <role>`, `model-id <family>`), and the CLI that runs a model follows its id: `claude-…` →
claude, `gpt-…` → codex, `grok-…` → grok, `gemini-…` → agy (Antigravity).

What the packs and the review gate can't do yet, and how likely each limit is to matter: [KNOWN-LIMITS.md](KNOWN-LIMITS.md).

## Layout

```
packs/<id>/pack.json                         the manifest (below)
packs/<id>/skills/claude/<skill>/...         the Claude Code skill (Grok reads ~/.claude/skills too)
packs/<id>/skills/codex/<skill>/...          the Codex skill
packs/flag/skills/*/flag/flag.mjs            the /flag helper, shipped in its skill folder (no shared runtime)
packs/pr/skills/*/pr/pr-facts.mjs            the /pr fact helper, with style.example.json beside it
packs/review-gate/runtime/                   review.mjs, calibration.md, the example config, hooks/
packs/review-gate/instructions/              the marked instruction block
packs/review-gate/tests/                     the review gate's tests (never shipped)
```

Where each file lands:

| Source | Destination |
|---|---|
| `packs/<id>/skills/claude/<skill>/…` | `~/.claude/skills/<skill>/…` |
| `packs/<id>/skills/codex/<skill>/…` | `$CODEX_HOME/skills/<skill>/…` (default `~/.codex`) |
| `packs/review-gate/runtime/…` | `~/.agent-config-studio/review-gate/…`, once, whichever harnesses use it |
| `packs/review-gate/instructions/review-gate.md` | a marked block in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` |
| `packs/cursor/session/…` | `~/.agent-config-studio/cursor/hooks/…`, with a `sessionStart` entry in `~/.cursor/hooks.json` |
| `packs/cursor/turns/…` | `~/.agent-config-studio/cursor/hooks/turns/…`, with `stop` and `sessionEnd` entries in `~/.cursor/hooks.json` |

The Cursor hook is a small launcher that Cursor runs at the start of each session. It runs `session-context.mjs` on the node that installed it (`node-path`; `node` on PATH when that is gone), which
prints your live `~/.claude/CLAUDE.md` followed by `cursor-note.md` as the session's `additional_context`. If node or
either file is unusable it prints `{}` and the session starts without them. Install adds one `{ "command": … }` entry
to `hooks.sessionStart` in `~/.cursor/hooks.json` (creating the file when absent, keeping every other entry, and
refusing a file that is not valid JSON of the expected shape). `acs packs update cursor` refreshes the files;
`--replace` also puts back a deleted hook entry and the launcher's execute bit. Uninstall removes only an entry
that holds nothing but that command.

The turn-count part counts finished agent turns for the Usage page. Cursor runs its launcher when a turn stops and
when a session ends, and the launcher runs `turn-count.mjs` the same way (`node-path`, then `node` on PATH). The script
appends one line to `~/.agent-config-studio/cursor/turns.jsonl`: `{ts, event, conversation_id, generation_id, model,
status}`, with the model taken from `model_id` when Cursor sends it and from `model` otherwise. Nothing else is
written: no prompts, replies, email or paths. `ts` is the time of the write and `event` is Cursor's `hook_event_name`;
`status` is Cursor's `status` on `stop` and its `final_status`, else `reason`, on `sessionEnd`. Only `stop` and
`sessionEnd` are logged, and one missing a conversation id, generation id, model or status is skipped. A write that takes the file
past 1 MB also drops lines older than 30 days. The script always prints `{}` and exits 0, and any failure is
silent, so counting never slows or stops Cursor. Install adds one `{ "command": … }` entry to each of `hooks.stop` and
`hooks.sessionEnd`, and update, status, `--replace` and uninstall treat them like the `sessionStart` entry
(uninstall also leaves `turns.jsonl` in place). The Usage page reads the file: a `stop` with status `completed` counts
once per conversation and generation, and a `sessionEnd` that completed counts only for a conversation with no `stop`
line (`cursor-agent -p` sends only `sessionEnd`). Aborted and errored turns are not counted.

The agent guard part also installs into Cursor, which runs a hook before each shell command. Cursor counts as here
when `~/.cursor` exists or `cursor-agent` is on PATH. Install adds one entry,
`{ "command": "<launcher> --cursor", "failClosed": true }`, to `hooks.beforeShellExecution` in `~/.cursor/hooks.json`
(keeping every other entry, and refusing a file that is not valid JSON of the expected shape). The guard applies the
same rules it applies to Claude Code and Codex. For a command the guard allows, it writes `{}` to stdout to express no
opinion, so Cursor's own approval still applies. For a blocked command, it writes a deny with the reason. Input the guard
cannot read, and a node that cannot start, are denied. `acs packs status`
reports the Cursor entry as active or missing (an entry without `--cursor` counts as missing); `acs packs update
review-gate --replace` rewrites it in place; uninstall removes only the entry the guard wrote.

The review gate's shared state lives under `~/.agent-config-studio/`:

- `review-gate/config.json` — your review settings for every project (copy `review-config.example.json`). The
  older `~/.claude/review-config.json` is read when it is absent; a repo's `.claude/review-config.json` wins over both,
  except for `security`, `merge` and `crossFamily`: for those the home file is a floor that a repo file git
  tracks, or `REVIEW_CONFIG`, may only tighten (each key's note in the example config gives its exact rule).
  `review.mjs --show-config` prints the settings in force, merge and crossFamily among them.
  `codexHomes` there lists extra Codex homes for the agent guard.
- `review-log/review-log.jsonl` — the review log. Until that folder exists, an existing `~/.claude/review-log/`
  folder or older `~/.claude/review-log.jsonl` file keeps being used (`logPath()` in review.mjs).
- `review-gate/hooks/node-path` — optional: one line, the absolute path of the node the hooks run on. The hooks
  fall back to `node` on PATH when it is missing or not executable.

## pack.json

| Field | Meaning |
|---|---|
| `id` | the folder name |
| `title` | a short display name |
| `version` | the pack's version (`1.0.0`); an update compares it with what is installed |
| `summary` | one plain sentence |
| `explain` | `{ what, does, changes, undo }`: three plain paragraphs and `changes`, a list naming every file and setting the pack touches |
| `requires` | `{ node, git, modelId, askModel, clis, packs }`: a node version range; whether git, `model-id` and `ask-model` are needed (`acs install-model-id` puts both on your PATH); `clis: { anyOf: [...] }`, at least one of these harness CLIs (empty: none needed); other packs this one needs |
| `parts` | the pieces you can turn on separately |

Each part is `{ id, title, default, kind, harnesses, files, explain }`:

- `default` — on when you pick the pack. Skills are on by default, and so are the Cursor pack's session hook and turn
  count, which edit `~/.cursor/hooks.json`. Anything else that changes machine-wide state (the agent guard, the push gate, Codex
  log access) or your global instruction files is off until you turn it on.
- `kind` — `skill | instructions | guard | push-gate | codex-log-access | worktree | cursor-session | cursor-turns`; it decides how ACS installs,
  checks and removes the part. Manifests never contain commands. A `codex-log-access` part also names
  `writableRoot`, the folder under `~/` it adds to `writable_roots` in each Codex home's config.toml (review-gate's
  review log, flag's field reports).
- `harnesses` — the harnesses the part installs into (`claude`, `codex`, `cursor`); empty when it does not depend on one.
- `files` — the source files, as paths from the root of the ACS package. The worktree part points at
  `bin/install-worktree.mjs` and `tools/worktree/`, which ACS already ships, rather than copying them.
- `explain` — inherits the pack's `explain` and overrides only the fields that differ. Its `changes` is always its
  own and never empty.

## How ACS uses them

ACS reads the manifests to list the packs and show each `summary` and `explain` before anything is installed, with a
preview of every path and setting the chosen parts will change. It checks `requires` and names a fix for each missing
piece; it installs only the parts you pick, for the harnesses you have; and it records what it wrote, so an update
replaces only files you have not edited and an uninstall puts back what was there before. `acs packs list | explain
<id> | install <id> | status | update | uninstall <id>` does this from the terminal (`acs packs help`); the Packs card
in the studio comes in a later step. This folder is the content they install.
