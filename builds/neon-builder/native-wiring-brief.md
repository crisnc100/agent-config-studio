# Native public CLI wiring

## Objective
Replace the unshipped custom Neon builder path with the already-proven normal native Antigravity session. Reuse the existing ask-model runner, argv and parser; no new launch subsystem. The operator explicitly approved normal file/network permissions. Actual local native high-effort edit proof passed (read/write/read, exact SHA256, postflight), served model unverified.

## Read first
plan.md and native-advisor-result.md in this folder; tools/ask-model.mjs, tools/agy-builder.mjs, tools/agy-builder-source.mjs; tests/ask-model-build.mjs, tests/acs-update.mjs, tests/agy-builder*.mjs; bin/acs and tests/SUITE. Global AGENTS applies. No need to read old diagnostic wrappers or review records.

## Constraints and ownership
Own ONLY tools/ask-model.mjs, bin/acs, moving tools/agy-builder{,-source}.mjs to builds/neon-builder/probe/isolated-runtime/, tests/ask-model-build.mjs, tests/acs-update.mjs, tests/agy-builder{,-source,-wall}.mjs import-path changes, and tests/SUITE if needed. Keep isolation tests active against archived helpers; preserve their assertions. Do not skip/delete checks. Frozen review.test.mjs untouched. No README/docs/context edits; writer handles them later. Benchmark is another owner's files. No actual provider/metadata/model call, install to real HOME, roles/API, remote, push/merge/PR/review/other agents or heavy suite.

Build remains opt-in --build, agy-only, explicit canonical Git TOP (not just realpath). Validate it before --version too. Preserve HOME/root refusal. Keep existing conflicts. Native argv uses --mode accept-edits, resolvedmodel/effort, stream-json and finite printtimeout, normal HOME and AGY_ENV. Do not inject AGY_SETTINGS, broker, private source/HOME, OS sandbox or custom permission rules into native builds. Keep default-readonly AGY_WALL/AGY_SETTINGS and full review runtime byte-identical. Preserve all readonly refusal behavior and other vendors.

Private per-call readable regular owned log is mandatory for native token pre/post checks. Preflight before version; postflight on success/failure/cancellation. Remove private temp log afterward. Refuse missing/unreadable log and plaintext-file/fallback evidence; never expose raw provider logs. Keep tested CLI version. Prefix the builder prompt with implementer/no other models/reviews/no push/no PR/no merge instructions. These are task instructions under native permissions, not an enforced security boundary.

Reuse existing runner with a native-only cancellation option if needed. Remember cancellation independently of exit code: fake child can edit, catch SIGTERM and exit0; CLI must still fail, omit completion and say inspect worktree before retrying. Do not change default readonly cancellation semantics. Native edits may remain after failure; no rollback/publication guarantee. Consider native-only process group cleanup without claiming complete containment.

Successful native envelope: mode:build, build:{execution:native,completed:true}, served.verified:false. No build.published or enforced-worktree/Google-only claim. The existing changed:null can remain informational; no snapshot or new change-audit subsystem. On failed/cancelled calls never claim completed. Preserve safe parsed action fields/model-echo mismatch checks as useful, but do not claim they prove isolation.

Retire both helpers from installedfiles and update detection. Archive them, not discard their evidence; keep their old tests running via import-only path adjustments. Public build integration tests should exercise fake agy behind the installed CLI rather than mocking a private helper. Verify no-helper reinstall and stale ask-model update reminders. Assertions for the old unpublished isolation behavior change ONLY because the operator explicitly replaced that requirement; name each behavior change in the test-only commit. Keep existing readonly assertions unchanged.

## Validation
Sequential taskpolicy-b focused checks with ACS_LIVE_CHECKS=0: source/lifecycle/wall prototype tests after import relocation, installed build CLI tests, readonly agy CLI tests, acs-update targeted test as practical. Meaningful native regressions: native argv/HOME/cwd, explicit top/invalid roots before provider invocation, real installed fakeCLI file edit, no helper dependency, version, pre/post/failure log token refusals, unverified model and mismatched echo, cancellation even zero-exit, no false completed/published flags. Fake only. Do not run a full suite or livechecks.

## Commit and stop
You exclusively own staging/index during this phase; root and benchmark agent will leave all edits unstaged. Commit ONLY your owned code/archive files and a short native-wiring-log.md first; changed existing tests go in a second TEST-ONLY commit whose body names each assertion/behavior change and preserved guards. Tests may be adapted before commits but stage code/tests separately. Never stage another owner's files. Stop after focused checks pass and both commits, with exact test counts, commit IDs and any unresolved issue. Do not invoke reviews. If the sandbox refuses Git metadata, leave changes and report; no bypass.
