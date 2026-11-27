# Build log: neon-build-refusals (Phase 2 guard, Opus builder)

Scope: sticky denied-action failure for native agy builds only. No launch-policy change (no `--sandbox`, no `--settings`, no allow or skip flags); no roles, UI, skills, benchmark or installed config touched. No agy, ask-model or model CLI was run by the builder; the root runs the live probes.

## Change

- `tools/ask-model.mjs`
  - `agyRefusal(state, message)`: one classifier for ERROR/DENIED steps. Denials: deny rule; approval/consent; EACCES/EPERM/permission denied/operation not permitted; state DENIED or "user denied"/"denied permission". Not denials: not-found, any other tool error, any non-ERROR/DENIED state.
  - `agyBuildDenials(steps, result)`: scans raw steps (not the 64-action trace), keyed per step so repeats count once and a later update never clears one. Tool name carried from an earlier update; invalid names become `(unnamed)`. Adds `result.denied_actions` and inline subagent entries (`state`/`status` with `error`, or `denied_actions`). Entries are sanitized labels, never agy's message; list capped at 64 with a `(N more not listed)` entry, count kept in full.
  - `readAgy`: a build with any denial returns exit 4 after the existing r.code / status / model-mismatch (exit 2) / empty-answer checks. Read-only `denied` list unchanged.
  - `agyBuildActions`: a denial refusal stays on its action through later updates; DENIED with a not-found message now labels `denied`.
  - Outer `--build` path unchanged: exit 4, `answer: null`, no `build`, error joined with the auth postflight and the inspect-worktree warning.
- `docs/neon-builder.md`: what fails a build, what does not, the 64-entry bound, and the stream-only limit (subagent transcripts are not read; a DONE shell step is not a refusal).
- `tests/ask-model-build-denials.mjs` (new): readAnswer over synthetic streams, temp HOME, no CLI started.

Existing-test changes are in their own test-only commit (`tests/ask-model-build.mjs`, `tests/SUITE`); the commit message names each assertion.

## Commands and results (final tree)

| Command | Result |
| --- | --- |
| `node --check` on tools/ask-model.mjs, tests/ask-model-build.mjs, tests/ask-model-build-denials.mjs | OK |
| `node tests/ask-model-build-denials.mjs` | 7 pass, 0 fail |
| `node tests/ask-model-build.mjs` | 11 pass, 0 fail |
| `node tests/ask-model-agy.mjs` | 88 passed, 0 failed (read-only agy unchanged) |
| `node tests/ask-model.mjs` | 364 passed, 0 failed |
| `node tests/guards.mjs` | 11 passed, 0 failed |
| `node tests/setup-guards.mjs` | 110 passed, 0 failed |
| `node tests/suite-coverage.mjs` | 33 passed, 0 failed |

Production change alone, before the test-only commit: `tests/ask-model-build.mjs` failed exactly the 5 cases that asserted exit 0 on a stream carrying denials (advisor item 11); the other suites above passed.

Mutation checks (each reverted):
- Denial return disabled: 3 of 7 new tests fail.
- Trace refusal made non-sticky: the later-success test fails.
- Build auth postflight disabled: the log/sign-in and cancellation tests fail (their kinds now stream a clean build, so the postflight is what fails them).

Frozen `packs/review-gate/tests/review.test.mjs` untouched.

## Sibling check

- `agyRefusal`: consumed by `agyBuildActions` and `agyBuildDenials` (applied). Read-only `readAgy` deny-rule list and `agySubagentDenials` transcript scan: not needed, read-only behavior is preserved by brief. `packs/review-gate/runtime/review.mjs` agy reader: not needed, read-only review path, outside this brief's files.
- Denial failure: every `readAgy` return for builds carries `denied` (r.code, status, mismatch, empty, denial, success). Cancellation returns before the stream is read and already fails (applied/not needed). Schema cannot combine with `--build`. Outer path is the only producer of `build.completed` (applied).
- Bounded list: stderr lines and the empty-answer error use the capped list; counts use the full count (applied).
- Docs: `docs/neon-builder.md` (applied). Build skills (`packs/build/skills/{claude,codex}/build/SKILL.md`) still read correctly ("a failed call can leave edits"); not handled, off limits by brief. README `--build` bullet needs no change.

## Residual unknowns

- Live agy 1.5.14 shapes for DENIED steps, "user denied permission" and inline nested subagent denials are synthetic here; only deny-rule ERROR steps, `denied_actions` and the subagent_info shape come from saved real streams.
- Subagent refusals stay unknown (transcripts not read for builds; `notes` says the subagent ran).
- A command blocked inside a shell step agy reports DONE is not seen.

# Phase B: per-task command grants (`--allow-command`, Opus builder)

Scope: advisor option (c) in `launch-policy-advisor-report.md`, as narrowed by the brief. No agy, ask-model or model CLI was run; all three live calls were already used by the root. No roles, UI, saved exclusion, benchmark, installed or global change.

## Change

- `tools/ask-model.mjs`
  - `--allow-command <string>`, repeatable, read before the one-value flags. `allowCommandsProblem` refuses a non-list, more than 16, a non-string, length outside 1..512, any character outside `[A-Za-z0-9 _\-./:=@,+"']`, a leading or trailing space, and a repeat. Without `--build` it exits 64 in `parse`; a non-agy family exits 64 at the existing `--build` vendor check. Both happen before the version probe.
  - `argvFor`: a build with commands adds `--settings {"permissions":{"allow":["command(<s>)",…]}}` right after `--mode accept-edits`; none adds nothing. It throws for commands on any other vendor or mode, and re-runs the list check.
  - Build preamble: the strings verbatim as `` - `<s>` `` lines and "run it exactly as written". It says a different command may be refused, not that every other command is.
  - No receipt field. Strings come only from argv.
- Both build skills: an `ALLOWED_COMMANDS` example block, and the launch builds `ALLOW_FLAGS` with `${a[@]+"${a[@]}"}`. Unset or empty gives the old argv.
- `docs/neon-builder.md`: "Granting the task's commands", the "What runs" wording, and why `--sandbox` is not used.
- `tests/ask-model-allow-command.mjs` (new). It is registered in `tests/SUITE` in its own test-only commit.

Brief over advisor: the preamble does not say "anything else is refused" (advisor item 4), and there is no `--json` field (item 5).

## Probe records

`probe-observations.json` is committed as the root wrote it. Checked against the brief's evidence: 3 of 3 calls used; under `--sandbox`, shell writes and reads of temporary siblings went through and example.com failed with `ENOTFOUND`, against HTTP 200 in the normal scoped call; sign-in worked in both (no plaintext fallback, no token file); served model unverified in all three. It holds no paths, account data or canary content. The raw streams are not in this worktree, so the hashes were not recomputed.

| | normal, no rules | normal, scoped | sandbox, scoped |
| --- | --- | --- | --- |
| commit (before → head) | `98afe5d` → `98afe5d`, none | `f5caf71` → `113bf99` | `e5040de` → `472b40a` |
| fixed test unchanged / post-test exit | yes / 0 | yes / 0 | yes / 0 |
| shell write / read of temp sibling | not recorded | completed / content returned | completed / content returned |
| shell fetch of example.com | not recorded | HTTP 200 | `ENOTFOUND` |
| native canary read | not attempted | refused | refused |
| stream sha256 | `988d98ab…be156` | `b03f2800…21fbe` | `23be1220…be9be17` |

Full hashes and SHAs are in `probe-observations.json`. The scoped calls' rules, as the root recorded them in its question to the advisor: `command(node test.cjs)`, `command(git add value.cjs)`, `command(git commit -m "Neon fixture edit")`, `command(node boundary-probe.cjs)`. The new test compiles those four strings and checks the result byte for byte (`PROBE_SETTINGS`).

## Commands and results (final tree)

| Command | Result |
| --- | --- |
| `node --check` on tools/ask-model.mjs, tests/ask-model-allow-command.mjs | OK |
| `node tests/ask-model-allow-command.mjs` | 9 pass, 0 fail |
| `node tests/ask-model-build-denials.mjs` | 7 pass, 0 fail |
| `node tests/ask-model-build.mjs` | 11 pass, 0 fail |
| `node tests/ask-model-agy.mjs` | 88 passed, 0 failed |
| `node tests/ask-model.mjs` | 364 passed, 0 failed |
| `node tests/vendor-prefixes.mjs` | 29 passed, 0 failed |
| `node tests/build-builder-skill.mjs` | 38 pass, 0 fail |
| `node packs/review-gate/tests/review.skills.test.mjs` | 26 pass, 0 fail |
| `node tests/models.mjs` | 64 passed, 0 failed |
| `node tests/guards.mjs` | 11 passed, 0 failed |
| `node tests/setup-guards.mjs` | 110 passed, 0 failed |
| `node tests/suite-coverage.mjs` | 33 passed, 0 failed after the SUITE commit (32/1 before it: the new file unlisted) |

Mutation checks, each reverted and its file hash re-checked. Every one failed the test that targets it: no `--build` check; `;` allowed; settings dropped; preamble list dropped; cap 17; repeats allowed; trim check dropped; `argvFor` accepting other modes; unquoted array expansion in the claude skill; Bash-3-unsafe `"${ALLOW_FLAGS[@]}"` in the codex skill.

Frozen `packs/review-gate/tests/review.test.mjs` untouched. No existing test changed.

## Sibling check

- List check: `parse` (CLI) and `argvFor` (the only compile point, also reached by in-process callers) both run it (applied). `argvFor` refuses commands on read-only agy and on claude, codex and grok (applied).
- `--settings` producer: `accept-edits` is built only in `argvFor` (searched the repo). The read-only `AGY_SETTINGS` path is unchanged and pinned by the new test and `ask-model-agy.mjs` (applied).
- Preamble: one build preamble in `main` (applied). Read-only agy prompts are not prefixed (not needed).
- Receipt: `finish` writes `result`; no field was added, and the test compares the key sets with and without grants (applied).
- Refusal guard: `readAnswer` is unchanged and a denied stream with grants still exits 4 (applied, tested).
- Skills: both copies of the launch block changed the same way and run under `/bin/bash` 3.2 and `/bin/zsh` with `-euo pipefail` (applied). `build-builder-skill.mjs` keeps its full-argv assertion for the unset case (passes unchanged).
- README `--build` bullet: still accurate (normal permissions, no deny list or sandbox); not changed. The benchmark adapter's native builds: out of scope (no benchmark), not handled.

## Residual unknowns

- unverified: whether agy matches `command(X)` exactly or as a prefix. Only the four probe strings were seen to match.
- unverified: that agy accepts the wrapper's compiled argv. The new test pins it to the shape the root passed by hand.
- unverified: whether git commands are refused under plain accept-edits. Call 1 shows no commit, not whether one was attempted.
- The first real named task with grants is the live confirmation; a wrong rule fails loudly through the guard. Qualification stays 0/5.
