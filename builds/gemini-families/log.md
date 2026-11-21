# Adopt a catalog model as a family — log

## Plan (builder, 2026-11-20)
- First draft to the advisor gate; advisor (Fable) found it over-built (advisor.out). The orchestrator adopted all
  of it; plan.md is the revised plan.

## Phase 1 — registry and resolver (builder, 2026-11-20)
- lib/models.js:
  - familiesPath, FAMILY_NAME_RE (letters, 2–24), RESERVED_FAMILY_NAMES, familyEntryProblem, familyNote;
  - loadRegistry reads families.json (its stat is in the cache key) and merges usable entries into registry.models.
    It also merges them when models.json is broken, so roles.json naming one does not turn invalid over an
    unrelated file;
  - it returns userFamilies / familiesHidden / familiesError beside `defaults`, and model-id --json keys are
    unchanged (tested).
- File errors (not JSON, not an object, version ≠ 1, families not an object): no added family and familiesError; the
  resolver's `error` stays null. An unknown top-level key is ignored (not an error), and phase 2 writes keep it. That
  is the PR B rule for a key a later build adds; the plan did not say either way.
- Hidden reasons, one per entry: a name not 2–24 letters, a shipped name, a reserved name, an unknown key, an id
  failing ID_RE, a non-gemini id, a non-string addedAt, a non-object.
- lib/roles.js: the family list is registry.models (shipped + added), and readPaused defaults to it. The
  unknown-family errors in roles, flavor and paused.json add familyNote: "~/.agent-config-studio/families.json has
  it, but hidden: <why>" or "could not be read …".
- lib/pause.js families() and server.js knownFamily use the merged list. models-panel set/reset stay shipped-only
  until phase 2, so no added family can be written into models.json in between.
- lib/roles-panel.js resolverStale: also stale when an installed lib/models.js is present and differs. A missing one
  beside a matching roles.js is not stale; existing tests plant only roles.js.
- Scripted check against main (098cd2b): main's model-id (lib/models.js, roles.js, roles.default.json,
  models.default.json, bin/model-id.mjs from origin/main), run on a temp HOME with a v2 roles.json and a pause:
  - opus, --table, --role reviewer, --roles and --json are byte-identical with and without a families.json adding
    argon;
  - `model-id argon` there is "unknown model family";
  - a role naming argon makes it refuse roles.json (exit 2). That is the known limit the stale guard covers.
- Planted bugs failed tests/models-families.mjs: roles listing shipped families only, and families.json missing from
  the cache key.
- Checks: tests/models-families.mjs 44/44 (new, ci:offline in tests/SUITE), tests/models.mjs 64/64,
  tests/guards.mjs 11/11, tests/roles-unit.mjs 96/96, tests/roles-pause.mjs 50/50, tests/roles-routes.mjs 157/157,
  tests/pause-cli.mjs 26/26, tests/pause-routes.mjs 23/23, tests/suite-coverage.mjs 33/33.
