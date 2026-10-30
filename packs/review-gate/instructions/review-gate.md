## Review gate

- Code review runs through the code-review skill and the shared review script: `scripts/review.mjs` in the repo when present, otherwise `~/.agent-config-studio/review-gate/review.mjs` (<review.mjs> below).
- Reviewers come from the `reviewer` role in ACS (Models → Roles). If the script stops and names a fix (install `model-id`, set the role, install a CLI), relay that fix; never review with a model the role does not list.
- Builders commit their work and never run reviews, grades or other models themselves; the orchestrator runs those checks and opens the PR.
- Only the operator accepts a confirmed finding (`--waive`, from a real terminal) or overrides the push gate. Agents never set `REVIEW_GATE_OVERRIDE`, never pass `--no-verify`, and never change `core.hooksPath` or any `reviewgate.*` setting.
- Every PR body must include a section titled exactly **Deferred findings**, using the filed findings in --summary (or `none` when empty). When chasing a bug, first check `node <review.mjs> --deferred` and merged PR descriptions with `gh pr list --state merged --search "Deferred findings in:body"`.
