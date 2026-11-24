# Read-only routing exploration

Objective: map the smallest complete implementation for the outcome in context.md. Return conclusions and file:line evidence, no dumps. The user wants a real setting with working selection, not guidance-only text.

Read first: builds/builder-selection/context.md; lib/roles.js; lib/roles-panel.js; bin/model-id.mjs; lib/models.js; lib/model-guide.js; lib/usage/refresh.js; lib/usage/accounts.js; public/usage-view.js; public/app.js; server.js role/usage routes; packs/build/skills/{claude,codex}/build/SKILL.md. Follow only relevant dependencies.

Constraints: read-only, no edits/commits, no other models, no live provider/usage refresh or benchmark/full suite. Preserve legacy model-id --role output; do not assume it may become nondeterministic. Identify how installed resolver files, generated guide and all harness build instructions must consume one selection result. User explicitly permits real Jev selection when that mode is selected; the older shadow-only delegation rule remains for unrelated lanes. Do not invent a new task/session scheduler. Record a single task choice in existing plan/handoff.

Validation: inspect existing code/tests and point at exact route/validation/UI/cache/consumer locations. Answer: (1) where selection happens today and whether Jev is actually wired; (2) role schema/save/UI/installation touchpoints; (3) available cached usage signal schema, account/family mapping, freshness and missing-data behavior, and smallest safe way to use it without network in the chooser; (4) Jev CLI integration seam and fallback; (5) minimal task-choice reuse/handoff contract; (6) focused tests/browser paths; (7) one PR or a justified small sequence. State factual unknowns rather than guessing.

Stop: send one concise report (about1000words maximum) with recommended minimal scope, planned file list and only genuinely undecidable product questions. Do not write source or tests. Return the report in your answer; the orchestrator will save it.
