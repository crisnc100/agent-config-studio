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
