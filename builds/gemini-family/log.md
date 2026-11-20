
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

## PR A round 2 — lead's decisions (builder, 2026-11-20)
- familyIndex: the shape path uses the exact path's rule (one tracked family wins; pinned stay a fallback). Audit tests where grok-4.5 was ambiguous now use a registry with grok-prev tracked; added an older-grok-is-grok and a lone-pinned-terra assertion (test-only commit 890b105).
- Subscription split: SUBSCRIPTION_OF {agy: gemini} in lib/models.js; PAUSE_VENDORS has gemini, not agy; pausedBy, describe and defaultUntil join through it. `acs pause gemini` pauses neon (test-only commit a96532d for the pause-cli account list).
- Containment: version pin 1.5.13; workspace refusal from the cwd to `/` (.agents/.agent/_agents/_agent × hooks.json/mcp_config.json/plugins.json/agents.json/plugins, any type or unreadable); home plugins/ and plugins.json refuse; deny list adds download_url, execute_url. unsandboxed(*) left off: agy 1.5.13 logs it as invalid and ignores it.
- Probes (real agy): subagents inherit the deny list; empty-cwd absolute-path read is refused by print mode and reported in result.denied_actions (the field exists for approval refusals, not deny-rule ones), so both runtimes print those too.
- REVIEW_AUTHOR=agy note in --security-only. SKILL.md pin sentence, README refusal list.
- Gate: 143 local test files pass one by one (6 at a time); packs 915/915.

## PR A fix round (review 2026-11-20-19-56-35-141781) — builder, 2026-11-20
- f1/f2: probe scripts work only in tagged folders they made under the temp folder; set -euo pipefail and a workspace check before any delete or agy launch. Checked against a foreign folder: exit 2, nothing touched.
- f3: workspace and home refusals before agy --version; the version runs in a fresh empty temp folder (both runtimes).
- f4: ask-model refuses agy for --role security (and --second).
- f5: fix check, second opinion, dispute and eval summary say model unverified; records carry modelVerified / verifierModelVerified false.
- f6: a home hook passes only as cmux's exact command template (fixture from the real hooks.json, user path removed).
- f7: the Gemini display-name pattern matches only whole names.
- s1: agents/ refuses in all four folders; probe/agents.sh showed a custom agent's hooks fire under the deny list.
- Test checks from Sol: cliOf literal again, union fixture neither catalog satisfies, exact model-id output, subscriptionOf inherited keys, pause-cli family list.
- Real agy: ask-model neon from the worktree answered; one-case --eval --family neon caught the bug (56.4s), model unverified on both lines.
