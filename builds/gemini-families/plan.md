# Families from every subscription's catalog (usage PR D) — plan

Goal (Cris chose "A: sync automatically", 2026-11-21): every model a signed-in subscription offers is a usable
family and model id, with nobody hard-coding it: Argon, Hydrogen and Flash from Antigravity, Luna from Codex today.
A newer version is picked up by itself. A family that a role, a flavor or a pause names never changes model silently.
Neon, the family Cris uses most, keeps working throughout. Never adoptable: agy's non-Gemini ids (decisions.md:5,
never Opus or GPT-OSS through Antigravity) and agy's orchestrator modes.

Branch `gemini-families`, now on main 0f98786 (PR C merged as #107; merge commit 3c6c694). One PR, four phases.

Revised 2026-11-21. It replaces the one-click adopt plan (advisor.out, 2026-11-20), whose read side is built and kept.
The advisor's cuts still hold: no flavor write, the name is the catalog word, no effort-picker change, and writes
refuse what reads would hide.

## What the code does today (read 2026-11-21 at 3c6c694)
- **Catalogs.** readCatalogs (lib/models-catalog.js:267) reads files only and spawns nothing:
  - Claude: the newest ~/.claude/cache/model-catalog/*-cc.json (:124). Claude Code rewrites it when it runs.
  - Codex: models_cache.json in ~/.codex plus every seat home, as a union (:173). Codex rewrites it when it runs.
  - Grok: ~/.grok/models_cache.json (:225).
  - Antigravity: ACS's own list, cache/agy-models.json (:252). Only Check now writes it (lib/models-panel.js:116).
- **Family words.** Each entry's family word comes from the catalog:
  - Claude: `short_name`, letters only (:94).
  - Codex: the slug's last segment. Hidden, `-latest` and `codex-` slugs get none (:98).
  - Grok: `grok` for `grok-N[.N]`, none for variants such as grok-4.7-build-fast (:104).
  - agy: `gemini-<version>-<word>`. Orchestrators get none (:247), and non-gemini ids are dropped at read (:258).
- **Real catalogs on this Mac (2026-11-21, projected fields only):**
  - Claude: opus, fable, sonnet, haiku, all shipped.
  - Codex: sol, astra, terra (shipped) and **luna** (gpt-6-luna, gpt-5.6-luna). gpt-reserve and codex-auto-review
    are hidden.
  - Grok: grok (shipped). grok-4.7-build-fast has no word.
  - agy: neon (shipped), **argon**, **hydrogen**, **flash** (gemini-3.8-flash), and two orchestrators with no word.
- **When it runs.** check() runs at studio start with no refresh (server.js:1928) and on Check now with refresh
  (server.js:1299, models-panel.js:145). There is no timer.
- **Alerts.** detect() gives per-family alerts:
  - `update`: a newer non-hidden id with the same word, for tracked families only (models-catalog.js:311). A dated
    snapshot never beats an undated alias (:319).
  - `retiring` (:332) and `vanished` (:338).
  - `tracks()` is false only for `track: false` (lib/models.js:210). The row then shows "pinned" (public/app.js:4743).
- **Where alerts show.** Models alerts are counted on the nav badge (server.js:1121). Home's Needs-attention card
  lists one line per live alert (public/home.js:43). Accept writes through setModel (server.js:1321). Dismiss holds per
  candidate (models-panel.js:64).
- **Shipped flavors.** roles.default.json ships a flavor for all nine primary families, neon included (:53). The
  three -prev families have none and are pinned with `track: false` (models.default.json:18-20). Roles merge the
  shipped and user flavors (lib/roles.js:226).
- **Cris's files today.**
  - roles.json is version 2. Its roles and alts name fable, opus, sol, astra, sonnet and grok; no pauses.
  - models.json overrides six shipped ids, which he accepted from update alerts.
  - There is no families.json.
  - The installed resolver's models.js and roles.js equal main's, and trunk is at main 0f98786.
- **Unknown names.** An unknown family in a role, an alt, a flavor or a pause refuses the whole file: lib/roles.js:141,
  :148 and :157, and checkPaused :364.
- **Stale resolver.** resolverStale compares the installed roles.js and models.js (lib/roles-panel.js:67). Writes are
  refused while it is stale:
  - version-2 roles writes, avoid and member effort (roles-panel.js:132-134);
  - pauses (lib/pause.js:132).
- **Review gate.** It accepts family names matching `/^[a-z]+(-prev)?$/` (review.mjs:449) and picks the CLI from the
  id prefix (:475). acs-agent builds only claude, codex and grok ids (lib/agent.js:491).

## Kept from the built branch (phases 1–3 at fa6e022)
- families.json is a file of its own, separate from models.json. An older resolver refuses an unknown family in
  models.json, and then every family fails.
- Rules apply per entry. A bad entry is hidden with its reason and never dropped, and every write keeps it byte for
  byte.
- families.json is part of loadRegistry's cache key (lib/models.js:236).
- userFamilies, familiesHidden and familiesError sit beside `defaults`, so `model-id --json` keys are unchanged.
- The families.json note in unknown-family errors (familyNote, lib/models.js:118).
- resolverStale also compares models.js.
- The parse-back writer (writeFamilies, models-panel.js:337) and its in-process queue (:289).
- setAddedModel's hard refusal (:380).
- namedBy (:398).
- tests/models-families.mjs.

Replaced: adoptFamily, removeFamily and addable; POST /api/models/adopt and /remove; the "Not added yet" line and the
Remove button.

## Design

### 1. Trigger: who writes, and when
- **When.** Sync runs inside check(), after readCatalogs and before `state` is set, so view() never shows a pre-sync
  alert. That covers studio start (cached catalogs, no refresh, no CLI spawned) and Check now (after the Codex and agy
  refresh). There is no timer and no sync on page load.
- **Who writes.** Only the studio writes families.json, through the one serialized writer: sync, Accept, Set and Pin.
  model-id, ask-model, the review gate and acs-agent only read it.
- **The write.**
  - Sync reads families.json fresh inside the queue and plans from that.
  - It writes only when the plan changes something, so a restart with nothing new leaves no history entry.
  - It makes one atomic write with the parse-back check, recorded in history as
    `families: synced — added argon (gemini-4-argon), …`.
- **Two studios on one HOME** (trunk on 8787 and a worktree studio) plan from the same catalogs, so their results
  agree. The last rename wins, and the parse-back refuses a file that changed under it.
- **Off limits for sync:** models.json, roles.json and paused.json.

### 2. Names
- **Name.** A synced family is named by its catalog word, per vendor as listed above: argon, hydrogen, flash, luna.
  Update alerts match on that word (models-catalog.js:315), so no other name would hear of a newer release.
- **Id.** The newest non-hidden entry with that word, by detect()'s own ordering (parseVersion, with dated snapshots
  never beating an undated alias). That ordering moves into a shared helper so the two cannot drift.
- **A shipped family's word, same vendor** (opus from Claude, sol from Codex, neon from agy) is that family. Sync
  never writes it.
- **A shipped family's word, another vendor** (say a `gemini-5-sol`) is skipped. The summary says "sol from
  Antigravity not synced: the shipped Codex family has that name".
- **A word two vendors offer, neither shipped.** An existing entry keeps the name. Between new ones, the first vendor
  in the order claude, codex, grok, agy takes it. The other is skipped with a note.
- **Other skips.** A reserved word (claude, codex, grok, agy, gemini, opencode), a name failing FAMILY_NAME_RE, or a
  name a hidden entry already has is skipped with a note. A hidden entry is never overwritten.
- **Shipped ids do not follow their catalogs; they keep today's alert and Accept.** Under the protection rule they
  would not move anyway: every shipped primary family is named by its shipped flavor, and the -prev ones are pinned.
  Making it explicit keeps sync to one file. It also means neon cannot move without Cris's Accept, and models.json
  stays written only by him.
- **Which entries sync manages.** An entry is managed when its name equals its id's catalog word. A hand-written
  entry under another name is never moved or removed.

### 3. Protection
- **In use.** A managed family is in use when any of these names it:
  - a role's `use`, at any position, as a string or a member object;
  - a role's `alt`;
  - the merged flavor;
  - any paused.json entry, expired or not.
  This is namedBy (models-panel.js:398), computed once for all families.
- **Unreadable files.** If roles.json or paused.json cannot be read, every managed family counts as in use: sync adds
  but never moves or removes.
- **Pinned.** A family whose entry has `"track": false` is never moved by sync. loadRegistry merges the pin into
  `registry.families`, so tracks() and the existing "pinned" badge work unchanged. families.json entries take
  `track`, a boolean, beside `id` and `addedAt`.
- **What each kind of family gets:**

  | Family | Newer id in its catalog | Its id no longer listed |
  |---|---|---|
  | unused, unpinned | moved to the newest, quietly | moved to the newest with the word; removed if the word is gone |
  | in use | not moved; the update alert shows on Models and Home, saying what holds it ("held by the reviewer role") | kept; vanished alert |
  | pinned | not moved; no update alert, as for -prev today | kept; vanished alert |
  | shipped | today's update alert and Accept, nothing new | today's vanished alert |

- **Accepting.** Accept on the alert writes the new id through setAddedModel. It does not pin.
- **Pinning.** Pin and Unpin sit in a synced row's editor (POST /api/models/pin {family, pinned}, strict same-origin,
  synced families only). After Unpin, an unused family follows its catalog at the next check.
- **Set pins.** Set (a typed id) on a synced family also pins it. Otherwise the next check would move an unused family
  back to the newest. The notice says "pinned — Unpin to follow Antigravity again".
- **Nothing pending.** A family no role uses has no notice; the Models page's sync line says what moved.

### 4. Removal
- **Unused and unpinned.** When its word is gone from a catalog that read ok, the managed family is removed from
  families.json. History keeps it, and it comes back by itself if the catalog lists the word again.
  `model-id argon` then fails as "unknown model family" rather than handing a CLI a dead id.
- **In use or pinned.** The family is kept. The existing vanished alert shows on Models and Home, and nothing moves.
  Once Cris takes it out of the role, the next check removes it.
- **Guards.**
  - A vendor whose catalog is missing, unreadable, or lists no worded entry at all causes no removals.
  - Moves still use any catalog that read ok.
  - A successful but empty agy answer is saved as the list (lib/usage/gemini.js:142 accepts `[]`), so this guard is
    what keeps a bad answer from emptying the Antigravity families.
- **No Remove button.** Every offered model shows up; an unused one costs a row and a picker option. A hand entry is
  removed by editing the file.

### 5. Excluded entries
- **agy non-Gemini ids** are dropped at read (models-catalog.js:258), so sync never sees them.
- **Every entry's CLI comes from its id prefix.** A claude- or gpt- id runs through claude or codex, never through agy.
  The entry rule changes from "a gemini- id" (lib/models.js:86) to "an id with a known vendor prefix".
- **Orchestrators** and any agy id not shaped `gemini-<version>-<word>` have no word (:247).
- **Codex:** hidden (`visibility` other than list), `-latest` and `codex-` slugs have no word (:98-99, :199).
- **Grok:** hidden entries and variants have no word (:104-106). Grok gives no new family today, since its only
  word is the shipped `grok`.
- **Claude** has no hidden field. Today every word it offers is a shipped family.
- **Preview models.** No catalog marks them in the projected fields, and there is no word denylist (open choice 4).

### 6. Back-compat
| Reader | families.json alone | a role, flavor or pause naming `argon` |
|---|---|---|
| installed resolver older than this PR (today's) | ignored | refuses roles.json / paused.json whole |
| installed resolver from this PR | reads every vendor's entries | resolves |
| older studio (trunk until pulled) | ignored | shows roles.json invalid, refuses edits, never rewrites |

Guards:
1. Sync writes only families.json, which every older reader ignores.
2. The only way a synced name reaches roles.json, a flavor or paused.json is Cris's own role, flavor or pause write.
   Those writes are refused while resolverStale is true (roles-panel.js:132-134, pause.js:132), and resolverStale
   compares models.js, which this PR changes. So after the merge, naming argon needs `acs install-model-id` first, and
   that resolver reads families.json.
3. Trunk is Cris's everyday `acs`. Until trunk is pulled after the merge, no studio on his HOME can offer argon, so
   nothing can name it.

Known gap: a legacy version-1 roles.json write is not stale-guarded (sibling check item 5). Cris's file is version 2.

### Neon
Shipped (models.default.json:15), shipped flavor (roles.default.json:53), and refused as a families.json name
(lib/models.js:81). Sync never writes it. Every phase checks that `model-id neon` prints gemini-4-neon before and
after a sync. It also checks that a newer neon in the agy list gives an update alert and no write.

## Phases (one PR: the read side, sync and screen only work together, and the vendors share one code path)

### Phase 1: read side for every vendor
**Code**
- lib/models.js:
  - familyEntryProblem takes any known vendor prefix and the `track` key (a boolean);
  - loadRegistry merges `track` into `registry.families`.
**Pass/fail** (tests/models-families.mjs, temp HOME)
- gpt-, claude- and grok- entries resolve. An unknown-prefix id is hidden with its reason.
- `track: false` gives a row with `track` false and no update alert.
- `model-id --json` keys are unchanged.
- neon resolves as before.
- The scripted check against main 0f98786's resolver (log.md) is re-run, with codex and claude entries in
  families.json: shipped families and roles come out byte-identical.

### Phase 2: sync engine
**Code**
- planSync({ catalogs, reg, inUse }) is pure. It returns add, move, remove and skipped-with-reason.
- applySync writes once through writeFamilies, inside the queue.
- The newest-id helper is shared with detect().
**Pass/fail** (unit tests in tests/models-families.mjs)
- A new word is added at its newest id, and a dated snapshot never beats an undated alias.
- Orchestrators, hidden entries, `-latest`, `codex-` slugs and grok variants are excluded.
- A shipped word from the same vendor gives no write, and its row keeps its update alert.
- A shipped word from another vendor, a reserved word, a hidden-entry name and a cross-vendor tie are skipped with a
  note.
- An unused family moves.
- In use (use, member object, alt, flavor, expired pause): not moved, and the alert says what holds it.
- Pinned: not moved, no update alert.
- Unused and gone: removed. In use or pinned and gone: kept, with a vanished alert.
- A missing or unreadable catalog, or one with no worded entry, gives no removals for that vendor.
- An unreadable roles.json or paused.json gives adds only.
- A broken families.json gives no write. Hidden entries and unknown top-level keys survive byte for byte.
- A second sync writes nothing.
- neon is untouched in every case.

### Phase 3: trigger and routes
**Code**
- check() runs the sync, and view() carries a `sync` summary (at, added, moved, removed, skipped).
- POST /api/models/pin is added, and Set on a synced family pins it.
- adoptFamily, removeFamily, addable and their routes are deleted.
- Home counts familiesError as a partial check (public/home.js:130 checks only registryError).
**Pass/fail** (real server, temp HOME, planted catalogs and fake CLIs)
- At start, families.json gains argon, hydrogen, flash and luna, and the fake agy and codex record no call.
- Check now with a newer argon in the list moves an unused argon.
- With argon in the reviewer role, Check now leaves the id alone. The update alert is in /api/models and on Home's
  attention list, and Accept moves it.
- Pin stops the move and the alert. Set pins.
- The adopt and remove routes are 404.
- The existing tests (models-panel, models-agy, models-refresh, home, models-layout-ui) pass unchanged. Some plant
  non-shipped words: tests/models-panel.mjs:287 and :441 assert every row is "default" or "override". If one breaks
  because sync added a row, stop and report it; any change follows the test-change rule.

### Phase 4: screen
**Code**
- Set by reads "synced from Antigravity", or "added by you" for a hand entry.
- A synced row's editor has Save and Pin or Unpin; there is no Reset and no Remove.
- An in-use update alert says what holds it.
- A sync line sits under the catalog lines: added, moved, removed, and not synced with each reason.
- The "Not added yet" line and Remove are deleted.
- The branch's own adopt and remove tests go in a test-only commit that names each one and why. They were never on
  main.
**Pass/fail**
- tests/models-layout-ui.mjs covers the sync line, the pinned and synced rows, the Pin and Unpin posts, and the
  hold reason.
- The orchestrator runs one browser QA under a temp HOME.

## Known limits
- Shipped families never follow their catalog by themselves; they keep the update alert and Accept.
- A roles.json naming a synced family is invalid on a machine whose catalogs never listed it, such as a fresh Mac
  before Check now.
- An older ACS checkout shows roles.json invalid once a role names a synced family. It never rewrites the file.
- Sync runs only when the studio starts or Check now is pressed. A Mac that never opens the studio has no synced
  families.

## Follow-ups (filed)
- Does agy reject an effort the model does not list? Argon lists no xhigh. If it does, limit the three effort pickers
  by the catalog's `efforts`.
- A builder or security warning by vendor for agy families, if wanted.
- Sibling check items 4 and 5 (log.md): editor and describe errors lack the families.json note, and a legacy write
  is not stale-guarded.

## Open choices (recommendation first)
1. **Shipped families never follow their catalog by themselves (recommended).** The alternative is the same
   protection rule, which today moves nothing anyway, since every shipped family has a shipped flavor.
2. **Unused synced families whose model is gone are removed (recommended).** The alternative keeps them with a
   quiet vanished mark; `model-id` then hands the CLI a dead id.
3. **Set on a synced family pins it (recommended).** Otherwise an unused family's next check undoes the Set.
4. **No preview or experimental word denylist (recommended).** No real catalog shows one today. Add it when a junk
   word appears.
5. **Skills calling `model-id <family>` directly do not count as "in use" (recommended).** The brief's definition is
   roles, flavors and pauses, and a skill naming a family is meant to follow it. The alternative protects anything
   where-used finds.
