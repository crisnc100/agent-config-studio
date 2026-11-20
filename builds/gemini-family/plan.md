# Gemini 4 Neon + Antigravity — plan

Goal: Gemini 4 Neon usable as a model family everywhere ACS uses one (model-id, ask-model, roles, review-gate reviewers, --eval); Antigravity (`agy`) supported as a harness; Neon benchmarked against Opus 5.5, Sol 6.2, Sol 6.1 and Grok 4.7 on the 30 fable-trial cases.

Split: 4 PRs + a benchmark run. A0 and A are separate (A0 changes no reachable behaviour and turns anything A misses into a loud failure); B1/B2 come after the benchmark.

Decisions (Cris, 2026-11-20): family `neon` (Gemini is the vendor/brand); agy runs only gemini- ids for now; web search in Neon read-only calls is allowed and noted; billing is subscription quota.
Advisor (Fable, builds/gemini-family/advisor.out): no vendor/harness split now — `agy` is the fourth value of the existing vendor token; when a harness first serves another maker's model (agy's GPT-OSS, opencode), add `makerOf(id)` at the cross-vendor comparisons only.

## PR A0 — unknown vendors fail loudly
Outcome: every place that maps a vendor to a CLI, argv, auth or label refuses an unknown vendor with a named error instead of falling through to codex or grok: review.mjs runModel (:2478-2482), ask-model argvFor (~482-511) and sandboxProblem (:464), lib/setup-clis.js:75-77, lib/agent.js openWorker (:488-519) and its else-grok ternaries, LABEL lookups in lib/models-panel.js:20 and lib/models-catalog.js:21, public/app.js vendorDot (:4709).
Acceptance: a stub family with an unknown id prefix gets a non-zero exit and a named error from the review gate and ask-model; loadPool lists it unusable; acs-agent refuses it; the full local suite (all 141 files) and the review-gate pack tests pass.
Out of scope: adding agy.

## PR A — the neon family on agy
Outcome: `model-id neon` → gemini-4-neon (effort via --effort); `sol-prev` → gpt-6.1-sol (track:false) and the shipped `sol` default bumped so prev < current; one identical prefix literal {'claude-':'claude','gpt-':'codex','grok-':'grok','gemini-':'agy'} in each runtime copy plus a parity test; ask-model and review.mjs run agy read-only (deny list, --disable-slash-commands, stream-json, </dev/null, cmux hooks disabled, refuse non-empty MCP config or foreign hooks, refuse --investigate/--no-tools/--x-search); fail on status≠SUCCESS, empty response, or denied_actions ending the turn; served model recorded as unverified (never fabricated from the echo), per-call --log-file kept; `agy` not accepted as a REVIEW_AUTHOR alias; neon flavor in roles.default.json, not in shipped default roles; toolNotes + KNOWN-LIMITS note that agy is the only reviewer with web access.
Before it reviews anything: a containment probe in a throwaway repo proving workspace settings, hooks and plugins can't undo the deny list.
Out of scope: agy-served claude-/GPT-OSS ids, usage seats, acs-agent sessions on agy, hooks/guard.

## Benchmark (no PR, after A is merged and installed)
--eval --family neon,opus,sol,sol-prev,grok on fable-trial/cases, current review.mjs; repeats per Cris.

## PR B1 — Antigravity instructions + model guide; PR B2 — packs install skills into ~/.gemini/config/skills (codex twin)
As in the scoping report; later PR B3 ports the review-gate guard to agy hooks.
