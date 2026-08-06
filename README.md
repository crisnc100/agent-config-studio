# Agent Config Studio

A local web app for reading, editing, and versioning every Claude Code and Codex
config surface on this machine — in one place, rendered properly.

```
acs          # start it and open the browser
acs stop     # shut it down
```

Then: <http://localhost:8787>

## What it manages

| Group | Source |
|---|---|
| Memory | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/Documents/Projects/CLAUDE.md`, every repo-level `CLAUDE.md` / `AGENTS.md` |
| Claude skills | `~/.claude/skills/*` (follows the symlink into `~/.agents`) |
| Codex skills | `~/.codex/skills/*` |
| Plugin skills | enabled plugins only, read from the plugin cache |
| Auto-memory | `~/.claude/projects/*/memory/*.md` — what the harness wrote itself, one bucket per project scope |
| MCP servers | project `.mcp.json` (editable); global + Codex servers read-only under **MCP** |
| Subagents | `~/.claude/agents/*.md` — appears once the directory exists |
| Slash commands | `~/.claude/commands/*.md` — appears once the directory exists |
| Hooks | `~/.claude/hooks/*.sh` |
| Settings & config | `settings.json`, `settings.local.json`, `advisor-config.json`, `investigate-config.json`, `review-config.json`, `~/.codex/config.toml`, `~/.codex/rules/*` |
| Retired | `~/.claude/skills_retired/*` |

Everything is editable. Nothing outside `~/.claude`, `~/.codex`, `~/.agents`, and
`~/Documents/Projects` is reachable, and `.credentials.json` / `auth.json` are
hard-blocked from both reads and writes.

## The parts that matter

**Rendered, not raw.** Markdown files render with real typography — headings,
tables, code blocks. YAML frontmatter becomes a metadata card instead of the
giant bogus heading Markdown would otherwise make of it.

**Only what is loaded.** The plugin cache holds 230 skills across marketplaces
that are merely installed. Only skills from plugins actually enabled in
`settings.json` are listed, because only those are ever loaded.

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
would restore them on its next update), and anything outside the allowed roots.
The three always-loaded singletons — global `CLAUDE.md`, global `AGENTS.md`, the
workspace `CLAUDE.md` — plus `settings.json` and friends delete only after you
type their name.

**It watches for changes made outside the studio.** Claude Code writes
auto-memory, you install a skill from the terminal, an agent edits a CLAUDE.md —
the sidebar updates live rather than going stale until a reload. The green dot
in the status bar means the watch is connected.

If the file you have open changes on disk, it reloads in place; if you have
unsaved edits it warns instead, because the save would be refused anyway. If the
open file is deleted, it tells you rather than leaving a phantom editor.

Only the directories the registry cares about are watched (28 of them). A
recursive watch on `~/.claude` would be a firehose — session transcripts,
file-history and the plugin cache are nearly all of its ~2GB and churn
constantly.

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
strings, multi-line strings, and values spanning several lines — a line-by-line
check rejected valid arrays while accepting unterminated strings. The rule
throughout: error only on definite breakage, warn when merely unrecognised. A
false rejection that blocks a legitimate save is worse than a missed problem.

**Nothing executable renders.** Markdown is sanitized after parsing — script,
iframe, `on*` handlers and `javascript:` URLs are stripped. The preview shows
third-party plugin skills and model-generated assist output, and those would
otherwise run with same-origin access to the write API.

**Credentials stay out.** `~/.claude/.credentials.json` and `~/.codex/auth.json`
are hard-blocked. `~/.claude.json` is never exposed through the file API either —
it holds oauth tokens and API-key responses alongside the MCP config, so only its
`mcpServers` key is extracted, read-only.

**Scope chain.** The `Scope` button answers "what actually applies when an agent
runs in this directory" — the global files plus every `CLAUDE.md`/`AGENTS.md` on
the path down, in the order they layer.

**Compare.** Skills that exist in both harnesses get a Compare tab showing the
Claude and Codex copies side by side. It does not judge them for differing —
a Claude skill *should* describe Codex differently than the Codex copy does.

**Assist is a chat, and you point it at the files.** Open it from anywhere —
no need to navigate to a file first. Attach targets with `@` (autocomplete over
all 719 files), say what you want, and edits come back as a **diff per file**
that you Accept or Reject individually. Accepting goes through the same save
path as manual editing, so it is validated and versioned like everything else.

It never picks targets for you. Nothing outside the files you attached is ever
edited — if the model references one you did not attach, that edit is dropped.

Why it stays short: the model replies with anchored search/replace blocks, not
whole-file rewrites, so a one-line rule change produces a few lines of output
rather than re-emitting the file. Every block must match its anchor **exactly
once**; ambiguous or overlapping edits are refused rather than guessed at.

Replies stream token by token — first text lands in ~3s. There is a live elapsed
timer and a Cancel button that kills the underlying process. Sonnet 5 is the
default because Opus 5 took 107s on a whole-file review; Opus stays selectable
for when you want the judgment. Follow-up turns resume the same CLI session, so
the conversation keeps context without re-sending the files.

It shells out to your local `claude` CLI, riding your existing subscription auth
— no API key is read or stored, and the server makes no outbound request of its
own.

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
- Symlinks resolve to their real target. `airflo-parts-master/AGENTS.md` is a
  symlink to its `CLAUDE.md`, so it shows as one entry serving both harnesses
  rather than two copies.
- No dependencies. Node stdlib server, one vendored file (`marked`) for markdown
  rendering.
