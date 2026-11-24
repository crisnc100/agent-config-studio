# Advisory: task-scoped builder selection

## THE ASK

Cris wants actual configurable first-slot, random-per-big-task and Jev task-fit selection, optional usage eligibility and new-visual-design preference, and preserved model strengths/weaknesses. The orchestrator holds context. Pick once for a meaningful task and keep that family through steps/fixes; a replacement gets a short handoff. He does not want a scheduler or unnecessary complexity. Personal pool is Sol/Opus/Neon, with Opus preferred only for new visual direction when configured.

## WHAT WE KNOW

Opus mapped the code read-only; explorer-report.md has file:line evidence. resolveRole currently returns first unpaused member; Jev and rotation are not wired. Roles settings have strict schema, stale installed-resolver checks and Describe file replacement. The installed resolver copies lib/roles.js. Existing cached usage is usage-snapshot.json. Both build skill variants need an explicit task-level picker call and Neon dispatch. Preserve legacy --role output and flavor data.

## CURRENT DIRECTION

Review plan.md. One PR, three phases: an explicit picker plus optional builder-only policy; settings/Describe/guide integration; build consumers/docs. Keep the picker pure for default/random and read only cached usage. Jev is a bounded CLI subprocess only in task-fit mode. One choice recorded in existing plan/handoff; no new state database. Existing configs stay ordered; enable Cris’s random policy only after compatible merged installation.

I reject three explorer suggestions that conflict with the brief or doctrine: do not silently reinclude all quota-excluded members; do not treat any other account’s headroom as proof the actual CLI account is available; do not change automatic quality escalation into ask-first. I favor an explicit Frame design flag over an extra classifier. Ordered is the Jev failure fallback. Usage reserve should be configurable with default0/exhaustion-only, not an unexplained fixed10-percent cutoff.

## DECISIONS IN PLAY

1. Smallest complete schema and CLI shape, including role.json/Describe/stale-reader compatibility, without changing deterministic --role.
2. Safe cache/account/scoped-window interpretation and minimum useful usage settings; answer lookup questions from code rather than guessing or handing them to Cris.
3. Bounded Jev process and guards integration; whether logic belongs in roles.js or a small separately installed helper, and how to keep profile/choice data from becoming commands.
4. Task-choice contract and both harness skill consumers, preserving existing effort, quality escalation and review ownership. One PR vs a strictly justified sequence.

## READ FIRST

Read builds/builder-selection/{context.md,plan.md,explorer-report.md}; then the cited role/schema/CLI/UI/Describe/usage/skill source files. Check cache and account details in lib/usage/{seats,claude,codex}.js, models.js vendor/subscription mapping, and current role save/install protection. Read ~/.codex/skills/effective-agent-skills/SKILL.md for the planned SKILL changes. No edits, no full tests, no provider refresh or model calls. Be concrete about acceptance gaps; cut overbuilding.
