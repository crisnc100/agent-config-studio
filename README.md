# Agent Config Studio

A local web app for reading, editing and versioning the config of the AI coding
CLIs on your machine — Claude Code, Codex and Grok — in one place, rendered
properly: instructions (`CLAUDE.md`, `AGENTS.md`), skills, MCP servers, hooks,
settings, the models they use, and your subscription headroom.

## Get started

### What you need

- **macOS.** On Linux the server and the browser UI work; the extras listed
  under [Linux](#linux) are best-effort.
- **Node.js 20 or newer** (`node --version`) and **git**. Nothing else is
  installed: there are no npm dependencies.
- **At least one of the CLIs**, installed and signed in:

  | CLI | Install | Sign in |
  |---|---|---|
  | Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
  | Codex | `npm install -g @openai/codex` | `codex login` |
  | Grok | `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` |

  The setup screen shows the same commands for whichever is missing, so you
  can also install them after starting.

### Steps

```sh
git clone https://github.com/crisnc100/agent-config-studio.git
cd agent-config-studio
./bin/acs
```

`./bin/acs` starts the studio at <http://localhost:8787> and opens it in your
browser. The first time, it opens on the **setup screen**:

1. **CLIs** — which of claude, codex and grok it found, their versions, and
   whether each is signed in. Installed one just now? **Recheck**.
2. **Accounts** — the subscriptions ("seats") to track in Usage, suggested
   from the CLIs it found. Optional.
3. **Project folders** — where your repos live. **Scan for projects** looks a
   few levels into `~/Documents`, `~/code`, `~/Projects` and similar, or type a
   path. Each folder is **read** (listed in Context, Skills and Worktrees) or
   **edit** (its instruction files are also editable here).
4. **Done** — optional next steps. **Finish** lands on **Home**.

Leave that terminal open: the studio runs in it. Press Ctrl-C there, or run
`acs stop` from another one, to stop it.

### Put `acs` on your PATH

```sh
./bin/acs install
```

This links `acs` into `~/.local/bin` (or another folder of yours that is
already on your PATH) and points it at this checkout. It never edits a shell
profile. If none of your folders is on PATH, it prints the one line to add
yourself. It refuses to replace an `acs` that is not a link to this checkout.

Open a new terminal (or run `hash -r` in this one). From then on, from any
folder:

```sh
acs
acs stop
acs help
```

`acs` starts the studio (or, if it is already running, just opens it). `acs
help` lists every command and names the checkout that answered. To take `acs`
off your PATH again, run `acs uninstall`; it removes only a link to this
checkout.

### Troubleshooting

- **Port 8787 is in use.** `acs` says so and starts nothing. Use another port:
  `ACS_PORT=8790 acs`.
- **A CLI shows "not installed" but you have it.** The studio looks where the
  installers put binaries, and on the PATH a new terminal gets. Install it, or
  open a new terminal, then press **Recheck** on the setup screen.
- **macOS asks whether your terminal may access Documents.** That is the folder
  scan reading `~/Documents`. Allow it to have folders there suggested, or
  decline and type the paths instead.
- **Run setup again:** **Run setup again** on Home, or open
  <http://localhost:8787/#setup>.
- **No browser** (a remote or headless machine): `ACS_NO_OPEN=1 acs`, or `acs
  --no-open`, then open the URL yourself.
- **Node is too old or missing.** `acs` stops and says which version it found.
- **Stop or uninstall:** `acs stop`, then `acs uninstall`. Delete the checkout
  and `~/.agent-config-studio` (the studio's history and settings) to remove
  everything. Your CLI config is never inside either.
- **`acs` runs an old copy.** A shell alias or an earlier `acs` on PATH wins
  over the link. `acs help` prints the checkout it came from. `acs install`
  refuses, and names the file, when an earlier `acs` on PATH is not this one.

### What the studio reads, writes and sends

There is no telemetry. These are all of its outbound calls:

- **`acs` fetches git origin** on start, to fast-forward a clean checkout on
  the default branch. It skips this on any other branch, with local changes,
  or with `ACS_NO_UPDATE=1`. `acs update` runs the fetch on its own.
- **Assist runs your CLI** (`claude` or `grok`), which talks to its vendor
  under your own sign-in.
- **The usage collector** reads credentials, in a separate child process, so
  the server never holds one. It runs when you press **Refresh** in Usage,
  once after you sign a seat in, or as `acs usage`. It reads the Claude Code credential from the macOS Keychain
  or `~/.claude/.credentials.json` and calls Anthropic's usage endpoint. It
  reads the Codex and Grok `auth.json` files for account identity, and asks
  `codex app-server` and `grok agent stdio` for their quota.
- **Check now** on the Models page runs `codex app-server` `model/list`, which
  fetches Codex's model catalog.

What it can change:

- **Your CLIs' own homes** (`~/.claude`, `~/.codex`, `~/.agents`, `~/.grok`,
  `~/.config/worktree`) are editable regardless of your folder choices.
- **Inside project folders**, only the instruction files (`CLAUDE.md`,
  `AGENTS.md`, `.mcp.json`, `.worktrees.conf`) in folders you marked **edit**.
- **Its own folder,** `~/.agent-config-studio` (settings, history, trash).

Nothing else is reachable through it. The file API never serves
`.credentials.json`, `auth.json` or `~/.claude.json`: only the `mcpServers` key
of `~/.claude.json` is extracted, read-only. It listens on `127.0.0.1` only.

### Linux

- **Works, and is CI-tested on Ubuntu:** the server, the browser UI, setup, the
  launcher (`acs`, `acs install`, `acs stop`) under sh, dash and zsh, and
  Assist.
- **Best-effort:**
  - The worktree toolkit (`acs install-worktree`) is zsh and was built on
    macOS.
  - "Which sessions are running", in Usage, needs `lsof` in `/usr/sbin` or
    `/usr/bin`.
  - Claude Code usage needs a `~/.claude/.credentials.json`, since there is no
    Keychain.
  - The codex memory count needs Node 22.5 or newer (`node:sqlite`).

## What it manages

| Group | Source |
|---|---|
| Memory | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.grok/AGENTS.md`, and every `CLAUDE.md` / `AGENTS.md` in your **edit** folders |
| Claude skills | `~/.claude/skills/*` (follows the symlink into `~/.agents`) |
| Codex skills | `~/.codex/skills/*` |
| Plugin skills | enabled plugins only, read from the plugin cache |
| Auto-memory | `~/.claude/projects/*/memory/*.md` — what the harness wrote itself, one bucket per project scope |
| MCP servers | `.mcp.json` in your edit folders (editable); global and Codex servers read-only under **MCP** |
| Subagents | `~/.claude/agents/*.md` — appears once the directory exists |
| Slash commands | `~/.claude/commands/*.md` — appears once the directory exists |
| Hooks | `~/.claude/hooks/*.sh` |
| Settings & config | `settings.json`, `settings.local.json`, `advisor-config.json`, `investigate-config.json`, `review-config.json`, `~/.codex/config.toml`, `~/.codex/rules/*` |
| Worktrees | `~/.config/worktree/defaults.conf`, `repos/*.conf`, and each `.worktrees.conf` in your edit folders |
| Retired | `~/.claude/skills_retired/*` |

**Context** and **Skills** also list your **read** folders, without editing
them. Change the folders any time under **Folders**, or with `acs roots ls`,
`acs roots add <path> [--edit]`, and `acs roots rm <id>`. A running studio
picks the change up by itself.

## The parts that matter

**Rendered, not raw.** Markdown files render with real typography — headings,
tables, code blocks. YAML frontmatter becomes a metadata card instead of the
giant bogus heading Markdown would otherwise make of it.

**Only what is loaded.** The plugin cache holds every skill of every plugin
merely installed. Only skills from plugins actually enabled in `settings.json`
are listed, because only those are ever loaded.

**Create and delete.** Hover a group in the sidebar for a `+` — it scaffolds a
new skill, hook, subagent or slash command with valid frontmatter already in
place (the scaffold passes the app's own validator). `+ file` on a skill adds a
reference doc. **Copy to Codex / Copy to Claude** seeds a skill in the other
harness from the open one, retargeting the frontmatter `name`; the two are
expected to diverge afterwards.

**Deleting is never destructive.** A delete records the current contents in
history, moves the item to `~/.agent-config-studio/trash/`, then commits the
removal. Two independent ways back: **Trash** restores in one click, or
`git show <sha>:<path>` in the history repo. Deleting a multi-file skill asks
whether you mean the whole skill or just the open file.

Two things are refused: plugin-cache skills (the plugin manager owns them and
would restore them on its next update), and anything outside the places listed
under [What it can change](#what-the-studio-reads-writes-and-sends). The
always-loaded singletons — global `CLAUDE.md`, global `AGENTS.md`, a folder's
workspace `CLAUDE.md` — plus `settings.json` and friends delete only after you
type their name.

**It watches for changes made outside the studio.** Claude Code writes
auto-memory, you install a skill from the terminal, an agent edits a CLAUDE.md —
the sidebar updates live rather than going stale until a reload. The green dot
in the status bar means the watch is connected.

If the file you have open changes on disk, it reloads in place; if you have
unsaved edits it warns instead, because the save would be refused anyway. If the
open file is deleted, it tells you rather than leaving a phantom editor.

Only the directories the registry cares about are watched. A recursive watch on
`~/.claude` would be a firehose — session transcripts, file-history and the
plugin cache are nearly all of it and churn constantly.

**Every save is a commit.** Writes go to the live file *and* to a shadow git repo
at `~/.agent-config-studio/history`, mirrored under `home/`. The History tab on
any file lists every version, diffs it against the current contents, and restores
it in one click. The shadow repo also re-snapshots on startup, so edits you make
outside the studio still land in the history.

Deleting `~/.agent-config-studio` loses the history, never the live config.

**Validation before write.** A save is refused outright if it would break the
file: invalid JSON, malformed TOML, a `SKILL.md` with no frontmatter or with an
empty `name` / `description`. Softer problems (no shebang on a hook, a 400-line
memory file, a suspiciously short skill description) save with a warning.

TOML is checked by a real scanner that understands comments, basic and literal
strings, multi-line strings, and values spanning several lines. The rule
throughout: error only on definite breakage, warn when merely unrecognised. A
false rejection that blocks a legitimate save is worse than a missed problem.

**Nothing executable renders.** Markdown is sanitized after parsing — script,
iframe, `on*` handlers and `javascript:` URLs are stripped. The preview shows
third-party plugin skills and model-generated assist output, and those would
otherwise run with same-origin access to the write API.

**Scope chain.** The `Scope` button answers "what actually applies when an agent
runs in this directory" — the global files plus every `CLAUDE.md`/`AGENTS.md` on
the path down, in the order they layer.

**Compare.** Skills that exist in both harnesses get a Compare tab showing the
Claude and Codex copies side by side. It does not judge them for differing —
a Claude skill *should* describe Codex differently than the Codex copy does.

## Assist

**Assist is a chat, and you point it at the files.** Open it from anywhere —
no need to navigate to a file first. Attach targets with `@` (autocomplete over
every file the studio lists), say what you want, and edits come back as a
**diff per file** that you Accept or Reject individually. Accepting goes
through the same save path as manual editing, so it is validated and versioned
like everything else.

It never picks targets for you. Nothing outside the files you attached is ever
edited — if the model references one you did not attach, that edit is dropped.

Why it stays short: the model replies with anchored search/replace blocks, not
whole-file rewrites, so a one-line rule change produces a few lines of output
rather than re-emitting the file. Every block must match its anchor **exactly
once**; ambiguous or overlapping edits are refused rather than guessed at.

Replies stream token by token. There is a live elapsed timer and a Cancel
button that kills the underlying process. Follow-up turns resume the same CLI
session, so the conversation keeps context without re-sending the files.

**It runs your local `claude` or `grok`**, under your own sign-in; no API key is
read or stored.

**The CLI can read, never write.** Each run gets one read tool and nothing else
(`--tools Read --strict-mcp-config` for Claude, `--tools read_file` for Grok),
so the only way a change reaches disk is your Accept. The CLI's first event
reports the tools it started with; anything else ends the run before its reply
is used.

- **Grok Assist runs only when grok has no MCP servers enabled** — neither
  its own nor ones a plugin brings. grok starts its MCP servers for every run
  and has no switch to keep them out. So before each Grok run, the studio asks
  `grok inspect` what it would load, and refuses if that includes any server.
  The message names the servers and the fix (`grok mcp disable <name>`).
  Grok Assist is unavailable while grok has MCP servers configured.
- **Claude Code's and Cursor's MCP sources are switched off for Assist runs**
  (grok imports `~/.claude.json` and Cursor's `mcp.json` by default), so
  servers configured there do not count.
- Claude Assist is unaffected; `--strict-mcp-config` loads no MCP server.

**Which models.** The picker comes from the model registry (below), as do the
default and the effort: `assist.claude` and `assist.grok` in
`models.default.json`, overridable in `~/.agent-config-studio/models.json`. A
model that is not on the picker never reaches the CLI's argv; the turn runs the
default instead.

**Sessions.** A session is one thread about one topic. It survives closing the
drawer, switching files, and reloading the page — the CLI session outlives the
tab. Up to **5** are kept; the switcher shows each with its remaining context,
and you delete one with `×` before starting a sixth.

The bar reports **% context left**, split into the conversation and the CLI's
own overhead (system prompt, tool definitions, your `CLAUDE.md`, the skills
index), which is loaded before you type a word. Only the conversation half
grows. **Compact** summarises the thread and continues it in a fresh context,
keeping the same session on your side; it stays disabled until enough of the
context is conversation for compacting to reclaim anything.

## Subscription usage

**Usage** in the top bar answers one question: which subscription should the
next task go to. Seats sort by the headroom of their tightest window, so the
line at the top is the answer and the cards below are the evidence.

Each seat is one *subscription*, not one vendor — two Codex plans and no Grok is
a valid setup, and so is none at all. **+ Add seat** registers one; a second
Codex seat gets its own `CODEX_HOME` under `~/.codex-seats/`, sharing
`config.toml`, `AGENTS.md`, `skills`, `rules` and `plugins` by symlink, so only
the login and session history differ. You sign in from the panel — it opens the
OAuth tab and the card flips to connected on its own.

Where each number comes from:

| Vendor | Source | Windows |
|---|---|---|
| Codex | `rate_limits` in its own rollout logs — offline, no credential | weekly, plus a 5h rolling window on some plans |
| Claude | `/api/oauth/usage` (undocumented) | session (5h), weekly all-models, weekly per-model |
| Grok | the `_x.ai/billing` method over `grok agent stdio` | weekly |

Readings that need a credential are taken by the usage collector in a child
process, which writes a snapshot. The studio renders the snapshot and shows how
old it is. **Refresh** retakes the readings.

Nothing is ever shown as a number it isn't. A seat that cannot be read says
*not connected* with the reason; one that is signed in but has never run says
*signed in · no usage yet*, because Codex records quota only when a turn runs.
A window whose percentage is missing is dropped rather than drawn as 0% — a
green bar meaning "we don't know" is worse than no bar.

Removing a seat unregisters it and leaves its home on disk. That directory holds
a real login and its history; dropping a row from a list must never delete
credentials.

From the terminal, `acs usage` prints the same gauge (`--json` for raw,
`detect --save` to register what's on this machine).

## Model registry

A model id lives in one file. `models.default.json` ships family → id
(`fable`, `opus`, `astra`, `sol`, …); `~/.agent-config-studio/models.json`
overrides it per key. Skills, skill scripts, skill configs and the Assist
picker all resolve through it, so a new model release is a one-line edit.

```
model-id opus
model-id --table
model-id --lint
model-id --sidecars
```

- `model-id opus` is the current id for a family; a raw id passes through.
- `--table` lists every family and its id.
- `--lint` finds raw ids and versioned names that crept back into your skills,
  `~/.claude` configs, and the `.claude/review-config.json` of every project
  folder.
- `--sidecars` lists ids in `~/.claude/settings.json` and `~/.codex/config.toml`
  that are no longer current.

**`acs install-model-id`** puts `model-id` on your PATH:

- It copies the resolver out of this checkout into
  `~/.agent-config-studio/resolver/`, writes a small launcher at
  `~/.agent-config-studio/bin/model-id`, and symlinks `~/.local/bin/model-id`
  to it.
- It is a copy on purpose: skills keep resolving when a worktree is removed or
  a branch changes.
- The launcher runs the node that did the install, then `node` on PATH, then
  `/opt/homebrew/bin/node`.

Re-run it:
- after node moves (a Homebrew switch, a new machine);
- after merging a change to `models.default.json`, `lib/models.js` or `bin/model-id` —
  the installed copy does not follow the checkout.

Until it has run, skills fail loudly rather than silently. Every skill shell
line reads `"$(model-id x || echo MODEL-ID-UNRESOLVED-x)"`, and the scripts do
the same. So a CLI is handed an id it rejects, never an empty `-m ""` that falls
through to its own default model.

## Optional: worktree tools

`tools/worktree/wt.zsh` is a zsh toolkit for parallel git worktrees: each
project gets a *trunk* (a checkout parked on its base branch, holding the env
files), and worktrees are cut from the latest base beside it.

```
acs install-worktree --dry-run
acs install-worktree
```

- It copies `wt.zsh` and `defaults.conf` into `~/.config/worktree` (`$WT_HOME`).
- It adds one marked `source` stanza to `~/.zshrc` (`$ZDOTDIR/.zshrc` when
  set), unless an uncommented line there already sources a `wt.zsh`. **This is
  the one command that edits a shell profile**, and `--dry-run` shows what it
  would do.
- A file that differs is backed up to `~/.agent-config-studio/backups/<ts>/`
  first; if the backup fails, nothing is written.
- A `defaults.conf` that differs is treated as yours and kept, unless you pass
  `--replace-defaults`.
- `repos/` is never touched.
- Re-run after a pull: the installed copy does not follow the checkout.

Then, once per repository: `wtinit` (or `wtinit --cmd m` for `mnew`, `mls`, …
from any directory; `wtinit --register --cmd m` adds a prefix to a project
configured earlier).

| Command | What it does |
|---|---|
| `wnew <name>` | fresh worktree off the latest base, env files linked, a port claimed, then `cd` in |
| `wls` | every worktree: branch, port, uncommitted count, env (`--json` for tools) |
| `wgo <name>` / `wtrunk` | `cd` to a worktree / the trunk |
| `wenv` | relink this worktree's env files that are links or missing |
| `wenv --status` | each env file's state here |
| `wenv --detach <f>` / `wenv --link <f> [--force]` | keep a private copy / go back to the trunk's |
| `wenv --link-all [--dry-run]` | migrate every worktree: identical copies become links, the rest are listed |
| `wenv --to-trunk [<dir>]` | seed the trunk's env files from a checkout that already runs |
| `wclean` | every worktree, `done` or why not (`--json`, `--no-fetch`) |
| `wclean --remove` | ask once, re-check each, remove the done ones and their branches |
| `wdev`, `wrm <name>`, `wtreg` | dev server on the claimed port, remove one, list registered prefixes |

**The env model.** Each `ENV_FILES` entry in a worktree is a symlink to the
trunk's file, so a secret is changed once, in the trunk.

An entry is refused by name, and nothing is created for it, when it:
- is absolute, or has a `..` or whitespace;
- sits under a directory that resolves outside the checkout;
- is tracked, or not ignored, by git there (a committed link would carry this
  machine's path).

A worktree that needs its own value runs `wenv --detach <f>`. That makes a real
copy, recorded in `.worktree-detached`, that no relink touches. Existing
worktrees keep their copies until `wenv --link-all` converts the ones identical
to trunk. A differing one is listed as `stale-or-override`, with both ways to
resolve it. No command prints a file's contents.

- **Running dev servers** (Next.js, Vite) read env at startup: restart after
  changing the trunk's env.
- **Docker:** a build context or a container mount of only the worktree cannot
  follow a link into the trunk. `wenv --detach` those files for container workflows.
- **direnv:** `.envrc` can be an entry.
  - `wnew` runs `direnv allow` once for a new worktree, and says so if it fails.
  - Editing the shared `.envrc` blocks it everywhere until each worktree is
    allowed again. Relinking never re-allows, and `wls` shows `envrc:blocked`.

**What `done` means.** `wclean` calls a worktree done only when every check
passes. A check that cannot run makes it unknown, never done. The checks:
- It is not the trunk, the primary checkout, or where you are standing.
- It is not locked, detached or mid-rebase, and has no submodules.
- The exact commit it sits on is an ancestor of the base, or is the head of a
  merged PR from origin's owner into the base's branch. That is asked of `gh`;
  without `gh`, only ancestors count, and it says so.
- The tree is clean, untracked files included.
- Every env file is a link to trunk, absent, or identical to trunk.

`--remove` re-runs all of that just before each removal and never uses
`--force`. It deletes a branch only if its tip is still the merged commit.
Ignored files other than env files (`node_modules`, build output) are removed
with the worktree.

The **Worktrees** button in the studio shows the same, per project and
read-only: the env summary and done (or why not), from `wls --json` and `wclean
--json --no-fetch`. A done row shows the command to run.

## Shortcuts

| Key | Action |
|---|---|
| `⌘K` | search across every config file |
| `⌘S` | save |
| `⌘E` | toggle preview / edit |
| `Esc` | close the assist drawer |

## Notes

- Serves `127.0.0.1` only, and rejects any request whose `Host` is not localhost.
- Saves are guarded against clobbering: if a file changed on disk after you
  opened it, the save is refused and asks you to reload.
- Symlinks resolve to their real target. A repo whose `AGENTS.md` is a symlink
  to its `CLAUDE.md` shows one entry serving both harnesses, not two copies.
- No dependencies. Node stdlib server, one vendored file (`marked`) for markdown
  rendering.
