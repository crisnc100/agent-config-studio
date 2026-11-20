
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
