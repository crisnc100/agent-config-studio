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
