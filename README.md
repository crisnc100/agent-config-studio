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

**Every save is a commit.** Writes go to the live file *and* to a shadow git repo
at `~/.agent-config-studio/history`, mirrored under `home/`. The History tab on
any file lists every version, diffs it against the current contents, and restores
it in one click. The shadow repo also re-snapshots on startup, so edits you make
outside the studio still land in the history.

Deleting `~/.agent-config-studio` loses the history, never the live config.

**Validation before write.** A save is refused outright if it would break the
file: invalid JSON, malformed TOML, a `SKILL.md` with no frontmatter or missing
`name` / `description`. Softer problems (no shebang on a hook, a 400-line memory
file, a suspiciously short skill description) save with a warning.

**Scope chain.** The `Scope` button answers "what actually applies when an agent
runs in this directory" — the global files plus every `CLAUDE.md`/`AGENTS.md` on
the path down, in the order they layer.

**Compare.** Skills that exist in both harnesses get a Compare tab showing the
Claude and Codex copies side by side. It does not judge them for differing —
a Claude skill *should* describe Codex differently than the Codex copy does.

**Assist.** Shells out to the local `claude` CLI (your existing subscription
auth — no API key). Four actions: Tighten, Critique, Reformat, Improve
description, plus free-form instructions. Results land in a diff you review;
nothing reaches disk until you Apply and then Save. A rewrite that shrinks the
file by more than half gets flagged, because the model occasionally answers with
prose instead of file contents.

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
