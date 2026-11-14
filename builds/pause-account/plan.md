# Pause an account — plan

Decided with Cris 2026-11-13 after /advisor (Fable): build "pause", not named profiles. Answers: pause instead of profiles; a role left empty refuses; a pause ends at the account's reset by default ("until I resume" optional); ships before the report card. Advisor brief and answer: this folder.

## Problem
When one subscription runs low (e.g. Claude), every role that starts with that vendor's models keeps spending it. Changing roles to work around it means editing defaults and remembering to change them back. Other users have the same problem with other mixes of plans.

## Outcome (one PR: the resolver change and its switch only work together)
- R1 **Pause file.** `~/.agent-config-studio/paused.json` (user-owned, separate from roles.json): a list of paused vendors (claude, codex, grok) and/or families, each with an optional `until` time. Missing file = nothing paused. roles.json is never written by this feature.
- R2 **Resolution.** `resolveRole` skips paused families (and families of a paused vendor) in a role's ordered `use` list and answers with the next one; the second opinion (`alt`) is skipped the same way, becoming empty. Expired entries are ignored. Every path that already uses resolveRole follows: model-id, ask-model, the review pool, /build, /advisor.
- R3 **Loud.** When something is skipped, model-id prints one stderr line ("claude paused: reviewer → sol (skipped fable)"), and its JSON carries `paused` and `skipped` fields. No silent fallback.
- R4 **Refuse when empty.** A role whose every family is paused exits 2 with a plain fix ("every model for advisor is paused; resume claude or add a fallback in ACS → Models → Roles"). The writer role is not exempt: it refuses the same way.
- R5 **Names still work.** A family named directly (`model-id opus`, `/build opus`, `REVIEW_REVIEWER=fable`, `ask-model --family`) is not affected by a pause.
- R6 **Stale resolver guard.** Pausing from ACS is refused while the installed model-id is older than the one that reads paused.json (existing `resolverStale`), with the existing "re-run acs install-model-id" fix; an old resolver must never silently ignore a pause.
- R7 **The switch, on Usage.** Each account row gets Pause / Resume. Pausing offers "until <reset time>" (pre-filled from the reading, when known) or "until I resume". A paused account shows "Paused until …".
- R8 **Effect, on Models → Roles.** While anything is paused, a notice lists each role's current answer and marks roles that would refuse, and a same-vendor note when builder and reviewer now come from one vendor.
- R9 **CLI.** `acs pause <vendor|family> [--until <time>|--until-resume]`, `acs resume <vendor|family>`, `acs pause` (lists).
- R10 **Model guide.** One sentence in the generated guide block: roles skip paused accounts; `model-id --role <r>` gives the current answer. No per-switch rewrite of instruction files.
- R11 **UI rules.** Styled buttons, no folds, ≥12px, plain words, light and dark; README documents pause.

## Out of scope
Named profiles; an orchestrator role; automatic switching or usage-driven suggestions (report card later); multi-seat logic; changing anyone's roles; the review gate itself beyond reading resolveRole.

## Acceptance
- Unit tests: skip by vendor and by family; alt skipped; expired pause ignored; empty role refuses with exit 2 and the fix; named family unaffected; missing/invalid paused.json = nothing paused (invalid reported, never crashes).
- model-id stderr line and JSON fields; ask-model and review pool pick the next family under pause (test with a temp HOME).
- Route + UI tests for Pause/Resume on Usage, notice on Roles, CLI commands; resolverStale refusal.
- Existing suites pass; changed assertions only in test-only commits.
- One browser QA at the end on a sandbox studio.

Lane: precise (roles drive every review gate). One PR. Builder: Opus (xhigh; resolver logic).
After merge: Cris adds one fallback each to advisor, judge and investigator in ACS (his setting), so a Claude pause doesn't empty them.
