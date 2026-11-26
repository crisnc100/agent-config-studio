# Phase 1 builder contract

## Objective
Implement Phase 1 of plan.md: optional builder policy, pure selection/eligibility and installed picker CLI, with focused meaningful new tests. The configured first-available builder is selected once for this task and remains the task owner across phases/fixes. You are a fresh phase worker, not a new family pick.

## Read first
Read repo AGENTS.md/CLAUDE.md if present, builds/builder-selection/{context,plan,advisor-report,explorer-report}.md, then the narrow source/test regions the reports identify. Model-family strengths are inputs, never hidden weights in random mode. Read the current test rules: existing test changes MUST be in a separate test-only commit, no weakening, frozen review.test.mjs unchanged.

## Constraints
Implement only Phase 1. No public/app.js or SKILL.md changes yet. Keep --role semantics and byte output, and all other roles/flavors intact. Keep settings optional. Read existing usage snapshot only, never refresh quota or launch providers. Handle effective Codex home/account stat, individual reading freshness and ambiguity conservatively. No optimism about unmapped alternate accounts, no silent override when all excluded. Validate policy, exclusions, explicit design flag, mode-specific selection. Use crypto.randomInt for uniform random. Keep Jev subprocess in bin/model-id.mjs, with safe fixed stdin JSON, pinned executable/args, bounded time/output, robust eligible finite confidence >=0.7 and <=1. CLI errors must be clean. No live Jev calls required for tests: stub or inject. Keep installation self-contained; preserve legacy resolver imports. No real personal config writes. No provider calls, subagents, reviews, pushes, PRs or merges. Commit phase work and build log; existing-test edits in a separate test-only commit describing each changed assertion and guarded behavior. Do not loosen guards just to pass: justify one audited spawn for Jev; preserve the guard's security intent. No bundling unrelated cleanup.

## Validation
Run the focused new picker tests plus existing roles/model-id/installation/pause compatibility tests relevant to changes. Discover exact commands from tests/SUITE.txt and package scripts; record commands/results. Do not run the full suite on laptop. Check git diff --check. Log exact new tests and existing-test assertion changes.

## Stop condition
Phase 1 committed with focused checks green, build log updated, clear exported CLI/API shape for Phase 2. Return concise changed files, tests/counts, commits, unresolved concerns. Stop before Phase 2 and before any review. Do not grade your own work.
