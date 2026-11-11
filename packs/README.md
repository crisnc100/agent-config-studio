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

No pack names a model, and none ships one: you choose which model does each job when you install.
`acs packs install <pack>` asks for every role the pack uses that is not set yet, offering only the
families whose CLI is installed here, none put forward (`--set-role <role>=<family>[,<family>…]` answers
ahead of time; Enter leaves a role unset). With `--yes` and no `--set-role`, the pack installs and the roles stay
unset: the output and `acs packs status` name each one and the command that sets it, and a skill that needs
one stops with that line until it is set. Skills read the families from your ACS roles
(`model-id --role <role>`, `model-id <family>`), and the CLI that runs a model follows its id: `claude-…` →
claude, `gpt-…` → codex, `grok-…` → grok.

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

The review gate's shared state lives under `~/.agent-config-studio/`:

- `review-gate/config.json` — your review settings for every project (copy `review-config.example.json`). The
  older `~/.claude/review-config.json` is read when it is absent; a repo's `.claude/review-config.json` wins over both,
  except for `fixCheck`, `security`, `merge` and `crossFamily`: for those the home file is a floor that a repo file git
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

- `default` — on when you pick the pack. Skills are on by default; anything that changes machine-wide state (the
  agent guard, the push gate, Codex log access) or your global instruction files is off until you turn it on.
- `kind` — `skill | instructions | guard | push-gate | codex-log-access | worktree`; it decides how ACS installs,
  checks and removes the part. Manifests never contain commands. A `codex-log-access` part also names
  `writableRoot`, the folder under `~/` it adds to `writable_roots` in each Codex home's config.toml (review-gate's
  review log, flag's field reports).
- `harnesses` — the harnesses the part installs into (`claude`, `codex`); empty when it does not depend on one.
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
