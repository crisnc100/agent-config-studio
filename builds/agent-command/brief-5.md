# Fix-check findings + one live finding. Fix all three (test first: each test fails on 600fb4f, then passes).

## x1 HIGH (protected) lib/agent.js:524 — s2 repair incomplete
An unresolved approval can still receive Enter. When a parallel command has exceeded 600 seconds, refresh selects long_command ahead of a newer PermissionRequest. Claude's actual file-edit question, "Do you want to make this edit to …?", also escapes approvalDialog. An in-memory reproduction recorded both text and Enter reaching the pending dialog.
Trigger: a Claude worker has a parallel command open >600s and a newer file-edit approval pending; agent send while Yes is selected.
Fix: `send` refuses whenever ANY unresolved approval/permission request exists (hook or screen), independent of which state `wait` reports first; `wait` reports stuck ahead of long_command/stalled when both hold. Recognize Claude's edit/write/fetch approval questions ("Do you want to make this edit to", "Do you want to create", "Do you want to …" with numbered Yes/No choices) — collect the real strings from the installed Claude Code bundle, as you did for trust.

## x2 MEDIUM lib/agent.js:264 — ordinary answer text mistaken for a dialog
A finished answer containing a standalone "Would you like to proceed?" matches the screen detector with no choices and no permission hook; wait says done, then send exits 3 and refuses the follow-up.
Fix: a screen dialog needs the question AND its choice rows (e.g. "1. Yes"/"❯ Yes"/"Yes, proceed … y"), in the bottom region of the screen, not anywhere in scrollback.

## g1 (live, orchestrator) — Grok trust dialog reported as no_start
Opened Grok in a brand-new worktree; it showed its trust dialog and `agent wait` returned `no_start` after 150s. The screen as read in the narrow tab pane wraps/cuts the header:
"Do you trust the contents of this" / "/Users/cortega/Documents/Projects" / "Grok Build may run or modify cont" / "     posing security risks." / "  Yes, proceed                y  " / "  No, quit                    n  "
Fix: match the trust dialog from fragments that survive narrow wrapping (header prefix "Do you trust the contents of" + both choice rows), per harness; add this exact screen as a fixture. Also: `agent answer` on a worker that never finished printed the raw screen — it should exit non-zero with "no answer yet (state …)".

Same constraints and grouping. Don't run the rig. Reply DONE with one line per finding.
