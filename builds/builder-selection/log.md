# Builder selection build log

Builder: sol; task owner selected by current ordered builder role (first unpaused). Worker effort: high, allowed for Sol for this cross-file logic change. Operator-named: false. Reuse this family across phases and fixes unless documented unavailability or quality escalation. No runtime user policy has been changed.

Advisor Astra high: right-sized, one PR; no human questions; read-only exit 0. Adopted optional reserve, per-account/per-reading usage proof, Describe omission preservation, bounded CLI-only Jev, and dispatch/resume tests.

Phase 1 Jev shadow: sol; confidence 0.33. Shadow only; ordered configuration selects the builder.

## Phase 1 implementation

The optional policy is `roles.builder.pick = { mode, design?, reservePercent? }`. The exported `BUILDER_PICK_MODES` lists `ordered`, `random` and `jev`. `roleFields(name)` gives the schema and edit endpoint the fields valid for that role. `loadRoles({ home }).roles.builder.pick` exposes the saved policy, and its provenance records the policy as one field.

`model-id --pick builder --json [--design] [--exclude <family>]… [--task-file <path>]` returns `family`, `id`, `effort`, `effortSource`, `mode`, `selectedBy`, `reason`, `eligible`, `skipped` and `usage`. An unavailable pick exits 2 with an `error` and candidate details in JSON. The picker reads cached usage when a reserve is configured. Jev uses the first 4096 bytes of the explicitly supplied regular summary file and the eligible families' saved profiles. A Jev call is bounded to five seconds and 64 KiB per output stream. Legacy role usage diagnostics retain their own usage string.

The 15 new tests cover schema validation, byte compatibility, precedence and the alt, random indices, explicit visual preference, pauses and exclusions, cache reserve and all-excluded handling, account home and credential stat, old snapshots, stale and malformed readings, scoped Claude and separate Argon windows, installed Jev request and bounds, and fallback and CLI errors. Every Jev test uses an in-process result or a local executable stub.

The separate test-only commit registers the suite in `tests/SUITE`. Guard B allows exactly one Jev spawn with pinned absolute PATH lookup, fixed arguments, JSON input and process bounds. The exact read allowlist covers one bounded task summary descriptor read for the CLI and its symlink. Controls reject a duplicate descriptor read, a changed executable, an argument appended from the summary and a second spawn.

All focused checks passed on Node 23.11.1. The commands were `node tests/roles-pick.mjs` (15), `node tests/roles.mjs` (207), `node tests/roles-pause.mjs` (50), `node tests/roles-unit.mjs` (100), `node tests/roles-routes.mjs` (157), `node tests/roles-writer.mjs` (9), `node tests/roles-security.mjs` (9), `node tests/pause-cli.mjs` (26), `node tests/models.mjs` (64), `node tests/models-families.mjs` (223), `node tests/readme.mjs` (56), `node tests/guards.mjs` (11), `node tests/setup-guards.mjs` (110), and `node tests/suite-coverage.mjs` (33). Syntax checks for the three changed source files and `git diff --check` passed. The registry contains 202 entries.

Phase 2 owns the settings controls, stale-resolver write protection, Describe preservation and guide changes. A preferred family can outlast a builder lineup change. Include the design preference when checking whether a family can be removed so that removal cannot leave an invalid policy behind. When Phase 3 documents the command, the README audit should recognize the separate picker usage string.

## Phase 1 independent verification

Installed code-review runtime: 2026-11-25-13-54-03-f69a50 at 0da63dbb42dbff9a3eb855fc043ff9e6f4ad463c; Sol-prev xhigh, 0 findings, no truncation. It explicitly inspected existing-test changes for weakening. CrossFamily is off; checker is a different configured family/model, same vendor. Security is not asked in this phase checkpoint and will run at PR tip. Root separately ran node tests/roles-pick.mjs: 15/15, 0 failed/skipped, 6.2 seconds. Close remains at final tip.

Phase 2 shadow: neon, confidence 0.24; telemetry only. Task owner remains Sol, fresh high-effort phase worker.

## Phase 2 implementation

Models → Roles → builder → Edit shows Builder selection, New frontend visual design preference, and Check cached usage when picking a builder. Reserve (%) appears when the check is on and starts at 0. The preference menu uses the builder lineup and retains an existing preference if that family leaves it. The Roles API preserves a saved policy if an older editor omits it. An unconfigured builder uses First available with both options off and needs no stored policy. Once configured, First available is an explicit `ordered` choice and turning either option off omits its key.

The existing Roles write path rejects a stale installed resolver before editing the document or recording history. If Describe omits a saved pick, it keeps the pick in the preview and the accepted bytes. If it omits the builder altogether, the preview retains the existing builder entry with its lineup and efforts. Model family removal checks the design reference even if the family is outside the lineup or its builder is unset. The guide explains how a selected family carries through the task, with Jev’s task summary and the optional usage and design behavior where configured. With no policy the guide retains its legacy bytes.

On Node 23.11.1, the 16 focused scripts passed 1,229 checks. Run `node tests/<name>.mjs` for each script: `builder-settings` (6), `builder-settings-ui` (2), `roles-pick` (15), `roles-routes` (157), `roles-unit` (100), `roles-ui` (75), `model-guide` (207), `model-guide-routes` (65), `model-guide-ui` (51), `models-families` (223), `models-layout-ui` (109), `roles-writer` (9), `readme` (56), `guards` (11), `setup-guards` (110), and `suite-coverage` (33). `node --check` passed for every changed JavaScript file. `git diff --check` passed. The registry has 204 entries, with the two new offline suites added in a test-registration commit. Existing assertions and frozen review.test.mjs did not change.

Browser QA uses the orchestrator’s isolated Models server and seed. Open `/#models`, then Edit for builder. Verify a save and reload with Random per task, a preference from the lineup and a reserve, then Jev task fit with None and usage unchecked, then First available. Check the preseeded advisor, model profile, per-member effort and second opinion. A preinstalled guide should show Review and update. A stale resolver copy under the isolated home’s `.agent-config-studio/resolver/lib/roles.js` should make the page show `acs install-model-id` and refuse the policy save.

## Phase 2 independent verification and UI interruption

Installed code-review runtime: 2026-11-25-14-08-33-5310a7 at 1c7e46bd460e93c894331ba6d21544473a7b049a; Sol-prev xhigh, 0 findings, no truncation, all Phase 2 code/test paths. Not closed mid-build.

Browser QA is NOT complete: initial CUA REPL could not initialize, native Chrome fallback was interrupted by Cris because it interfered with an interview. All computer control stopped and isolated QA server stopped. No feature UI interaction/persistence criterion is claimed passed by that attempt. Continue only background code/tests; interactive computer control requires Cris to resume it. A private headless automated check, if used, must have its own evidence and must not touch the active browser/profile.

Phase 3 shadow: neon, confidence 0.37; telemetry only. Same task owner Sol, fresh high-effort worker.

## Phase 3 implementation

The Claude and Codex build skills load `BUILDER_RECORD` from the task plan or handoff. On the first automatic selection, they call `model-id --pick builder --json` with the Frame's explicit visual-direction decision, a short summary file for task fit when applicable, and any accumulated exclusions on replacement. They save the family, model ID, effective effort, mode, reason and `operatorNamed` separately from the phase worker's session identifier. Fresh phases, resumes and fixes load the same record. The seat's effort rules and operator's effort overrides are applied once and the effective effort is recorded. An explicitly named member of the configured lineup retains the direct-family pause behavior and bypasses the automatic pick. A role's alt is not a lineup member.

Same-vendor builders use native subagents with the recorded model and effort. The Claude seat uses the Codex CLI for a Codex family. The Codex seat uses the Claude CLI with edit permissions and an empty MCP configuration for a Claude family. Fresh phases start fresh workers. Callbacks and unfinished phases use their own saved session when the route supports it. Antigravity goes through `ask-model --family "$BUILDER" --build --cwd "$WORKTREE" --effort "$EFFORT"` at the canonical Git root, with the wrapper's native permission and unverified served-model behavior. Review gets the recorded author in `REVIEW_AUTHOR`.

For confirmed quota or startup unavailability, the replacement keeps earlier exclusions, adds the failed family and hands off commits, check results, remaining work and partial edits before dispatch. A generic error can leave edits and does not by itself trigger replacement. A structured no-eligible result ends the chain with the picker's reasons. A CLI without the picker reports `acs install-model-id`. The standing quality escalation still sharpens an incomplete brief first and changes an automatically chosen family when the adequate brief misses the same criterion twice.

Implementation and documentation are in b75320f. The separate test-only commit 0caa7fb registers the new consumer suite and keeps the existing lookup and raw-command guards scoped to their original behavior, with exact exceptions for saved-packet effort and the Codex-to-Claude write command. It retains named/member/role/flavor effort checks, omitted empty effort, the builder-alt check and the model resolver flags in the README. The frozen review.test.mjs is unchanged. The registry contains 205 entries. The test changes are ready for independent checking.

On Node 23.11.1, these focused commands passed 379 checks with zero failures or skips.

| Command | Passed |
| --- | ---: |
| `node tests/build-builder-skill.mjs` | 12 |
| `node packs/review-gate/tests/review.skills.test.mjs` | 26 |
| `node tests/readme.mjs` | 57 |
| `node tests/guards.mjs` | 11 |
| `node tests/setup-guards.mjs` | 110 |
| `node tests/suite-coverage.mjs` | 33 |
| `node tests/no-personal-paths.mjs` | 11 |
| `node tests/roles-pick.mjs` | 15 |
| `node tests/packs-install.mjs` | 93 |
| `node tests/ask-model-build.mjs` | 11 |

`node --check` passed for the changed test JavaScript and `git diff --check` passed. `node packs/review-gate/tests/review.packs.test.mjs` reported 24 passes and one existing failure. The model-name sweep reports the same two lines, `packs/KNOWN-LIMITS.md:53` and `:54`, when run from an isolated full `git archive c07e0e9`. Both lines and the model-name sweep are unchanged.

The new tests run the skills' shell blocks against stub worker CLIs and fixture picks, use the repository resolver for explicit membership and exhaustion, and check the instruction-driven native route and handoff requirements as text. They do not claim a live builder, review, or model identity check. Browser QA and full-suite close are tracked by the orchestrator separately.

## Builder editor guidance

The note beneath the settings explains that a big task keeps its chosen builder through phases, fixes and resumes. It states when the preference applies and which work uses the selected strategy. Focused checks passed with zero failures: `node tests/builder-settings-ui.mjs` (2), `node tests/builder-settings.mjs` (6), `node tests/roles-ui.mjs` (75), and `node tests/models-layout-ui.mjs` (109). `node --check public/app.js` and `git diff --check` passed.

## Final browser acceptance

Private headless Chrome on Mini: Q1-Q6 all PASS at source 1b976d9; six UI/core blob hashes match. No active laptop controls. Original explanatory-copy finding 12/100 (likelihood4 x impact3) fixed by 1b976d9 and independently rechecked in rendered DOM/screenshot; original evidence preserved without rescoring. The helper regex did not recognize selected strategy, so its raw classification is preserved; the final verdict uses the actual rendered text and inspected screenshot. Details qa-final.json.

Jev post-run: all6pass confidence1.0; residual copy severity0.04 on0-4 scale,confidence0.98 (triage only, not a new score for the original finding). QA preflight0.78/0.59; verifier shadowSol-prev0.78. UI-copy builder shadowNeon0.25, ignored: same task owner Sol.

All three phases committed. Registered offline list now160files; full exact-tip suite, combined code/security review, context pass, fix check, close, PR and CI remain pending. New actual Neon probes/calls for this feature:0. Existing read-only agy wall/settings/review runtime are outside this diff. Global selection policy is not activated before a compatible merged installation.

## Combined PR review and remaining files

Primary 2026-11-25-15-37-04-f20056 at16601e5: input cap left28paths outside prompt. Remaining-files review 2026-11-25-15-51-39-99e1b8 read all28 without truncation/security debt. Both code reviewerSol-prev and securityMythos ran. One fix round follows for primaryf1/s1(35/100,15/100) and s2(10/100), remainingf1(35/100), f2(9/100), s2(4/100). Remaining securitys1(6/100) is filed caller-steering hardening, no normal-use path; preserve score and report it.

Fix shadowSol0.71, task owner unchanged. Targeted live Claude permission probe effortmedium0.96; no provider call yet. The fixture is outside shipping source; the seat, never builder, runs the probe after the fix. No GUI.

## Review fix round

Commit 7ee0731 addresses primary f1 and s1 and remaining-files f1 with explicit phase-scoped Bash rules on the Codex-to-Claude headless route. The orchestrator lists the literal validation, staging and commit commands from its phase brief in `CLAUDE_BASH_RULES`. The launch passes those rules via `--allowedTools` with `acceptEdits` and an empty strict MCP configuration. The dispatch refuses an empty rule list.

Primary s2 is addressed in both build skills. Reload checks the existing owner against the configured builder lineup and current registry ID and validates the saved effort and boolean selection marker. A paused automatic owner stops before dispatch and follows the existing replacement procedure. A deliberate named override preserves its original behavior. Historical review attribution keeps the validated original author even if the family is now paused. The original restore block at fa1c213 returned both an out-of-lineup family and a mismatched ID. The updated executable fixtures reject both cases before the stub builder or review starts.

The Claude skill's hard rule now matches the fresh workers required by remaining-files f2. Each new cross-vendor Codex phase starts with `workspace-write`. Same-phase resumes inherit the session's sandbox and verifiers stay read-only.

For remaining-files s2, the committed QA projection replaces the SSH login and address with `<mini>` and records the redaction. A JSON comparison with fa1c213 confirmed that only the SSH target and redaction note changed. The script hash, timestamps, scores, and raw local evidence are preserved. The pre-redaction commit still contains the old projection. Remaining-files s1 (LOW 6/100, likelihood 1 × impact 6) remains filed for follow-up. This round left the task-summary reader and its guard unchanged.

Commit a024b1f includes only test changes. The existing effort lookup and raw CLI guard exceptions match the exact new commands, with a new control that rejects dropping the allow-rule flag. Consumer tests retain earlier picker reuse, effort, and replacement assertions. The paused-case fixture now omits `until` to create an effective indefinite pause, exercising both explicit and automatic owner behavior.

Focused checks on Node 23.11.1 passed with zero failures or skips.

| Command | Passed |
| --- | ---: |
| `node tests/build-builder-skill.mjs` | 17 |
| `node packs/review-gate/tests/review.skills.test.mjs` | 26 |
| `node tests/roles-pick.mjs` | 15 |
| `node tests/roles.mjs` | 207 |
| `node tests/guards.mjs` | 11 |
| `node tests/setup-guards.mjs` | 110 |
| `node tests/suite-coverage.mjs` | 33 |
| `node tests/readme.mjs` | 57 |
| `node tests/no-personal-paths.mjs` | 11 |

`node --check tests/build-builder-skill.mjs`, `node --check packs/review-gate/tests/review.packs.test.mjs`, and `git diff --check` passed. The manual `node packs/review-gate/tests/review.packs.test.mjs` again had 24 passes and the pre-existing model-name lint failure at `packs/KNOWN-LIMITS.md:53–54`. Git confirmed the frozen review.test.mjs and known-limits documentation are unchanged.

The seat's separate live probe uses the resolved Claude builder at medium effort and its isolated fixture brief. The rules for the required commands are `CLAUDE_BASH_RULES=('Bash(node verify.mjs)' 'Bash(git add -- value.txt)' 'Bash(git commit -m builder-permission-smoke)')`. No live model was called in this fix round.

## Escalation wording in the same fix round

Both build skills follow the standing escalation rule. When output misses the bar, the orchestrator checks the brief first. A gap is fixed and sent back to the same family. An adequate brief moves the work automatically to another eligible builder, with the handoff and reason recorded. Only an explicit instruction to use one family limits that choice.

A byte comparison against 01a29b0 confirmed every Bash block in both skill files is identical, including the headless Claude dispatch and permission rules. `node tests/build-builder-skill.mjs` passed 17 checks, `node packs/review-gate/tests/review.skills.test.mjs` passed 26, and `node tests/guards.mjs` passed 11. `node packs/review-gate/tests/review.packs.test.mjs` passed 24 checks and reproduced the one baseline model-name lint failure in KNOWN-LIMITS.md. `git diff --check` passed.

## Headless dispatch on Bash 3

The initial permission smoke stopped during shell expansion before Claude started. With `set -euo pipefail`, Bash 3.2.57 treats an empty optional array as unset. Commit c79cef7 uses conditional expansion for the effort and session arrays. The dispatch retains the phase-specific Bash rules, strict empty MCP configuration, and named model.

The test-only commit 285cde4 checks the full argv for fresh and resumed dispatches, each with and without an effort, under the same strict shell options. `node --test --test-name-pattern='strict Bash starts' tests/build-builder-skill.mjs` failed on the original block at the empty effort array, then passed after the correction. `node tests/build-builder-skill.mjs` (18), `node packs/review-gate/tests/review.skills.test.mjs` (26), and `node tests/guards.mjs` (11) passed. The manual pack lint reported 24 passes and the existing model-name lint failure in KNOWN-LIMITS.md. Syntax checks for both changed test files and `git diff --check` passed.
