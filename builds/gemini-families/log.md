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

## Sync phase 1 — read side for every vendor (builder, 2026-11-21)
- lib/models.js: a families.json id may start with claude-, gpt-, grok- or gemini- (an unknown prefix hides the entry:
  "its id does not start with claude-, gpt-, grok-, gemini-"). Entries take `track` (boolean; anything else hides
  the entry). loadRegistry merges `track: false` into `registry.families`, only when there is a pin.
- lib/models-panel.js: Set's hard refusal says "lives in families.json" (no longer Antigravity-only).
- Test-only commit 168bfd2 moves the hidden-id assertions from claude-/gpt- ids to llama-4-x / mistral-9.
- Scripted check against main 0f98786 (git archive of bin, lib, models.default.json): main's model-id on a temp HOME
  with a v2 roles.json (member effort, alt), a flavor and a pause printed byte-identical output for opus, neon,
  --table, --role reviewer, --roles, --json and --flavor sol with and without a families.json holding luna
  (gpt-6-luna), mythos (claude-) and a pinned argon. Main's `model-id luna` is "unknown model family" (exit 1), and
  a role naming luna refuses roles.json (exit 2): the known limit resolverStale guards.
- Checks: tests/models.mjs 64/64; tests/models-families.mjs 117/117.

## Sync phase 2 — sync engine (builder, 2026-11-21)
- lib/models-catalog.js:
  - newestFor(models, word, {above, cli, gated}) is detect()'s ordering, moved out: hidden and unorderable ids
    never win; strictly above the current id; a dated id never beats an undated current one, or (no current id)
    any undated entry. `gated` passes over an id whose minCliVersion the installed Claude Code does not meet;
    detect() calls it ungated and keeps showing the reason.
  - planSync({catalogs, reg, inUse, cli}) → {add, move, skipped}. Vendors in the order claude, codex, grok, agy.
    Moves only families.json entries whose id's vendor offers their name, unpinned, and not in `inUse` (null →
    nothing moves). No removal, no downward move.
- lib/models-panel.js:
  - heldBy(home): family → where a role (use member, alt when not also a member), the merged flavor, or any pause
    entry names it; null when roles.json or paused.json cannot be read. namedBy (Remove) reads it.
  - syncFamilies({catalogs, claudeVersion, home}) plans inside the families.json queue, writes once through
    writeFamilies only when something changes, and returns {at, added, moved, skipped, error, historyError}.
    A broken families.json → no write, `error` says why.
- Planted bugs, each caught by tests/models-families.mjs: no strictly-higher floor (4 FAIL); in-use ignored (6);
  no Claude Code gate (6); pin ignored (1); writing when nothing changed (1, plus a crash on no file).
- Checks: tests/models.mjs 64/64; tests/models-families.mjs 168/168; tests/models-panel.mjs 118/118;
  tests/models-agy.mjs 50/50.

## Sync phase 3 — trigger and routes (builder, 2026-11-21)
- lib/models-panel.js:
  - check() runs syncFamilies after readCatalogs and before `state`, in a catch; the error goes to
    `sync.error` ("The sync from the model lists failed: …"), historyError is not passed to the view.
  - view(): rows from families.json get source `synced` (detect's `added` param is now `synced`), `offered`
    (true/false; null when the list is unreadable) and `heldBy` (null when roles/paused cannot be read). `sync`
    replaces `addable`.
  - pinFamily({family, pinned}); setModel/setAddedModel take `pin` (Set route passes it, Accept does not);
    withFamilyPin writes `"track": false` or removes the key. adoptFamily, addable, ADD_STALE are deleted.
  - Reset/Remove/Pin messages say "families.json" instead of "added by you".
- server.js: POST /api/models/pin (strict same-origin, object body); Set passes pin: true; adopt route deleted.
- public/home.js: familiesError → partial ("families.json is invalid — the families synced from the model lists
  are left out"); a sync error → partial unless familiesError already says it; an update line on a held synced
  family ends "(held by …)".
- **Found and fixed (sibling):** lib/history.js allowed only models.json and roles.json among studio files, so every
  families.json write — Set, Accept, Remove on the adopt branch, and now sync and Pin — came back with
  historyError "path outside allowed roots" and was never recorded. families.json joins both lists (allowedRoots and
  snapshotAll's studio files). A test asserts the sync and a Pin land in the history log; it fails without the fix.
- tests/models-panel.mjs:287 and :441 were not changed: they pass unchanged (their HOMEs come from defaultCatalogs,
  whose only words are shipped families). The lead's brief asked for a test-only change there; it was not needed,
  and widening the source list with no synced row in that HOME would only loosen it.
- Planted bugs: a sync throw escaping check() (crash), Set not pinning (1 FAIL), no heldBy (4), history fix
  reverted (2).
- Checks: tests/models.mjs 64/64; models-families 182/182; home 130/130; models-panel 118/118; models-agy 50/50;
  models-refresh 29/29; roots-history 10/10; own-writes 43/43; guards 11/11; setup-guards 106/106.
- `taskpolicy -b` fails inside the sandbox (setpriority: Operation not permitted), so every run here was with the
  sandbox off.

## Sync phase 4 — screen (builder, 2026-11-21)
- public/app.js:
  - Set by: "synced from <catalog label>";
  - a synced row's editor: Save, Pin/Unpin, and Remove only when `offered === false`; no Reset. Save's notice says
    it pinned;
  - an update chip on a held synced family adds "held by …, so it was not moved";
  - syncLines under the catalog lines: added/moved, then "Not synced: … (why)"; a sync error is an amber line;
    nothing when the sync did nothing;
  - the broken-families.json notice speaks of synced families; addableLine and its three CSS rules are deleted.
- Test-only commit 7e32a1d rewrites the branch's adopt UI assertions (listed in its message).
- Planted bugs, each caught by tests/models-layout-ui.mjs: Remove always shown (2 FAIL), no hold reason (1), the
  sync line drawn under each catalog (2).
- Dry run of planSync on this Mac's real catalogs and roles (no write): add luna (gpt-6-luna), argon
  (gemini-4-argon), flash (gemini-3.8-flash), hydrogen (gemini-4-hydrogen); nothing moved, nothing skipped. No
  families.json exists on the real HOME.
- Checks: tests/models.mjs 64/64; models-layout-ui 86/86; ui-clarity-g 17/17.

## Sibling check (sync build, before the last commit)
Each check, guard, rule or output added or changed; the other paths to the same data or state; the consumers.
1. familyEntryProblem takes any known prefix and a boolean `track` (lib/models.js):
   - read side (readFamilies), Set/Accept hard refusal (setAddedModel), sync adds (planSync): applied, tested;
   - the installed resolver copy: applied (no new import; VENDOR_PREFIXES is in the same module);
   - review gate (name regex, CLI by prefix), ask-model, pause (subscription by prefix): not needed, prefix-based;
   - acs-agent: a synced codex/claude family (luna) can now build if a role names it: not needed, that takes
     Cris's own role edit, like any shipped family.
2. `track: false` merged into registry.families:
   - detect/tracks (update alerts, pinned badge): applied, tested;
   - model-id --json spreads registry: applied, top-level keys tested unchanged (pins sit inside `families`);
   - lib/audit.js familyIndex and lib/packs.js installedFamilies/roleProblems read `track`: not needed, a pinned
     synced family is treated like a shipped -prev pin, as intended.
3. newestFor (one ordering): detect and planSync: applied. lib/audit.js keeps its own older-than check for lint
   suggestions: not needed (it answers "is this id older", not "which is newest").
4. planSync rules (skips, claim order, moves only managed/unpinned/unused, forward only, Claude Code gate):
   - every families.json writer (sync, Set/Accept, Pin, Remove) shares the queue and the parse-back: applied;
   - hand edits: hidden with reason, never overwritten by sync: applied, tested;
   - a second studio process: not handled in-process; sync is add/forward-only and idempotent, the rename is
     atomic and the parse-back refuses a file that changed under it.
5. heldBy (in use): sync moves, the view's heldBy (Models chip, Home line), Remove's namedBy: applied, tested.
   whereUsed (skills calling model-id): not needed, settled choice 5.
6. check() catches the sync: its only caller is check(); the start call (server.js:1928) and Check now both get a
   state either way: applied, tested in-process (EACCES). The other steps in check() already catch.
7. The view (source `synced`, offered, heldBy, sync; no addable):
   - app.js rows/editor/chip/sync line, home.js lines and partials: applied, tested;
   - roles-panel familyWarnings and server liveAlert read rows/alerts only: not needed;
   - tests/models-panel.mjs:287/:441 (source default|override): not needed, they pass unchanged (no synced word
     in defaultCatalogs).
8. POST /api/models/pin: strict same-origin and object body like remove: applied, tested. Pin on a shipped family
   is refused (400); a shipped pin stays a hand edit of models.json `families.<f>.track`: not handled (no UI asked).
9. Set pins: the Set route passes pin, Accept does not; setModel has no other callers: applied, tested.
10. Home partials (familiesError, sync error, no duplicate): applied, tested in the VM.
11. History (families.json as a studio file): allowedRoots and snapshotAll's list: applied, tested through the real
    server. paused.json is not in history either: not handled (before this branch, out of scope).
12. Remove only when the word is no longer offered: UI only. removeFamily itself does not check `offered`, so a
    direct POST can remove an offered family and the next sync adds it back: not handled (harmless; filed).

## Phase 5 — effort pickers follow the catalog (builder, 2026-11-21)
- The orchestrator checked agy 1.5.13 by hand: `--model gemini-4-argon --effort xhigh` (and the same for
  gemini-3.8-flash) exits 1 with "invalid model selection: … has no "xhigh" effort (available: low, medium, high)".
- lib/models-catalog.js detect(): rows carry `efforts` (the catalog entry's list for the current id; null when
  none). Claude, Codex and Grok projections have no efforts, so their rows are null.
- public/app.js: effortOptions(sel, families, value) feeds the member, role and flavor pickers. The role picker
  takes the role's models plus its second opinion, since the role effort reaches each one without its own effort;
  it repaints on a model pick and on a second-opinion change. A saved value outside the offered list is kept as a
  marked option. The intersection across a role's families is how the brief's per-family rule applies to the one
  picker that serves several families.
- Planted bugs, each caught by tests/models-layout-ui.mjs: lists ignored (7 FAIL), no repaint on a pick (2), the
  saved value dropped (2), the second opinion ignored (1).
- Checks: tests/models.mjs 64/64; models-layout-ui 96/96; models-families 183/183; models-panel 118/118;
  models-agy 50/50; roles-ui 75/75; ui-clarity-g 17/17.
- Sibling check for this phase:
  1. `efforts` on rows: the three pickers read it (applied). Other effort inputs: none on the Models page; the Usage
     pause controls and the CLI (`model-id --effort`, ask-model) pass a saved effort through and fail loudly at
     agy (not handled, the known limit). The roles describe proposals (AI-suggested roles) can propose an effort
     outside a list: not handled, the proposal is shown before it is accepted and the call fails loudly.
  2. Server-side writes (role, member, flavor effort) do not check the list: not handled, by design (the brief asks
     for the pickers; the known limit covers saved values).

## Fix round: weakened test-only rewrites (builder, 2026-11-21)
- Sol's check of the three test-only commits: 57 PASS, 3 weakened. All three are restored in 83fff49 (test-only), each
  proven against a planted break that was then reverted:
  1. the families.json queue: sync+Pin and Pin+Pin at the same time must both land. With serialized() calling fn
     directly: 2 FAIL, 3 runs out of 3; the file was also left corrupt (two writes on one temp name).
  2. a cross-site POST to Check now → 403, agy not asked, no families.json (real server; start sync has nothing
     to add), with a same-origin control. With /api/models/check let past the global non-GET origin check: 2 FAIL.
  3. the screen after Check now, Pin, Unpin and Save shows the server's new state. Check now without repaint:
     4 FAIL; model writes without the GET /api/models reload: 2 FAIL (Pin, Save).
- Checks: tests/models-families.mjs 188/188, tests/models-layout-ui.mjs 101/101.
- One line, not fixed: Check now is guarded only by the global non-GET policy (sameOriginRequest), which passes
  `Sec-Fetch-Site: same-site` from another localhost port; Pin and Remove use requireStrict. Check now spawns
  codex/agy (since PR C) and now writes families.json.

## Fix round: PR D review MEDIUMs (builder, 2026-11-21)
Reviews 2026-11-21-14-53-16-aa4710 (screen) and 2026-11-21-14-56-35-dfd95e (lib and server).
- 2a58e76 Check now under requireStrict. The global guard already refuses same-site with a foreign Origin (it
  compares the port); the gap was same-site with no Origin. New tests: both get 403, agy not asked, nothing
  written. The no-Origin case failed before the fix (200, agy asked, three families added).
- f50cf3d (test-only) three existing removals now plant a list without argon first (assertions unchanged).
- 584f009 lib and server:
  - dfd95e f1: Claude thinking.effort_options, Codex supported_reasoning_levels, Grok reasoning_efforts reach
    `efforts` (only EFFORTS values; `thinking.type` other than effort → null).
  - f8 (+ s1): planSync ranks only ids that pass ID_RE and carry the source vendor's prefix; add and move share
    familyEntryProblem.
  - f2, f3: commitFamilies(home, prepare) replaces writeFamilies. prepare() runs, the history baseline is awaited,
    prepare() runs again, then edit, parse-back check and a synchronous temp+rename with no await between; history
    records the bytes written. All four writers (Set, Pin, Remove, sync) use it. writeAtomic is synchronous.
  - f4: Set on the current id of an unpinned family writes the pin.
  - f5: Remove refuses while a readable list (read fresh from disk) offers the word, and when it cannot be read.
  - f6: view.sync.historyError.
  - f7: heldBy also reads a stored alt on a role the merged view leaves out.
  - f11: the start check runs no CLI; its sync uses the version already known (none at first), so nothing needing
    a newer Claude Code is synced. The version is probed when a view or write first needs it and on each Check now;
    the server's probe is claude only, off the main thread (lib/version-probe.js).
- a3e128b screen: aa4710 f1 (Check now reloads the registry and roles; role, flavor and describe writes reload the
  model rows); aa4710 f2 (effortOptions keeps an out-of-list value only when it is the saved one; an unsaved pick
  falls back to the saved value if offered, else none, and is kept as the draft); the sync line shows the history
  error.
- Test-first: every new test failed on the code before its fix (21 in models-families, 6 in models-layout-ui).
  Planted breaks after the fix, each reverted: start probe back (4 FAIL incl. the real-server test), no replan after
  the baseline (3), no offered check + no raw alt + no id filter (9).
- The race tests run in the process's own HOME, where history records families.json, and act the moment the
  baseline's mirror holds the file's bytes (the write is then awaiting git).
- Checks: models-families 223/223, models-layout-ui 109/109, models 64/64, models-panel 118/118, models-agy 50/50,
  models-refresh 29/29, guards 11/11, setup-guards 106/106, own-writes 43/43, roots-history 10/10, roles-ui 75/75,
  model-guide-ui 50/50, ui-clarity-f 59/59, ui-clarity-g 17/17, packs-workflow 111/111, pause-ui 36/36, home 130/130.

## Fix round: a Remove during a roles write (builder, 2026-11-21)
- The lead put sibling item 4's reverse direction in scope: PR D's Remove is what makes this race reachable.
- lib/roles-panel.js replaceRoles: validateRoles(text, home) is run again in the no-await section, right before
  renameSync. A refused write keeps the existing shape (400, unknown family), and the temp file is removed.
- Test-first, in tests/roles-unit.mjs: the write hook (_setWriteHook, inside the compare-and-rename) runs a real
  removeFamily of argon, which commits. Before the fix: 2 FAIL (the write saved; roles.json named argon). After:
  100/100.
- Pause writes (lib/pause.js): pauseName checks the family, then update() writes the temp file and renames with
  no await anywhere, so an in-process Remove cannot land between them. Not the same shape; left unchanged. Another
  studio process could, which is the two-process limit already filed.
- Checks: roles-unit 100, roles-routes 157, roles-writer 9, roles-security 9, pause-routes 23,
  packs-review-settings 135, packs-security 44, packs-pages 81, models-families 223, models 64.
- One run of roles-unit showed the real-home snapshot check failing (activity on the real home during the run);
  the next two runs passed it, as did every other check.
