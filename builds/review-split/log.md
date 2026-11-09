# Build log — review split, PR 2

## Decisions the plan did not make

- **How /code-review avoids the security pass.** `review.mjs --code-only` (an opt-out the skill passes), not an opt-in flag for the pass. Plain `review.mjs` still runs the pass per `security.run`, which is what /pr-review runs, so existing callers and tests keep their behavior. A code-only review with `security.run` on records `security.status: "not-asked"`, and the merge tier is HIGH with the existing "did not cover logic" reason: a PR never reads as security-reviewed when it was not. With `security.run` off the record says `off`, as before.
- **Where the security-only record lives.** `security-log.jsonl` beside the review log, `type: "security-check"`, `securityOnly: true`. `readLog()` also drops any record marked `securityOnly`, so a record copied or forged into the review log is never a review (the eval-mode pattern). Report under `reviews/security/<id>/`, so `reviews/latest` is untouched.
- **Standalone ignores `security.run`.** Asking for /security-check is the decision; the setting only governs the pass inside a PR review.
- **Feeding open standalone findings to the PR review.** `review.mjs --security-findings` prints this branch's (and repo's) non-filed, non-pre-existing, still-located findings as text; /pr-review passes it as an extra intent argument, so both reviewers see it as "not decided: check whether each still holds". Never via the "already decided" channel.
- **One fix check.** /pr-review runs `--fix-check` once whenever the fix round changed code, not only when close requires it (the plan's "ONE fix check").
- **/build tip.** /pr-review skips the review when `--tier-json` shows the tip covered and `security.run` is off; with it on, it reviews at the tip, since a Grade carries no security pass.
- **Packaging.** The two new skills ship in the existing `code-review` part (same runtime, installed together), not as new parts.
- **Rules 1–11 stay in /code-review**; /pr-review refers to them. Fewer moved pins, one copy of the policy.
- **The pack's workflow diagram** keeps its /code-review card with the Security pass step; reworking it around /pr-review is left for later.
- **The security switch** writes the first home config that exists (review.mjs `homeKey` order), else the primary; a file already at the chosen level is left byte for byte; a malformed or non-object file is refused, not rewritten.
- **`--show-config`** now prints `security` (the run level in force), which /pr-review reads in its first step.

# Build log — review split, PR 3 (/context-pass)

## Decisions the plan did not make

- **Writer role wiring.** `writer` ships in roles.default.json as Opus then Sonnet (medium) and is install-only, like `security`: unset on every existing install until chosen. It is not in packs.js ROLE_NEEDS, so installing the review gate never asks for it; `--set-role writer=…` works through the existing role plumbing.
- **Harness rule for the writer.** Claude Code runs the role's first Claude family as a native subagent; Codex runs the role's first `gpt-` family with `codex exec --sandbox workspace-write`. When the role has no family for the harness, the skill stops and says so; it never falls back to another vendor's CLI (a raw `claude -p` writer would break the raw-call lint and the watchable-builder rule).
- **The brief file and table file.** `builds/<slug>/context-brief.json` and `builds/<slug>/docs-table.json`; pr-facts finds the table beside the plan, or by `--docs-table`.
- **The comment-only classifier** lives in review.mjs (single-file contract) and is exposed read-only as `--comment-only <from> <to> [paths]`; context-pass.mjs calls its sibling review.mjs, so the two never drift. A line counts as comment only when every non-blank character on it is inside a comment; mixed lines, strings (docstrings included), directives, doc tests and unknown languages are code.
- **Tier exemption scope.** Only a docs-focus slice's close, and only for a file whose state at the closing HEAD differs from a state a security pass on this branch saw in comments and blank lines alone (same mode, file present). A plain slice of the same edit stays HIGH. When fixes changed the file after the pass, the main close is already HIGH and the slice keeps it there.
- **`--focus docs` runs on slices only** (REVIEW_PATHS or --slices) and runs no security pass, so a docs review can never be the only review of a whole branch.
- **pr-facts table enforcement** applies only when a table exists; repos that never run a context pass are unaffected. It lives under `docsTable`, beside the existing `docs` facts.
- **Pinned doc text** is found deterministically: a removed doc line (12+ characters) that a test file in the repo quotes. The brief's `untouchable` globs cover the rest (program-input .md files).
- **The diagram** has eight tiles: the context pass after Close; the /pr tile folded into the card's note, keeping two even rows of four.
- **The docs-focus check of a planted wrong claim** is tested with a stub reviewer: the prompt carries the instruction and the claim, and a reviewer's finding on the doc line is quote-verified and blocks the slice close. Whether a real model catches it is not tested here (no model runs in the suites).
