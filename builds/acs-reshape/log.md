# ACS reshape PR 1 — builder log (deliberate choices)

## Where each Files group went (GROUP_HOME in public/app.js)
| Registry group | Opens from |
|---|---|
| memory (global) | Context → main instruction files (size + outline, Open) |
| memory (project) | Context → pick project → its instruction files; load order above it |
| claude-skills, codex-skills | Tools → Skills: an Open button beside each skill row the registry lists |
| plugin-skills, retired | Tools → Skills: "Plugin skills" / "Retired skills" lists below the skills (only before: Files) |
| agents, commands | Tools → Agents and commands, with New subagent / New slash command (only before: Files) |
| mcp (project .mcp.json) | Tools → MCP servers (unchanged view) |
| auto-memory | Memory; MEMORY.md index now has an Open on Memory → Projects (only before: Files) — lib/memory-ops.js projects its path |
| hooks, settings | Setup → new step 4 "Settings and hooks", with New hook (only before: Files) |
| worktrees (rules files) | Worktrees page → "Worktree rules" list + Register a project (only before: Files' + on Worktrees) |
| anything | ⌘K → Search page (#search): search box + Recently opened |

## Choices the plan left open
- **Search page, not a hidden Files page.** ⌘K opens a `search` view (no sidebar item) with the box and Recently opened only; no per-tool file tree. `#files` redirects there.
- **Audit removed in full on the client** (team-lead approved): page code, Home's audit attention line and /api/audit/summary fetch, Setup's "Open Audit" button, audit CSS. Server routes and tests stay. `#audit` → Home.
  The fix-preview UI is recoverable from git for PR 2/4: `git show c927783:public/app.js`, section "Audit view" (openAudit … dismissAudit; the one-file preview is proposeAudit + auditProposalView), its CSS in `git show c927783:public/styles.css` ("audit view"), and its tests in `git show c927783:tests/audit-ui.mjs`. Removed in ded9606 (code) and a85ed82 (tests).
- **Tools sections as tabs** (`#tools/skills|agents|mcp`), the sidebar's Tools reopening the last section. `#skills`, `#mcp` redirect to their section; `#skills/new` stays the wizard's hash, Tools marked.
- **Context project picker** = the projects /api/context reports (each with instruction files), plus a folder picker for subfolders from /api/scope/dirs (what Scope's single select offered). A project with no instruction file at all is not listed: its load order is the main files, shown above.
- **Setup's folders step absorbed Folders' read-only facts**: missing badge, skipped entries, unreadable roots.json, and where to edit roots.json. Setup's Done step drops "Open Audit".
- **Setup follows a step hash at runtime** (`moved` on its VIEWS row), so `#folders` lands on the folders step even with Setup open.
- **Worktrees** has no sidebar item; parent `packs`, so Packs stays marked; the Worktree setup pack page gets a "Your worktrees" section with Open Worktrees.
- **A file opened from a bare link** (`#file=`) marks the page that lists it (GROUP_HOME), not Files.
- **"Open in Files"** on the review-gate settings footer is now "Open file".

## Deviations
- **Skill quick-scaffold (+ on Skills) is gone**; creating a skill goes through the New skill wizard (Claude or Codex destinations). Every other create action keeps a button.
- **Files' per-type caps ("Show all N")** have no successor: the new lists show every entry (no folds).
