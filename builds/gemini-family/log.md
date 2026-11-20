
## PR A0 — unknown vendors fail loudly (builder, 2026-11-20)
- review.mjs runModel: codex is explicit; any other vendor throws `no CLI runs vendor "<v>" (<family>)`. Reachable today through a --security-worker job file; test fails before (codex ran), passes after.
- ask-model: VENDORS list; argvFor throws for a vendor with no wiring (main turns it into exit 4, CLI not run); sandboxProblem names an unknown vendor instead of null; readAnswer exit 4 for one. argvFor/readAnswer/sandboxProblem exported for the tests.
- setup-clis signInFor: throws for an id that is not claude/codex/grok (was checked as grok).
- models-catalog: exported vendorLabel() throws on an unknown vendor; models-panel and readCatalogs use it (models-panel's own LABEL copy removed).
- agent.js openWorker: gated to HARNESSES (claude, codex, grok).
- app.js vendorDot: unknown vendor → `unknown` (a ring in styles.css), was drawn as grok.
- Already loud before A0 (tests added to pin it): loadPool unusable list, REVIEW_REVIEWER on an unknown-prefix family, ask-model on an unknown-prefix id, openWorker on an unknown-prefix id.
- Checks: node tests/run.mjs --local --jobs 6 → 141/141; node --test packs/review-gate/tests/*.test.mjs → 897/897. Frozen review.test.mjs untouched.

## PR A0 fix round (review 2026-11-20-16-59-30-8ef164)
- f1: a REVIEW_MODEL / config "model" pin whose id has no known prefix stops with `<setting>=<pin> resolves to "<id>", whose prefix names no known CLI`, on the implicit pin and with REVIEW_REVIEWER=codex. New test in review.behavior.test.mjs (failed before, exit 0).
- Test-only commit before it: review.security.test.mjs "4 selection" pins REVIEW_MODEL 'sol' instead of 'gpt-stub-sol' (the file's model-id stub rewrote the raw id to 'stub-gpt-stub-sol'). No assertion changed.
- f2 LOW filed, not fixed.
- Docs: the code-review skill (claude) says a raw model pin with no known prefix stops the run. The codex twin has no pin sentence, so it is unchanged.
- Comments: review.mjs pin comment now names the known-prefix stop; ask-model's test export moved above install()'s doc comment.

## PR A phase 1 — neon family, one prefix table (builder, 2026-11-20)
- VENDOR_PREFIXES in lib/models.js; identical copies in review.mjs and public/workflow.js, ask-model imports it; tests/vendor-prefixes.mjs.
- neon → gemini-4-neon, sol-prev → gpt-6.1-sol (track:false), sol default → gpt-6.2-sol; neon flavor (no avoid list: tests/roles.mjs pins "shipped defaults set no avoid list").
- agy: pause vendor, vendor dot, Antigravity catalog reported as "keeps no catalog on disk" (guard f forbids a spawn), gemini lint patterns, audit name/command matching, picker label.
- Open: sol-prev makes stale sol ids ambiguous in the audit (tests/audit.mjs, audit-routes.mjs fail); proposal sent to the orchestrator.

## PR A phase 2 — containment probe (builder, 2026-11-20)
- containment-probe.md: the deny list holds for tool calls (workspace settings, hook allow/permissionOverrides don't undo it), but workspace .agents/hooks.json, .agents/mcp_config.json and .agents/plugins run shell commands, trusted or not, also via --add-dir. Recommended refusal sent to the orchestrator; not built.

## PR A phase 3 — ask-model on agy (builder, 2026-11-20)
- argv per brief + per-call --log-file; refusals (MCP config, non-cmux hooks, --investigate/--no-tools/--min-tools, --x-search); failures exit 4; init.model ≠ id exit 2; served model recorded unverified. f2 and x1 closed. tests/ask-model-agy.mjs.

## PR A phase 4 — review gate on agy (builder, 2026-11-20)
- runAgy, model unverified in reviewer line/report/FINDINGS_JSON/record/close/eval; never security (pinned, role, worker); REVIEW_AUTHOR=agy unknown; x2 built as refuse (non-codex pin stops). review.agy.test.mjs.
- First real eval errored: agy's result.response joins every response turn (its finish tool refused the first schema answer; the retry followed), so the JSON did not parse. The answer is now the last response turn's text, in review.mjs and ask-model.
- Proof: `PATH=<worktree>/bin:$PATH node packs/review-gate/runtime/review.mjs --eval --family neon --cases <clean-advisor-no-edit, logic-schema-enum-key-order> --yes` → clean 140.8s, caught (medium) 216.4s, modelVerified false (eval-proof/eval-neon-2cases.out).
