# Current facts

- Worktree created by `wnew neon-builder`: branch neon-builder from main f47b36f, `/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder`. wnew printed no local URL/port.
- `gh pr list --state open --json number,author,title,files` returned [] before planning. Cursor-seat has unpushed work and is paused by user instruction.
- tools/ask-model.mjs has AGY_SETTINGS denying command, write_file, MCP and URL tools; argvFor and main explicitly reject all agy modes but read-only.
- AGY_WALL is allow-default with read-data denials under user/temp roots, narrow read-back exceptions, and summary-write denials. It is intentionally not a writable builder boundary. packs/review-gate/runtime/review.mjs has an identical wall, checked by tests/agy-wall.mjs.
- Existing keychain allowances are required for token refresh; failure can produce a plaintext token. agyTokenLeft refuses a preexisting token and agyAfterCall refuses missing logs, fallback log text and a newly present token. AGY_VERSION is 1.5.14; AGY_CLI_DISABLE_AUTO_UPDATE must be literal true.
- Current roles resolved in this session: advisor Astra high, builder Sol medium, security Mythos high. Advisor has no second opinion configured. Use the requested advisor-role occupant rather than silently switching.
- The compute-pool surface was read only. Its visible old report says Neon review quota exhausted until Nov 28 and a prior Grok message is pending in the input; user says Neon has since reset. Current quota needs checking with the runner; do not assume either old screen or reset report proves available capacity.

Read-first files: tools/ask-model.mjs (AGY constants, argvFor, parse, main); tests/agy-wall.mjs; tests/ask-model-agy.mjs; packs/review-gate/runtime/review.mjs (read-only wall only); lib/roles.js; server.js roles API; /Users/cortega/Documents/Projects/personal/skills-work/builds/benchmark/runner/run.mjs.
