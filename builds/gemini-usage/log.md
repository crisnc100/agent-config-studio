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

## Phase 2 — seats (builder, 2026-11-20)
- VENDORS gains `gemini`; HARNESSES = { gemini: ['agy'] }. validateSeat: a gemini seat needs harness `agy`, has no home,
  and only one may exist (agy keeps one keychain login per machine). Checked in validateSeat so every path (createSeat,
  addSuggestedSeat, `acs-usage add`, `detect --save`) gets the same rule.
- loadSeats returns `hidden` (entries this build cannot read); saveSeats writes them back from the file as it is at
  write time, so addSeat/removeSeat/moveSeatToPrivateHome never delete a newer build's seat. uniqueSeatId avoids hidden
  ids. A hidden entry cannot be removed by a build that cannot read it (removeSeat throws, as for an unknown id).
- readSeat 'gemini' → readGeminiSeat (dynamic import). Not CREDENTIAL_FREE: renderSnapshot shows the stored reading.
- detectSeats suggests `gemini-1` (harness agy, no home) when ~/.gemini/antigravity-cli exists or agy is installed;
  suggestSeats carries `harness` (it dropped it, and adding the suggestion then failed validation — the new
  setup-accounts test caught it). server.js installedClis includes agy.
- createSeat({ vendor:'gemini', harness }) defaults harness to agy, refuses another; its note says to sign in inside
  agy. Both seat routes pass `harness` through; createSeat checks it against the fixed list.
- `acs-usage add gemini <label>` sets harness agy; the gauge prints extraWindows (Argon) as a grey line, unranked.
- Checks: usage-seats 138/138, usage-routes 82/82, usage-cli 18/18, setup-accounts and setup-routes all pass except
  one real-home byte-identity check that flagged ~/.agent-config-studio/logs/agy/review-*.log — written by the
  background benchmark's ask-model runs, not by these tests; setup-ui 92/92, setup-guards 84/84.

## Phase 3 — screen and pause (builder, 2026-11-20)
- public/usage-view.js: SEAT_VENDORS / SEAT_HARNESSES (gemini → agy only) and seatMeta ("gemini · through
  Antigravity"); used by the Usage card and Home's Accounts card so both label a seat the same way.
- public/app.js: seatVendorPicker() + seatBody() build the Add form for Usage and setup's manual form (one picker, two
  forms). The harness select is hidden unless the subscription has one; the body carries `harness` only then.
  The Usage card prints extraWindows (Argon weekly) as a line with no gauge. The Add note says to sign in inside agy.
- Pause needed no code: the gemini pause account and seatReset/vendorReset already read `windows`; with a gemini
  seat accepted, the row offers "until it resets" from the tightest Gemini Models window (finding x8).
- README: Gemini in Subscription usage (one seat, sign in inside agy, the source table row, the API-key case) and in
  the usage collector's list of what it runs.
- Not done (out of scope): the setup screen's CLIs step still lists claude, codex and grok only.
- Checks: pause-ui 36/36, setup-ui 94/94, home 125/125 (one earlier run failed "8 Refresh re-asks the sources and
  keeps a sticky warning", a timing test; three reruns passed, and the change does not touch it), pause-routes
  23/23, roles-pause 50/50, pause-cli 26/26, readme 56/56, guards 11/11.

## Sibling check fixes (builder, 2026-11-20)
- gemini.js: one 20 s deadline for both agy calls (was 30 s per call, 60 s worst case). The usage CLI is killed at 30 s
  by lib/usage/refresh.js, so a slow agy would have cost every seat's reading. Test: a slow --version leaves /usage
  only the time that is left.
- tests/setup-guards.mjs: three pins proving guards.mjs rejects gemini.js spawning a prompt, an extra flag, or a PATH name.
- Checks: usage-gemini 44/44, setup-guards 87/87.
