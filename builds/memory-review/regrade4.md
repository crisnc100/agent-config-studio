**FAIL at `4153c86`. Both regrade3 bugs are fixed; two new regressions remain.**

| Regrade3 bug | Verdict | In-memory evidence |
|---|---|---|
| Cross-device trash loses concurrent edits | **FIXED** | Prior code copied, deleted the edited source, and returned `applied`. HEAD returned **409**, made **zero copies**, preserved the fact and index, and left no trash entry. Cross-device Restore also refused safely and succeeded on retry. |
| Temporary index write escapes containment | **FIXED** | Substituted `memory → .claude/hooks` during the history await. Prior code wrote a temporary file under hooks before refusing. HEAD returned **409 with zero outside writes**. |

| Criterion | Grade | Evidence |
|---|---|---|
| 1. Discovery | **PASS** | Relevant discovery modules unchanged; prior grade retained. |
| 2. Exact link edits | **FAIL** | One/five-link transformations pass byte comparisons, but a short write lets Accept publish a truncated index. Bug 1. |
| 3. Empty-folder eligibility | **PASS** | Adding a file after preview produced a skip, zero operation steps, and preserved the folder. |
| 4. Trash safety | **PASS** | Cross-device refusal preserves data; collision/interruption/history handling retained. |
| 5. Complete undo | **FAIL** | Normal fact-plus-index undo passes. Short writes can break undo or falsely report successful restoration. Bug 1. |
| 6. Conflicts before step one | **PASS** | Participant changes and duplicate concurrent Accepts refused; both prior asynchronous gaps closed. |
| 7. IDs and containment | **PASS** | Forged IDs and credential symlinks refused. New fields contain server-owned display paths; injected path fields were ignored. No transcript-content or credential-path exposure found. |
| 8. Spawns and guards | **PASS** | `node tests/guards.mjs`: **9 passed, 0 failed**. |
| 9. Context map | **PASS** | Mapping/registry unchanged; revised collapsed-copy count matches `copies − 1`. |
| 10. Real-machine report | **PASS** | Required reporting remains present; measurements not independently repeated. |
| 11. Honest wording | **PASS** | Executed wording and caveat assertions passed. |
| 12. Suite / real-home protection | **PASS*** | Tests only added; synthetic protection checks rejected unexpected files, directories and symlinks. |
| 13. Browser QA | **N/A** | As requested. |

*Full-suite execution excluded under your sandbox instruction. Unchanged criteria retain the prior grade. The accepted synchronous race limit is unchanged.*

**Bugs**

1. **P2 — Short writes silently truncate indexes and break Restore.**  
   [memory-ops.js:494](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/memory-ops.js:494) calls `fs.writeSync(fd, text)` once and ignores its returned byte count. That API returns bytes written; the former `writeFile` API handles multiple writes internally. [Node documentation](https://nodejs.org/api/fs.html#fswritesyncfd-string-position-encoding)

   **Reproduced:** simulated a successful five-byte write. Accept returned `applied` with the index reduced to **`# Ind`**; Restore refused it as externally edited. Injecting the same short write during Restore instead returned **`restored:true` with the index still truncated**.

   Write the complete buffer through the already-open descriptor, handling short writes and errors before replacement.

2. **P2 — Own-write suppression hides genuine outside changes beneath skipped folders.**  
   [app.js:792](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/app.js:792) suppresses every descendant of a registered path. [app.js:1963](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/app.js:1963) registers preview paths before knowing what Accept actually changes.

   **Reproduced:** preview empty-slug cleanup; an outside writer creates `empty/memory/OUTSIDE.md`; Accept correctly skips the slug. Its broad suppression remains active for 15 seconds. Feeding the actual event handler that addition produced **zero notices**; a subsequent change to that file while open produced **zero reloads or warnings**. Registry refresh still ran. Sibling files and other slugs correctly retained their notices.

   Suppress confirmed changes to exact file paths, clear skipped/refused expectations, and avoid suppressing arbitrary descendants. Empty-slug operations contain no memory files requiring descendant suppression.

No files changed.
