# Live checks (orchestrator, cmux, 2026-11-16)
- Real review (Sol code + Fable security, watch=pane): two live sidebar lines with each reviewer's real step; pane opened; log tagged per reviewer. Found: code reviewer labelled security (prompt text matched), intent used as label — fixed in 6ca4f12.
- Gate died mid-run (Sol at capacity): watcher exited by itself, lines cleared, pane closed, runs/ empty.
- Fix check with watch=sidebar: line `fix-check · fable · <1m · read tests/agent-watch.mjs`, no pane, cleared at the end.
- ask-model --family fable: line `ask · fable` within 2s.
- kill -9 of ask-model and its watcher: stale line left; the next ask-model run's watcher swept it; runs/ empty.
