---
name: handoff
description: Create a context handoff file so another Claude agent (or a future session) can pick up cleanly when context runs low. Captures goal, current state, files in flight, what's changed, failed attempts, and next steps.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# /handoff — Context Handoff

Write the file a future session reads first. Not a session summary and not a journal entry — a baton-pass: what we're doing, where it stands, what already failed, and what to do next.

## Step 1 — Where it goes

Ask git rather than guessing from the folder name; a directory named `<project>-main` is often sitting on a feature branch.

```bash
git rev-parse --show-toplevel      # worktree root
git rev-parse --abbrev-ref HEAD    # branch
```

On `main`, `master`, `staging`, `production`, `develop`, or a detached `HEAD` — **don't write.** Say which branch they're on and offer to cut a feature branch, or to write outside the repo if they just need the state captured.

Otherwise the path is `<root>/docs/handoffs/<branch>.md`, with any `/` in the branch name becoming `-`, or `<root>/.handoffs/<branch>.md` if there's no `docs/`. Confirm it's ignored before writing:

```bash
git check-ignore -q <path> && echo IGNORED || echo NOT-IGNORED
```

If it isn't, fix that before writing: add the directory to `.gitignore`, and if the path is already tracked (`git ls-files --error-unmatch <path>` succeeds) untrack it with `git rm --cached <path>` — an ignore rule does nothing to a file git already follows. A committed handoff rides the next PR into the default branch and is then inherited by every worktree cut afterward — preventing that is why this file is scoped to a branch at all.

Outside a git repo there's nothing to leak into: use `docs/handoff.md`, or `<root>/handoff.md`.

## Step 2 — What to capture

Pull it from the session you've been in — don't make the user re-explain. Write for someone who remembers nothing: absolute paths, no "as discussed." If a section is genuinely empty, say so instead of padding it.

1. **Goal** — what we're building and why. One paragraph.
2. **Current State** — where it stands, concretely. What works, what doesn't.
3. **Files in Flight** — what's open right now: absolute path plus a line on what's changing in each. This is what tells the next agent where to start reading.
4. **Changed This Session** — what's already done, saved, or staged, as distinct from still in flight.
5. **Failed Attempts** — what was tried, what happened, and why it failed. The most valuable section in the file, because it's what stops the next agent walking back down a dead end. "Tried X, didn't work, not sure why" is worth more than leaving it out.
6. **Next Steps** — the single most important next action. List five and the next agent picks the easiest one; pick for them.

Add **Key Context** for non-obvious constraints or decisions, and **Open Questions** for anything the user still has to settle — only if they exist.

## Step 3 — Write it

If a handoff for this branch already exists, replace it. It's a stale snapshot of the same work — but read its Failed Attempts first and carry forward anything you didn't already know. A bare `docs/handoff.md` left over from the old shared-file scheme isn't yours: don't read it or extend it, just mention it so it can be deleted.

````markdown
# Handoff — <short description of the work>

**Branch:** `<branch>`
**Created:** <YYYY-MM-DD HH:MM>
**From session:** Claude Code

> If this isn't the branch you're on, this handoff isn't yours — ignore it.

---

## Goal

<one paragraph>

## Current State

<what works, what doesn't>

## Files in Flight

- `<absolute path>` — <what's changing in it>

## Changed This Session

- <file or area> — <what changed>

## Failed Attempts

- **Tried:** <what was attempted>
  **Result:** <what happened>
  **Why it failed:** <root cause, or "unknown — needs investigation">

## Next Steps

1. <the one thing to do next>

## Key Context

<only if non-obvious context exists>

## Open Questions

<only if there are unresolved decisions>
````

Drop the **Branch** line outside a git repo.

## Step 4 — Confirm

Give the path, and say whether you replaced an earlier handoff and when it was from. One line on what was captured, and how to point the next agent at it. The file is the output — don't restate its contents in chat.
