# PR 1 Soft slate theme: log

- Dark `:root` tokens set to the Soft slate block in tokens.md, value for value. `--radius`, `--mono` and `--sans` are not in Soft slate and stay as they were. The `*-ink` tokens already equal `var(--colour)` in dark, as Soft slate specifies.
- `body` `-webkit-font-smoothing` is `auto`.
- The light theme is untouched. styles.css has no prefers-color-scheme block and no literal colours outside the two token blocks, so nothing else needed changing.
- The `--muted` comment "5:1 on the darkest panel" stays true (5.15 on `--panel-3`).
- No test pins the old dark hex values, so there is no test commit.
- `--border-soft` equals `--panel-3` (#343940) in Soft slate, so a soft border on a panel-3 surface is invisible. Kept as specified; flagged for the orchestrator.
