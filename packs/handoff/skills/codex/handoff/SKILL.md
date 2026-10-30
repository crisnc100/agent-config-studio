---
name: handoff
description: Generate a handoff.md that lets another agent session (any tool) resume work without losing context. A structured baton-pass — goal, current state, files in flight, what changed, failed attempts, next step — not a session summary. Use when context is running low, switching tools/machines, or passing work to someone else.
---

# handoff — context baton-pass for the next agent

Write `handoff.md` for the *next* agent (Claude Code, Codex, or Cursor) to read first. Not a journal; a resume-here file.

## Where to save

Find the project root (walk up for `.git`, `package.json`, `pyproject.toml`, `CLAUDE.md`, or `AGENTS.md`). Then:
- `docs/` exists → `docs/handoff.md`
- else → `<project-root>/handoff.md`

Tell the user the path before writing. If a handoff already exists there, ask whether to replace, append a dated section, save as `handoff-YYYY-MM-DD.md`, or cancel. Never silently overwrite.

## Content (pull from THIS session; don't make the user re-explain)

Required, in order:
1. **Goal** — what we're building and why. One paragraph.
2. **Current State** — where it stands, concretely.
3. **Files in Flight** — active files with absolute paths, one line each on what's changing.
4. **Changed This Session** — what's done or staged (distinct from in-flight).
5. **Failed Attempts** — what was tried, what happened, why it failed. The most valuable section; it stops the next agent from repeating dead ends. None → say "None so far."
6. **Next Steps** — the single most important next action (or a prioritized list). Specific enough to act without asking.

Optional: **Key Context** (non-obvious constraints/decisions), **Open Questions** (unresolved decisions).

## After writing

Report the exact path, a one-line summary of what was captured, and remind the user the next agent starts with `Read <path>`.

## Tips

- Write for the next agent, not yourself. Absolute paths. Assume zero memory.
- Be brutally honest in Failed Attempts. "Tried X, didn't work, unsure why" beats glossing over it.
- One next step beats five. Pick the most important yourself.
- Don't pad. Empty section → say so or omit it.
