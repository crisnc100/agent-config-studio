# Gemini models on the Models panel — log

## Phase 0 — probe (builder, 2026-11-20)
- `agy help` lists a `models` subcommand; `agy help models` has only -h. `agy models --output-format json` → exit 1
  ("flags provided but not defined: -output-format"); `agy --output-format json models` → the JSON list.
- Sandboxed, it fails with "listen tcp 127.0.0.1:0: bind: operation not permitted"; run with the sandbox off.
- Reply: SUCCESS, num_turns 0, total_tokens 0, conversation_id "", command.name "models", 23 `{id,label}` entries,
  1.36 s. stderr: "Fetching available models...". One new log file under ~/.gemini/antigravity-cli/log per run.
- `-p /model --output-format json` → only the current model (`id`, `label`, `effort`, `is_default`): not a catalog.
- ~/.gemini holds no model list (names listed only; nothing named token/credential/auth/oauth read).
- Orchestrator decided all nine open choices (plan.md, Decisions).

## Phase 1 — reader (builder, 2026-11-20)
- tests/guards.mjs (test-only commit 886f0a4): AGY_USAGE_CALLS gains `spawn(found.binary, ['--output-format', 'json',
  'models'], opts)`; guard b failed against the old reader (opts named 3 times, 4 expected) until the code landed, and
  fails on an appended argv (checked by planting `'-p', 'hi'`, then restored).
- lib/usage/gemini.js: runAgy picks among three literal calls and refuses any other name; the version read is shared
  (readAgyVersion), readGeminiSeat's messages unchanged. readGeminiModels: agy ≥ MODELS_MIN_VERSION (1.1.12), status
  SUCCESS, `command.name === 'models'`, `num_turns === 0`; non-zero exit → sign-in hint (no API-key case, decision 8).
- shapeModels: ids must pass ID_RE and be agy's (`gemini-`); `<base>-<effort>` (EFFORTS) collapse to the base, efforts
  in EFFORTS order; the label loses " (Effort)" only when it names that id's effort; capped at 200; a list with no
  Gemini model is a failure, not an empty catalog (it would make every Antigravity family look vanished).
- Real fixture → gemini-4-neon "Gemini 4 Neon" low..xhigh, argon, hydrogen, 3.8-flash, two orchestrators kept whole.
- Checks: tests/usage-gemini.mjs 86/86, tests/guards.mjs 11/11, tests/models.mjs 64/64.

## Phase 2 — catalog and Check now (builder, 2026-11-20)
- lib/models-catalog.js: agyModelsPath = ~/.agent-config-studio/cache/agy-models.json; readAgy reads it through the
  same readJson (ENOENT → missing, anything else a failed read), keeps only ID_RE-valid agy ids, family = the word of
  a `gemini-<numbers>-<word>` id (orchestrators null). project() carries `efforts` (null for other vendors). The
  noCatalog state is gone; agy's catalog is `checkOnly`, and its notes say "press Check now" where the others say
  "run `<cli>` once".
- lib/models-panel.js: createModelsState takes refreshAgy; only check({refresh:true}) calls it, beside the Codex
  refresh (Promise.all); a success writes {version, fetchedAt, agyVersion, models[{id,displayName,efforts}]} with the
  existing writeAtomic; a failure, a throw or an answer without a list writes nothing and sets agy's refreshNote
  ("Not refreshed: <reason>." + " Shown as last fetched." when a list is saved). The view adds `names` for agy only.
  Guard g holds: models-panel.js writes but names no CLI catalog path; models-catalog.js names them and never writes.
- server.js: refreshAgy = opts.refreshAgyModels || readGeminiModels; nothing runs agy at start.
- tests/models-agy.mjs (new, ci:offline in tests/SUITE): reading, detect (neon name, newer neon → update, gone →
  vanished, orchestrators silent), stale/broken lists, Check now in process (writes, failures keep the file, one ask
  for two Check nows) and through the real server with a fake agy in HOME/.local/bin. Planted bugs (agy asked on a
  plain read; family from any last word) each failed it.
- Checks: tests/models-agy.mjs 44/44, tests/guards.mjs 11/11, tests/models.mjs 64/64, tests/suite-coverage.mjs 33/33,
  tests/models-panel.mjs 118/118, tests/models-refresh.mjs 29/29.

## Phase 3 — screen and Home (builder, 2026-11-20)
- public/app.js: the Antigravity line reads "N models: <names> · fetched X ago" (names only where the view sends
  them, agy only); Check now's sentence says it asks Antigravity for its models too. A stale or missing list shows
  its note instead, as every catalog does; the refreshNote line below it says why Check now did not fill it.
- public/home.js: a never-fetched Antigravity list is one quiet line, "Antigravity: no model list yet — press Check
  now on Models" (setup's CLI check does not cover agy, so Home never says "not installed" for it); an unreadable one
  is partial, like any catalog. The noCatalog branch is gone (nothing sets it now).
- Home does not show agy's refreshNote, the same as Codex's: a failed Check now is reported on Models, where it was
  pressed.
- README: what Check now runs (agy models, 1.1.12+, empty folder, no turn) and the saved list in
  ~/.agent-config-studio; "a run file per port" kept on one line (tests/readme.mjs pins it).
- Checks: tests/models-layout-ui.mjs 58/58, tests/home.mjs 127/127 (the new Home check fails with the checkOnly line
  removed), tests/setup-ui.mjs 94/94, tests/readme.mjs 56/56, tests/models.mjs 64/64, tests/guards.mjs 11/11.
- tests/no-personal-paths.mjs fails locally on reviews/2026-11-20-23-46-51-1998e5/code-review.md, a gitignored PR B
  review artifact in this worktree that names the maintainer; not shipped, not from this branch, left alone.

## Sibling check (before the last commit)
1. Guard b's third pinned call (tests/guards.mjs). Other agy spawn paths: lib/usage/gemini.js runAgy is the only one
   in lib/ (guard b scans all of lib/, bin/, server.js); tools/ask-model.mjs and the review runtime run agy turns
   under their own containment (off limits). Applied.
2. MODELS_MIN_VERSION (1.1.12). The only path to the `models` argv is readGeminiModels → runAgy('models'), after the
   gate; runAgy is module-private. Applied. readGeminiSeat keeps 1.1.11 (tested on a 1.1.11 fake).
3. runAgy refuses a call name it has no literal for. Callers: readGeminiSeat (version, usage), readGeminiModels
   (version, models). Applied.
4. Zero-turn, command-name and status checks for models: shapeModels + readGeminiModels; the one consumer,
   refreshAgyList, also requires ok and a models array before writing. Applied.
5. Gemini-only + ID_RE filter: at shapeModels (what agy says) and again at readAgy (the saved file, which an
   injected refresher or a hand edit could fill). Applied on both.
6. Effort collapse: shapeModels only. Not needed elsewhere: the saved list's only writer is refreshAgyList, from
   shapeModels' output.
7. efforts projection: project() keeps only EFFORTS values; other vendors get null. Consumers: none render it yet
   (PR D). Applied.
8. geminiFamily: agy entries only; detect() also needs parseVersion, which is null for orchestrators. Applied.
9. Notes per vendor (refreshHint) and checkOnly. Consumers: the Models line (app.js shows note), Home (missing →
   missingCatalogText checkOnly; failed read → partial). Applied. noCatalog had no other consumer (grep: none left).
10. names in the view: agy only, from displayName (capped at 200 chars by project, list at 200 by shapeModels).
    Consumer: app.js catalog line. Home ignores it. Applied.
11. agy refreshNote. Consumers: app.js renders every catalog's refreshNote. Home does not render it (not handled, by
    design, the same as Codex's).
12. Saved-list write: only POST /api/models/check → check({refresh:true}); server start's models.check() has no
    refresh (server.js:1917), tested. Two Check nows share one run. Guard g holds. Applied.
13. Check now sentence and README: the only places that describe Check now. Applied.

## Live check (builder, 2026-11-20)
- readGeminiModels() with the default locateBinary on this Mac (real agy 1.5.13, past the cmux wrapper): ok, six
  entries, neon low..xhigh, argon and flash low..high, hydrogen low..xhigh, two orchestrators with no efforts.

## Fix round — review 2026-11-21-02-30-14-c07dfa (builder, 2026-11-20)
- Found while fixing: phase 1's runAgy rewrite broke three tests/setup-guards.mjs variants ("the variant did not
  apply"); setup-guards was not run in phase 1. Re-anchored in test-only 75932b9; setup-guards 100/100 then.
- Sol's test check of 886f0a4: guard b now requires each pinned agy call exactly once and takes the opts definition and
  each pinned call out of the source before looking for any other opts mention (test-only a414f06). Five planted
  models variants added to setup-guards; "second --version spawn" and "void opts" pass the 886f0a4 guard and fail now.
- f1 (+ s1): readGeminiModels and readGeminiSeat both require status === 'SUCCESS'; a missing, empty or non-string
  status reads "agy <what> reported no SUCCESS status". Tested for omitted, null, false, 0 and "" on both paths, and
  through the server: a no-status reply leaves the saved list byte for byte, with the note.
- f2: runAgy registers each call in flight; stopAgyCalls() SIGKILLs them and removes their folders synchronously, and
  server.js's stop handler calls it before re-raising the signal. The suggested process group was checked first and
  not used: agy 1.5.13 starts no child process during `models` or `/usage` (ps sampled every 150–200 ms through both),
  so a group kill has nothing more to kill, and detaching would take agy out of the terminal's foreground group, so
  Ctrl-C on `acs usage` (a CLI with no stop handler) would no longer reach it. opts is unchanged.
  Tested in process (stopAgyCalls) and through the real server: SIGTERM while Check now waits on a hanging fake agy
  → the studio exits, the fake's pid is gone, its folder removed. Dropping the server hook fails both checks.
- Checks: tests/usage-gemini.mjs 102/102, tests/models-agy.mjs 50/50, tests/guards.mjs 11/11,
  tests/setup-guards.mjs 106/106, tests/models.mjs 64/64, tests/models-panel.mjs 118/118, tests/models-refresh.mjs 29/29.

## Sibling check (fix round)
1. status === 'SUCCESS': applied on both agy readers (models, /usage). shapeModels/shapeUsage are only called
   unchecked by tests; their production callers check first. ask-model and the review runtime parse agy turn replies
   under their own rules (off limits). Consumers: refreshAgyList (writes only on ok) and the usage snapshot.
2. stopAgyCalls: applied to the studio's SIGINT/SIGTERM handler, which also serves the self-SIGTERM route
   (server.js:720). Not needed for the acs-usage worker: it is its own process, keeps its own 20 s deadline, and
   refresh.js kills it only at 30 s. Not handled: a studio ended by SIGKILL (the fs watchdog's die(), or acs stop's
   SIGKILL after 3 s) runs no handler, so agy lives until it answers and its folder stays; bounding that needs new
   logic (a sweep of stale acs-agy-usage-* folders, or a self-timeout in the child), proposal only. Not handled, out of
   scope: the codex app-server child of the same Check now (lib/usage/codex-limits.js) has the same gap on stop.
3. Guard b exactly-once and positional opts: applied to the one agyUsageOnly file. The agent inspector pin already
   checks positions (split on the pinned texts); not needed there.
