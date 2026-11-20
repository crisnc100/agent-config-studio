# Gemini usage seat — log

## Phase 1 — reader (builder, 2026-11-20)
- lib/usage/gemini.js runs agy twice per reading, both in a fresh empty temp folder removed afterwards, stdin closed,
  CMUX_ANTIGRAVITY_HOOKS_DISABLED=1: `--version` (its own spawn, not harness readVersion, so it too starts in an empty
  folder), then `-p /usage --output-format json` only on agy ≥ 1.1.11. An unreadable version is refused like an old one.
- A reply counts only with `command.name === 'usage'` and `num_turns === 0`; anything else is ok:false, so a future agy
  that turns /usage into a prompt shows as an error, never as numbers.
- usedPercent = (1 − remaining_fraction) × 100, rounded to 0.1. A fraction outside 0–1 or non-numeric is refused (no 0%).
- Exit 2 → the API-key reason (decision 3). Any other non-zero exit → "exited N — if agy is signed out, run `agy` and
  sign in"; the signed-out exit code was not probed (Cris was not signed out).
- Argon weekly → `extraWindows`, Gemini Models 5h/weekly → `windows` (decision 1). `agyVersion` is on every result.
- tests/guards.mjs: gemini.js pinned to spawn(found.binary, ['--version'] | ['-p','/usage','--output-format','json']);
  checked it fails on a changed argv. `agy` added to both PATH-name literal checks (guard a and b), beside claude/grok/codex.
- lib/harness.js: agy candidates (~/.local/bin/agy first, then PATH; the cmux wrapper is skipped as a shim).
- Live run on this Mac (agy 1.5.13): ok, 5h 7.7% used, weekly 8.5%, Argon 0%.
- Checks: tests/usage-gemini.mjs 43/43, tests/guards.mjs 11/11, tests/suite-coverage.mjs 33/33, tests/setup-guards.mjs 84/84.
