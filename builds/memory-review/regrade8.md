**FAIL at `8917b6a`: regrade7’s three bugs are fixed; one new P2 regression remains.**

| Regrade7 bug | Verdict | In-memory evidence |
|---|---|---|
| 1. Reload discards edits typed during fetch | **FIXED** | Deferred the actual handler’s fetch, then typed. HEAD preserved the draft, kept it dirty and warned once. `e5e2faa` discarded it without warning. |
| 2. Same-content rewrite leaves obsolete timestamp | **FIXED** | Timestamp refreshed from `100` to `200`; actual `save()` and server PUT handler saved successfully. `e5e2faa` retained `100` and refused the save. |
| 3. Interleaved expectations hide expired deletion | **FIXED** | A removal at 0s, B change at 5s, A restoration at 6s, outside A deletion at 11s: HEAD classified it **outside**; `e5e2faa` classified it **studio**. |

| Criterion | Grade | Evidence |
|---|---|---|
| 1. Discovery | **PASS** | Implementation unchanged; regrade7 retained. |
| 2. Exact link edits | **PASS** | Implementation unchanged; prior exact-byte reproductions retained. |
| 3. Empty-folder eligibility | **PASS** | Eligibility checks unchanged. |
| 4. Trash safety | **PASS** | Persistence and recovery safeguards unchanged. |
| 5. Complete undo | **PASS** | Operation and restore implementations unchanged. |
| 6. Conflicts before step one | **PASS** | Hash, locking and containment checks unchanged. |
| 7. IDs and paths | **PASS** | No route, input or containment changes. |
| 8. Spawns and guards | **PASS** | Guard suite: **9 passed, 0 failed**. |
| 9. Context map | **PASS** | Context map, registry and sidebar unchanged. |
| 10. Real-machine report | **PASS** | Required report present; measurements not repeated. |
| 11. Honest wording | **PASS** | Memory wording and caveat unchanged. |
| 12. Suite / real-home protection | **PASS*** | Protection unchanged; all four changed JavaScript files passed syntax checks. |
| 13. Browser QA | **N/A** | As requested. |

*Prior suite grade retained under your read-only-sandbox exclusion; no claim of two fresh full-suite passes. Reproductions executed actual source with mocked I/O. Accepted race limit unchanged.*

**Bugs**

1. **P2 — Failed reload silently suppresses a dirty editor’s conflict warning.**  
   [app.js:813](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/app.js:813), [file-events.js:34](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/file-events.js:34)

   A studio event’s failed GET becomes `null`, and `reloadDecision()` returns `none`, bypassing the warning previously shown to an already-dirty editor.

   **Reproduced:** tab B holds an unsaved draft; tab A saves 5 MiB through the actual PUT handler, which accepts it. Tab B’s reload hits the GET route’s 4 MiB limit and returns **413**. HEAD produces **zero warnings**; its next Save returns **409**. Both `87419d3` and `e5e2faa` produce **one conflict warning** before Save. The draft survives, so this is P2.

   Preserve the warning when fetching fails and the same file remains open with unsaved edits.

No files changed.
