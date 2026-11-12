# PR 3 log: review gate settings rows

Deliberate choices, for the reviewer.

- **Segmented control is `.pk-tabs` / `.pk-tab`.** The diagram's variant switch already uses it with the mock's `.seg` values, and ui-words names `pk-tab` as an allowed control. The orange `.btn.pk-sec-on` button is gone, along with its ui-words contrast entry (test-only commit).
- **The bar and preview sit in one slot after the rows** (`.pk-savebar-slot` inside `.pk-settings`, and at the foot of the paths page). They are sticky inside that wrapper, as in the mock, so they stay in view while the rows are on screen.
- **Picking no longer previews.** A pick only changes the draft and repaints; **Preview and save** sends the one plan request. A pick made while a preview is open drops the preview and brings the bar back.
- **Both Cancels restore the saved values** (the bar's and the preview's): one meaning for Cancel.
- **A refused Save drops the preview** and shows the server's error above the bar, which keeps the picks. That is how "asks to preview again" works.
- **Typing in the paths box repaints only the slot** (`pkPaintSlot`), so the caret stays put. `PK_SEC.paths` keeps typed text across the pack page and the paths page, so the bar, the count and any Save include it. That covers the first trap, and the test drives it across both pages. Save and Cancel clear it, so the next read of the data shows the list on disk. That covers the second trap, and the test calls `pkLoad()`.
- **Paths edited after a preview** still go through the existing check in `pkSettingsApply`: Save shows the refreshed preview with its reason and does not write.
- **Route:** `#packs/<id>/<sub>` sets `PK.sub`, and `pkMoved` compares both parts. Only `review-gate/paths` is a page; any other sub shows "No page called <id>/<sub>." with the back button. Coming back from the paths page puts focus on **Edit paths**.
- **gh line (approved by the lead):** `machine()` checks the PATH for gh the same way it checks for git, and `catalogView` sends it only as the boolean `settings.merge.gh`. No new route; the writer (`lib/review-settings.js`) is unchanged. The amber line shows only when gh is missing and the picked policy is not Off. The page tests pin gh as present, so they pass whatever the machine has.
- **CI half dropped (approved by the lead):** the studio has no repo context. merge.mjs leaves its own "no CI checks" comment on the PR, and the README covers repos with no CI.
- **Lines cut to one sentence:** Low-risk PRs reads "An agent may merge any low-risk PR. You merge the rest.", the mock's wording. Low and medium-risk PRs reads "An agent may merge low- and medium-risk PRs; high-risk always waits for you."
- **README is not touched:** its "Review gate settings" section still describes the old layout. That is left for the context pass.
