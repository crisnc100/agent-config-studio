# Plan — review-gate PR C: cleanup + security prompt borrowings

Approved scope: skills-work/builds/review-vs-anthropic/decisions.md (2026-11-05: item 5 and the Cloudflare borrowings).
One PR: three small, independent parts, each small enough to review in one slice, all in one pack. Split them only if the diff goes over about 400 changed lines of logic.

## Parts (in commit order)

1. **Remove the shadow pickers and the Grok shadow** (`packs/review-gate/runtime/review.mjs`)
   - Remove: the `shadow` / `pickShadow` config and `REVIEW_SHADOW` / `REVIEW_PICK_SHADOW`, `--pick-shadow-run`, `--pick-report`, and the shadow-only parts of `appendShadow` and the `--shadow-report` paths. Also remove their mentions in the skills, the instructions, `review-config.example.json`, and any ACS lib/public reference.
   - Keep: the reviewer pool, the `pick` modes, and the Jev picker itself. Only the "what would X have picked" logging goes.
   - Old configs: a home config that still has `shadow` / `pickShadow` must not break. Ignore only those two keys (`grokMcpAllow` stays: real grok reviews and ask-model use it) with one short note on stderr ("ignored: shadow pickers were removed"), never an error.
   - Old records: shadow lines already in logs stay readable; nothing rewrites them.
   - Tests: tests that only cover the removed feature are deleted in their **own test-only commit**. Its message names each removed assertion and says the feature is gone. Tests that mix shadow and kept behavior get only the shadow parts removed, in that same commit. The frozen `review.test.mjs` is untouched (it has no shadow references).
   - New tests: an old config with the shadow keys runs a normal review with the note and no shadow job; `--pick-report` is an unknown flag (a plain error).
2. **Shorten the code-review skill** (`packs/review-gate/skills/claude/code-review/SKILL.md`, 161 lines; codex twin 112)
   - SKILL.md becomes about 40–60 lines: when to use it, the one command, the fix-round and fix-check loop, and the never-do rules.
   - The rest moves to a `reference.md` beside it, which SKILL.md points to. The review policy rules, the tables and the env options go there word for word: move, don't rewrite. Same for the codex twin.
   - `review.skills.test.mjs` (or whatever checks skill text) is updated in the test-only commit if it pins moved lines to SKILL.md: the assertion then checks the same text exists in SKILL.md or reference.md.
3. **Security prompt borrowings** (`securityPrompt`, review.mjs:1614). Cris approved these three from Cloudflare's security-audit-skill:
   a. Attack-class checklists, used only when the changed files match the class:
      - AI/agent tools: prompt injection through tool output, tool permissions, model-chosen commands;
      - supply chain: install scripts, lockfile or registry changes, fetched code;
      - local IPC: localhost servers, Host/Origin checks, sockets, file-permission races.
      The prompt includes only the matching lists.
   b. "A missing extra layer of defense is a hardening note (LOW), not a vulnerability."
   c. "Do not report a vulnerability without a concrete harmed principal: who is harmed, and how an attacker reaches them."
   - Tests: the prompt for a diff touching each class contains that class's list and not the others; (b) and (c) are always present; the prompt for a docs-only diff has no class lists.

## Out of scope

- Moving Cris's hand-written review rules from ~/.claude/CLAUDE.md into the managed block. That is his own instruction file: the orchestrator shows him the lines separately, and nothing here edits it.
- Removing the keys from Cris's home config. The orchestrator shows him that diff after merge.
- SQLite: it is dropped and never built, so there is nothing to remove.

## Bar

- Every listed test passes. The full `node --test packs/review-gate/tests/*.test.mjs` passes (the known flaky ones pass alone).
- `grep -rni shadow packs/review-gate lib public` matches only the old-key ignore note, its tests, and record readers.
- SKILL.md is 60 lines or fewer; nothing in the old skill is lost (every old line appears in SKILL.md or reference.md, apart from removed shadow text).
- The security prompt tests pass, and the frozen file is byte-identical.

## Process

1. The builder (Opus, medium) builds test-first and commits each part, plus the test-only commit.
2. /code-review with a reviewer from the other vendor, plus the other vendor checking the test-only commit.
3. One fix round, then one fix check.
4. Close, push, open the PR, and wait for green checks.
