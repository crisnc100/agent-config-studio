---
name: Deferred findings in the PR body
summary: Every PR body lists its deferred findings; a bug hunt checks them first.
---
Every PR body must include a section titled exactly **Deferred findings**, using the deferred and filed findings in --summary (or `none` when empty). When chasing a bug, first check `node <review.mjs> --deferred` and merged PR descriptions with `gh pr list --state merged --search "Deferred findings in:body"`.
