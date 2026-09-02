# Phase 1c — finish the containment proof (3 items)

Worktree (work here only):
/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-harness-picker

STATE: ./verify.sh currently reports 11 passed, 1 failed. The one failure is CORRECT and
INTENTIONAL — the grok containment assertion now honestly refuses to pass on a mode echo:
  "grok write was not demonstrably prevented: permissionMode=plan is a mode echo while
   write tools remain listed (write,search_replace,run_terminal_command)"
Two earlier fixes already landed (isShim fd `finally`, sweepPromptFiles error surfacing).
DO NOT redo those. DO NOT refactor anything else. DO NOT touch server.js or public/app.js.

Three items remain.

## 1 — NEGATIVE CONTROL (do this first; highest value)
Nothing currently proves the containment suite can DETECT a mutation at all. If
treeManifest()/compareTrees() were blind, every containment check would pass vacuously —
the exact failure this bar exists to prevent.

Add a check that runs BEFORE the live harness turns:
  - build the temp fixture tree, take a manifest
  - deliberately (a) change one file's CONTENT and (b) change another file's MODE
  - assert compareTrees() reports BOTH, naming each changed path
  - restore the fixture, assert compareTrees() is then clean
Label it clearly as the negative control. It must fail loudly if the comparison is blind.

## 2 — Make grok's containment provable (turn the honest FAIL into an honest PASS)
Probe, do not guess. Take the first that actually works:
  a. BLOCKED-WRITE SIGNAL: prompt grok, in --permission-mode plan, to write the file, and
     look in the stream for a refusal / denied / blocked / permission tool event. If such a
     signal exists, assert on it.
  b. BEHAVIORAL CONTROL (preferred if (a) yields nothing): in a THROWAWAY temp dir, run the
     same mutation prompt TWICE —
       once with containment REMOVED (grok's own default, which is bypassPermissions)
       once with --permission-mode plan
     Assert the file IS mutated in the first and IS NOT in the second. That delta is real
     proof of prevention rather than a mode echo.
     HARD GUARD: the uncontained run must be structurally incapable of touching anything
     outside its own freshly-created temp dir — assert the target path is inside the temp
     dir immediately before running, and never point it at the repo, $HOME, ~/.claude,
     ~/.codex or ~/.grok. If you cannot guarantee that guard, skip (b) and go to (c).
     Note: this is the ONLY place an uncontained spawn is permitted, and only against a
     throwaway temp dir. It must not weaken composeArgv's refusal for normal spawns.
  c. If neither works, leave the assertion as an explicit, clearly-labelled UNVERIFIED in
     the output — NOT a green PASS — and say so in your report.

## 3 — Assert the turn actually SUCCEEDED
The bar requires exit 0. There is a TIMEOUT guard (tests/phase1.mjs ~:406) but no explicit
exit-code assertion. Capture the child's exit code and assert it is 0, alongside the existing
non-empty-reply and auth-failure checks. A turn that never ran must FAIL, not pass.

## Constraints
- Do NOT modify ~/.claude, ~/.codex, ~/.grok. Temp dirs only.
- Do NOT add dependencies.
- Do NOT weaken, skip, or narrow any existing check to make something pass.
- Every currently-passing check must stay passing.

## Validate
./verify.sh

## Stop when
verify.sh is green, OR grok's containment is explicitly marked UNVERIFIED with the reason.
Report: which of 2a/2b/2c you used, and the evidence from the real run that proves it.
