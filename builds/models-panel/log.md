# Models panel — build log

Implementer decisions, in order. Plan: `plan.md` rev 2.

1. **Codex catalogs are a UNION** (deviation; the orchestrator's rule, replacing my first
   pick-one proposal). Evidence: at 00:22Z `~/.codex/models_cache.json` (client 0.155.0, newest
   `fetched_at`) listed no `gpt-6-*`, while both seat homes (0.156.0) listed `gpt-6-sol`; plain
   "newest fetched_at" would have raised a false Vanished for sol. At 00:45Z the same 0.155.0 file
   listed `gpt-6-*` too, so the cause (client version, the login's entitlements, rollout timing)
   is **unverified** — and no pick-one rule is safe without it. So:
   - an id is offered if ANY loaded catalog (`~/.codex` + every registered codex seat home) lists
     it; Vanished fires only when it is absent from all of them; candidates come from the union;
   - per-id metadata (display name, visibility, upgrade/retirement) comes from the catalog with the
     highest `client_version`, tie-break newest `fetched_at` — a **heuristic, unverified**;
   - catalog age is the newest `fetched_at`;
   - when the loaded catalogs list different ids, `disagree` carries a note naming the home and
     client version (never the file), shown under the Codex line; it is not an error or staleness.
   Fixtures: catalog A (older client, fetched last) lacks `gpt-6-sol`, catalog B lists it → no
   Vanished, no false candidate, metadata from B, age from A, note present; an id absent from both
   still raises Vanished.
2. **`track: false` lives in a new top-level `families` object** (`"families": {"grok-prev":
   {"track": false}}`) rather than turning `models` values into objects. `models` stays
   family → string, so the resolver, the lint and every existing reader are unchanged. `checkShape`
   accepts `families` (known families, `track` boolean only); the user file may set it too.
3. **Catalog modules take no seat import.** `lib/models-catalog.js` reads only `fs`; the server
   passes the codex seat homes from `loadSeats()`. Keeps lib/usage (which spawns) out of the
   panel's import graph.
4. **User-file edits are positional text edits** (`lib/jsontext.js`), not parse + stringify, so
   the other overrides and `assist` survive byte-for-byte. The same scanner does the
   `settings.json` edits. A missing user file is created with only `version` and the one key.
5. **Confirm is a 200 with `needsConfirm` + `warnings`**, like PUT /api/file's `saved:false`
   shape. Warnings: vendor prefix change; id not in that vendor's catalog; no catalog to check
   against; Claude `min_claude_code_version` above the installed CLI (or installed unknown).
6. **Accept goes through `setModel` with `confirm:true`** after the server re-finds the alert in
   the live detection; a not-acceptable candidate (needs newer Claude Code) is a 409. Accept and
   Dismiss only act on alerts detection shows right now.
7. **Installed Claude Code version** comes from the injected `detectFn` (`detectHarnesses`), the
   existing `readVersion` path. Unknown installed version → a gated candidate is not acceptable.
8. **Detection state**: catalogs + CLI version are read once, lazily or at server start
   (`models.check()` in the launch block), and on "Check now". Alerts are recomputed per request
   from that state, the current registry and the dismissed file — so an edit clears its alert at
   once, and a catalog change shows only after Check now. No timer.
9. **Dismissed store**: `~/.agent-config-studio/models-dismissed.json`,
   `{version, families: {fam: {id, keys}}}`. A key is `kind:candidate` (or `kind:id` for
   Vanished), so a different newer candidate un-hides; the entry only applies while the family
   is still on the id it was dismissed against.
10. **Sidecars**: three edits, each proposed only from the one old → new change —
    `modelSettings` copy (Cris's decision: Copy, old key stays), the top-level `settings.json`
    `"model"` (a separate proposal, per criterion 8), and `config.toml`'s top-level `model =` line
    (before the first table header only). Accept re-derives the file from `kind` server-side (no
    path crosses the wire), requires the proposal's mtime, and refuses a `to` that is not a
    current registry id. The strip carries the server-returned mtime forward to the other
    proposals on the same file, since that write is the only change since they were proposed.
    Writes go through the symlink to its target (seat homes symlink config.toml).
11. **History**: every write is `recordBaseline` → atomic temp+rename → `record`. `snapshotAll`
    now also mirrors `~/.agent-config-studio/models.json` when it exists — it is not in
    `buildRegistry`, so without this each startup snapshot recorded it as deleted and the tip of
    history lied. (One-line addition in lib/history.js.)
12. **Where-used**: `lintScope()` files, regex `model-id\s+<family>(?![\w.-])` — so `model-id
    grok-prev` is not a use of `grok`, and prose never matches. Computed only on row expand.
13. **Guard f** (tests/guards.mjs, added; no existing guard touched): over
    `lib/models-catalog.js`, `lib/models-panel.js`, `lib/jsontext.js` and `server.js`, comments
    stripped, fails on any string literal equal to `child_process`/`node:child_process`, on any
    `import()`/`require()` whose argument is not a plain literal, and on `process.binding(`.
    Checked by planting a static import, a computed dynamic import and a template-literal
    import (all three fail) and a comment mention (passes).
14. **Criterion 9**: tests/real-home.mjs also hashes `~/.claude/settings.json`,
    `~/.codex/config.toml`, `~/.codex/models_cache.json`, `~/.grok/models_cache.json` and every
    `~/.claude/cache/model-catalog/*-cc.json`, by name.
14b. **Criterion 9 catalogs, stamp-normalized** (deviation, approved by the orchestrator): two
    consecutive verify.sh runs failed strict byte-identity on `~/.codex/models_cache.json` and
    `~/.grok/models_cache.json`. A parsed diff across phase1+phase2a alone showed only codex
    `fetched_at` and grok `renewed_at` changed. The grok one is consistent with phase1/phase2a's live grok
    turns (unverified which process wrote it); the codex one with a codex process outside the suite. So catalogs are hashed with only the
    freshness-stamp values blanked (`fetched_at`, `renewed_at`, `fetchedAt`, `staleAt`); a
    re-stamp is printed as a `note` line; settings.json and config.toml stay strictly
    byte-identical. Checked: a re-stamped copy compares equal, a copy with one slug edited does not.
14c. **Criterion 9, fresh-stamp rule for the Codex and Grok catalogs** (deviation, approved by the
    orchestrator). Evidence: verify run C failed on `~/.codex/models_cache.json` with a change
    beyond the stamp. A read-only 4-minute watch (01:01–01:05Z) showed two Codex clients taking
    turns rewriting that file about once a minute: 0.155.0 (with `identity`, 352271 bytes, lists
    `gpt-6-sol`/`gpt-6-luna`) and 0.153.4 (no `identity`, 228040 bytes, lacks both), flipping at
    01:03:02, 01:03:29, 01:04:37 and 01:04:49. So for those two files only, a change passes when the
    file is still valid JSON of that CLI's shape (Codex: `models` array; Grok: `models` object)
    and its freshness stamp (`fetched_at`; Grok: the later of `renewed_at`/`fetched_at`) is newer
    than at the start of the run; each such rewrite is printed with old → new client version and
    stamp. A changed list with a stamp that did not advance, or an unparseable file, fails.
    settings.json and config.toml stay strictly byte-identical; the Claude catalog stays
    stamp-only (14b). Checked against a simulated HOME: a newer-stamp rewrite passes with a note;
    a same-stamp list change, invalid JSON, a Claude list change and a one-byte settings.json change
    all fail. Paired with **guard g** (tests/guards.mjs, added): any lib/, bin/ or server.js file
    whose code names a catalog path (`models_cache.json`, `model-catalog`, `-cc.json`) may contain
    no write API (writeFile*, appendFile*, createWriteStream, rename*, copyFile*, cp*, truncate*,
    open with a w/a flag); it also fails if no file names a catalog path at all. Only
    lib/models-catalog.js names one today. Planted in it, `fs.writeFileSync(...models_cache.json)`,
    `fs.openSync(p, 'w')` and `fs.renameSync(a, b)` each fail the guard.
14d. **Grade fixes.** Guard f now runs on its own regex- and template-aware tokenizer
    (`tokenizeJs` in tests/guards.mjs; the shared `stripComments`/`skipString` are untouched, so
    guards a–e behave exactly as before). The old pass lost string/code parity at the `"` inside
    a regex literal in lib/models-panel.js and blanked the rest of the file. Guard f also fails on
    calls named spawn/spawnSync/exec/execSync/execFile/execFileSync/fork. Guard g reads the same
    tokenizer's comments-stripped, strings-kept view. Plus: never propose an id with an 8-digit
    date segment over one without; a Codex entry with no `visibility` is listed; config.toml's
    top-level scan stops only at a real table header outside an open multi-line array;
    tests/real-home.mjs blanks only TOP-LEVEL stamp keys (via lib/jsontext.js `scan`); the two
    tautological checks in tests/models-panel.mjs became real ones (the server read the fixture
    skill; every server HOME was a fresh temp dir).
15. **QA launcher**: `node tests/models-qa-server.mjs` — temp HOME from the fixtures, a user file
    with an `astra` override and an `assist` override, one alert of every kind. Not in verify.sh.

## Criterion 3 — real-machine report (recorded)

`node builds/models-panel/real-report.mjs`, read-only, run 2026-09-23T01:33:18Z on this branch
(registry = shipped defaults, no family override), exit 0:

```
registry error: none
claude code: 2.1.280 (Claude Code)
catalog claude: ok=true models=9 fetched=2026-09-23T00:33:08.807Z note=-
catalog codex: ok=true models=9 fetched=2026-09-23T01:33:12.048Z note=-
catalog grok: ok=true models=4 fetched=2026-09-23T01:20:06.807Z note=-
fable      claude-fable-5-1             default  track=true in-catalog=yes  alerts: none
opus       claude-opus-5-5              default  track=true in-catalog=yes  alerts: none
sonnet     claude-sonnet-5              default  track=true in-catalog=yes  alerts: none
haiku      claude-haiku-4-5-20251001    default  track=true in-catalog=yes  alerts: none
astra      gpt-6-astra                  default  track=true in-catalog=yes  alerts: none
sol        gpt-6-sol                    default  track=true in-catalog=yes  alerts: none
terra      gpt-5.6-terra                default  track=true in-catalog=yes  alerts: none
grok       grok-4.7                     default  track=true in-catalog=yes  alerts: none
grok-prev  grok-4.6                     default  track=false in-catalog=yes  alerts: none
pending alerts: 0
```

Line by line:
- **registry error: none** — the real user registry file parsed and passed `checkShape`; every
  family shows `source=default`, so it sets no `models` key.
- **claude code 2.1.280** — from the existing `detectHarnesses` → `readVersion` path; it gates
  `min_claude_code_version`.
- **catalog claude** — one `*-cc.json`, 9 models, fetched an hour earlier: under the 7-day stale
  bar, so no note.
- **catalog codex** — the union of `~/.codex` and both seat homes: 9 distinct slugs, age = the
  newest `fetched_at` of the three. No `disagree` note at this instant: every loaded list had the
  same slugs (the 0.153.4 writer's shorter list was not the one on disk; see 14c).
- **catalog grok** — 4 models, age from `renewed_at`.
- **fable claude-fable-5-1: none** — newest Fable (Fable 5 is older); in catalog; needs 2.1.251,
  installed 2.1.280.
- **opus claude-opus-5-5: none** — Opus 5 and 4.x are older; in catalog; needs 2.1.280, which is
  what is installed.
- **sonnet claude-sonnet-5: none** — sonnet-4-6 is older.
- **haiku claude-haiku-4-5-20251001: none** — the only Haiku, present.
- **astra gpt-6-astra: none** — the only astra slug.
- **sol gpt-6-sol: none** — gpt-5.6-sol is older; gpt-5.5 has no family (numeric trailing word);
  present in the union even when one writer's list omits it.
- **terra gpt-5.6-terra: none** — the only terra; no upgrade block. gpt-5.5's retirement
  (2026-10-14 → gpt-5.6-sol) is on an id no family pins, so it raises nothing.
- **grok grok-4.7: none** — newest plain grok; grok-4.7-build-fast is suffixed, never proposed.
- **grok-prev grok-4.6: none** — `track=false` blocks the grok-4.7 update by design; present, so
  not Vanished; the Grok catalog carries no retirement data.
- **pending alerts: 0** — matches the plan's expectation (no updates, retiring or vanished).
