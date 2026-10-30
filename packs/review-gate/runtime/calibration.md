# Review severity calibration

Rubric version: 2026-10-29.2

| # | Finding | likelihood | impact | protected | risk | expected band | Why |
|---|---|---|---|---|---|---|---|
| 1 | Grade-failure fixes wrongly count as out of scope and block the push | 7 | 7 | no | 49 | HIGH | Every Grade-failure fix; the main workflow is blocked |
| 2 | Pushing a local tag to a branch bypasses the review gate | 1 | 7 | yes | 7 | HIGH | Uncommon, but a push-check bug: the gate's own logic lets unreviewed code onto a branch, so protected |
| 3 | A dispute verifier sees only the last commit rather than the reviewed diff | 5 | 7 | no | 35 | MEDIUM | Disputes are a regular optional path; a silently wrong verdict |
| 4 | A never-deployed build-only legacy record cannot use its own REFUTED dispute | 1 | 3 | no | 3 | LOW | No normal-use path |
| 5 | updateInstead accepts a push but leaves the working tree stale | 3 | 7 | no | 21 | MEDIUM | Named, supported, uncommon config; the stale tree is silent and the next commit undoes the push, but history, revert or reflog restores it, so not protected |
| 6 | Each Deferred findings line repeats the issue text | 10 | 1 | no | 10 | LOW | Cosmetic, every line |
| 7 | Global-hook install and status walk node_modules and take minutes | 10 | 3 | no | 30 | MEDIUM | Every install or status run; minutes lost, with the result correct |
| 8 | A blocked multi-ref push incorrectly lists covered refs as uncovered | 3 | 3 | no | 9 | LOW | Needs a mixed multi-ref push that is blocked; the block is correct, and its visible message is misleading |

## Rescore when a new model arrives

Give the new model the output of `node <review.mjs> --rubric` and these eight findings. Put its
scores in a copy of this table, keeping the expected bands. Run `node <review.mjs> --calibrate
copy.md` to compare derived and expected bands. When they disagree, tighten the anchor wording
before touching the constants. After any rubric edit, bump RUBRIC_VERSION and update this
file's version, then run `node <review.mjs> --calibrate` again. Scores cannot change in triage;
HIGH is fixed first, then MEDIUM; LOW is filed. Unscored findings block.
