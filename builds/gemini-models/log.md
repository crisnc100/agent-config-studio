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
