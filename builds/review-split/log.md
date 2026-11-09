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
- **The brief file and table file.** `builds/<slug>/context-brief.json` and `builds/<slug>/docs-table.json`; pr-facts finds the table by `--docs-table`, beside the plan, as a changed builds/<slug>/docs-table.json, or in builds/<branch>/.
- **Fix round (review 2026-11-09-20-29-48-6c3e93): no lexer in the gate.** The merge-tier exemption for comment-only edits is deleted; securityReasons, closeTier and mergeTier are main's again, and review.mjs has no classifier. The comment-only check lives only in context-pass.mjs, as a fail-closed accident barrier for the writer (block-comment delimiters, regex literals, string continuations, heredocs, YAML block scalars, line continuations, mode changes and unknown languages count as code; changed lines come from git diff, so length never decides). The writer therefore cannot delete a whole block comment; it reports it instead.
- **`--focus docs` is a full review** (correctness prompt plus docs instructions; the security pass runs when on), slice-only.
- **`--since-close <sha>`** (slices only): the code reviewer reads only what changed after a complete close of this branch ended at `<sha>`, and only when that close's coverage holds every slice file's state there (or the file is as at base). The slice's security pass reads the whole slice from the branch base, so its `saw` never vouches for unread code. Named `--since-close` because `--since <date>` belongs to --noise-report.
- **A covered /build tip** re-closes its review at the tip (tests only, no model), so the context pass has a close head to slice from.
- **pr-facts table enforcement** applies only when a table exists; repos that never run a context pass are unaffected. It lives under `docsTable`, beside the existing `docs` facts.
- **Pinned doc text** is found deterministically: a removed doc line (12+ characters) that a test file in the repo quotes. The brief's `untouchable` globs cover the rest (program-input .md files).
- **The diagram** has eight tiles: the context pass after Close; the /pr tile folded into the card's note, keeping two even rows of four.
- **The docs-focus check of a planted wrong claim** is tested with a stub reviewer: the prompt carries the instruction and the claim, and a reviewer's finding on the doc line is quote-verified and blocks the slice close. Whether a real model catches it is not tested here (no model runs in the suites).
