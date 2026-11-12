# Remove Shared rules — choices

- Wizard restored, not hand-edited: `lib/skill-wizard.js`, `public/skill-wizard.js`,
  `tests/skill-wizard-ui.mjs`, `tests/skill-wizard-multi-ui.mjs` and
  `tests/skill-wizard-routes.mjs` were touched only by 866ebb4 (#72) since
  866ebb4^, and that diff is all Blocks, so each file is checked out from
  866ebb4^. "Creates skills exactly as before" is then true by construction.
- One line added beyond deletion (`public/skill-wizard.js` swLoad): a
  sessionStorage wizard saved on the gone `blocks` step would make paintWizard
  call undefined and throw; it now starts fresh. Without it, anyone mid-wizard
  across the upgrade gets a broken page until they clear storage.
- `.github/workflows/ci.yml` syntax step and `tests/ci-syntax-step.mjs` drop
  `blocks`: `find` on a missing folder exits non-zero under `set -euo
  pipefail`, so CI would go red. RUNBOOK's description of that step follows.
- `packs/review-gate/tests/review.skills.test.mjs` read four `blocks/*.md`
  files; they leave its lists, and the rule-5 check compares the two
  code-review skills to each other instead of to `blocks/review-policy.md`.
- `ui-words.mjs`: `ruleHits()` existed only for the blocks-view `quoteIn`
  allowance; inlined back to the pre-page form. The seeded `delta` skill (a
  block copy for the sweep) is gone.
- Kept: `lib/registry.js` `globalInstructionFiles()` / `skillsDirs()` (added
  for the page, now used by `buildRegistry` itself); the `parent`/`moved`
  view mechanism in `app.js` (the pack page uses it). Its comment's example
  now names the pack page instead of Compare.
- No CHANGELOG existed; `CHANGELOG.md` is new at the repo root (not in
  package.json `files`, so not shipped).
- Pre-existing, unrelated: `tests/models-scripts.mjs` fails 6 assertions on a
  clean `git archive 35b4957` snapshot too (it runs this machine's installed
  review.mjs, which needs the reviewer role set).
