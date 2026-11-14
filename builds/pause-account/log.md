# Pause an account — build log

## Phase 1: resolver + CLI
- Pause reading lives in lib/roles.js (readPaused, pausedBy, pauseLine), so the existing resolverStale byte compare of the installed roles.js covers R6 with no new install file. vendorOf moved to lib/models.js (the resolver copies it); lib/models-catalog.js re-exports it.
- resolveRole filters `use`/`ids`/`members` and `alt`; adds `paused`, `skipped` [{family, by}], `altSkipped` only while a pause is in force; `pauseError` when paused.json is invalid.
- A name that is a vendor (grok) means the vendor, which already covers the family of that name.
- ask-model keeps its usage exit (64) for a refused role, as it does for an unset one; model-id exits 2.
- `acs pause <name>` with no flag ends at the vendor's tightest-window reset from the stored usage reading, else until resume (says so).
- Resume is never refused for a stale resolver: an old resolver ignores pauses anyway.
- Tests: tests/roles-pause.mjs (R1–R5, ask-model, reviewer pool via --show-config), tests/pause-cli.mjs (R1, R6, R9).

## Phase 2: UI + routes
- GET /api/pause, POST /api/pause {name, until|null}, POST /api/pause/resume {name}: strict same-origin. GET /api/models/roles carries `pause` (state + each role's answer, refusals, sameVendor).
- Usage row: Pause (secondary) → "Until it resets (…)" (primary, only when the reading has a reset) / "Until I resume" / Cancel (quiet). Paused row: "Paused until …" + Resume. Family pauses show on their vendor's rows. Stale resolver or invalid file disables Pause with the reason.
- Tests: tests/pause-routes.mjs (R6 server, R7, R8 data), tests/pause-ui.mjs (R7, R8, R11 styles).

## Phase 3: docs
- README "Pausing an account" under Subscription usage; acs help lists pause and resume.
- R10's guide sentence landed in phase 1 with guideText; its test (and README's) are in tests/roles-pause.mjs.
