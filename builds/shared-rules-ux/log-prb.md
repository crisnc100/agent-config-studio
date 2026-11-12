# PR B log: make one copy match

Deliberate choices, server phase:

- The writer is lib/blocks-match.js, so lib/blocks.js stays write-free (its "no write call" test is unchanged). blocks.js gained only `copySpan` and, per copy, `canMatch` and `whyNot` in the GET payload.
- The client names a copy as the scan reports it: rule id, the file's display path (`~/…`), line and endLine. The server re-runs the scan and maps the display path to the file the scan found; a path the client spells is never opened. So traversal, absolute paths and unlisted files are refused as "not a file the check reads" (403). Pack files are refused by source (403). resolveSafe then refuses a listed file whose link leaves the roots (403); the page also shows such a copy without the button, with a one-line reason.
- Hard-linked files never reach the writer: openUserFile refuses them, so the scan never lists them (tested as "not listed, preview 403").
- Backup = the studio's existing history (shadow git repo, `~/.agent-config-studio/history`), the same one Files → History restores from. The writer calls `history.recordBaseline` itself first and refuses with 500 "Nothing was written" if that fails (the proposals writer would only warn). The write itself goes through `createProposals().commit` (lib/proposals.js), the audit's in-place writer: it re-checks identity and bytes with no await before writing, and records the new bytes in history.
- Signature = sha256 over rule id, display path, line, endLine and the file's byte hash, so a signature from one copy can't apply another. A stale signature, or a copy no longer at its line, is 409 "preview it again".
- Ambiguous spans (no button, one-line reason): an unmarked copy inside a longer paragraph; an unmarked copy sharing lines with another rule's copy. Rules nest in the shipped set (review-policy holds the operator-merges sentence), so every unmarked operator-merges copy also scans as a loose review-policy copy. A strict overlap rule would block those, so a close copy (same/reworded) that wholly contains a loose ("differs") match of another rule keeps its span; a partial overlap, a close copy of another rule, or two loose copies still block.
- Line endings: the replaced span takes the file's own line ending (CRLF stays CRLF), and a copy at the end of a file with no final newline gets none. After building the new text the writer re-scans it and refuses unless that rule now scans as a marked, matching copy where the old one started.
- The preview's diff uses lib/describe.js lineDiff (as the review settings preview does), so unchanged lines inside a marked region show as context.

Page phase:

- The button, preview and result live inside Compare copies only; the list page is unchanged. One copy is previewed at a time (BB.match); the other buttons are disabled while it is busy. Leaving Compare or switching rule drops the preview and the result line.
- Preview shows "In <file>, lines X–Y become the reference version:", the server's line diff numbered from the copy's first line, "The old file is saved to History first…", primary "Make it match", quiet Cancel.
- A 409 on apply drops the preview, shows the server's message (stale: "The file changed since the preview. Nothing was written; preview it again.") and a secondary "Preview again"; a 409 on preview (for example, the copy moved) also offers Preview again.
- After apply the page runs GET /api/blocks again (B6) and shows a status line at the top of Compare: "Updated <file>: that copy now matches the reference. The old version is in History (~/.agent-config-studio/history): open <file> and choose History to put it back."
- No browser pass was run in this phase; B7's one browser QA is left for the end of the build.
