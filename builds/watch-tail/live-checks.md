# Live checks (orchestrator, plain shell with cmux variables unset, 2026-11-17)
- acs-agent tail followed the newest live run (another session advisor call) with tagged live steps.
- ask-model outside cmux: run file without workspace, log with the call steps, tail <id> --once printed them, files removed after.
- Sol test-change check: ask-model-watch PASS; review.watch test 3 FAIL (watch-1 cases dropped for two environments), fixed in 5fe39a6 with a mutation check.
