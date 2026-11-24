# Builder selection per task

## Outcome

Cris can choose ordered first-available selection, uniform random selection per big task, or Jev task-fit selection from the configured builder role. A task records one family and keeps it through its phases and fixes. Usage availability and a preference for genuinely new visual design decisions are configurable. Existing strengths, weaknesses, effort overrides and other roles are preserved.

One PR in three implementation phases. The role schema, installed CLI, settings UI, generated guide and build consumers must agree about the same policy. Ship one complete optional feature with legacy defaults intact, without an intermediate unsupported configuration.

## Out of scope

No central session scheduler, global rotation cursor or workflow database. No provider quota refresh or new live provider calls while choosing. No hardcoded builder pool or model IDs. No change to other judgment roles, default read-only Neon containment or model-proof semantics. No builder benchmark. No unrelated Cursor-seat work. No agent merge.

## Decisions

- “Random per task” means equal chance among eligible configured members on the first pick of a meaningful task. The orchestrator records the choice in the existing plan/handoff and reuses it; a fresh phase worker can use the same family.
- The default remains ordered selection for existing configurations. Cris’s desired random policy, with an optional configured Opus design preference, is activated only after compatible merged resolver/build instructions are installed.
- New visual design is an explicit Frame decision recorded by the orchestrator and passed to the picker. Frontend logic, implementation of a settled design, backend and database work use the normal strategy. The preference can be disabled or point to an eligible configured family.
- Usage reads only the existing snapshot. Missing, stale, reset, invalid or ambiguous data remains unknown, with a reason; it must not falsely exclude a builder. Fresh authoritative limits can exclude a candidate. One optional reserve percentage controls cached usage filtering: omitted means disabled, 0 skips exhaustion, and a positive value protects that much remaining headroom. The settings UI can enable the check at 0. There is no hidden weighting.
- Never silently ignore usage policy when all candidates are excluded. Return no eligible candidate with reasons. Manual pauses remain honored. Scoped windows and account mappings must be established from code; do not guess matching model/account names.
- Jev mode receives bounded task text plus saved likes/quirks/avoid. Validate its typed choice and confidence>=0.7 against the eligible set. Missing CLI, malformed/ineligible response, timeout, low confidence or escape choice falls back to first eligible with an explanation. Other selection modes do not invoke Jev for family selection. Existing separate effort/shadow calls remain outside this feature.
- Keep model-id --role builder deterministic and byte-compatible. Add one explicit picker entry point and reuse its single returned family/id/effort packet. Do not choose separately for IDs and effort.
- An operator-named builder wins. Replacement after quota/startup failure is logged with an exclusion and a handoff. Preserve the standing quality-escalation rule; do not add a new ask-first gate or silently switch every phase.

## Phase1: chooser and compatibility

Add optional roles.builder.pick with mode, an optional design family, and optional reserve percentage; expose model-id --pick builder --json. Keep pure selection in lib/roles.js and the bounded Jev subprocess in bin/model-id.mjs. Keep legacy role resolution unchanged. Implement uniform selection, conservative cached usage eligibility, explicit design preference, exclusions, and bounded safe Jev integration. Reject unknown policy fields and invalid values. Preserve role membership, per-member efforts and flavor data. Register meaningful new tests; changes to existing tests/guards/registry go in a separate test-only commit, checked independently. For Codex, match the effective home and credential stat; use per-reading freshness, ignore Claude model-scoped windows without structured identity, and use Gemini windows without Argon. Add opposite-headroom/home and fresh-snapshot/stale-reading fixtures. No global runtime configuration changes.

## Phase2: settings and guide

Add controls to the existing builder editor for strategy, usage/reserve and design preference/none. Save and reload the same policy through the existing role API with resolver-version compatibility checks. Preserve policy during Describe proposals, unrelated edits, backups and generated guide flows. Preserve policy before Describe preview and acceptance when unrelated proposals omit it. Old/default configurations keep prior behavior and output.

## Phase3: consumers and documentation

Both build skill variants call the picker once per task, record and reuse the family, retain fresh-worker phase handoffs and existing escalation/effort rules, and dispatch supported families through their proper harness routes (including native agy). Update usage docs, guide text and focused consumer tests. Read effective-agent-skills before modifying any SKILL.md. An upgraded skill with an old CLI reports acs install-model-id instead of guessing. Consumer tests force a non-first family and prove one pick, resumed/fix dispatch identity and effort, review author, cumulative exclusions and partial-edit handoff. No writer edits executable instruction files in the context pass.

## Acceptance criteria

- B1: Existing role defaults and every legacy --role output remain compatible; other roles/flavors/efforts survive save, Describe and policy changes.
- B2: The three modes persist and affect the actual installed pick command; only builder accepts this policy. Stale installed readers cannot be broken by saving new fields.
- B3: Random selects each eligible index equally using unbiased randomness; role order or flavor text adds no weight. Paused and explicitly excluded members cannot be selected.
- B4: Usage eligibility is cached-only, configurable and conservative for stale/missing/scoped/ambiguous/reset data. Known exhausted members are excluded; all-excluded returns unavailable without bypassing policy.
- B5: New-visual-design preference applies only when explicitly flagged, configured and eligible. No preference uses the selected strategy. Frontend logic/backend/database fixtures follow ordinary selection.
- B6: Jev uses preserved profile strengths/cautions and bounded task text, accepts only an eligible high-confidence choice, and has deterministic safe fallbacks for every error class. No family selection service call in ordered/random modes.
- B7: Updated Claude/Codex build consumers record one family for the task, reuse it across phases/fixes/resumes, handle explicit operator choice and bounded replacements with context, and include the proper Neon route. No new scheduler or shared cursor.
- B8: Browser QA verifies mode and option changes, save/reload, unrelated profile preservation, compatibility messaging and generated-guide update state in an isolated test home.
- B9: Focused checks plus the complete registered suite, independent review/Mythos/context/one fix check/close, PR and green CI. Label needs-human; never merge.

## Verification

Use pure policy tests with fixed random inputs, fake cache clocks/windows and stub Jev, installed CLI tests, schema/Describe/guide round-trips and shell-consumer contract tests. Browser QA uses the repo’s isolated-home QA server pattern. No real builders need to run to validate selection. Use the Mini for the portable full-suite work as previously selected, with the already established small laptop-only checks for developer data/new Git; preserve exact-source per-file coverage and home guards. Determine the new registered count after tests are added. Do not repeat the prior host-prerequisite failures.
