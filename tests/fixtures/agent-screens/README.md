Trust fixtures use strings extracted from installed CLI bundles: Codex 0.160.0
(`Trust this folder?`, `Trust and continue`), Claude Code 2.1.325
(`Accessing workspace:`, `Quick safety check:`, both choice labels), and Grok
1.0.77 (`Do you trust the contents of this directory?`, both choices and footer).
Paths are synthetic. ANSI decoration is supplied by the test.

Running fixtures combine the harness status labels with elapsed-time examples.
Codex's `Working (` was observed by the orchestrator. Claude's bundle supplies
`Churning` and `esc to interrupt`; Grok's supplies `Thinking…`. These are parser
fixtures, not captured screenshots. Frozen and advancing readings share the
same labels so animation alone cannot prove activity.
