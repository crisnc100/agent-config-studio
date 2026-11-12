# Packs redesign and Soft slate theme: plan

Approved design: `mock.html` (published), `direction.md`, `tokens.md` (Soft slate). Cris picked Soft slate and approved the redesign on 2026-11-11.

## Outcome

The studio's dark theme is Soft slate everywhere, with no glare and no navy cast. The Packs page is a grid of eight cards, and each pack opens its own page with five sections: What it does, How it runs, Settings, Parts, Files and undo. Less text on screen, more space, nothing under 12px, no uppercase labels.

## Three PRs

Each one, merged alone, leaves main working.

1. **Soft slate theme.** Only `public/styles.css`: the dark tokens at `:root` become the Soft slate values in `tokens.md`, and the body's `-webkit-font-smoothing` becomes `auto`. The light theme is unchanged. It touches the token block only, so it can be built in parallel with PR 2 (checked with `git merge-tree` before either is called ready).
2. **Packs grid and pack pages.** `#packs` becomes the card grid; `#packs/<id>` is the pack page. Everything the current long page does still works, moved onto the pack page: install, update, remove parts, previews and results (inline under the action, no dialogs), the diagram as a vertical step list, and the Review gate settings moved over as they are today. The Codex trust-check checkbox moves to Setup and the older-install notice moves into the review gate's Files and undo.
3. **Review gate settings rows.** Branched from main after PR 2 merges. Four rows, each with one control and one line for the selected choice; "Always needs you" as a count plus **Edit paths**, which opens its own page (`#packs/review-gate/paths`); one sticky "Preview and save" bar. The writer and routes from #75 are unchanged.

## Acceptance criteria

PR 1
- C1: Dark theme tokens match `tokens.md` Soft slate exactly; light tokens unchanged.
- C2: Every text token at 4.5:1 or more on every panel colour in both themes (existing contrast tests updated only where they pin old hex values, in their own test-only commit).

PR 2
- C3: `#packs` shows eight cards with name, command, the one-liner from `direction.md`, status, step strip; a primary Install or Update button only on cards that need it; no settings, parts or install controls on the grid.
- C4: Clicking a card opens `#packs/<id>`; back and the sidebar return to the grid; a reload on `#packs/<id>` lands on the pack page; an unknown id shows a plain "No pack called …" with a way back.
- C5: The pack page has the five sections in order with jump links (Settings only for Review gate). Install, update, part add/remove each still previews before writing and shows its result on the pack page; no `pkDialog`.
- C6: The trust-check preference is set on Setup and still read by the status check; the older-install notice shows in Review gate's Files and undo.
- C7: Content width 1080px; no text under 12px and no uppercase letter-spaced labels on either page; readable in light and dark.

PR 3
- C8: Settings show four rows; each choice row shows one line for the selected choice only; the gh/CI condition appears only when it applies.
- C9: Edit paths opens its own page with the built-in and risky lists and the box; Save there previews first.
- C10: Picking a choice opens the sticky save bar naming the change; Cancel restores; Preview and save shows the diff in place of the bar; Save writes through the existing #75 routes with one backup.

All: no new dependencies, every button primary/secondary/quiet, no Details folds, touched test suites pass, `ui-words` passes.

## Out of scope

Other pages' layouts (they get the new palette only), the Models page, model roles, any new setting, studio sign-in.

## Who builds

Builder role (Opus or Sol); one builder per PR, PR 1 and PR 2 in parallel in their own worktrees. Each PR goes through `/pr-review` and one browser QA near the end.
