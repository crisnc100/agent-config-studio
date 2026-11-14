# Pause an account — build log

## Phase 1: resolver + CLI
- Pause reading lives in lib/roles.js (readPaused, pausedBy, pauseLine), so the existing resolverStale byte compare of the installed roles.js covers R6 with no new install file. vendorOf moved to lib/models.js (the resolver copies it); lib/models-catalog.js re-exports it.
- resolveRole filters `use`/`ids`/`members` and `alt`; adds `paused`, `skipped` [{family, by}], `altSkipped` only while a pause is in force; `pauseError` when paused.json is invalid.
- A name that is a vendor (grok) means the vendor, which already covers the family of that name.
- ask-model keeps its usage exit (64) for a refused role, as it does for an unset one; model-id exits 2.
- `acs pause <name>` with no flag ends at the vendor's tightest-window reset from the stored usage reading, else until resume (says so).
- Resume is never refused for a stale resolver: an old resolver ignores pauses anyway.
- Tests: tests/roles-pause.mjs (R1–R5, ask-model, reviewer pool via --show-config), tests/pause-cli.mjs (R1, R6, R9).
