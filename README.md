# Agent Config Studio

[MIT licensed](LICENSE) · `npx agent-config-studio`

A local web app for reading, editing and versioning the config of the AI coding
CLIs on your machine — Claude Code, Codex and Grok — in one place, rendered
properly: instructions (`CLAUDE.md`, `AGENTS.md`), skills, MCP servers, hooks,
settings, the models they use, and your subscription headroom.

## Get started

### What you need

- **macOS.** On Linux the server and the browser UI work; the extras listed
  under [Linux](#linux) are best-effort.
- **Node.js 20 or newer** (`node --version`) and **git**: the studio keeps the
  history of your config files in a git repo of its own, and `acs` refuses to
  start without git. Nothing else is installed: there are no npm dependencies.
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
npx agent-config-studio
```

That fetches the package and starts the studio at <http://localhost:8787> in
your browser. The first time, it opens on the **setup screen**:

1. **CLIs** — which of claude, codex and grok it found, their versions, and
   whether each is signed in. Installed one just now? **Recheck**.
2. **Accounts** — the subscriptions ("seats") to track in Usage, suggested
   from the CLIs it found. Optional.
3. **Project folders** — where your repos live. **Scan for projects** looks a
   few levels into `~/Documents`, `~/code`, `~/Projects` and similar, or type a
   path. Each folder is **read** (listed in Context, Tools and Worktrees) or
   **edit** (its instruction files are also editable here).
4. **Settings and hooks** — your CLIs' settings files and Claude Code's hook
   scripts, each opening in the editor.
5. **Done** — optional next steps. **Finish** lands on **Home**.

Leave that terminal open: the studio runs in it. Press Ctrl-C there, or run
`npx agent-config-studio stop` from another one, to stop it.

**To have `acs` as a command** in every terminal, install the package once
with `npm install -g agent-config-studio`. Then `acs` starts the studio from
any folder, `acs stop` stops it and `acs help` lists every command. To update,
run that install again; under npx, `npx agent-config-studio@latest` runs the
newest. `bunx agent-config-studio` works too, but Bun only fetches the package:
the studio still runs on Node 20 or newer.

Everything the studio keeps is in `~/.agent-config-studio`, never in the
package, so updating or removing the package keeps your history and settings.

### From a git clone

For working on the studio itself:

```sh
git clone https://github.com/crisnc100/agent-config-studio.git
cd agent-config-studio
./bin/acs
```

A clone updates itself: on start, `acs` fast-forwards a clean checkout on the
default branch (see below).

### Put `acs` on your PATH

```sh
./bin/acs install
```

This links `acs` into `~/.local/bin` (or another folder of yours that is
already on your PATH) and points it at this checkout. It never edits a shell
profile. If none of your folders is on PATH, it prints the one line to add
yourself. It refuses to replace an `acs` that is not a link to this checkout.
Under npm it is not needed, and says so.

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
- **Which node runs the studio.** The `node` on your PATH, unless there is
  none, it is older than 20, or it is a short-lived odd-numbered release such
  as Node 23: then `acs` runs the newest LTS that nvm, fnm, Volta or Homebrew
  installed, and says so when it starts. Set `ACS_NODE` to a node binary to
  choose it yourself.
- **The studio stops loading pages.** It checks itself every minute and exits
  when its file reads stop completing, and `acs` replaces a running studio
  that has frozen that way — so run `acs` again.
- **Stop or uninstall:** `acs stop` (`npx agent-config-studio stop` under
  npx). Installed from npm, `acs uninstall` prints the npm command that
  removes the package; from a clone, `acs uninstall` removes the link, then
  delete the checkout. Delete `~/.agent-config-studio` (the
  studio's history and settings) to remove everything. Your CLI config is
  never inside either.
- **`acs` says git is required.** Install git, then start it again: the
  history of your config files is a git repo.
- **`acs` runs an old copy.** A shell alias or an earlier `acs` on PATH wins
  over the link. `acs help` prints the checkout it came from. `acs install`
  refuses, and names the file, when an earlier `acs` on PATH is not this one.

### What the studio reads, writes and sends

There is no telemetry. What reaches the network, and when:

- **`acs` fetches git origin** on start, to fast-forward a clean checkout on
  the default branch — only when it runs from a git clone of the studio. It
  skips this on any other branch, with local changes, or with
  `ACS_NO_UPDATE=1`. `acs update` runs the fetch on its own. Installed from
  npm, it never fetches; npm (or npx) is what updates it.
- **Assist runs your CLI** (`claude` or `grok`), which talks to its vendor
  under your own sign-in.
- **The usage collector** reads credentials in a separate child process, so
  the server never holds one. It runs when you press **Refresh** in Usage,
  once after you sign a seat in, or as `acs usage`. It reads:
  - the Claude Code credential, from the macOS Keychain or
    `~/.claude/.credentials.json`, and calls Anthropic's usage endpoint;
  - the Codex and Grok `auth.json` files, for account identity;
  - quota, by asking `codex app-server` and `grok agent stdio`, and by running
    `agy -p /usage --output-format json` (agy 1.1.11 or later, where print mode
    answers `/usage` without a model turn) in an empty temporary folder; agy
    signs itself in from its own login.
- **Signing a Codex seat in** from Usage or setup runs `codex login`, which
  opens OpenAI's sign-in page and writes that seat's `auth.json`.
- **Check now** on the Models page runs `codex app-server` `model/list`, which
  fetches Codex's model catalog, and `agy --output-format json models` (agy
  1.1.12 or later, no model turn) in an empty temporary folder, which lists the
  Gemini models your Antigravity sign-in offers.
- **The Worktrees view** runs the toolkit's `wclean`, which asks `gh` (when
  installed) whether a branch's pull request was merged. It never fetches.

What it writes:

- **Your CLIs' own homes** (`~/.claude`, `~/.codex`, `~/.agents`, `~/.grok`,
  `~/.config/worktree`): editable regardless of your folder choices.
- **Inside project folders you marked edit:** the instruction files
  (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.worktrees.conf`). Setting a project
  up under **Worktrees** also runs `wtinit` there, which creates the project's
  trunk checkout.
- **Its own folder,** `~/.agent-config-studio` (settings, history, trash, the
  usage snapshot, the Antigravity model list Check now saves, and
  a run file per port for `acs stop`).
- **When you add a second Codex seat:** its own home under `~/.codex-seats/`,
  sharing `~/.codex`'s config, skills, rules and plugins by symlink.
- **When you turn on Terminal shortcuts in Usage:** a generated file in
  `~/.agent-config-studio`, plus one `source` line appended to `~/.zshenv`.
- **Commands you run:** `acs install` links `~/.local/bin/acs`;
  `acs install-model-id` writes `~/.local/bin/model-id` and
  `~/.local/bin/ask-model` and `~/.local/bin/acs-agent`, and their copy in the studio folder; `acs install-worktree` writes `~/.config/worktree` and adds
  one line to `~/.zshrc`.
- **Your temp folder:** each Grok Assist turn's prompt, in a file that is
  removed when the turn ends (in `~/.agent-config-studio/tmp` when the temp
  folder is not writable). Nothing is ever written inside the installed
  package.

The file API serves only files in those places and in your **read** folders,
and never serves `.credentials.json`, `auth.json` or `~/.claude.json`. Only the
`mcpServers` key of `~/.claude.json` is extracted, read-only. The server
listens on `127.0.0.1` only.

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

The sidebar holds **Home**, **Context**, **Tools**, **Models**, **Usage**,
**Memory** and **Packs**; **Setup**, **Trash** and the theme switch sit at its
foot. Every file the studio manages opens from the page that lists it, and
`⌘K` searches all of them by content.

| Files | Source | Opens from |
|---|---|---|
| Instruction files | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.grok/AGENTS.md`, and every `CLAUDE.md` / `AGENTS.md` in your **edit** folders | Context |
| Claude skills | `~/.claude/skills/*` (follows the symlink into `~/.agents`) | Tools → Skills |
| Codex skills | `~/.codex/skills/*` | Tools → Skills |
| Plugin skills | enabled plugins only, read from the plugin cache | Tools → Skills |
| Retired skills | `~/.claude/skills_retired/*` | Tools → Skills |
| Subagents | `~/.claude/agents/*.md` | Tools → Agents and commands |
| Slash commands | `~/.claude/commands/*.md` | Tools → Agents and commands |
| MCP servers | `.mcp.json` in your edit folders (editable); global and Codex servers read-only | Tools → MCP servers |
| Auto-memory | `~/.claude/projects/*/memory/*.md` — what the harness wrote itself, one bucket per project scope, `MEMORY.md` included | Memory |
| Settings & config | `settings.json`, `settings.local.json`, `advisor-config.json`, `investigate-config.json`, `review-config.json`, `~/.codex/config.toml`, `~/.codex/rules/*` | Setup → Settings and hooks |
| Hooks | `~/.claude/hooks/*.sh` | Setup → Settings and hooks |
| Worktree rules | `~/.config/worktree/defaults.conf`, `repos/*.conf`, and each `.worktrees.conf` in your edit folders | Worktrees (from Packs → Worktree setup) |

**Context** and **Tools** also list your **read** folders, without editing
them. Add folders any time under **Setup → Project folders**; `acs roots
ls`, `acs roots add <path> [--edit]` and `acs roots rm <id>` list, add and
remove them. A running studio picks the change up by itself.

**Context** opens on your main instruction files — the global ones every
session of that CLI loads — each with its size and the outline of its
headings. Below them, pick a project, and a folder in it: Context lists what
an agent started there loads, in order (the main files first, then every
`CLAUDE.md` / `AGENTS.md` on the path down), and every instruction file in
that project, with identical worktree copies collapsed and differing ones
flagged. For a project outside your home folder, the path down starts at
its registered folder, never above it. In a **read** folder each file in the
load order is marked read-only, with no **Open**. **All projects** lists every
project's files at once, so a selection moved to Trash can span projects.

## The parts that matter

**Rendered, not raw.** Markdown files render with real typography — headings,
tables, code blocks. YAML frontmatter becomes a metadata card instead of the
giant bogus heading Markdown would otherwise make of it.

**Only what is loaded.** The plugin cache holds every skill of every plugin
merely installed. Only skills from plugins actually enabled in `settings.json`
are listed, because only those are ever loaded.

**Create and delete.** **New subagent** and **New slash command** (Tools →
Agents and commands) and **New hook** (Setup → Settings and hooks) scaffold
the file with valid frontmatter already in place (the scaffold passes the
app's own validator). `+ file` on a skill adds a
reference doc. **Copy to Codex / Copy to Claude** seeds a skill in the other
harness from the open one, retargeting the frontmatter `name`; the two are
expected to diverge afterwards.

**New skill, by interview.** **New skill** on Tools → Skills opens a wizard:
describe the skill, answer the interview one question at a time, pick where it
goes, then review the drafted `SKILL.md` and create it. Nothing is written
until you press **Create**, and it writes exactly what Review shows.

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
the page lists update live rather than going stale until a reload. The green dot
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

**Usage** in the sidebar answers one question: which subscription should the
next task go to. Seats sort by the headroom of their tightest window, so the
line at the top is the answer and the cards below are the evidence.

Each seat is one *subscription*, not one vendor — two Codex plans and no Grok is
a valid setup, and so is none at all. **+ Add account** registers one; a second
Codex seat gets its own `CODEX_HOME` under `~/.codex-seats/`, sharing
`config.toml`, `AGENTS.md`, `skills`, `rules` and `plugins` by symlink, so only
the login and session history differ. You sign in from the panel — it opens the
OAuth tab and the card flips to connected on its own.

A Gemini subscription is added the same way and runs through Antigravity
(`agy`), the only harness offered for it today. Sign in inside agy itself
(run `agy`); ACS never handles that login. agy keeps one sign-in per machine,
so one Gemini seat can be tracked.

Where each number comes from:

| Vendor | Source | Windows |
|---|---|---|
| Codex | `rate_limits` in its own rollout logs — offline, no credential | weekly, plus a 5h rolling window on some plans |
| Claude | `/api/oauth/usage` (undocumented) | session (5h), weekly all-models, weekly per-model |
| Grok | the `_x.ai/billing` method over `grok agent stdio` | weekly |
| Gemini | `agy -p /usage --output-format json` | 5h and weekly for the Gemini models; Gemini 4 Argon's own weekly limit as a line without a gauge |

A Gemini seat signed in to agy with a `GEMINI_API_KEY` has no subscription
quota to read and says so.

Readings that need a credential are taken by the usage collector in a child
process, which writes a snapshot. The studio renders the snapshot and shows how
old it is. **Refresh** retakes the readings; so does **Refresh usage** on Home's
Accounts & usage card. One refresh runs at a time, however many tabs ask, and a
refresh that could not run says so instead of passing off the stored reading
as new.

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
`detect` suggests a Gemini seat when agy is installed and none is tracked yet;
`acs usage add gemini <label>` adds one by hand. Seats a newer ACS registered
in `seats.json` that this version cannot read are left in the file untouched,
not shown, and their ids are never reused.

### Pausing an account

When one subscription runs low, **Pause** on its row makes every role skip
that account's models (claude, codex, grok or gemini; a model belongs to
the account its id's prefix names, and `gemini-` models run through agy on
the Gemini subscription) and answer with its next one. Pausing offers **until it resets**, filled in
from the reading's tightest window when it has a reset time, or **until I
resume**; a paused row says *Paused until …* and has **Resume**. Your roles are
not changed: the pause lives in `~/.agent-config-studio/paused.json`, its own
file, and `roles.json` is never written.

While anything is paused, Models → Roles lists what each role answers now,
marks a role that would refuse, and says when builder and reviewer now come
from one vendor (so that vendor checks its own work).

- A role skips paused families in its `use` order; its second opinion is
  skipped the same way and left empty, never promoted.
- A role whose every model is paused refuses with exit 2 from `model-id
  --role` (64 from `ask-model --role`) and the fix (*every model for advisor
  is paused; resume claude or add a fallback in ACS → Models → Roles*). The
  writer role refuses the same way. `ask-model --role <name> --second` refuses (64)
  when that role's second opinion is paused.
- `model-id --role` prints one line on stderr when it skipped something
  (*claude paused: reviewer → sol (skipped fable)*), and its `--json` carries
  `paused`, `skipped` and `altSkipped`. `ask-model --role` and the review
  gate's reviewer pool follow the same answer.
- A family you name yourself is never paused: `model-id opus`,
  `ask-model --family fable`, `REVIEW_REVIEWER=fable` and `/build opus` run as
  asked.
- A missing `paused.json` pauses nothing. An invalid one pauses nothing too,
  and `model-id`, `acs pause` and Usage say why; edits are refused until you
  fix or delete it.
- Pausing is refused while the installed `model-id` is older than the studio
  (it would ignore the file): run `acs install-model-id` first.

From the terminal:

```
acs pause
acs pause claude
acs pause fable --until 2026-11-14T15:00:00Z
acs pause codex --until-resume
acs pause gemini
acs resume claude
```

`acs pause` alone lists what is paused and each role a pause changes. A pause
names an account (claude, codex, grok or gemini; not agy) or one family; with no flag it ends when the last usage reading
says that account resets, or lasts until you resume when no reading says. A
pause whose time has passed no longer counts and is dropped on the next write.

`acs pause` and `acs resume` exit 2 on a usage error, an unknown name or a
time that is not ahead, and 1 when the change is refused (a stale `model-id`,
an invalid `paused.json`, resuming something not paused); the bare listing
exits 1 while `paused.json` is invalid. If the studio and `acs pause` save at
nearly the same moment, a change based on an outdated file is made again from
the newer one; after three tries it is refused (HTTP 409 in the studio) and
nothing is written. Two saves in the same instant can still lose one, so check
`acs pause` after scripting several at once.

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

**Synced families.** Every model your signed-in CLIs offer (Claude, Codex,
Antigravity, Grok) becomes a family without an edit: when ACS starts, and on
**Check now**, it reads each vendor's model list and writes new words to
`~/.agent-config-studio/families.json`, a file apart from `models.json` (an
older resolver refuses `models.json` whole on a family it does not know, and
never opens this one). `model-id` reads it too, once `acs install-model-id`
has copied the newer resolver.

- A sync only adds a family at its newest id, or moves one forward to a
  strictly higher id from the same CLI. It never removes a family and never
  moves one down, because a partial list must not take away a family you call
  by name. The start check runs no CLI, so the Antigravity list refreshes only
  on Check now.
- A family that a role, a flavor or a pause names never moves by itself, nor
  does one you pinned. The Models page says what holds it. Shipped families
  never follow a list: they keep the update alert and **Accept**.
- Words that cannot be added (a CLI name, a name two vendors share, an id that
  needs a newer Claude Code) are listed under the catalog lines with why.
- Typing an id for a synced family pins it. **Pin** keeps the id; **Unpin**
  lets it follow its list again. **Remove** shows only once the list no longer
  offers the word, and is refused while a role, flavor or pause still names the
  family, since the next sync would otherwise add it back.
- Effort pickers offer only the efforts the family's list gives (a role picks
  from the efforts all its models accept).
- Every write to `families.json` is recorded in history.

**`acs install-model-id`** puts `model-id`, `ask-model` and `acs-agent` on your PATH:

- It copies the resolver out of this checkout (or the npm package) into
  `~/.agent-config-studio/resolver/`, writes a small launcher at
  `~/.agent-config-studio/bin/model-id`, and symlinks `~/.local/bin/model-id`
  to it. `ask-model` gets the same: a copy beside the resolver, a launcher,
  and `~/.local/bin/ask-model`. `acs-agent` is copied and linked the same way at
  `~/.local/bin/acs-agent`, pointing to `~/.agent-config-studio/bin/acs-agent`.
  An existing `acs-agent` entry is replaced only when it is a symlink to that launcher; files and links elsewhere are refused. The installer
  never touches `~/.local/bin/agent`.
- It is a copy on purpose: skills keep resolving when a worktree is removed or
  a branch changes.
- The launcher runs the node that did the install, then `node` on PATH, then
  `/opt/homebrew/bin/node`.

Re-run it:
- after node moves (a Homebrew switch, a new machine);
- after merging a change to `models.default.json`, `lib/models.js`, `lib/roles.js`,
  `lib/roles.default.json`, `bin/model-id`, `tools/ask-model.mjs` or the agent CLI — the
  installed copy does not follow the checkout;
- after updating the npm package. The first start after an update says so
  when the installed copy differs from the package's.

Until it has run, skills fail loudly rather than silently. Every skill shell
line reads `"$(model-id x || echo MODEL-ID-UNRESOLVED-x)"`, and the scripts do
the same. So a CLI is handed an id it rejects, never an empty `-m ""` that falls
through to its own default model.

### Roles and flavor

Beyond ids, the registry says which family does which job and how to brief
each one. You choose which model does each job when you install the packs that
use it (`acs packs install <pack>` asks, offering only the families whose CLI
you have), or later in Models → Roles. Your choices live in
`~/.agent-config-studio/roles.json`, a separate file from `models.json`, so a
resolver installed before roles existed keeps working.
`lib/roles.default.json` ships a short flavor per family, shown beside each
family when you choose. Its role entries are kept only for `roles.json` files
written before this (below); they are never offered and never run for anyone
else.

A job you have not chosen a model for is unset: `model-id --role`, `ask-model`
and the review gate stop with one line naming the fix, `acs packs install
<pack> --set-role <role>=<family>[,<family>…]` or Models → Roles. `acs packs
install <pack> --yes` without `--set-role` installs anyway and leaves the roles
unset, saying so. Nothing picks a family for you.

A `roles.json` written before roles were chosen at install (version 1) keeps
working as it did: the jobs it leaves out still run the shipped roles.
`acs packs install` or `acs packs update` writes those jobs into it, with the
same values, and marks it version 2 (backed up and recorded in history first);
from then on only what it says runs. An older installed `model-id` refuses a
version 2 file, so run `acs install-model-id` first; until then the packs
leave the file as it is.

```
model-id --role reviewer
model-id --role builder --json
model-id --flavor sol
model-id --roles
```

- `--role <name>` prints one line, `family=… id=… effort=… alt=…`, ready for
  `eval "$(model-id --role reviewer || true)"`. `use` is an ordered
  preference list and the first entry is the answer; `alt` is a second-opinion
  family a skill asks for on purpose, never a fallback. `effort` is the first
  model's (see the precedence below), else empty — never guessed.
- `--json` (with `--role`, `--flavor` or `--roles`) gives the whole entry: every
  `use` family and id, and where each field came from (default, yours, or
  cleared). When a role gives a model an effort of its own, its entry also has
  `members` (each model in order as `{family, id, effort, source}`) and
  `altMember` (the second opinion the same way, or null). Without one they are
  absent, so a script reading them falls back to `use` and `ids` with the
  role's `effort`, else each family's `--flavor` effort.
- `--flavor <family>` prints what the family is good at, its quirks and how to
  brief it, as plain text for a delegation brief.
- `--table` is unchanged: families only. Roles are listed by `--roles`.
- An unknown role or family, or an invalid `roles.json`, exits 2 and says why;
  `--role` then prints `MODEL-ID-UNRESOLVED-<name>` in place of every value. A
  family call keeps its old behaviour (exit 1).

Effort is set per model in a job first, then per job, then per model. A
`use` entry (or `alt`) is either a family name or `{"family": "sol", "effort":
"high"}`; that effort applies to that model in that job only. A model without
one runs at the job's effort, and a job without one runs each model at its
own default effort (its flavor `effort`). So "builder = Opus medium, Sol high"
beside "reviewer = Opus high" needs no change to Opus's default. `source` in
`members` says which of the three applied: `member`, `role` or `flavor`.

Each family's flavor in `roles.json` merges over the shipped one field by
field: a list replaces the shipped list, and `null` clears a shipped field.
Roles do not merge: a role is what your file says. Nothing reads a catalog or
swaps a family on its own; the Models panel only warns when a role's family is
retiring, gone, or has a malformed id.

In the Models panel, the **Roles** table edits and resets each role (your own
roles can be added and deleted), and each family's row edits its flavor. Every
save is versioned in history and refused if `roles.json` changed since the
panel read it. A field the form does not know is refused, never dropped.

**Describe your models** takes a plain-language description and has Claude,
at the Assist registry's default model and with no tools at all, turn it into
a proposed `roles.json`. The reply must be exactly one JSON object (one code
fence labelled json around it is allowed, no other) that passes
the same checks as a hand edit; you see the whole change as a diff and nothing
is written until you accept it. Flavor text becomes part of the instructions
other agents are briefed with, so read a proposal before accepting it — it is
the AI's reading of what you wrote, not a check of it.

### Watchable workers (`acs-agent`)

`acs-agent` runs an interactive worker in cmux. Install it with `acs install-model-id`
and put `~/.local/bin` on PATH. `acs agent` also runs it from this checkout.
It requires a reachable cmux socket; outside cmux it exits 2 with
“acs-agent needs cmux”. Other ACS commands do not need cmux.

```sh
acs-agent open sol --effort medium --cwd /path/to/project --prompt-file task.md
acs-agent open opus "Read the project and explain its entry points"
acs-agent wait <id> --timeout 600
acs-agent send <id> "Check the error path too"
acs-agent answer <id>
acs-agent close <id>
acs-agent list --json
```

`open` prints a worker id. A family resolves through the same registry as
`model-id`; `--role` records the job's role, and `--effort` sets the harness's
reasoning effort when supported. Use either a task argument or `--prompt-file`.
Each worker records its effective harness home, honoring `CODEX_HOME`,
`CLAUDE_CONFIG_DIR` and `GROK_HOME` at launch. Later commands use that recorded
home even if their caller’s environment changes.
The launcher reads a private prompt file and passes it after the harness’s
end-of-options delimiter, so option-shaped briefs remain literal task text.
Prompt text is never typed into the terminal. Codex uses workspace-write with approvals disabled, Claude uses auto
permissions, and Grok uses always-approve.

Claude workers start with `--strict-mcp-config`, so they load no MCP servers.
Pass `--mcp` to inherit the Claude MCP configuration. Codex and Grok keep their
configured MCP servers: neither has a verified global switch that disables
configured servers for a run. Codex supports a per-server
`mcp_servers.<name>.enabled=false` override, but an empty `mcp_servers` table
does not clear inherited servers. `--mcp` is accepted and recorded for every
family; it changes launch flags only for Claude. No persistent CLI config is
edited.

For a Codex worker in a linked Git worktree, the launcher grants writes only
to the common directory's `objects/`, `refs/` and `logs/`, and that worktree's
`index`, `index.lock`, `HEAD`, `HEAD.lock`, `COMMIT_EDITMSG` and `logs/` paths.
Codex's macOS sandbox supports file grants, including missing lock files;
the administration directory itself receives no grant. Its `commondir`,
`gitdir`, `config.worktree` and other configuration or object redirects remain
read-only. Every Codex launcher clears inherited extra writable roots and
excludes default writable temp directories, including for normal checkouts,
subdirectories and rejected Git links. Each worker receives its own private
scratch directory, exported as `TMPDIR`, `TMP` and `TEMP` and explicitly granted
write access, so tests can create temp files without exposing other temp repos.
Worker Git processes use a runtime `core.splitIndex=false` override, preserving
other runtime Git settings and persistent repository config. This avoids granting
the administration directory to create unpredictable `sharedindex.*` files.
It verifies that the administration directory is under the common directory's
`worktrees/` and points back to the working directory's `.git` file. Forged links,
symlinked data directories and symlinked commit files get no grant for those
paths. Common `config`, `hooks/`, `info/`, `packed-refs` and root lock files receive
no extra write permission. Normal branch and detached-HEAD commits, including
one from a packed branch ref, need no common-root writes; maintenance operations
may require the operator's separate action.
The launcher records granted admin paths outside the worker's write grants.
On wait, send, answer, close and list (including idle expiry), ACS checks those
paths and their reflog entries with `lstat`. Unsafe symlink or nonregular scratch
entries are removed without following them; unexpected nonempty directories
remain blocked. ACS reports `stuck` with kind `git_tamper` and the affected paths,
and retains that warning after cleanup and close. Closing still terminates the
worker surface; a flagged worker cannot send a follow-up or supply an answer.

Each worker opens as a background tab in the orchestrator's own pane, in its
workspace, without taking focus, so the orchestrator's screen stays as it is.
The tab is titled `builder · <family> · <branch>`, the branch checked out in
its folder (the folder name outside Git or on a detached HEAD). Grok needs
its own visible pane to start, so it opens in a pane beside the orchestrator;
focus returns to the orchestrator after its session appears, or after six
seconds. Workers are scoped to the orchestrator's
workspace and pane. At most four workers run at once across orchestrators; extra
`open` calls and follow-ups to finished workers wait for a slot. Keep the
waiting `open` process alive: there is no background queue service. Every
command accepts `--json`. Turns submitted directly in a worker pane count as
running work, update its activity, occupy a worker slot and keep fault checks
active.

`wait` polls the harness transcript, cmux events and worker screen. JSON includes `state` and
its compatible `status` alias. Plain output starts with the state, followed by
its details when available:

| State | Exit | Meaning |
| --- | --- | --- |
| `done` | 0 | The turn ended. When the final message's last nonempty line starts with `QUESTION:`, JSON includes `question: true` and the exact final answer in `text`. |
| `stuck` | 3 | A permission or folder-trust prompt; `prompt` contains the dialog. Pre-session folder trust also includes `kind: "trust"`. |
| `timeout` | 4 | No completion or fault before the requested timeout. |
| `unsent` | 5 | A send has no confirmed new turn after 10 seconds; `input` is the detected composer line and `screen` preserves the screen for inspection. |
| `no_start` | 6 | No session or transcript appeared within 60 seconds of open. |
| `stalled` | 7 | A started, unfinished turn has no open tool, transcript growth or advancing thinking indicator; `steps` contains up to the last three available tool calls or commands. |
| `closed` | 8 | The worker was closed, its surface vanished, or it was closed after 30 idle minutes. JSON includes `closed: true`. |
| `long_command` | 9 | A tool call has stayed open for `--command-after` seconds without a matching result. `command` contains its input or command text. |

`--timeout` is in seconds, defaults to 600, and zero checks once. `--stall-after`
is in seconds and defaults to 300. `--command-after` is in seconds and defaults
to 600; zero checks an open tool immediately. A waiting orchestrator wakes on the first
observed completion or fault; when multiple faults are already overdue, the
oldest threshold wins, except pending approvals take precedence over other
faults, including `long_command`, `stalled` and startup `no_start`. Until a session exists, the screen is checked at least every three
seconds. Trust remains the user’s decision; `acs-agent` never answers the dialog
or edits trust settings. Running indicators are sampled every three seconds
and checked again before reporting a stall. Only an advancing elapsed time
extends the thinking stall deadline; a frozen spinner does not. While a tool
is open, the UI timer does not count as thinking progress. The tool uses its
own deadline, measured from its transcript timestamp or first observation
when no timestamp exists. Matching results close calls individually, including
failed results; parallel calls keep their own ages. Grok uses structured call
records when available and otherwise recognizes explicit `Running:` or
`Executing:` command rows on its screen. The first elapsed
reading starts an observation window so it can be compared with a later sample.
A closed worker returns `closed` with `closed: true`, including when its
surface was closed manually. `wait` checks surface availability on each poll,
so a retained transcript does not hide a vanished surface.
Codex and Grok completion does not rely on cmux Stop hooks.

When a known session's transcript remains unresolved after 30 seconds,
`wait --json` includes `transcriptMissing: true`, including on a timeout.
Transcript-based completion and tool checks are unavailable until that file is
found. The flag clears when discovery succeeds and does not change the exit
code or wait deadline.

`send` refuses stuck workers with exit 3 and names the stuck state. It checks
for trust and permission dialogs before sending text and before every Enter
attempt, stopping if one appears during submission. Unresolved permission hooks
block sending independently of command deadlines. Screen detection requires a
question and both choice rows in the bottom 20 screen lines. When the transcript
confirms completion and no permission hook is pending, even Yes/No choices are
answer text. Older scrollback does not block follow-ups. It never answers dialogs.
A matching tool result, a later turn, or an observed dialog disappearing
retires the old permission request.

`send` refuses before the initial launch turn is observed. Once startup is
established, it confirms a new `task_started` event for Codex, a new non-tool-result
user entry for Claude, or `turn_started` for Grok. It retries Enter up to three
times and waits up to 10 seconds for proof. Failure exits 1 and persists the
send attempt so `wait` also reports `unsent`. Another send refuses with exit 5
and the leftover input until a later turn proves submission. Submit that input
in the worker pane or close the worker before sending again; retries never
append new instructions to unresolved input. A Codex user-message line alone
is insufficient. Messages longer than 400 characters are saved privately in
the worker's run directory; only `Read <path> and follow it.` is sent to the
composer. This avoids the long-paste placeholder that can remain unsubmitted.

`answer` preserves the final message's exact bytes, including trailing spaces,
without adding a newline; after a completed turn, Grok falls back to the screen
when no assistant history exists. Before the current turn finishes, `answer`
exits nonzero with `no answer yet (state …)`.

Worker records, prompt files and launchers live in `~/.agent-config-studio/agents/`.
`close` force-closes the surface and keeps the transcript. `list` and `wait`
also close workers that have been done and idle for 30 minutes. Running workers
remain open, including those waiting for a correction. There is no daemon.

Each launcher records its process id in `<worker-id>/harness.pid` before exec
and starts one `caffeinate -i -w <pid>` to hold off idle sleep while that worker
process lives, including between turns. Its log is in the same run directory.
The assertion ends when the process exits. A closed lid on battery still sleeps;
caffeinate cannot prevent that. Interactive workers retain their terminal
stdin; the cmux control subprocess reads no stdin. This command does not run
headless Codex turns.

The development-only fault rig is at `builds/agent-command/rig/run.mjs`.
Run it with Node inside cmux, with `acs-agent` installed and a worker slot available. It uses
real workers and reports six scenarios in a pass/fail table. Its scratch
checkout is a detached worktree of this repository under `$TMPDIR`, so existing
repository trust applies. The silent Python command checks `long_command`
with a 30-second command threshold; `stalled` is covered offline because the
rig does not reliably provoke a quiet turn without an open tool. A separate
fresh Git repository checks folder trust.
It closes its workers and removes the scratch worktree on exit. It is outside the installed package. The rig
uses `AGENT_TEST_MODE=1` with `AGENT_TEST_LAUNCH_EXTRA` (a JSON array of extra
harness arguments) or `AGENT_TEST_BINARY` (a replacement executable) to provoke
permission prompts and launch failures. These overrides are test-only and
are ignored unless test mode is explicitly enabled.

### Asking another model (`ask-model`)

`ask-model` is what a skill runs to ask another model something. The flags
that keep that call read-only and on the right model live in it, not in each
skill.

- `ask-model --role advisor --prompt-file brief.md` asks the role's first
  family; `--family sol` asks one family by name. The effort is the role's (or
  the family's flavor effort), `--effort high` overrides it, and when none is
  set no effort flag is passed at all.
- The CLI follows the id. Claude runs with `--tools Read,Grep,Glob` and
  `--strict-mcp-config`, Codex with `--sandbox read-only` and each MCP server
  it has configured switched off, and Grok with its read tools only and MCP
  denied, so the model can read but not edit. If Codex's servers cannot be
  confirmed off, Codex is not run. A server that a Codex plugin brings has no
  setting of its own to switch off, so when one is there Codex runs that call
  with its plugins off.
- Grok starts every MCP server it has configured, whatever the call's flags
  say, and nothing turns one off for a single call. So before each Grok call
  `ask-model` runs `grok inspect` in the call's folder, with Grok's borrowed
  Claude Code and Cursor servers switched off for that check and for the
  call. If a server, or a plugin that brings one, would still start, Grok is
  not run (exit 4) and the message names each one. Switch it off with
  `grok mcp disable <name>` (a plugin's with Grok's plugin disable command).
- `ask-model` runs claude, codex, grok and agy (Antigravity, for a `gemini-`
  id). A family whose id starts with none of their prefixes is not run: it
  exits 64 and names the id.
- Agy runs read-only through a deny list passed for that call only (no
  commands, file writes, MCP tools, or URL reads, downloads or runs); web
  search cannot be denied, so it stays on. Agy itself runs workspace hooks,
  MCP servers and plugins whatever the deny list says, so the call stops
  first (exit 4, naming what it found) when any of these holds, checked in
  this order:
  - any folder from the working folder up to `/` has a `.agents`, `.agent`,
    `_agents` or `_agent` folder holding `hooks.json`, `mcp_config.json`,
    `plugins.json`, `agents.json`, `plugins` or `agents` (custom agents,
    which can name hooks of their own);
  - `~/.gemini/config/plugins/` holds anything, or `plugins.json` exists
    there;
  - `~/.gemini/config/mcp_config.json` holds anything beyond an empty server
    list, or cannot be read as JSON;
  - `~/.gemini/config/hooks.json` has a hook whose command is not exactly
    one of cmux's;
  - `agy --version`, run in an empty temporary folder, is not the version
    its containment was checked on.
  Agy then runs only on macOS, inside a `sandbox-exec` sandbox that lets it
  read the git work tree holding `--cwd` (or `--cwd` itself), its own temp
  folder and log, and the few agy settings files it needs to start and sign
  in (your login keychain's file, its lock file and the copy a save writes
  among them), and nothing else under your home or temp folders. It may not
  write agy's conversation summaries, which it cannot read there and would
  otherwise empty. It exits 4 without running agy off macOS, inside another
  sandbox (run it from a plain terminal), when that folder is your home or
  holds it, when git names a work tree that does not hold `--cwd` (a
  repository's own config can), or when a check made before each call
  shows the sandbox not holding. It also exits 4 while
  `~/.gemini/antigravity-cli/antigravity-oauth-token` exists: agy writes
  your Google sign-in token there in plain text when it cannot save it in
  the keychain, and leaves it. Delete it; agy signs in from the keychain
  without it. A call exits 4 too when agy left no readable log of it, when
  that log says agy kept its sign-in token in a file, or when the token file
  is there afterwards.
  `--role security` (or its `--second`) that resolves to an agy family
  exits 4 without running it, since agy's web search stays on.
  A tool call agy refused is printed on stderr and does not fail the call.
  A subagent the model tries to start is named there too: subagents can't
  run inside the sandbox, and that does not fail the call either.
  `--investigate`, `--no-tools` and `--min-tools` exit 4
  for agy without running it. Agy reports only the model it was asked for,
  so its answer is labelled unverified (`--json` adds `served` with
  `verified: false`), and each call keeps its own agy log under
  `~/.agent-config-studio/logs/agy/` (`logFile`). A failed status, an empty
  answer (a turn its deny list ended, say) or a deadline exits 4.
- The answer goes to stdout, and one line on stderr names the family, id,
  effort and mode. `--json` prints `family`, `id`, `effort`, `mode`, `answer`,
  `changed` and `error` instead. `--cwd <dir>` is where the model works.
- It checks that the model it asked for answered: for Claude and Grok the id
  must be in the reply's `modelUsage`. Codex reports no model, so a Codex
  answer is not checked.
- `--investigate` lets the model run commands: Claude gets `Bash`, Grok its
  shell tool with shell commands allowed, and Codex's read-only sandbox
  already runs them. The shell runs inside the CLI's own sandbox. Claude's
  Bash sandbox is set for that call only: commands write to the work tree and
  the temp folder, reach no network host and never run outside the sandbox,
  and Claude exits if the sandbox cannot start. No user, project or local
  Claude Code settings file loads for that call, yours included, so none can
  widen the sandbox (your login is not a settings file and still works).
  Managed settings, the ones an administrator installs, still apply, since no
  flag turns them off. Grok runs with `--sandbox strict`, and only on Linux
  with Landlock active. For Claude or Grok on a platform other than macOS or
  Linux, for Grok on macOS (where its sandbox can't block a command's
  network), or for Grok on Linux without Landlock, `--investigate` exits 4
  and the model is not run. Codex runs anywhere, in its own read-only
  sandbox. `--json` adds
  `shellSandbox`, naming the sandbox the shell ran in. A command Grok still
  refuses is passed on to stderr. In a git work
  tree it compares HEAD (its commit and branch) and the status before and
  after, so a checkout shows even when it leaves the status as it was; if
  anything changed, it names each file (and a moved HEAD with both commits)
  and exits 5. Each checked-out submodule is compared the same way, its
  files and HEAD named under its path. It also fingerprints, before the
  call, the work tree's `.git`, the git dir's `commondir`, the repository's
  `config` and `config.worktree`, and every file those configs include (a
  symlink by its target path and the target's contents), the same for each
  submodule; if any of them changed, it names them and exits 5 without
  running git again. Every look at the repository runs git with a config
  `ask-model` writes for it, never the repository's, your global or the
  system one, so nothing a config names (an fsmonitor, a clean filter, an
  include) runs, wherever the shell put it. A repository it finds but can't
  read that way (one keeping its refs in reftable, say) exits 4 before the
  call; one that can't be read after the call exits 5. It never reverts
  anything. Ignored files, the contents of a
  submodule that is not checked out, and files outside the repository are
  not checked.
- `--no-tools` asks with no tools at all. Only Claude has such a mode
  (`--tools ""`); Grok and Codex have none, so `ask-model` refuses them with
  exit 4 rather than run them with tools. It cannot be combined with
  `--investigate`.
- `--min-tools` asks with as few tools as each CLI allows, from `--cwd`:
  Claude with none (as `--no-tools`), Grok with `list_dir` only, Codex with
  its shell and other tool features off, web search disabled and the
  read-only sandbox. `--json` adds `tools` (`none` or `restricted`) and a
  `toolsNote` naming what is left. It cannot be combined with
  `--investigate` or `--no-tools`.
- `--x-search` asks Grok what people on X are saying, with Grok's four X
  search tools and no others: every other built-in tool is disallowed, rules
  deny shell, file and fetch tools and MCP tools, and subagents are off.
  Only a family Grok runs can use it, and only on Grok 1.0.92, the version
  its tool list was checked against; any other version exits 4 without
  running. Each run is checked after the run against Grok's session
  record: unless it shows no tool offered and only X searches called, the
  call exits 4 with no answer. `--json` marks `tools` as `restricted` with a
  `toolsNote`. It
  cannot be combined with `--investigate`, `--no-tools`, `--min-tools` or
  `--schema`, and any of those, or a non-Grok family, exits 64.
- Exit codes: 0 answered, 2 another model answered, 3 the CLI (or node) is
  missing, 4 the call failed or returned an error, 5 files changed under
  `--investigate`, 64 a usage error or a role or family that does not resolve.

### Model guide

The Models panel's **Model guide** section puts one generated block into each
harness's global instruction file: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`
and `~/.grok/AGENTS.md`. Every agent reads that file at the start of every
session, so **the block's contents become instructions for every agent
session** — the roles (which family does which job, at what effort, with its
fallbacks and second opinion) and how to brief each family. It names families,
never model ids, and points at `model-id` for the current id.

- The block sits between `<!-- acs:model-guide v1 sep=… sha256:… -->` and
  `<!-- /acs:model-guide -->`. ACS writes only inside it; the rest of the file
  is kept byte for byte, line endings included. Edits made inside the block are
  replaced the next time you update it, and the panel warns before that.
- Adding it is a choice per file. **Add**, **Update** and **Remove** each show
  the whole file before and after, and nothing is written until you accept.
  Accept is refused if the file changed since the diff was made. Every write is
  versioned in history.
- When roles or flavor change, a banner at the top of Models says how many
  files' guides are out of date. **Review and update** opens each file's diff
  right under it, with **Accept** and **Cancel**. Saving a role that leaves the
  guide behind also shows a notice with the same button. ACS never rewrites a
  file on its own.
- A harness whose folder does not exist reads "Not installed"; ACS never
  creates it. A missing file in an existing folder is created holding only the
  block. A symlinked file is written in place, so the link stays a link. Broken
  markers, a file that is not UTF-8, over 1 MB or hard-linked, and invalid
  roles are each shown and refused (removing a block still works while the
  roles are invalid). Hand-written text outside the block is never touched.

## Review gate settings

The studio sets how its own packs behave on **Packs**; everything else it
shows and edits as files. Open **Review gate** on Packs: its page has a
**Settings** section, whose rows appear once its Code review part is
installed (that part ships the scripts that read them). Each choice row
shows one line for the option picked:

- **Security pass**: Off, When code changes, or Always (`security.run`).
- **Agent merge** (`merge.policy`): Off (the default: you merge every PR),
  Docs and tests only, Low-risk PRs, or Low and medium-risk PRs (high-risk
  always waits for you). An agent merges only through `merge.mjs`, and only
  when the review is closed at the tip, CI is green and nobody asked for
  changes. A repo with no CI checks waits for you unless the config sets
  `merge.requireChecks` to `false`. When the `gh` CLI is not on your PATH
  and the pick is not Off, the row warns that agent merge needs it.
- **Always needs you**: a count of the paths no agent merges (built in,
  risky, your own) and **Edit paths**, which opens its own page: the
  built-in paths (`.github/workflows/**`, `package.json`) and the risky
  paths (`riskPaths`, or the review gate's defaults) read-only, and a box
  for your own paths (`merge.alwaysHuman`), one per line.
- **Cross-vendor checks** (`crossFamily`): Prefer another vendor (the
  default; never a blocker) or Off (any reviewer in your roles may check any
  work). The Build pack's Grade follows it.
- **Watch reviews** (`watch`): Sidebar (the default), Sidebar and pane
  (`pane`), or Off. See [Watching reviews](#watching-reviews).

The review gate's steps under **How it runs** end with a **Merge** step,
marked off while agent merge is off.

Every change is written to your home review config only: the first of
`~/.agent-config-studio/review-gate/config.json` and
`~/.claude/review-config.json` that exists, or the first when neither does:
the same order the review script reads its home config in. The Settings
section names that file, with **Open file** when the studio lists it
(`~/.claude/review-config.json` is listed; the studio's own folder is not).

A pick, or typing your own paths, opens a save bar that names each
change. **Cancel** puts back what is saved; **Preview and save**
replaces the bar with that file's diff and **Save**, which writes every
change together, copies the old file into `~/.agent-config-studio/backups/`
once, and keeps every other key. If the file changed after the preview,
Save refuses and the bar returns so you can preview again; if you edited
your own paths after it, Save shows the new preview instead of writing.

### Watching reviews

Inside cmux, a review (and its fix check, slices, security pass, dispute or
eval) and an `ask-model` call show their model calls while they run:

- **Sidebar** (the default): one sidebar line per running reviewer, for
  example `review · sol · watch-tail · 4m · read lib/agent.js`: what it is,
  its family, the branch it runs on (the folder name outside Git), how long
  it has run and its current step. A security pass shows as `security`. The
  line goes when that call ends. If no transcript turns up for a call, its
  line says `running` rather than guess.
- **Sidebar and pane** (`pane`): the same lines, plus one pane on the right
  for the run, with one tab per reviewer, titled like
  `security · astra · watch-tail`, showing only that reviewer's steps. The
  pane opens at the first model call without taking focus, in the review's
  own workspace, and closes with its tabs 30 seconds after the run ends, or at
  once on Ctrl-C.
- **Off**: nothing is shown.

Watching never changes a review: the same output, report and exit code,
whatever the setting. It is a home-config setting only (the Settings section
above, `watch` in your home review config, or `REVIEW_WATCH` for one run); a
repo config that git tracks cannot set it, and an unknown value means off.
It needs cmux and an `acs-agent` that has its `watch` command
(`acs install-model-id` installs it); without either, reviews run as before
and show nothing. The review starts `acs-agent watch` itself, outside any
pane, so it needs no pane of its own. It clears its lines when the review
ends, on Ctrl-C, and, after a hard kill, when the next review starts.

In any terminal, cmux or not, open a pane or split and run `acs-agent tail`:
it prints the running review's steps, each tagged with its reviewer (every
tab of the cmux pane in one stream), and new ones as they come. When that review ends it says
so and waits for the next, so a pane left open keeps showing reviews; Ctrl-C
stops it. `acs-agent tail <run id>` follows one run and exits when it ends;
`--once` prints what is there and exits. Outside cmux the review still starts
the watcher, which writes only that log and never calls cmux.

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
- Re-run after a pull, or after updating the npm package: the installed copy
  does not follow either, and `acs` says so on its first start after an npm
  update. It keeps a copy of the two files it installed from in
  `~/.agent-config-studio/worktree-source/`, which is what that check compares.

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

The studio's **Worktrees** page (Packs → Worktree setup → **Open Worktrees**)
shows the same, per project and read-only: the env summary and done (or why not), from `wls --json` and `wclean
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

## License

MIT — see [LICENSE](LICENSE).
