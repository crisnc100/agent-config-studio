# Plan — build 3: ready for strangers

Part of `../configurable-roots/program.md`, the final build. Builds 0–2 are merged (#18, #19, #20).

## Outcome
A stranger on a Mac clones the repo, follows the README, and within about 10 minutes, without help, has:
- `acs` on their PATH;
- the setup screen completed;
- their CLIs, seats, folders, skills, context and models showing.

Nothing in the shipped code or docs assumes Cris's machine. On Linux the server half works (CI-gated), and the README says plainly which extras are best-effort. Grok Assist is contained deterministically.

## Work
1. **README "Get started"** (rewrite the top; keep the reference sections):
   - Prerequisites: Node version (read from what the code actually needs, e.g. `fs.promises.opendir`, `for await` on Dir; state the minimum, verified with `node --version` checks in CI or the launcher), git, and at least one of claude/codex/grok. Each install command comes from `builds/setup-screen/commands.md` (single source).
   - Steps: clone → `./bin/acs` → setup screen → Home.
   - Putting `acs` on PATH: the one recommended way, plus its uninstall.
   - What ACS never does: reads credentials, edits outside your chosen folders, phones home.
   - Linux notes: what works and what is best-effort (worktree kit zsh/macOS, lsof locations).
   - Troubleshooting: port in use, a CLI not found (Recheck), the macOS folder-access prompt, how to re-run setup, how to stop or uninstall.
   - Remove Cris-specific content from the README: `airflo-parts-master`, Garman, personal paths and seat counts. Garman stays only as migration code, which isn't user-facing.
2. **`acs` on PATH works from a symlink.**
   - `bin/acs` resolves its own checkout through symlinks, without GNU-only `readlink -f`; it must work on macOS sh/zsh and dash.
   - Add `acs install` (or `acs link`): it symlinks `acs` into a PATH directory. It picks `~/.local/bin` or another writable dir already on the login PATH. If none exists, it prints the line to add to the shell profile and never edits a profile without saying so. Also add `acs uninstall`/`unlink`.
   - The setup Done step and the README show this command.
3. **No remaining Cris-machine assumptions in the code.**
   - `lib/models.js:270` scans `~/Documents/Projects` for review configs; it must use the roots registry. models.js is copied standalone into the resolver, so pass roots in from the caller, or read roots.json directly there with a reasoned allowlist entry.
   - Sweep lib/, bin/, server.js, public/ and tools/ for any other hardcoded personal path, account, name or seat count, and fix each one. A test asserts that no source file (outside tests and migration) contains `Documents/Projects`, `Garman`, `cortega`, or `/Users/`.
4. **Grok Assist containment, fail-closed** (the "flake").
   - What we know: tests/phase1.mjs intermittently sees grok's init report 134 tools (its ~/.grok MCP servers) instead of `[read_file]`. The containment flags (`--tools read_file --disallowed-tools search_tool,use_tool`) are the SAME ones Assist uses in production (lib/harness.js:62). And nothing at runtime checks the init event.
   - The fix comes in two layers, by class:
     - **(a) Runtime enforcement for every harness.** spawnContained/chat reads the stream's init event. If the effective tool set isn't exactly the harness's allowed read set, it kills the child before any tool call is processed, ends the turn with a plain error ("Grok started with extra tools (MCP servers); Assist stopped. …"), and applies no edits. Same rule for claude (`Read`). The rule lives in one place, shared by phase1.mjs and runtime.
     - **(b) Make grok start contained deterministically, if grok 1.0.x has a mechanism.** Candidates: a `--deny` rule pattern for MCP tools; a per-invocation config/home override that loads no MCP servers without losing auth; an MCP-disable env. Probe each against the real CLI and record the evidence in `builds/ready-for-strangers/grok-mcp.md`. If none works, layer (a) alone is the fix, and the README says Grok Assist may refuse to run when MCP servers are configured.
   - Tests:
     - a fake grok whose init lists extra tools → the turn is refused, the child is killed, no edit is proposed, and the error is shown;
     - a fake grok with init `[read_file]` → it proceeds;
     - the init event is missing → refused;
     - the same for claude.
   - phase1.mjs keeps its real-CLI probe. If (b) lands, it must pass 20/20 inside full verify runs; if only (a), the probe asserts a red means refused, not leaked, and the assertion is never loosened.
5. **Scripted stranger run (offline).**
   - Extend tests/setup-walkthrough.mjs, or add tests/stranger.mjs. From a `git archive` of HEAD into a temp dir, with an empty HOME and fake CLIs, it follows the README literally:
     - run the documented install-on-PATH command;
     - run `acs` through the symlink with `ACS_NO_UPDATE=1` and no browser open;
     - complete setup through the UI (reuse the walkthrough driver);
     - `acs stop`.
   - It asserts: the README commands exist and run; acs via the symlink finds its checkout; Home shows the CLIs, seat and folder; `acs stop` stops it; uninstall removes the link.
   - It runs in verify and in CI on ubuntu and macOS. Add a macos-latest runner for this one job if CI lacks one.
6. **Human timed run (Cris, at the end).** A checklist, `builds/ready-for-strangers/human-run.md`, for a fresh macOS user account: start a timer, follow only the README, note every hesitation. The pass bar is under 10 minutes with zero outside help. Its findings feed a follow-up, not this PR's merge gate.

## Acceptance criteria
1. **README:** every command it shows is executed by the stranger test (criterion 5), or by a test asserting it exists (`--help` exits 0), and every install command matches commands.md. No Cris-specific names or paths (asserted).
2. **Symlink:** `acs` works when invoked through a symlink, a chain of two symlinks, and a path with spaces, under sh/dash and zsh. `acs install` and `acs uninstall` are idempotent; they never overwrite an existing non-ACS `acs` on PATH (they refuse with a message) and never edit a shell profile.
3. **Hardcoded paths:** models review-config discovery follows roots.json (test: a temp HOME with a root elsewhere finds its review config; ~/Documents/Projects isn't scanned when not a root). The source sweep test passes.
4. **Grok containment:**
   - the runtime refusal tests pass for grok and claude;
   - the shared rule is used by both phase1.mjs and runtime (asserted by import);
   - grok-mcp.md records the probe evidence;
   - if (b) is adopted, phase1 passes 20/20 across full verify runs;
   - guards are unmodified, or receive additive changes only with my callback.
5. **Stranger run:** it passes in verify and in CI (ubuntu, plus macOS if added).
6. **Regression:** every existing suite passes unmodified, `./verify.sh` is green uninterrupted, and CI is green.
7. **human-run.md exists.** Cris runs it after merge.

## Out of scope
- Packaging: npm or Homebrew.
- Windows.
- Installing CLIs for the user.
- The skill-export manifest.
- Multi-select delete.
- The roots watcher debounce.

## Lanes
- Opus medium builds it.
- Astra high Bounces and Grades.
- No browser QA: there's no UI change beyond the Done-step command text, which the stranger test covers. If the Done step changes visibly, one short QA pass.

## Bounce folds (Astra, `bounce.md`). These override anything above.
- **B1, prevention before execution (overrides item 4a as "the fix").** ACS can't stop a tool that runs before it reads init: grok gets its prompt at spawn. So containment must be established BEFORE the spawn.
  - (b) A grok mechanism that keeps MCP out, probed and recorded in grok-mcp.md; OR
  - a pre-spawn refusal: if grok's effective config has any MCP server configured, Grok Assist is unavailable, with a plain reason and the fix. Detect it via `grok mcp list` / `grok inspect`, or by reading its config through readUserText.
  - The init check stays as defence in depth (kill, then reap the process group), never as the containment claim.
  - Test: a fake grok that performs an observable side effect at startup, with MCP configured. The side effect never happens, because grok is never spawned.
- **B2, covering both Assist paths.**
  - The init check covers chat.js streamTurn AND assist.js runAssist (buffered json). The pre-spawn rule covers both.
  - Add an init deadline (no init within N s → kill and refuse).
  - Refused turns discard all output, and server.js parses no proposals from a refused or unsuccessful result.
  - Tests: malformed init, a toolCount that contradicts the tools list (`{tools:['read_file'], toolCount:134}` must FAIL; fix containmentHeld), repeated init, init after partial output, a resumed session.
- **B3, honest README claims.** State exactly what ACS sends and reads:
  - the usage collector runs as a separate child process and reads the Claude Keychain or credential file and the Codex/Grok auth files to call the vendors' usage endpoints;
  - Check now runs `codex app-server` model/list;
  - `acs` fetches git origin on start;
  - Assist runs your CLI;
  - the built-in agent homes are editable regardless of folders.

  No "never reads credentials" or "never phones home". The claim is "no telemetry; these are the outbound calls". A test greps the README for the banned absolute claims.
- **B4, tests that conflict with this build.**
  - Fixtures that omit init tools (models-assist.mjs:57) and the phase1 expectations get changed ONLY with my callback, listing each old vs new assertion.
  - The phase1 raw grok probe asserts the pre-spawn rule: with MCP configured it's refused before spawn, and without MCP it holds. It is never loosened.
- **B5, the stranger run uses the production launcher.**
  - It runs `bin/acs` → server.js, with no fixture injection, and its guards are unchanged.
  - Offline: it never triggers usage refresh or Check now. A fake `security` and fake CLIs record calls, and the test asserts no network-bound call happened. Use a sandboxed HOME, and a PATH without real CLIs.
  - It drives the real UI through the existing VM proxy.
  - It asserts the program's full outcome on Home and the views: CLIs, seat, folder, skills, MCP, models, context and worktrees each render from the temp HOME's fixtures.
- **B6, the candidate identity.**
  - The stranger test copies the working tree (tracked plus new files, minus .git), or archives a temp commit. It asserts the copy's README and bin/acs hashes equal the worktree's.
  - A second variant uses a real `git clone` of a local bare repo pushed from HEAD, to cover the update and re-exec path through the symlink.
- **B7, PATH ownership.**
  - `acs install` writes a link that it can identify as its own: the target equals this checkout's bin/acs.
  - It refuses when an earlier `acs` on PATH is not this checkout's, and refuses on a dangling or foreign link.
  - Uninstall removes only a link whose target is this checkout.
  - Tests: bare `acs` from an unrelated cwd reports which checkout answered; relative targets; a link cycle (refused); install into a login-PATH dir, with the README telling the user to open a new terminal or `hash -r`.
- **B8, launcher robustness.**
  - Missing `curl` or `lsof` gives a clear message, never a mistaken "port free".
  - A browser opener failure doesn't kill the launcher.
  - `ACS_NO_OPEN=1` (or `--no-open`) for headless use.
  - `acs --help` / `help` prints usage; an unknown subcommand exits non-zero.
  - Tests: an occupied port, headless start, a failing opener.
- **B9, Node and the CI matrix are gates.**
  - CI runs on ubuntu with Node 20.0 pinned (the declared minimum) and the current LTS, and on macOS for the stranger job.
  - An unsupported Node gives a clear launcher error.
  - dash and zsh are installed and used in the symlink tests on ubuntu.
- **B10, a README truth pass.** Rewrite stale reference sections, such as the model list in chat.js, the fixed folders, and "everything is editable". Every factual claim about paths and behaviour must match the code. The stranger test executes every command block in Get started.
- **B11, the hardcoded-path detector.**
  - Detect by construction: a sweep test flags any path assembled from `'Documents'` plus `'Projects'` segments, as well as the literals.
  - models.js review-config discovery reads roots.json itself (standalone-safe), handling missing, invalid and revoked roots.
  - Test both the server path and the INSTALLED resolver (`model-id --install` into a temp dir, then `--lint`).

## Cris's decisions (2026-10-06)
- **Grok and MCP:** if no grok mechanism keeps MCP out of an Assist run, Grok Assist is unavailable whenever grok has any MCP server configured. ACS refuses before spawning, with the reason and the fix. Claude Assist is unchanged.
- **Human run:** the timed fresh-macOS-account run happens BEFORE merge, against the PR branch. Its findings are fixed in this PR, so `human-run.md` is a merge gate.
