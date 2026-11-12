# Packs redesign, PR 2: deliberate choices

The plan, direction and mock live in `skills-work/builds/packs-redesign/`. This log records the calls the brief and
direction did not settle, so a reviewer can tell a choice from a slip.

## Routing

- A second VIEWS row, `pack` (no sidebar item, `parent: 'packs'`), owns `#packs/<id>` through a `match` function;
  `viewForHash` replaces the two `hashIs` lookups. Its `hash` is `#packs/setup`, a real page, so the shell suite's
  "every VIEWS hash opens its view" check covers it unchanged.
- `#packs/setup` is the shared-fixes page: `setup` is reserved in the pack-id slot. No pack uses that id.
- Moving between the grid and pack pages repaints from the state already read; only entering Packs from another view
  reads the catalog, roles and status again (the R3 "roles fresh on open" rule still holds).
- In-app navigation sets `location.hash`, then paints; the hash change it fires finds the page already shown.
- Focus after an in-app navigation goes to the back button (pack page) or to the card just left (grid). A heading
  is never focused on load: Chrome drew a ring round it.

## Grid

- Card status order: Update ready, then Needs setup (a need of the pack's own; shared needs are said once above the
  grid), then Installed, then Not installed. A not-installed pack that needs setup still gets Install: its preview
  shows what is missing.
- The CLI chips use an SVG check, not a "✓" glyph; an absent CLI's reason is in the chip's title.
- The status line drops "with/without the Codex trust check" from its text; it is the line's title now.
- The chevron is `.pk-card-go`: ui-words forbids a `.chev` class (it meant a fold toggle).

## Pack page

- Update shows only when it helps: a newer version, an edited part, or a part the status check says an update
  fixes (a missing file). An unset role marks a part "Not working" but does not offer Update.
- Part status words: On, Off, Edited, Update ready, plus two the server can report that the direction did not name:
  "Not working" (broken) and "New CLI here". The server's full words are the status's title.
- A part with "New CLI here" gets Add… (installing it for the new CLI) instead of Remove…: one action per row. The
  pack's Uninstall… still removes it.
- The last installed part's Remove… previews the pack's uninstall, as the old page hid a lone part's remove.
- Install for and the dependency offer live in the install preview; changing either previews again (the old page
  dropped the preview and waited for another click).
- A stale preview (409) keeps its box with the error and a "Preview again" button, under the same action.
- Installer output shows in place, in a short scrolling box. Packs opens no dialog; `pkDialog` stays in
  packs-view.js because Models' "Used by" and the skill wizard's reply use it, with its CSS.
- What it does: three tiles per pack written from `explain.does` (review gate's from direction.md); handoff and
  worktree get two. The tiles and the card one-liners are page copy in packs-view.js, not pack.json fields.
- Files and undo, What it changes: each `explain.changes` entry is split into its path and a plain line where it
  starts with a path; "On this machine" lists, per part, the CLIs it is installed for and the status check's details.
  Per-part change lists are not repeated here: each Add… preview lists the exact paths.
- The page header shows only the pack's own missing need and its fix. The met-requirements list is gone (less text);
  "Ready to run" stands for it.
- The R8 promise line ("The studio sets how its own packs behave here…") is replaced by direction.md's grid lead.
  The top bar's subtitle for Packs is shortened so it does not repeat the lead.

## Settings

- Moved as #75 built them, inside a panel; restyled only for the scales (13px choice lines, sentence-case labels).
  The row redesign is PR 3.

## Styles

- Spacing and type scales are a separate `:root` rule at the start of the Packs section; the colour token block is
  untouched (PR 1 edits it in parallel). The shell suite now looks tokens up in every `:root` rule.
- Old `.pk-badge`, `.pk-ready`, `.pk-todo-title`, `.wf-sw`, `.pk-flow .flow.rows` and the arrow masks are gone with
  the markup that used them.

## Not done here

- No server or API change.
- The Setup trust checkbox shows under Codex whether or not Codex is installed: it is a preference.
