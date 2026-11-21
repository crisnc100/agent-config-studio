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

## Phase 2 — writes and routes (builder, 2026-11-20)
- lib/models-panel.js:
  - adoptFamily({id}): the name is the catalog word. Refuses:
    - not an id (400);
    - families.json invalid or newer (409);
    - stale installed resolver (409, ADD_STALE);
    - no Antigravity list (409, "Press Check now first");
    - an id not in the list (400);
    - an orchestrator or nameless id (400);
    - an id a family holds (409);
    - a name a shipped, added or hidden family has (409, says to hand-edit families.json);
    - a name the entry rules refuse, e.g. reserved (400).
  - setModel on an added family goes to families.json. It hard-refuses (400, confirm or not) an id the read side
    would hide; catalog warnings still ask to confirm. Accept uses the same path.
  - resetModel on an added family → 400 ("Remove it instead").
  - removeFamily refuses while a role's use, a role's alt, a flavor or a pause (any, expired included) names the
    family. It also refuses when roles.json or paused.json is invalid (nobody can tell then) and for a hidden or
    shipped name. Otherwise it changes families.json only.
  - families.json writes:
    - serialized in-process (two tabs adding at once: the second sees the first);
    - jsontext edits, so other bytes are kept;
    - the result is parsed back and refused (409) unless it says what was meant. A file naming a family twice is
      edited at its first entry but read at its last; a hand edit between read and write can leave no entry.
  - The view adds `addable` (Antigravity entries with a family word whose id no family holds), `familiesError` and
    `familiesHidden`. Rows for added families have source 'added' (detect() takes `added`).
- server.js: POST /api/models/adopt {id} and /api/models/remove {family}, both strict same-origin with an object
  body. Set, Accept, Reset and where-used reach added families through knownFamily (phase 1).
- **Phase 1 miss:** commit 721ffbf added an `fs.readFileSync` to lib/models.js. tests/setup-guards.mjs pins every
  read outside lib/paths.js and fails on it; I had not run setup-guards in phase 1. Fixed here with no allowlist
  change: models.js reads families.json through its existing readJson, and models-panel.js through paths.js
  readUserText.
- Planted bugs, each caught by tests/models-families.mjs:
  - no write queue (1 FAIL);
  - no hard refuse on Set (4);
  - alt not counted by Remove (4);
  - no stale check on Add (1).
- Checks:
  - tests/models-families.mjs 103/103 (unit + real server);
  - tests/models.mjs 64/64; tests/guards.mjs 11/11; tests/setup-guards.mjs 106/106;
  - tests/models-panel.mjs 118/118; tests/models-agy.mjs 50/50; tests/models-refresh.mjs 29/29;
  - tests/models-layout-ui.mjs 58/58; tests/home.mjs 127/127.

## Phase 3 — screen (builder, 2026-11-20)
- public/app.js:
  - Under the Antigravity catalog line, "Not added yet" lists the view's `addable`, each with a secondary
    "Add as <name>" button. It posts {id} through modelWrite (notice, registry refresh, repaint, roles reload);
  - Set by: "added by you";
  - an added row's editor has Save + Remove (secondary) in place of Reset to default;
  - Save, Remove and Accept on an added row stay enabled while models.json is broken (the id is in families.json);
  - a broken families.json is an error notice at the top, and each hidden entry is a warn notice line with its
    reason.
- public/styles.css: three rules for the line.
- Planted bugs, each caught by tests/models-layout-ui.mjs:
  - the line under the wrong catalog (1 FAIL);
  - Remove posting to reset (2);
  - the added row disabled by registryError (3).
- Sibling fix (47a3ca8): `model-id --flavor` and `--effort` on a hidden family carry the same families.json note as
  the role/flavor/pause errors (lib/roles.js resolveFlavor/familyEffort), tested.
- Checks:
  - tests/models-layout-ui.mjs 74/74; tests/models-families.mjs 105/105;
  - tests/models.mjs 64/64; tests/setup-guards.mjs 106/106; tests/guards.mjs 11/11;
  - tests/ui-clarity-g.mjs 17/17; tests/roles-ui.mjs 75/75; tests/pause-ui.mjs 36/36; tests/model-guide-ui.mjs 50/50;
  - tests/roles-pause.mjs 50/50;
  - tests/home.mjs 127/127 on rerun. The first run failed "8 Refresh re-asks the sources and keeps a sticky
    warning" once, a timing test that does not touch the Models code;
  - tests/roles-unit.mjs 95/96 twice. Its one failure is the real-home snapshot: the running review benchmark wrote
    ~/.agent-config-studio/logs/agy/review-*.log and ~/.claude/projects/-private-var-…-review-eval-…-repo during the
    run. The same file passed 96/96 in phase 1.

## Sibling check (builder, before the last commit)
Each check, guard, rule or output added or changed, the other paths that reach the same data or state, and the
code that consumes it:
1. Added families merged into registry.models (lib/models.js loadRegistry):
   - model-id `<family>`, --table and --json: applied, tested;
   - resolveModel / resolveRole / familyEffort / resolveFlavor: applied, tested;
   - lib/roles.js family list and readPaused default: applied, tested;
   - lib/pause.js families(): applied (pause-cli/pause-routes pass);
   - server.js knownFamily (where-used, liveAlert → Accept/Dismiss): applied, tested through the route;
   - models-catalog detect rows: applied (`added` param), tested;
   - roles-panel validateRoles / rolesView pickers / describe.js families and models: applied through loadRoles,
     no code change;
   - lib/harness.js assistModels compares `registry !== defaults`. Not needed: with families.json present they
     differ, but that only matters when a picker resolves empty. The shipped pickers (claude 4, grok 2) name
     shipped families, which resolve the same;
   - ask-model, the review gate and acs-agent use the installed resolver or the prefix: no change. Builder on an
     agy id is refused (lib/agent.js:491) as before;
   - the installed resolver copy: models.js imports nothing new, so it stays standalone.
2. families.json in the loadRegistry cache key: applied, tested (edit shows on next read).
3. userFamilies / familiesHidden / familiesError beside `defaults`:
   - `model-id --json` keys unchanged: tested;
   - GET /api/models carries familiesError/familiesHidden: applied, drawn on the page;
   - registryError's sibling notice: applied.
4. The families.json note on unknown-family errors:
   - roles use/alt, flavor, paused.json and resolveModel: applied, tested;
   - resolveFlavor / familyEffort: applied in 47a3ca8, tested;
   - roles-panel validateRoles (the editor's save) and describe proposals call checkRoles without `note`. Not
     handled: those errors read "unknown family X (known: …)" without the families.json reason. The page's hidden
     notice names the entry and why.
5. resolverStale also compares lib/models.js:
   - roles writes (avoid, member effort, version 2), pause, packs.js:545, the page banner and Add: applied, since
     they all use the one function;
   - package start reminder: already compares models.js.
   - Not handled: a legacy (version 1) roles.json write naming an added family is not refused while stale, unlike
     version 2. The family can only exist after an Add, which needs a fresh resolver, or a hand edit. A resolver
     installed after this PR reads families.json even when stale later. The gap needs a hand-written families.json
     plus a pre-PR resolver plus a version-1 file.
6. Entry rules (familyEntryProblem):
   - read side: applied;
   - Add: applied (the same function);
   - Set and Accept: applied (hard refuse), tested;
   - hand edits: hidden by the read side;
   - Remove: not needed (it only takes entries out).
7. Add's refusals: the route and the in-process call share adoptFamily; tested both ways.
8. Remove's "named by" check (role use, member objects, alt, flavor, any pause entry):
   - unreadable roles.json or paused.json → refuse: applied, tested;
   - models-dismissed.json keyed by family: not needed (a stale dismissal is ignored, and harmless if the family is
     re-added);
   - skills and scripts calling `model-id <family>` by name: not handled, same as Reset today. They fail after
     Remove, and where-used lists them on the family.
9. Write serialization and parse-back: applied to all three families.json writers (adopt, set, remove). No other
   writer exists. External edits are caught by the parse-back (409).
10. Hard-refuse on Set/Accept for added families: both reach setModel → setAddedModel; applied, tested (Accept
    through the real route). Sidecar proposals for gemini ids are none (claude/codex files only).
11. Save/Remove/Accept enabled on added rows while models.json is broken: the server agrees, since setAddedModel
    and removeFamily never call editable(): applied, tested.
12. Read allowlist (tests/setup-guards.mjs): no new read calls (readJson and readUserText): applied.

## Follow-ups (filed, not in this PR)
- Does agy reject an effort a model does not list (e.g. xhigh for Argon)? If so, limit the three effort pickers
  (public/app.js role effort, member effort, flavor effort) to the catalog's `efforts` for agy families.
- A builder/security warning by vendor for agy families (neon included), if wanted.
- The two "not handled" items above (4: editor/describe errors without the note; 5: legacy write while stale).

## Merge main + sync redesign (builder, 2026-11-21)
- Merged origin/main (0f98786, PR C #107) into gemini-families: 3c6c694. Three conflicts (lib/models-panel.js view,
  tests/SUITE, tests/models-layout-ui.mjs); main's side of each was empty, so the branch side was kept. After the
  merge: models-families 105/105, models-layout-ui 74/74, models-agy 50/50, models-panel 118/118, models-refresh
  29/29. The four server-backed files need local port binding (EPERM inside the sandbox).
- Cris chose "sync automatically". plan.md is rewritten for it; the adopt/remove write side and UI are what it
  replaces. No code changed this turn.
- Read on this Mac (projected catalog fields only): sync would add argon, hydrogen and flash (agy) and luna (Codex).
  Claude and Grok offer no word that is not a shipped family. roles.default.json ships a flavor for all nine primary
  families, so every shipped family is already "in use" by the brief's rule. Neon is in no role and has no where-used
  hit, so only its shipped flavor and being shipped protect it.
