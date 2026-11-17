# Live checks (orchestrator, Cris cmux, 2026-11-17)
- Builder (real Sol worker): opened as a background tab in the caller pane titled builder · sol · agent-layout; first run made it the selected tab (fixed in 77f65c3); after the fix the main tab stayed selected and focused; worker ran hidden and closed.
- Review with watch=pane: one right pane with tabs review · fable · agent-layout and security · astra · agent-layout; main pane kept focus; sidebar lines carry the branch; pane closed and runs/ empty after.
- Sol test-change check on 59844d2: coverage gaps (workspace/focus per open, Codex vs Grok, branch value outside cmux) added in 6bd23c7 with mutation checks.
