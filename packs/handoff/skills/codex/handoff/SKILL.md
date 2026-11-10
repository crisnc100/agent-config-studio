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

An orchestrator thread — a session that runs work across several repos or worktrees, or from a folder that is not one — instead writes `HANDOFF-<thread>.md` (a short name for the work) in the nearest folder at or above the working folder that is not inside a git repo. Other threads can share that folder: reuse an existing `HANDOFF-*.md` there only when its Goal is this thread's work (its **Thread:** line names only the shared folder), and replace it in place each time, without asking. When none matches, write a new `HANDOFF-<thread>.md` under a name no file there has, and never replace another thread's file or carry its items forward.

Tell the user the path before writing. If a handoff already exists there (other than a thread file), ask whether to replace it, save as `handoff-YYYY-MM-DD.md`, or cancel. Never silently overwrite. Before replacing any handoff, read its Failed Attempts, Waiting on the user and Later (do not start), and carry forward every item not known to be resolved. One file holds one Next objective.

## Content (pull from THIS session; don't make the user re-explain)

Required, in order:
1. **Goal** — what we're building and why. One paragraph.
2. **Current State** — where it stands, concretely.
3. **Files in Flight** — active files with absolute paths, one line each on what's changing. Delegated work goes here by location: worktree, branch, PR, and what to do with its report: only steps the user already approved; anything else is "bring the report to the user", under Waiting on the user. An agent's name dies with the session.
4. **Changed This Session** — what's done or staged (distinct from in-flight).
5. **Failed Attempts** — what was tried, what happened, why it failed. The most valuable section; it stops the next agent from repeating dead ends. None → say "None so far."
6. **Next objective** — the one action to take next, already approved by the user, and how to tell it is done. Never put an offered or proposed item here.
7. **Waiting on the user** — what needs their decision or go-ahead, each with the question.
8. **Later (do not start)** — parked work.

Optional: **What worked** (approaches worth repeating), **Key Context** (non-obvious constraints/decisions).

## After writing

Report the exact path, a one-line summary of what was captured, and remind the user the next agent starts with `Read <path>`.

## Tips

- Write for the next agent, not yourself. Absolute paths. Assume zero memory.
- Be brutally honest in Failed Attempts. "Tried X, didn't work, unsure why" beats glossing over it.
- One next objective beats five. Pick the most important approved one yourself.
- Don't pad. Empty section → say so or omit it.
