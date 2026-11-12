# Plan — Shared rules page: clear what it is and what you can do

Cris: "It's confusing — what does it mean? Focus on UI/UX so it's clear what this is and what users can do." Grounded in an Impeccable critique of the live page (14/36 on Nielsen's heuristics; top problems: no explanation of why it matters, red "differs" pills with no way to see the difference, copies from the studio's own packs mixed in, jargon).

**3 PRs**, each leaves main working: PR A is read-only; PR B and C write, so they stay apart from the read-only work.

## PR A — a page that explains itself (read-only)

1. **Rename** "Building blocks" → **"Shared rules"** (sidebar and title).
2. **Intro**, always shown: "Some rules appear in more than one of your instruction files and skills. The studio keeps one reference version of each and checks every file for it. When copies drift apart, your agents follow different versions of the same rule, depending on which file they read."
3. **Status line**, computed: "6 rules need a look · 6 have small wording changes · 0 match everywhere · checked 727 files" + quiet "Check again".
4. **Groups**, by each rule's worst copy, in this order, each with one line under it:
   - **Needs a look** — "At least one copy is quite different from the reference: it may leave part of the rule out, add other rules, or sit inside a longer paragraph."
   - **Small wording changes** — "Every copy is close to the reference, with a few words changed. Check that the meaning held."
   - **Match everywhere** — "Every copy is word for word the same."
5. **Per-copy labels**: Matches / Small changes / Big changes (only Big changes in the warning colour). A rule card leads with "3 of 12 copies match".
6. **Where a copy lives**, in words: "CLAUDE.md (Claude, global) · line 168", the full path in small mono text beneath. "Appears twice in this file" when a rule repeats in one file.
7. **The studio's own pack files** go under one quiet line per rule: "Also in the studio's own packs: 4 copies (you don't need to change these)."
8. **Compare copies** (primary on Needs a look, secondary on Small wording changes): its own view, not a fold — the reference text beside each copy, word-level differences marked "Missing from this copy" and "Only in this copy". The API returns each copy's text (today it returns only line numbers).
9. **Cut**: the word "marked", the summary line when it repeats the text, link-looking tags that aren't links. Empty states and the error state with plain wording (from the critique).
- Buttons in PR A: Compare copies, Back, Check again. Nothing writes.

## PR B — make a copy match (writes)
- Inside Compare: **"Make this copy match"** per copy: shows exactly what is removed and added, then confirm; a backup is kept through the studio's existing history so it can be undone. Never a blanket "everywhere" button: a copy with big changes may hold the person's own extra rules.
- Optional: "Update all close copies", limited to Small changes copies, same preview.
- Pack copies are never written.

## PR B criteria (approved 2026-11-12: "fix first", then B2)
- B1 In Compare copies, every copy outside a pack whose text differs from the studio's has a secondary "Make this copy match"; same copies and pack copies don't.
- B2 Clicking it shows a preview on the page: the file, and exactly the lines removed and added. Nothing is written before the person confirms (primary "Make it match"); Cancel drops it.
- B3 Confirm replaces only that copy's rule text (its marked region, or the located span of an unmarked copy) with the studio's text between block markers; every other byte of the file is unchanged; the old file goes into the studio's existing history/backup, and the result line says where and how to undo.
- B4 If the file changed after the preview, Save is refused and asks to preview again.
- B5 The server writes only files the Shared rules scan lists as a copy of that rule; pack copies, other paths and traversal are refused.
- B6 After a write the page checks again and that copy shows as the same.
- B7 UI rules: no folds, styled buttons, plain words, readable light and dark; existing suites and ui-words pass; one browser QA at the end.
- Not in B: "Update all close copies" (later, if wanted).

## PR B2 — add a rule where it's missing (after B)
- "Add to…" on a rule: pick skills or instruction files that don't have it; each gets the rule pasted under a "Shared rules" heading with markers, previewed per file, backed up, same write path as B.

## PR C — choose the reference, and "Leave as is"
- "Use this copy as the reference": the reference lives in a file the person owns (not inside the installed package); the studio's text stays the fallback.
- "Leave as is": remembered per copy, cleared automatically when that copy's text changes.

## Out of scope
Suggestions, automatic fixes, editing packs, meaning-level comparison (ratings stay word-based and say so).

## Criteria (PR A)
- A1 A first-time reader can say what the page is for and which rules need attention without reading a file path (intro, status line, groups).
- A2 Every Needs a look rule has Compare copies, and Compare shows the copy's actual text with the differences marked.
- A3 Labels say what is measured (wording), never "same meaning".
- A4 Pack copies are separated; a rule repeated in one file is flagged.
- A5 Nothing on the page writes; GET /api/blocks stays the only call besides static files.
- A6 UI rules: no folds, styled buttons, plain words, light and dark readable; ui-words and existing suites pass; one browser QA at the end.
