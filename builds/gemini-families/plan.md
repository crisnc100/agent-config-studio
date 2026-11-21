# Families from every subscription's catalog (usage PR D) — plan

Goal (Cris chose "A: sync automatically", 2026-11-21): every model a signed-in subscription offers is a usable
family and model id, with nobody hard-coding it: Argon, Hydrogen and Flash from Antigravity, Luna from Codex today.
A newer version is picked up by itself. A family that a role, a flavor or a pause names never changes model silently.
Neon, the family Cris uses most, keeps working throughout. Never adoptable: agy's non-Gemini ids (decisions.md:5,
never Opus or GPT-OSS through Antigravity) and agy's orchestrator modes.

Branch `gemini-families`, on main 0f98786 (PR C merged as #107; merge commit 3c6c694). One PR, four phases.

Revised 2026-11-21 after the advisor gate (advisor-sync.out, adopted in full by the orchestrator):
- sync adds and moves forward only; it never removes and never moves backward;
- a sync failure never fails check();
- the newest-id helper keeps the Claude Code version gate;
- the open choices are settled.

This replaces the one-click adopt plan (advisor.out, 2026-11-20). That plan's read side is built and kept. The first
gate's cuts still hold: no flavor write, the name is the catalog word, no effort-picker change, and writes refuse what
reads would hide.

## What the code does today (read 2026-11-21 at 3c6c694)
- **Catalogs.** readCatalogs (lib/models-catalog.js:267) reads files only and spawns nothing:
  - Claude: the newest ~/.claude/cache/model-catalog/*-cc.json, one login's (:133). Claude Code rewrites it when
    it runs.
  - Codex: models_cache.json in ~/.codex and every seat home, as a union (:173). Codex rewrites it when it runs.
  - Grok: ~/.grok/models_cache.json (:225).
  - Antigravity: ACS's own list (:252). Only Check now writes it (lib/models-panel.js:116).
    - An empty answer is refused (lib/usage/gemini.js:160).
    - A partial answer is saved.
- **Family words.** Each entry's family word comes from the catalog:
  - Claude: `short_name`, letters only (:94).
  - Codex: the slug's last segment. Hidden, `-latest` and `codex-` slugs get none (:98).
  - Grok: `grok` for `grok-N[.N]`, none for variants (:104).
  - agy: `gemini-<version>-<word>`. Orchestrators get none (:247), and non-gemini ids are dropped at read (:258).
- **Real catalogs on this Mac (2026-11-21, projected fields only):** sync adds argon, hydrogen and flash (agy) and
  luna (Codex, at gpt-6-luna). Claude and Grok offer no word beyond the shipped families.
- **When it runs.** check() runs at studio start with no refresh (server.js:1928) and on Check now with refresh
  (server.js:1299, models-panel.js:145). There is no timer.
  - current() reuses a rejected check() promise (models-panel.js:168), so a throw there breaks the Models page until
    Check now.
- **Alerts.** detect() gives per-family alerts:
  - `update`: a strictly higher, non-hidden id with the same word (:317), gated on the installed Claude Code version
    (:323-324), for tracked families only;
  - `retiring` (:332) and `vanished` (:338).
  - `tracks()` is false only for `track: false` (lib/models.js:210), and the row shows "pinned" (public/app.js:4743).
- **Where alerts show.** Models (nav badge, server.js:1121) and Home's Needs-attention card, one line per live alert
  (public/home.js:43). Accept goes through setModel (server.js:1321).
- **Shipped flavors.** roles.default.json ships a flavor for all nine primary families, neon included (:53). The
  three -prev families have none and are pinned (models.default.json:18-20). Roles merge shipped and user flavors
  (lib/roles.js:226).
- **Unknown names.** An unknown family in a role, an alt, a flavor or a pause refuses the whole file: lib/roles.js:141,
  :148 and :157, and checkPaused :364.
- **Stale resolver.** resolverStale compares the installed roles.js and models.js (lib/roles-panel.js:67). Writes are
  refused while it is stale:
  - version-2 roles writes, avoid and member effort (roles-panel.js:132-134);
  - pauses (lib/pause.js:132).
- **Review gate and builder.** The review gate accepts `/^[a-z]+(-prev)?$/` names (review.mjs:449) and picks the
  CLI from the id prefix (:475). acs-agent builds only claude, codex and grok ids (lib/agent.js:491).

## Kept from the built branch (phases 1–3 at fa6e022)
- families.json is a file of its own; per-entry rules, with bad entries hidden and never dropped.
- families.json is part of loadRegistry's cache key (lib/models.js:236).
- userFamilies, familiesHidden and familiesError sit beside `defaults`.
- familyNote; resolverStale also compares models.js.
- writeFamilies (models-panel.js:337) and its queue (:289).
- setAddedModel and its hard refusal (:380).
- namedBy (:398), removeFamily (:413).
- tests/models-families.mjs.

Replaced: adoptFamily, addable, POST /api/models/adopt, and the "Not added yet" line.

## Design

### 1. Trigger: who writes, and when
- **When.** Sync runs inside check(), after readCatalogs and before `state` is set, so view() never shows a pre-sync
  alert. That covers studio start (cached catalogs, no CLI spawned) and Check now. There is no timer.
- **A sync failure never fails check().** The sync is caught, its error goes into the view's `sync` summary, and
  `state` is always set.
- **Who writes.** Only the studio writes families.json, through the one queue: sync, Set, Accept, Pin and Remove.
  model-id, ask-model, the review gate and acs-agent only read it.
- **The write.**
  - Sync plans from a fresh read inside the queue.
  - It writes only when something changes: one atomic write with the parse-back check, recorded in history as
    `families: synced — added argon (gemini-4-argon), …`.
- **Off limits for sync:** models.json, roles.json, paused.json, and removing any entry.

### 2. Names and ids
- **Name.** A synced family is named by its catalog word: argon, hydrogen, flash, luna. Update alerts match on that
  word (models-catalog.js:315).
- **Id.** One helper, shared with detect(), picks the newest non-hidden entry with that word:
  - parseable, and strictly higher than the current id;
  - a dated snapshot never beats an undated id. With no current id, undated entries win when there are any;
  - for sync only, an entry whose `minCliVersion` the installed Claude Code does not meet is passed over.
- **A shipped family's word, same vendor** (opus from Claude, sol from Codex, neon from agy) is that family. Sync
  never writes it.
- **Skipped, with a note** on the Models page:
  - a shipped word from another vendor ("sol from Antigravity: the shipped Codex family has that name");
  - a reserved word, or a name failing FAMILY_NAME_RE;
  - a name a hidden entry has, which is never overwritten;
  - a name a families.json entry of another vendor has;
  - a word two vendors offer anew. The first in the order claude, codex, grok, agy takes it.
- **Shipped ids never follow their catalogs.** They keep today's alert and Accept. Neon moves only on Cris's Accept,
  and models.json stays written only by him.
- **Managed entries.** Sync moves an entry only when its id's vendor offers a word equal to its name.

### 3. Protection
- **In use.** A family is in use when any of these names it:
  - a role's `use`, at any position, as a string or a member object;
  - a role's `alt`;
  - the merged flavor;
  - any paused.json entry, expired or not.
  If roles.json or paused.json cannot be read, every family counts as in use, and sync only adds.
- **Pinned.** A family with `"track": false` is never moved by sync. loadRegistry merges the pin into
  `registry.families`, so tracks() and the "pinned" badge work unchanged. families.json entries take `track` (a
  boolean) beside `id` and `addedAt`.

  | Family | A strictly higher id in its catalog | Its id no longer listed |
  |---|---|---|
  | unused, unpinned | moved to it, quietly; the sync line says so | vanished alert; moves only to a higher id |
  | in use | not moved; the update alert on Models and Home says what holds it | vanished alert |
  | pinned | not moved; no update alert | vanished alert |
  | shipped | today's alert and Accept | today's vanished alert |

- **Actions.**
  - **Accept** on an alert writes the new id. It does not pin.
  - **Set** (a typed id) on a families.json family also pins it. The notice says "pinned — Unpin to follow
    <Vendor> again".
  - **Pin and Unpin** sit in the row editor (POST /api/models/pin {family, pinned}, strict same-origin, families.json
    families only). Unpin takes the `track` key out. An unused family then follows its catalog at the next check.

### 4. No removal by sync
- Sync never removes an entry and never moves one to a lower version. A partial agy answer, a shorter Codex home, a
  different Claude login, or a second studio on another build could otherwise remove families Cris calls by name.
- An id no longer listed gets the existing vanished alert.
- **Remove** (removeFamily, kept) shows only on a families.json row whose vendor's catalog read ok and no longer
  offers its word, so the next sync cannot add it back. It is still refused while a role, flavor or pause names the
  family.

### 5. Excluded entries
- **agy non-Gemini ids** are dropped at read (models-catalog.js:258).
- **The CLI comes from the id prefix.** A claude- or gpt- id runs through claude or codex, never agy. The entry rule
  changes from "a gemini- id" (lib/models.js:86) to "an id with a known vendor prefix".
- **No word:** orchestrators (:247); hidden, `-latest` and `codex-` Codex slugs (:98-99, :199); hidden Grok entries
  and variants (:104-106).
- **No preview or experimental denylist.** No real catalog shows one.

### 6. Back-compat
| Reader | families.json alone | a role, flavor or pause naming `argon` |
|---|---|---|
| installed resolver older than this PR (today's) | ignored | refuses roles.json / paused.json whole |
| installed resolver from this PR | reads every vendor's entries | resolves |
| older studio (trunk until pulled) | ignored | shows roles.json invalid, refuses edits, never rewrites |

- **Sync writes only families.json**, and older readers ignore it. Sync is add-only, so two studios on different
  builds cannot undo each other.
- **A synced name reaches roles.json, a flavor or paused.json only through Cris's own write.** Those writes are refused
  while resolverStale is true (roles-panel.js:132-134, pause.js:132). resolverStale compares models.js, which this PR
  changes, so naming argon after the merge needs `acs install-model-id` first.
- **Trunk is Cris's everyday `acs`.** It cannot offer argon until it is pulled.
- **Known gap:** a legacy version-1 roles.json write is not stale-guarded. Cris's file is version 2.

### Neon
Shipped (models.default.json:15), with a shipped flavor (roles.default.json:53), and refused as a families.json name
(lib/models.js:81). Sync never writes it. Each phase checks that `model-id neon` prints gemini-4-neon. It also checks
that a newer neon in the agy list gives an update alert and no write.

## Phases
One PR: the read side, sync and screen only work together, and the vendors share one code path. Commit at each
phase end, build folder included.

Test rules:
- tests/models.mjs runs before every lib/, public/ or server commit.
- Only touched test files run, one at a time, under `taskpolicy -b`. Server-backed files need the sandbox off.
- Changes to existing assertions go in their own test-only commit, which names each one.

### Phase 1: read side for every vendor
**Code**
- familyEntryProblem takes any known vendor prefix and a boolean `track`.
- loadRegistry merges `track: false` into `registry.families`.
**Test-only commit**
These existing assertions in tests/models-families.mjs move from "a non-gemini id is hidden" to "an id with no known
prefix is hidden" (a claude- id is now usable):
- hidden `opusish`;
- model-id, --flavor and --effort on it;
- the role and flavor naming it;
- the Set refusals.
**Pass/fail**
- gpt-, claude- and grok- entries resolve. An unknown-prefix id and a non-boolean `track` are hidden with their
  reasons.
- `track: false`: the row has `track` false, with no update alert.
- `model-id --json` keys are unchanged; neon resolves.
- The scripted check against main 0f98786's resolver is re-run with codex and claude entries (log.md).

### Phase 2: sync engine
**Code**
- The shared newest-id helper.
- planSync({ catalogs, reg, inUse, cli }) is pure and returns add, move and skipped-with-reason.
- syncFamilies writes once through writeFamilies, inside the queue.
- namedBy becomes one map for all families.
**Pass/fail** (tests/models-families.mjs)
- A new word is added at its newest id; a dated snapshot does not win.
- Orchestrators, hidden entries, `-latest`, `codex-` and Grok variants are excluded.
- A shipped word from the same vendor gives no write.
- Each skip reason is given.
- An unused family moves to a strictly higher id only. A lower id or an unlisted current id is no move.
- An entry needing a newer Claude Code is not added or moved to.
- In use (use, member object, alt, flavor, expired pause): not moved. Pinned: not moved.
- An unreadable roles.json gives adds only.
- A broken families.json gives no write. Hidden entries and unknown keys survive byte for byte.
- A family whose word is gone is kept.
- A second sync writes nothing.
- neon is untouched.

### Phase 3: trigger and routes
**Code**
- check() runs the sync inside a catch, and view() carries `sync` (at, added, moved, skipped, error).
- Rows from families.json have source `synced`, the catalog's `vendor`, `offered`, and `heldBy` when in use.
- POST /api/models/pin is added; Set pins.
- adoptFamily, addable and the adopt route are deleted.
- Home counts familiesError and a sync error as partial (public/home.js:130).
**Test-only commit**
Replace the adopt-based setups in tests/models-families.mjs with planted families.json files. Delete the adopt and
addable assertions, naming each.

tests/models-panel.mjs:287 and :441 do not change. Their HOMEs come from seedHome → defaultCatalogs
(tests/fixtures/models-home.mjs:45-83), whose only words are shipped families: gpt-5.5 has no word, codex-9-sol none,
and gpt-7-sol is hidden. Sync adds no row there, so both keep guarding what they guard. The planted gpt-6-luna at
:200 is in another HOME and is read directly. The explicit synced-row checks (which name, which id, from which
catalog) are new tests in tests/models-families.mjs.
**Pass/fail** (real server, temp HOME)
- At start, families.json gains exactly argon, hydrogen and flash at their ids and luna at gpt-6-luna. The fake agy
  records no call.
- Check now with a newer argon moves an unused argon.
- Argon in the reviewer role is not moved, and the alert names the role on /api/models and Home. Accept moves it.
- Pin stops moves and alerts; Set pins.
- A sync that throws leaves /api/models answering, with the error in `sync`.
- The adopt route is 404.
- Existing models-panel, models-agy, models-refresh and home tests pass unchanged.

### Phase 4: screen
**Code**
- Set by reads "synced from <Vendor>".
- A synced row's editor has Save and Pin or Unpin, and Remove only when the word is no longer offered.
- An in-use update alert says what holds it.
- A sync line sits under the catalog lines, and the error notice wording changes.
- The "Not added yet" line and its styles are deleted.
**Test-only commit**
Delete or move the branch's adopt UI assertions in tests/models-layout-ui.mjs, naming each.
**Pass/fail**
- tests/models-layout-ui.mjs covers the sync line, a synced row, Pin and Unpin, Remove only when not offered, and the
  hold reason.
- The orchestrator runs one browser QA under a temp HOME.

### Phase 5: effort pickers follow the catalog's efforts
agy 1.5.13 refuses an effort a model does not list, with exit 1. The orchestrator checked this on 2026-11-21:
`--model gemini-4-argon --effort xhigh` gives "invalid model selection: gemini-4-argon has no "xhigh" effort
(available: low, medium, high)", and gemini-3.8-flash does the same.

**Code**
- detect() rows carry `efforts`: the catalog entry's list for the current id, or null when the catalog lists none.
  Only agy's list has efforts today.
- The three pickers in public/app.js (member effort, role effort, flavor effort) offer only those efforts for a
  family whose catalog lists them. Other families keep the full list.
- The role effort applies to every member and the alt without its own effort. It therefore offers the efforts all
  of them accept, and refreshes when the models or the alt change.
- A saved value outside the offered list stays selectable, marked "not offered for <family>", so a save never
  changes it silently.

**Pass/fail** (tests/models-layout-ui.mjs, and a row check in tests/models-families.mjs)
- argon (low, medium, high) shows no xhigh in its member or flavor picker; neon shows xhigh; opus shows the full
  list.
- A role with argon and opus offers no xhigh or max. With argon taken out, it offers the full list.
- A saved xhigh on a role with argon stays selected, marked.

## Known limits
- Shipped families never follow their catalog on their own; they keep the update alert and Accept.
- agy's list refreshes only on Check now, since nothing spawns agy at start. A new Gemini model appears after Check
  now, not at studio start.
- Sync never removes. A family whose model is gone stays until Cris removes it.
- Every families.json row reads "synced from <Vendor>". A hand-written entry has no marker that sets it apart.
- A roles.json naming a synced family is invalid on a machine whose catalogs never listed it.
- An older ACS checkout shows roles.json invalid once a role names a synced family. It never rewrites the file.
- A role, member or flavor effort already saved outside a family's listed efforts (such as xhigh on argon) still
  fails loudly at call time: agy exits 1 naming the efforts it has. The pickers show such a value as not offered,
  but they do not rewrite it.

## Follow-ups (filed)
- A builder or security warning by vendor for agy families, if wanted.
- Editor and describe errors lack the families.json note, and a legacy roles write is not stale-guarded.

## Settled choices (2026-11-21)
1. Shipped families never follow their catalog on their own.
2. Sync never removes (advisor), and Remove shows only when a word is gone.
3. Set pins, and Unpin stays.
4. No word denylist.
5. Direct `model-id <family>` calls in skills do not count as in use.
