You are the writer role for one PR context pass.

Objective: align docs and deliberate comments with the fixed builder-selection feature. No product code changes.
Read first: builds/builder-selection/context-brief.json, current README.md and docs/neon-builder.md, then each source behavior before claiming it. The brief is checked and describes the mechanism; verify it yourself. Changed source paths:
bin/model-id.mjs
lib/describe.js
lib/models-panel.js
lib/roles-panel.js
lib/roles.js
public/app.js
public/styles.css

Constraints: follow the writer rules below word for word. No GUI, computer use, visible apps or terminals (Cris is in an interview), no other model/agent/provider calls, no tests/instruction/generated-block/build-evidence edits, no global files, push, PR or merge. Only the task worktree. Keep original review records and scores untouched. Existing manual KNOWN-LIMITS lint failure is out of scope.

Validation: the parent runs node ~/.agent-config-studio/review-gate/context-pass.mjs --check-commit HEAD --brief builds/builder-selection/context-brief.json. You have file tools only; leave edits uncommitted, and parent commits them as Context pass: explain builder selection.

Stop: write builds/builder-selection/docs-table.json in the required rows/files/docs/claims/at shape, covering every changed source file (a justified none row when no doc is needed). Every claim has a real repo file:line. Report proposed changes to untouchable instruction files; do not apply them. Then stop and report changed paths/proposals concisely.

Writer rules:
- **Deliberate comments.** Every comment tells the next reader something the code can't: why, a constraint, a trade-off, a trap. Otherwise delete it, including slop left by earlier agents. No narration, section banners, name-restating doc comments or process notes ("fixed", "now", "per review"). Keep license headers and ticketed TODOs.
- **Directive and executable comments are never touched:** `@ts-…`, `//go:build`, `# type: ignore`, lint directives, docstrings that tests read, Rust doc tests, Go `// Output:` examples.
- **Never edit a line that holds code,** even to change a comment at its end. Never add or remove a block-comment delimiter (`/*`, `*/`): edit the text inside a block comment, and report a whole block that should go.
- **Every doc claim is true of the code.** Confirm each one by reading the code, and record it with its `file:line` in the docs table. A claim you cannot confirm is not written. Check each point of the brief's `mechanism` against the code before using it.
- **The right place, not the main file.** A project's root CLAUDE.md or AGENTS.md stays short: only what every agent needs in every session there. Anything else goes, in this order: into a sub-folder CLAUDE.md or AGENTS.md next to the code it is about; or into a fuller doc (`docs/<topic>.md`) with a one-line pointer from the root file ("read docs/x.md before touching y"); or nowhere, when the code already says it. Instruction files are untouchable for the writer, so propose each such change in the report, naming its target file and level (root, sub-folder, or pointer plus doc). The docs you write follow the same rule: one home per fact, linked rather than repeated.
- **Docs describe the result, not the journey.**
- **Cut as well as add:** stale, wrong or duplicated text goes.
