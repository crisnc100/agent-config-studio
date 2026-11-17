# Changelog

## 1.4.0 (2026-11-17)

1.3.0 was tagged but never published to npm; this release includes it.

### Added

- **`acs-agent`**: open a builder in any model (Claude, Codex, Grok) as a
  cmux tab you can watch, and drive it with `open`, `wait`, `send`,
  `answer`, `close` and `list`. `wait` never stalls silently: it reports a
  worker that is done, stuck (with why, for example a trust or permission
  prompt) or idle. Named `acs-agent` so it never clashes with Grok's `agent`.
- **Watch reviews** (Packs → Review gate → Settings, or `watch` in your home
  review config): inside cmux, each running reviewer gets a live sidebar line
  with its kind, model, branch, time and current step. With **Sidebar and
  pane**, a narrow pane on the right has one tab per reviewer. **Off** shows
  nothing. Reviews themselves don't change.
- **`acs-agent tail`**: follow the running review's steps in any terminal,
  cmux or not.
- **Pause an account** (Usage): every role skips its models until it resets
  or you resume it; `acs pause` and `acs resume` from the shell.

### Changed

- Builders open as background tabs beside the main agent, titled
  `builder · <model> · <branch>`, so the main agent keeps its screen and
  focus. Grok still opens in its own pane, because it only starts while
  visible.
- A Codex builder in a git worktree can commit: it gets write access only to
  the exact git files a commit needs, never git's config or hooks, plus its
  own private temp folder.

### Fixed

- Usage finds the signed-in Claude login when two keychain items share its
  name.

## 1.3.0 (2026-11-13)

### Changed

- The sidebar is shorter: **Home, Context, Tools, Models, Usage, Memory,
  Packs**, with **Setup**, **Trash** and the theme switch at the bottom.
  - **Context** and **Scope** are one page. It opens on your main
    `CLAUDE.md` and `AGENTS.md`, with their size and an outline, and lists
    projects below with what an agent loads in each.
  - **Tools** gathers skills, subagents, slash commands and MCP servers.
  - **Files** is gone: each file opens from the page it belongs to, and
    **⌘K** finds any file by its name or by what is in it.
  - **Folders** is a step of **Setup**, which also lists settings files and
    hooks. **Worktrees** opens from Packs → Worktree setup.
  - The **Audit** page is gone.
  - Old links (`#files`, `#scope`, `#audit`, `#folders`, `#worktrees`,
    `#skills`, `#mcp`) take you to the new place.
- No text in the studio is smaller than 12px.

### Removed

- The **Shared rules** page (Workflows), its Compare copies view and
  `GET /api/blocks`, added in 1.2.0, along with the Make this copy match and
  Add to files writers built on it after 1.2.0. The studio no longer ships
  reference rule texts in `blocks/`, and nothing in it rewrites a rule in your
  files.
- The skill wizard's **Blocks** step, also from 1.2.0. The wizard goes
  Describe → Interview → Where → Review again, and Review drafts the skill as
  before.

Lines such as `<!-- block:<id> sha256:… -->` and `<!-- /block:<id> -->` that
1.2.0's wizard put in your skills, or the later writers put in your
instruction files, are plain HTML comments: the studio no longer reads or
writes them. Delete them by hand if you like.
