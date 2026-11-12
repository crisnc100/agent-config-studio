Use the qa-tester skill's rules. Browser QA of the Packs redesign (PR 2) plus the new Soft slate dark theme. Lane: Claude Chrome. Mark the report "same-family QA" (the builder is Opus).

Target: http://localhost:49261 — a sandboxed test studio with a temp HOME and stub CLIs (local, full interaction allowed; it is NOT the user's real studio). Open it in a NEW tab, close the tab when done. Use the window as it is: never resize, zoom or emulate widths. Never open Details toggles (there should be none). Setup: none; the sandbox has the handoff pack installed for Claude only with an edited SKILL.md, codex stub present.

Approved design to compare against: /Users/cortega/Documents/Projects/personal/skills-work/builds/packs-redesign/mock.html (read it as a file; Soft slate palette).

Criteria (verdict PASS / FAIL / blocked each, with what you saw):
1. #packs shows eight cards in a grid: each with name, command, one-line purpose, a status word with dot, a step strip with "N steps" or a who-line. No settings, parts or install controls on the grid. A primary Install/Update button appears only on cards that need one.
2. Clicking a card opens #packs/<id>; the back button and the sidebar's Packs return to the grid; Packs stays highlighted in the sidebar on a pack page; reloading on #packs/review-gate lands on that page; #packs/nope shows "No pack called nope." with a way back.
3. The Review gate page shows, in order: What it does, How it runs (vertical step list), Settings, Parts, Files and undo; jump links at the top scroll to each. Another pack (e.g. Advisor) has no Settings section, and its variant switch works.
4. Install a pack that is not installed (e.g. Advisor) from its page: a preview appears on the page under the action before anything is written; Cancel closes it; Install again then apply installs it and the result shows on the page; no dialog opens anywhere on Packs. Also: start a preview and click Cancel while it is still loading — the buttons must stay usable.
5. On Handoff's page, the edited part shows its status (Edited or similar) and an action; Remove… previews before writing (cancel it; don't apply).
6. Setup page: the Codex card has the "Run the Codex trust check when Packs checks status" checkbox; toggling it and reloading keeps the choice.
7. Readability in dark (Soft slate) and light theme (toggle at the sidebar bottom): no text under 12px and no uppercase letter-spaced labels on the Packs pages (check with a script: computed font sizes and text-transform); body text contrast ≥ 4.5:1. Also look for dividers or row borders that vanish in dark mode (the soft border equals the darkest panel colour) — report where any divider is invisible.
8. No console errors on the grid and pack pages in either theme.

Also report improvement observations separately from errors (anything that looks cluttered, cramped, or off from the mock). Report once, as a table per criterion plus screenshots paths for failures. Test and report only; never edit files.
