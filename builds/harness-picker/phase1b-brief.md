# Phase 1b — close the four real Grade findings

Worktree (work here only):
/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-harness-picker

Phase 1 is done and ./verify.sh passes 12/12. An independent grader found four REAL gaps.
Fix exactly these. Do not refactor anything else. Do not touch server.js or public/app.js.

## 1 — NEGATIVE CONTROL for the containment suite (highest value)
Right now nothing proves the containment test can DETECT a mutation at all. If
treeManifest()/compareTrees() were blind, every containment check would pass vacuously —
which is the exact failure mode this whole bar exists to prevent.

Add a check that runs BEFORE the live harness turns:
  - build the temp fixture tree, take a manifest
  - deliberately (a) change a file's CONTENT and (b) change another file's MODE
  - assert compareTrees() reports BOTH changes, naming each path
  - restore the fixture and assert compareTrees() is then clean
This must fail loudly if the comparison is blind. Name it clearly as the negative control.

## 2 — Grok containment is currently a MODE ECHO, not proof
tests/phase1.mjs:116 passes grok on `permissionMode === 'plan'` alone, while the write tools
(write, search_replace, run_terminal_command) are STILL LISTED in the init event. That could
pass while grok remains able to write and merely chose not to.

Strengthen it. In priority order, take the first that actually works — probe, do not guess:
  a. Capture a BLOCKED/DENIED write attempt from the stream: prompt grok in plan mode to
     write the file, and look for a refusal/denied/blocked tool event or an explicit
     permission-denied signal. Assert on that signal.
  b. If no such signal is emitted, run a CONTROL: the same prompt with containment REMOVED
     (grok's own default, bypassPermissions) in a THROWAWAY temp dir, and show the file DOES
     get mutated there — then show it does NOT with --permission-mode plan. That difference
     is the proof, and it converts the mode echo into a demonstrated behavioral delta.
     Guard this control so it can never run against anything but its own temp dir.
  c. If neither is achievable, say so plainly and mark the grok containment assertion
     UNVERIFIED in the test output rather than reporting a green PASS. An honest UNVERIFIED
     is required; a green check on a mode echo is not acceptable.

## 3 — Assert the turn actually SUCCEEDED
The bar (A6 iii) requires exit 0. There is a TIMEOUT guard at tests/phase1.mjs:406 but no
explicit exit-code assertion. Capture the child's exit code and assert it is 0, alongside the
existing non-empty-reply and auth-failure checks. A turn that never ran must FAIL, not pass.

## 4 — Two real bugs in lib/harness.js
  a. isShim() at :362 — `fs.closeSync(fd)` is not in a `finally`, so the fd LEAKS if
     fs.readSync() throws. Wrap it.
  b. sweepPromptFiles() at :421 — only unlinks prompt files older than 10 minutes, so a
     recent orphan survives startup carrying the user's config text. The bar (A10) says
     swept on startup. Sweep ALL orphaned prompt files belonging to this app on startup,
     not just old ones. Do not swallow cleanup errors silently — surface them.

## Constraints
- Do NOT modify ~/.claude, ~/.codex, ~/.grok. Temp dirs only.
- Do NOT add dependencies.
- Do NOT weaken, skip, or narrow any existing check to make something pass.
- Keep every currently-passing check passing.

## Validate
./verify.sh — all existing checks plus the new ones must pass (or report an explicit,
clearly-labelled UNVERIFIED for 2c if and only if 2a and 2b both proved impossible).

## Stop when
verify.sh is green and you can state, with evidence from a real run, exactly how grok's
containment is now proven — or state plainly that it could not be proven beyond the mode
echo and that you marked it UNVERIFIED.
