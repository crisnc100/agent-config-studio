# Objective

Wire the reviewed containment helper into the explicit public `ask-model --family neon --build --cwd <worktree>` route and the resolver installer. Keep this a narrow CLI/install phase, with deterministic tests and no live model calls. A prior helper checkpoint review must finish before this phase starts; the orchestrator will supply its id and any resolved fixes.

# Read first

~/.codex/AGENTS.md; builds/neon-builder/{plan,helper-phase,ORCHESTRATOR-STATE}.md; tools/{ask-model,agy-builder,agy-builder-source}.mjs; bin/model-id.mjs installer; tests/{ask-model,ask-model-agy,agy-wall,agy-builder,agy-builder-source,agy-builder-wall}.mjs; tests/SUITE and installer tests. Existing read-only tests and AGY_WALL literals are the frozen behavior baseline, not frozen files. Do not edit review.test.mjs.

# Constraints

- Work only in /Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder. No edits to Cursor-seat/trunk, installed runtime, live roles, benchmark runner/cases or global trust/settings. No model/review/push/merge calls, Docker, local full suite/e2e/benchmark. Native Sol medium only. Report to orchestrator, never Cris.
- Public --build is opt-in, agy only, requires an explicitly supplied --cwd that resolves to the exact canonical Git top. Reject conflicts with investigate/no-tools/min-tools/x-search/schema and roles other than builder before starting any vendor CLI. --json is supported. Explicit --family neon is allowed for the user-authorized pre-enrollment probe. Other vendor/default modes retain existing behavior.
- Use `runAgyBuilder` and current checks as callbacks exactly as helper-phase.md describes. Do not pass test overrides from public CLI/env/config. Never execute an unwalled alternative. Preserve error exit semantics where appropriate and never report build.published:true on a failure. Do not alter helper containment to make wiring tests pass.
- Existing read-only AGY_WALL/AGY_SETTINGS and review runtime remain byte-identical. Keep defaults read-only and retain security-role refusal, token/customization/version controls and model-unverified labels. Build provides source edits with command/MCP/URL actions denied; first-party Google-side web search remains available. No arbitrary shell/commit/push/merge capability.
- Preserve `family,id,effort,mode,answer,error` JSON conventions and helper `served:{requested,id,verified:false}`, `build:{published:true}`, `changed:[...]` success data. Expose denied-action evidence and unverified warnings like current Neon calls; do not claim a private log survives cleanup or leak broker/auth credentials. Ask the orchestrator if the existing result callback cannot provide needed refusal evidence.
- Effort uses the existing resolver. For named-family build calls, prefer its builder-role member effort by default, preserving explicit --effort/--effort-from precedence; don't hardcode a model id. Treat empty effort as absent for the helper. Benchmark will explicitly pass high.
- Install both helper modules adjacent to installed ask-model through the existing installer. Default read-only installation must remain usable. Keep dependencies self-contained, no new package. Support the arm64 macOS pin honestly; off-platform build refuses without a model call.
- Add meaningful CLI/installer tests using fake modules/CLIs or an internal unit seam that public CLI cannot control. No production env bypass. Never call real Neon in a test. Register new focused tests in tests/SUITE. Existing-test edits (including SUITE) must go in a separate TEST-ONLY commit; name changed assertions/guarded behavior in that commit. No test weakening. Orchestrator will run the independent weakening check.
- Writer/context pass happens once after validation. Leave broad README/comment cleanup to it; update executable usage/help text as part of the CLI change. Don't bulk-stage benchmark snapshots or parent observer/opinion files unless specifically named by the orchestrator.

# Validation

Run targeted new CLI/installer tests and `taskpolicy -b node tests/ask-model.mjs`, `tests/ask-model-agy.mjs`, `tests/agy-wall.mjs`, `tests/guards.mjs`, `tests/suite-coverage.mjs` sequentially with ACS_LIVE_CHECKS=0. Run any touched installer checks. Ensure new tests have honest macOS skips/portable deterministic paths for Linux CI; no Docker to simulate it. No full suite and no real model calls. Keep counts and logs concise.

# Stop

Stop after code commit plus separate existing-test-only commit and focused checks. Return exact public command, changed files, test counts, test-only commit assertions and any limits. Never install/run the live mode yourself. The orchestrator owns the combined live probe, conditional role enrollment, benchmark coordination and pr-review.
