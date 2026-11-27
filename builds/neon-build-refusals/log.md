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
