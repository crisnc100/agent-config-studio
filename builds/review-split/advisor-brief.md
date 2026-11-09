# Advisory brief — split the review gate into code, security and context reviews

## THE ASK (Cris, 2026-11-09)
Today one 5,201-line script (`packs/review-gate/runtime/review.mjs`) and one skill (code-review) do everything: the code review, the security pass, the PR gate (close, push block, merge tier, summary), and eval. Cris says that is the problem: "this is becoming too much of a single part and we need to separate them."

He wants a flow:
- A builder builds.
- Then the review agents:
  - **code review**: looks deeply at the code;
  - **security review**: its own area;
  - a NEW **context review**: right comments (no over-commenting or jargon), technical docs up to date, a PR description that makes sense to someone outside.
- The context agent comes at the end, after the code and security fixes. It must NOT log every fix or loop ("overkill"), and it documents only after the final analysis — not per phase in big looped builds.

## WHAT WE KNOW
- Review gate, merged: tiers (#40/#41), the security pass (#42, inside review.mjs; `security` role; `security.run` off|required|always; findings s1… share one fix round and fix check with the code findings), merge.mjs (#43), base-merge coverage (#44/#48), --eval (#45), findings that mean something (#46), the pr pack (#47: pr-facts.mjs and style.json, a readable PR body checked before gh pr create).
- Existing skills that overlap with context review: /lean-comments (audits comments added in the diff), /pr (writes the PR description).
- Earlier decision (2026-11-05, item 7): a docs check — when behavior changes, the README, skill or CLAUDE.md describing it must change in the same PR, or the PR says why not. Not built yet.
- Process rules (in ~/.claude/CLAUDE.md):
  - one fix round, then one fix check; what remains is deferred and listed in the PR body;
  - builders commit at each phase end and never push;
  - the push gate needs a close covering the tip;
  - Sonnet writes technical documentation only.
- Open: review-gate PR C (worktree agent-config-studio-review-cleanup) removes the shadow pickers and adds security prompt borrowings.
- Claude Code ships a built-in /security-review, so our skill would be /security-check.

## CURRENT DIRECTION (attack it)
Flow: BUILD → REVIEW (code + security in parallel; one fix round; one fix check) → CONTEXT (once, on the final diff vs base) → PR GATE (close, push, PR) → Cris merges.

1. **Three skills:**
   - /code-review: diff, correctness;
   - /security-check: diff, security; can also run alone;
   - /context-review: comments, docs, PR description, at the end.

   The PR gate is not a skill: it is the pack's hook and rules, and it orchestrates the reviews.
2. **The context stage edits only comments and docs.**
   - A mechanical check confirms no code tokens changed, so its commit never reopens the review loop.
   - If it thinks code should change, it reports that instead.
   - It reads the final diff and the plan, never the loop history.
   - The PR body keeps one line per deferred finding.
3. **Context writer:** Sonnet, checked by another vendor.
4. **Split review.mjs into modules:** a shared core (model calls, scoring, quote check, records), the code reviewer, the security reviewer, and the gate (close, push, tier, merge). Behavior and tests unchanged.
5. **Order of small PRs:**
   a. split the skills (text only);
   b. `--security-only`;
   c. /context-review plus the comment-only check;
   d. move the script into modules, one per PR.

## DECISIONS IN PLAY
1. Is this the right decomposition? Should context be a reviewer (findings) or a writer (edits)?
2. Does the comment/doc-only commit safely skip re-review, and is a token-level "no code changed" check sound?
3. Should the module split of review.mjs happen at all now, or only the skill split? Weigh the risk to a gate with ~800 tests.
4. PR order and sizes: what should come first?

## READ FIRST
- /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/packs/review-gate/skills/claude/code-review/SKILL.md
- /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/packs/review-gate/pack.json
- /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/packs/pr/ (the pr pack)
- /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk/packs/review-gate/runtime/review.mjs (skim its structure; security pass near :3104, :1614)
- /Users/cortega/.claude/skills/lean-comments/SKILL.md
- /Users/cortega/Documents/Projects/personal/skills-work/builds/review-vs-anthropic/decisions.md
