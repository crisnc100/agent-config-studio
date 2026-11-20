# Gemini usage seat (usage PR B) — plan

Goal: Cris tracks and pauses his Gemini subscription in ACS the way he does Claude, Codex and Grok. The Usage page holds a
`gemini` seat (the subscription) run through the Antigravity CLI `agy` (the harness); sign-in happens inside agy, ACS
never handles credentials; the seat shows Gemini usage when agy exposes it and says plainly why when it doesn't; Pause
works on the Gemini pool (the `gemini` pause account from PR A). Model choice is PR C/D.

One PR: the reader, the seat and the screen only work together.

## Data source (Phase 0 probe, agy 1.5.13, 2026-11-20)
`agy -p /usage --output-format json`, run from a fresh empty folder with stdin closed: exit 0 in ~2s, `num_turns:0`,
no conversation created, one log file under ~/.gemini/antigravity-cli/log/. agy reads its own login from the keychain.
`command.data.groups[]` → `buckets[]` with `id`, `window` (`weekly` | `5h`), `remaining_fraction` (0–1 left) and
`reset_time` (ISO UTC). Groups: "Gemini Models" (gemini-weekly, gemini-5h), "Claude and GPT models" (3p-*),
"Gemini 4 Argon" (gemini-argon-wtu-weekly). Before agy 1.1.11, `-p "/usage"` was sent to the model as a prompt.
A GEMINI_API_KEY login makes /usage exit 2 (1.5.11).

## Phase 1 — reader
lib/usage/gemini.js: real agy via locateBinary (past the cmux wrapper); `--version` first and refuse below 1.1.11 or
an unreadable version; argv pinned to ['-p','/usage','--output-format','json'], cwd a fresh temp folder removed after,
stdin closed, CMUX_ANTIGRAVITY_HOOKS_DISABLED=1, killed at a deadline; accept only `command.name === 'usage'` and
`num_turns === 0`; exit 2 / non-zero / timeout → ok:false with a plain reason. The agy version rides on every reading.
tests/guards.mjs pins the file (binary = found.binary, argv exactly the two literals); harness.js gets agy candidates.
Pass/fail: tests/usage-gemini.mjs (fixture from the real JSON: 0.928 → 7.2% used, reset in ms, 300/10080 minutes,
rejects a turn, a wrong command, exit 2, an old version) and tests/guards.mjs pass.

## Phase 2 — seats
VENDORS gains `gemini`; a gemini seat carries `harness:'agy'` (the only allowed value) and no home; one gemini seat
per machine (one keychain login); readSeat reads it; not CREDENTIAL_FREE (the CLI takes the reading, the studio renders
the snapshot); detectSeats suggests it when agy is installed or ~/.gemini/antigravity-cli exists; saveSeats/addSeat/
removeSeat keep registry entries this build does not recognise.
Pass/fail: tests/usage-seats.mjs and tests/usage-cli.mjs pass, including an unknown entry surviving add and remove.

## Phase 3 — screen and pause
Add form offers Gemini, then the harness (Antigravity only); sign-in note points to agy; the card shows the Gemini bars
or the reason, Argon's weekly limit as its own line without a gauge; the Pause row works for the gemini account;
installedClis knows agy; README's Gemini pause line matches (finding x8).
Pass/fail: the pause and usage route/UI test files pass, one at a time. Browser QA is the orchestrator's, near the end.

## Decisions (decided by orchestrator 2026-11-20)
1. `windows` = the Gemini Models weekly and 5h buckets only; Argon weekly shown as a separate line, no gauge; the
   Claude/GPT group dropped (Cris never runs Opus or GPT-OSS through Antigravity).
2. The seat stores `harness:'agy'`, the only allowed value, so opencode can be added without a migration.
3. GEMINI_API_KEY is left alone; exit 2 → "agy is signed in with an API key, which has no subscription quota — sign
   in with your Google account in agy".
4. No /credits.

Out of scope: opencode, model choice (PR C/D), the review runtime, tools/ask-model.mjs, models.default.json.
