# Advisory brief: usage-aware routing ("usage profiles") in Agent Config Studio

## THE ASK
Cris (sole dev of ACS, a local web app + CLI for configuring Claude Code / Codex / Grok setups) hits usage limits on one subscription (e.g. Claude) and wants an easy way to move work (orchestrator, builders, reviewers, security, advisor) onto another account (e.g. Codex: Sol/Astra) WITHOUT editing his default roles, then switch back. He wants it flexible ("whatever I want it to be"). He believes this is a common problem for other users with other account mixes (one Claude plan only; Claude + Codex; several Claude/Codex seats; API keys), and wants the product shape right for them, not just for him.

## WHAT WE KNOW
- Roles live in ~/.agent-config-studio/roles.json (keys: version, flavor, roles{builder, reviewer, investigator, advisor, judge, security, writer, researcher}); each role = ordered families (first is the answer, rest fallbacks), effort, optional second opinion. Code: /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/lib/roles.js, defaults /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/lib/roles.default.json, UI /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/lib/roles-panel.js. Every skill resolves models through the model-id CLI (installed shim -> ACS code), so a change to how roles resolve reaches every skill at once.
- No orchestrator role exists: the harness the user opens IS the orchestrator. A Claude Code session's main loop can only run Claude models (--model switches among Claude models; a gateway via ANTHROPIC_BASE_URL needs a paid OpenAI API key, not the ChatGPT/Codex plan). So "Sol orchestrates" realistically means opening the Codex CLI; Cris prefers the Claude Code UI.
- ACS already has a Usage page reading per-account limits: /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/lib/usage/ (claude.js, codex.js, codex-limits.js, grok.js, seats.js, accounts.js, percent.js); seats in ~/.agent-config-studio/seats.json and ~/.codex-seats/*. So remaining room per account is known.
- Measured this session (Claude side only): builders 0.74M output tokens, orchestrator 0.31M output but ~182M input+cache (long conversation), docs writers small; reviews mostly ran on Codex (Sol) or separate headless Fable calls not counted.
- Product direction (decided 2026-11-12): ACS = Cris's tool + portfolio + product; "if it confuses a new user it doesn't ship"; success = context, routing, checks, guardrails; routing is the differentiator; zero-config, every setting in a file the user owns; Cris's opinionated workflow is an optional pack, never a default. Build order approved: PR1 simplify (merged #88) -> Cris uses it a day -> PR2 report card (read-only mirror of the setup on those four parts, sketch first) -> PR3 Guardrails read-only -> PR4 writes.
- Only real user today is Cris (69 npm downloads/month).

## CURRENT DIRECTION (attack this)
Add "profiles" to roles.json: Default = current roles untouched; named profiles (e.g. "Low Claude", "Low Codex") hold only overrides per role; one active profile; switch via a toggle on the Models page or "acs profile use <name>"; model-id resolves active profile over defaults so every skill follows. Add an advisory "orchestrator" role telling which harness to open. Later: Usage page suggests (never auto-switches) a profile when an account is near its limit. Ship it next, before the report card, as a small precise-lane PR (roles drive every review gate).

## DECISIONS IN PLAY
1. Shape for other users: hand-made named profiles, vs. a simpler "an account is low -> skip its families" rule (automatic fallback down each role's existing family list using known usage), vs. both. Which survives the confuse-a-new-user rule and works for single-plan users?
2. Manual switch vs. suggested vs. automatic (usage-driven) switching, and where it shows (Models, Usage, report card).
3. Orchestrator: is an "orchestrator role" meaningful when the harness decides, or just guidance text?
4. Sequencing: before the report card, or as part of its Routing part.

## READ FIRST
- /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/lib/roles.js
- /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/lib/roles.default.json
- /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/lib/roles-panel.js
- /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/lib/usage/accounts.js and /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/lib/usage/percent.js
- /Users/cortega/.claude/projects/-Users-cortega/memory/project-acs-product-direction.md
- /Users/cortega/Documents/Projects/personal/skills-work/builds/acs-reshape/decisions.md
