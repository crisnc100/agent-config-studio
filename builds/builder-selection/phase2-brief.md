# Phase 2 builder contract

## Objective
Implement Phase 2 of builds/builder-selection/plan.md: configurable builder selection in existing Roles UI/API, compatible save/Describe flow and generated guide. Keep the Phase 1 API and task owner stable.

## Read first
Repo instructions; builds/builder-selection/{context,plan,advisor-report,explorer-report,log}.md; Phase 1 source/test commits and phase review receipt/status. Read the existing editor/roles-panel/Describe flows before editing, including family-removal references.

## Constraints
Only Phase 2. Optional roles.builder.pick {mode, design?, reservePercent?}. Three user labels: First available, Random per task, Jev task fit. Optional usage check: absent reserve disables, enabled starts at 0, configured percentage bounded 0..100. Optional preference family with None, explicitly for NEW frontend visual/design direction. No general UI/frontend bias. Existing model profiles/roles/efforts preserved; unrelated editor operations must not erase policy. Prevent saving new policy into a stale installed resolver before writing anything. Preserve builder policy when a whole-document Describe proposal omits it for unrelated changes, both preview and accept. Treat policy design as family reference in removal/rename checks. Generated guide explains one pick per meaningful task and sticky family; absent policy keeps legacy guide bytes. No new API routes or scheduling state. Do not edit build SKILLs yet; no real config, provider calls, reviews, pushes, PRs, merges or subagents. New tests allowed; existing-test changes separate test-only commit, assertion preservation documented, frozen review.test.mjs untouched. User comments/docs deliberate, no process narration.

## Validation
Run new focused settings/Describe/policy/guide tests plus existing relevant roles-panel/roles-ui/describe tests, discovery/guard/readme checks for changes. Record exact commands/results. Validate stale-reader refusal before-write, omission round trip, role+flavor preservation, all modes and disabled preferences. Do not run full suite on laptop. git diff --check.

## Stop condition
Phase 2 committed and clean with build log/handoff updated; new tests green. Report files, counts, commits, exact UI entry path and QA seeding needs. Stop before Phase 3 and all reviews. Orchestrator performs browser QA and independent verification.
