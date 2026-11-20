# Advisory brief: model vendor vs harness in ACS (before the Gemini 4 Neon PRs)

## THE ASK
Cris wants Google's Gemini 4 Neon usable everywhere ACS uses a model family (model-id, ask-model, roles, review-gate reviewers, --eval), and Google's Antigravity CLI (`agy`) supported as a harness, then a benchmark (Neon vs Opus 5.5, Sol 6.2, Sol 6.1, Grok 4.7) on his 30 trial cases. His answers today: "Gemini is the brand like Claude but there can be different models just like Claude and codex" (so the family is the model, e.g. `neon`, and Gemini/Google is the vendor), and on agy also serving Claude Opus/Sonnet 5.5 and GPT-OSS: "Same thing for like opencode it can serve different models so do what's best for these harnesses." Web search in Neon read-only calls is accepted (noted). Billing is subscription quota.

## WHAT WE KNOW
- ACS picks the CLI from the model id's prefix (claude- → claude, gpt- → codex, grok- → grok) in 5 copies: lib/models.js:27-33, tools/ask-model.mjs:474-479, packs/review-gate/runtime/review.mjs:475-482 (VENDORS = ['codex','claude','grok']), public/workflow.js:14, packs/review-gate/tests/review.skills.test.mjs:104.
- "Vendor" today means both who made the model (crossFamily / cross-vendor checks compare vendors: review.mjs ~1240-1340, second opinion and security pick "another vendor" ~2650, 3319) and which CLI runs it.
- Silent fallbacks: review.mjs runModel :2478-2482 runs anything not claude/grok as codex; ask-model argvFor ~482-511 gives an unknown vendor grok's argv; lib/setup-clis.js:75-77 treats non-codex as grok auth.
- agy ids: gemini-4-neon-{low..xhigh} (base id + --effort works), plus claude-opus-5-5-*, claude-sonnet-5-5-*, GPT-OSS 120B. agy headless JSON has no served-model field; only stream-json init.model echoes the request. Read-only works via --settings permissions.deny [command(*), write_file(*), mcp(*), read_url(*)]; web search cannot be denied; no "shell but no writes" mode.
- lib/models.js FAMILY_KEYS allows only `track` per family (:36, :73-79).
- Frozen test packs/review-gate/tests/review.test.mjs:248-250 uses 'gemini' as an unknown reviewer name; a family named `neon` avoids touching it.

## CURRENT DIRECTION
Draft plan: PR A0 (unknown vendors fail loudly), PR A (neon family on agy: gemini- prefix → agy in all 5 copies; sol-prev = gpt-6.1-sol), benchmark, PR B1 (Antigravity instructions/model guide), PR B2 (packs install skills into ~/.gemini/config/skills using the codex twin).
Proposed addition to answer Cris's harness point: separate the model's **vendor** (anthropic/openai/xai/google — what cross-vendor checks compare) from its **harness** (the CLI that runs it: claude/codex/grok/agy, later opencode). Default harness from the id prefix as today; gemini- → agy. Per-family harness override (e.g. Opus via agy or opencode) is allowed by the data model but not built in PR A. Cross-vendor checks always use the model's vendor, never the harness.

## DECISIONS IN PLAY
1. Do the vendor/harness split now (in A0 or A), or keep prefix = CLI and add only gemini- → agy?
2. If now: minimal shape — where the single source of truth lives so the 5 copies stop drifting (e.g. one table in lib/models.js that review.mjs and ask-model read, given review.mjs is installed standalone at ~/.agent-config-studio/review-gate/review.mjs).
3. Is the 4-PR split right, or should A0 fold into A?

## READ FIRST
- /Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-gemini-family/lib/models.js
- /Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-gemini-family/tools/ask-model.mjs (lines 440-520)
- /Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-gemini-family/packs/review-gate/runtime/review.mjs (lines 460-545, 1230-1340, 2470-2485)
- /Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-gemini-family/models.default.json
