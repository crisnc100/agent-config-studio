Trust fixtures use strings extracted from installed CLI bundles: Codex 0.160.0
(`Trust this folder?`, `Trust and continue`), Claude Code 2.1.325
(`Accessing workspace:`, `Quick safety check:`, both choice labels), and Grok
1.0.77 (`Do you trust the contents of this directory?`, both choices and footer).
Paths are synthetic except the supplied narrow Grok fixture. ANSI decoration is supplied by the test.

Running fixtures combine the harness status labels with elapsed-time examples.
Codex's `Working (` was observed by the orchestrator. Claude's bundle supplies
`Churning` and `esc to interrupt`; Grok's supplies `Thinking…`. These are parser
fixtures, not captured screenshots. Frozen and advancing readings share the
same labels so animation alone cannot prove activity.

The narrow Grok trust fixture preserves the exact screen supplied in brief 5,
including its displayed path, to cover clipped and wrapped header text.
Claude approval regressions use its 2.1.325 bundle's shared question template
(`Do you want to ` + verb phrase + filename + `?`): edit uses
`make this edit to`; file writes use `create`, `write to` or `overwrite`.
The fetch question is `Do you want to allow Claude to fetch this content?`.
The bundle supplies `Yes` and `No` choices; test numbering and filenames are
synthetic.
