## SCOPE VERDICT

right-sized — the native probe made the exact edit and passed token postflight. Reusing the existing runner is the smallest sound route. The remaining proof is one edit through the installed `ask-model --build`. [Probe result](builds/neon-builder/probe/native-session-edit.result.json#L5) · [Acceptance bar](builds/neon-builder/plan.md#L17)

## ADVISORY

- **Fork only on explicit `--build`.** Reuse the watcher, runner and build-aware answer parser. Preserve the canonical Git-top check before invoking `agy`, even for `--version`. The current CLI checks path canonicality, while the retiring helper verifies that Git names that exact directory. Keep the read-only wall and refusal tests intact. [CLI check](tools/ask-model.mjs#L1797) · [Git-top check](tools/agy-builder-source.mjs#L77) · [Shared lifecycle](tools/ask-model.mjs#L1974)
- **Require a private per-call log.** Its retention can be temporary. Postflight needs a readable log because it can reveal plaintext-token fallback even when the token file is absent afterward. Run token preflight before the version probe and postflight after every attempted build, including failures. Today postflight runs only when `wall` is set. [Token checks](tools/ask-model.mjs#L913) · [Postflight dispatch](tools/ask-model.mjs#L1983)
- **Remember cancellation independently of the child’s exit code.** The shared runner forwards signals but forgets that it received one. Test a child that edits, catches `SIGTERM` and exits zero. Require nonzero CLI status, no completion claim, and an instruction to inspect the worktree before retrying. Put “never push, open a PR, or merge” in the builder prompt. These are instructions under native permissions. Keep `served.verified:false` on success. [Signal handling](tools/ask-model.mjs#L1369) · [Model reporting](tools/ask-model.mjs#L1655)
- **Retire the helpers across installation and update detection.** Archive them with their isolation tests. Replace public helper mocks with a fake `agy` behind the installed CLI. Check that reinstall works without either helper and that stale `ask-model` still triggers the reminder. Give existing-test edits their own independently checked commit. [Installer](tools/ask-model.mjs#L2035) · [Update detection](bin/acs#L391) · [Update test](tests/acs-update.mjs#L87)
- **Fix both benchmark assumptions.** The adapter requires `published` and a changed-file list, then independently writes `published:true`. Use native completion in both places. Defer the benchmark run and scheduler. Enable Neon after the public proof, and give Mythos the actual diff. [Adapter validation](builds/neon-builder/benchmark-adapter/run.mjs#L654) · [Result writer](builds/neon-builder/benchmark-adapter/run.mjs#L793)

## QUESTIONS

No real questions — the scope is determined.
