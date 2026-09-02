# Phase 3 — CI checks + RUNBOOK.md

Worktree (work here only):
/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-harness-picker
Branch harness-picker. ./verify.sh is 24/24 green (15 phase1 + 9 phase2a). Repo is now on
GitHub at crisnc100/agent-config-studio (private), PR #1 open.

## The constraint that shapes this
verify.sh makes LIVE, AUTHENTICATED model calls. GitHub Actions has no `claude` or `grok`
binary and no auth, so most of the suite CANNOT run there.
tests/phase1.mjs:616 deliberately FAILS when no harness is detected ("a skipped containment
test would pass vacuously") — correct locally, fatal in CI.

So CI must run the OFFLINE subset and must be HONEST that it did. A green CI tick that
silently omitted the containment checks would be exactly the vacuous pass this whole branch
was built to prevent. Do not weaken tests/phase1.mjs's local behavior to make CI pass.

## Task 1 — an offline suite mode
Add an explicit offline mode (e.g. `ACS_SUITE=offline`, your call, document it) that runs
ONLY checks needing no harness binary and no network:

phase1 offline-able (by current line):
  366 contract: descriptors have required fields + non-empty containment
  376 chokepoint: composeArgv appends containment when buildArgs omits it
  389 chokepoint: empty containment refuses to spawn
  422 (e) non-JSON noise line skipped
  438 (e) is_error:false not terminal
  454 (e) split/partial-UTF-8 delta reassembles
  469 (d) codex-shaped descriptor satisfies the contract and routes
  572 negative control: compareTrees detects content and mode mutations

phase2a: audit each of the 9. Any that already use a fake/mocked turn and createApp are
offline-able. Any that genuinely require a detected binary are not — classify honestly,
do not force one into offline by stubbing away what it was testing.

REQUIREMENTS:
- Offline mode must print a LOUD, unmissable banner naming exactly which checks did NOT run
  and stating that containment is NOT verified in this mode.
- Its exit code must still be 0 only if every check it DID run passed.
- The default (no env var) stays the full local gate. verify.sh behavior is unchanged.

## Task 2 — .github/workflows/ci.yml
A single workflow on push + pull_request. Node 20 (package.json says engines >=20). No deps
to install — the repo has zero, keep it that way. Jobs:
  1. syntax: `node --check` on every .js/.mjs in lib/, tests/, public/, plus server.js
  2. offline suite: the mode from Task 1
  3. STATIC SECURITY GUARDS — these catch regressions of the properties this branch
     established, and they cost nothing:
       a. no `zsh -lc` (or any shell-string spawn) reintroduced anywhere in lib/ or server.js
          — spawns must exec the resolved absolute binary
       b. no `spawn(`/`execFile(`/`exec(` of a harness binary outside lib/harness.js's
          spawnContained — i.e. the chokepoint stays the only spawn site
       c. every descriptor's `containment` is a non-empty array (belt and braces with the
          contract test)
       d. no `--allowedTools` / `--disallowedTools` / `--disallowed-tools` /
          `--permission-mode` used AS containment — those were all measured to leak; the
          allowlist `--tools` is the only accepted containment mechanism
     Implement these as a small node script (tests/guards.mjs or similar) so they run
     locally too, not just in CI. Each guard must print WHY it exists when it fires — a
     future reader must not "fix" the failure by deleting the guard.
  4. the workflow must state in its output that live containment checks are a LOCAL gate
     (`./verify.sh`) and were not run here.

## Task 3 — RUNBOOK.md (repo root)
For an operator, not a tourist. Concise, accurate, no marketing. Cover:
- What this app is in two sentences, and the one safety property that matters: Assist
  proposes @@EDIT diffs for review and must never write to disk itself.
- Run it: `acs` / `acs stop`, or `node server.js` (127.0.0.1:8787, PORT/ACS_PORT to change).
- Harnesses: which are supported, how detection works (real binary, rejects cmux shims),
  how to add a new one (the descriptor contract fields), and that a descriptor with empty
  containment refuses to spawn by design.
- Containment: state plainly that it is an ALLOWLIST and WHY — include the measured table of
  what leaked (claude wrote via `Workflow` and grok via `spawn_subagent` despite their
  denylists naming every write tool; grok ignored `--permission-mode plan` entirely). This
  is the single most important thing for a future maintainer not to undo.
- Testing: `./verify.sh` is the full gate and needs authenticated CLIs; the offline mode and
  what it does NOT cover; that live checks are variance-prone (grok ranged 21-133s) so an
  occasional red is not necessarily a regression; and that the suite is deliberately built
  to be unable to pass vacuously (negative control, positive controls, exit-0 assertion).
- Troubleshooting: grok slow first token (~39s, up to 133s total) is normal; `codex`/`grok`
  on PATH may be a cmux shim; MCP transport warnings on stderr are noise and are NOT treated
  as failure; a 409 means a session id was sent with the wrong harness.
- Known residuals: grok still connects MCP servers though they are out of the tool set; the
  uncontained-probe guard checks cwd and cannot stop an absolute-path write; no Codex adapter
  yet though the contract accommodates one (streams:false).

## Constraints
- Do NOT add dependencies.
- Do NOT weaken, skip, or narrow any existing check.
- Do NOT modify ~/.claude, ~/.codex, ~/.grok.
- Match the repo's existing prose voice: terse, concrete, explains WHY. No marketing tone,
  no emoji, no filler.

## Validate
- `./verify.sh` still 24/24 locally
- the offline mode runs green and prints its banner
- the guards script passes, and you have MANUALLY confirmed each guard actually FIRES when
  its property is violated (temporarily break it, see it fail, restore) — a guard that
  cannot fail is worse than no guard. Report what you observed for each.
- `node --check` clean everywhere

## Stop when
CI workflow, guards, offline mode and RUNBOOK.md exist, verify.sh is still 24/24, and you
have shown each guard firing. Report what you verified by running vs. only reasoned about.
