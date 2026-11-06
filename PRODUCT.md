# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Two audiences, served equally (confirmed by the maintainer, 2026-11-05):
- **Daily operator**: a developer running several AI coding agents (Claude Code, Codex, Grok) every day, who changes model roles, toggles pack settings and edits instruction files often, and needs to see at a glance what each workflow will do.
- **Newcomer**: someone who just ran `npx agent-config-studio`, has at least one CLI installed, and needs to move through each area without feeling overwhelmed.

## Product Purpose
A local web app for reading, editing and versioning the config of the AI coding CLIs on one machine in one place: instructions (`CLAUDE.md`, `AGENTS.md`), skills, MCP servers, hooks, settings, model roles, skill packs, and subscription headroom. Success: a user can go through each area, understand what it controls and what a workflow will do, and change it with confidence.

## Positioning
One place that sees all three agent CLIs' config together, keeps its own git history of every change, and installs configurable skill packs (review gate, PR descriptions and others) as marked blocks that never replace the user's own files.

## Operating Context
- Runs on the user's machine at `127.0.0.1` (default port 8787); rejects non-localhost hosts. Never reads credentials itself.
- Used alongside terminal agent sessions: the user checks or changes config, then goes back to the agents.
- Core jobs (all confirmed): see how a workflow runs (which agent and model does each step of /code-review, /build, /pr and others); change models and roles; turn pack settings on and off; edit instruction files, skills, MCP and hooks, with history.

## Capabilities and Constraints
- No npm dependencies; plain HTML/CSS/JS in `public/`, served by `server.js`. macOS first; Linux best-effort.
- Model roles (advisor, builder, investigator, judge, reviewer, security) are defined in the studio and written into each agent's instruction file as a generated block.
- Packs install parts (skills, instructions, hooks) with backups; instruction parts are marked blocks removed whole when turned off.
- Shipped content contains no personal names or paths.
- Workflow diagrams: the maintainer wants clear examples of what each skill or pack does and who does each step; whether they read live settings was left to the builder.

## Brand Commitments
- Name: Agent Config Studio (ACS). MIT licensed.
- Voice: plain, short, no jargon; explain any code term. The maintainer: the UI "is super important"; today it has "a lot of extra words or extra things", some "hard to see", some "just jargon" that confuses people.

## Evidence on Hand
README.md, RUNBOOK.md, the packs in `packs/` (review-gate, pr and others), and the live UI in `public/`. No testimonials, user counts or benchmarks exist; do not invent any.

## Product Principles
1. Every area is understandable on its own, without the others.
2. Fewer words: say what a thing does in plain language, or show it.
3. Show the workflow: who does each step should be visible, not buried in text.
4. The user's own files are theirs: the studio manages marked blocks, never replaces their content.
5. Local and safe: nothing leaves the machine, credentials are never read.
