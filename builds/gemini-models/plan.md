# Gemini models on the Models panel (usage PR C) — plan

Goal: the Models panel shows the Gemini models Antigravity (`agy`) offers on Cris's subscription, so he sees what is
available and when a newer one appears, the same way it shows other vendors' catalogs. Only `gemini-` ids: Cris never
runs Opus or GPT-OSS through Antigravity (decisions.md). Adopting a listed model as a family is PR D.

One PR: the reader, the cache and the screen only make sense together.

## Data source (Phase 0 probe, agy 1.5.13, 2026-11-20)
`agy --output-format json models` (the flag before the subcommand; `agy models --output-format json` exits 1 with
"flags provided but not defined"), from a fresh empty folder, stdin closed, CMUX_ANTIGRAVITY_HOOKS_DISABLED=1: exit 0
in 1.4 s, status SUCCESS, num_turns 0, total_tokens 0, conversation_id "", `command.name` "models",
`command.data.models[]` = `{ id, label }` and nothing else (no version, retirement or default). It binds 127.0.0.1:0.
agy keeps no model list on disk; each run fetches it. 23 entries; 16 are `gemini-`, each listed once per effort
(`<base>-low|medium|high|xhigh`, label "<name> (High)") except the two orchestrators (`gemini-pro-orchestrator-*`).
The registry holds base ids (neon = the base id; effort goes on `--effort`, agy accepts base ids since 1.3.4).
Changelog: `models` subcommand 1.0.5; JSON output for it 1.1.12. Raw replies: probe/models-1.5.13.{json,txt}.

## Phase 1 — reader
lib/usage/gemini.js: `readGeminiModels()` reuses runAgy (temp folder, opts, deadline, output cap, the `--version`
call) with a third pinned argv `['--output-format','json','models']`, only on agy ≥ 1.1.12 (MODELS_MIN_VERSION).
Accept only status SUCCESS, `command.name === 'models'`, `num_turns === 0`. `shapeModels(json)`: keep ids whose vendor
is agy and that pass ID_RE, collapse `<base>-<effort>` to one entry `{ id: base, displayName, efforts }`, label without
its " (Effort)" suffix. tests/guards.mjs gains the third literal in a test-only commit before the code.
Pass/fail: tests/usage-gemini.mjs (real fixture → exactly 6 base ids, no claude-/gpt- id, neon efforts low..xhigh;
a turn, another command, an agy below 1.1.12, non-JSON and a failed status are refused), tests/guards.mjs,
tests/models.mjs.

## Phase 2 — catalog and Check now
createModelsState takes `refreshAgy` (server.js passes readGeminiModels, tests a fake). Only `check({refresh:true})`
runs it; a success writes ~/.agent-config-studio/cache/agy-models.json (projected fields, fetchedAt, agyVersion)
atomically; a failure leaves the file and sets the catalog's refreshNote. readAgy reads that file, never spawns:
family = the last word of a `gemini-<numbers>-<word>` id, else null; no file → note to press Check now; older than
STALE_MS → the same note.
Pass/fail: a new test with a fake HOME and a fake refresher, no real agy: neon gets "Gemini 4 Neon" and no alert;
a planted newer neon raises an update alert; neon gone → vanished; orchestrators never alert; a failed refresh keeps
the cache and shows the note. tests/models.mjs.

## Phase 3 — screen and Home
Check now's sentence names Antigravity; the Antigravity line lists the base names; Home says "press Check now" for
agy instead of "run it once". Pass/fail: the models panel and home test files, one at a time. Browser QA is the
orchestrator's.

## Decisions (decided by orchestrator 2026-11-20)
1. The Antigravity catalog line lists the base model names inline; other vendors keep their counts.
2. Effort variants collapse to base ids; `efforts` is kept as a projected field (PR D will want it).
3. Orchestrators stay in the list with family null, so they never alert; PR D decides whether they can be adopted.
4. agy runs on Check now only; nothing at server start (test servers can never reach a real agy).
5. The list lives in ACS's own cache, ~/.agent-config-studio/cache/agy-models.json, written atomically; a failed
   refresh keeps the old file and adds a note.
6. One agy spawn site: a third pinned argv in lib/usage/gemini.js; the guard change is a test-only commit first.
7. The models floor is 1.1.12, its own constant; /usage keeps 1.1.11.
8. API-key sign-in: no special handling (see Known limits).
9. A family set by hand to a suffixed id keeps the "not in the Antigravity catalog" confirm warning: the registry
   holds base ids and effort is per role.

## Known limits
- The list is whatever agy is signed in with. Under a GEMINI_API_KEY or ADC login agy lists that login's models, not
  the subscription's; the Gemini usage seat already says when agy is on an API key.
- agy gives no retirement data, so Antigravity families never get a "retiring" alert; a removed model shows as
  vanished.
- Not tested (it could run a turn): what an agy without the `models` subcommand does with this argv. The 1.1.12 floor
  is the guard; every agy from there on has the subcommand with JSON output.

Out of scope: adopting a model as a family (PR D), opencode, the review runtime, tools/ask-model.mjs,
models.default.json.
