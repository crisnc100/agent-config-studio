**FAIL at `e5e2faa`: regrade6’s three bugs are fixed; three new regressions remain.**

| Regrade6 bug | Verdict | In-memory evidence |
|---|---|---|
| 1. Duplicate removal suppresses outside deletion | **FIXED** | Actual trash code registered one expectation. Trash → studio; different-byte recreation → outside; subsequent deletion → outside. |
| 2. Expectations accumulate indefinitely | **FIXED** | 200 single-file removals left zero expectations. A directory expectation expired on unrelated activity. 6,000 registrations were capped at 5,000. |
| 3. Other tabs’ editors ignore studio saves | **FIXED** | Actual handler updated a clean tab’s content and timestamp. An already-dirty tab retained its draft and received a warning. |

| Criterion | Grade | Evidence |
|---|---|---|
| 1. Discovery | **PASS** | Relevant implementation unchanged; regrade6 retained. |
| 2. Exact link edits | **PASS** | Relevant implementation unchanged; regrade6 retained. |
| 3. Empty-folder eligibility | **PASS** | Relevant implementation unchanged; regrade6 retained. |
| 4. Trash safety | **PASS** | Persistence safeguards unchanged; actual trash exercised with mocked I/O. |
| 5. Complete undo | **PASS** | Restore implementation unchanged; regrade6 retained. |
| 6. Conflicts before step one | **PASS** | Operation conflict checks unchanged; regrade6 retained. |
| 7. IDs and containment | **PASS** | No new routes, client inputs or containment changes. |
| 8. Spawns and guards | **PASS** | Guard suite: **9 passed, 0 failed**. |
| 9. Context map | **PASS** | Context map and registry unchanged; regrade6 retained. |
| 10. Real-machine report | **PASS** | Required report present; measurements not repeated. |
| 11. Honest wording | **PASS** | Memory wording and caveat unchanged. |
| 12. Suite / real-home protection | **PASS*** | Protection unchanged; all five changed JavaScript files passed syntax checks. |
| 13. Browser QA | **N/A** | As requested. |

*Full-suite execution excluded under your read-only-sandbox instruction. Overall FAIL comes from the additional regression checks below. Reproductions executed actual source in memory with mocked I/O; accepted race limits unchanged.*

**Bugs**

1. **P1 — A studio reload discards edits typed during its fetch.**  
   [app.js:818](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/app.js:818)

   The handler decides the editor is clean before awaiting `/api/file`, then replaces `S.draft` without checking again.

   **Reproduced:** another tab saves; this tab starts fetching; the user types an unsaved draft; the fetch completes. HEAD replaced that draft with the other tab’s bytes, marked it clean, and issued **zero warnings**. At `cb6af5e`, the same studio event preserved the draft. This asynchronous loss is outside the accepted synchronous race limit.

   Recheck editor state after the fetch; preserve intervening edits and warn.

2. **P2 — Same-content outside rewrites leave Save using an obsolete timestamp.**  
   [app.js:820](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/app.js:820)

   Skipping updates when content matches also skips refreshing `S.file.mtime`.

   **Reproduced:** unchanged bytes, editor timestamp `100`, disk timestamp `200`. HEAD retained `100`; the actual `save()` function and server timestamp check rejected the next edit with **409**. At `cb6af5e`, the handler updated the timestamp to `200`, avoiding that refusal.

   Refresh file metadata even when the bytes match.

3. **P2 — Interleaved expectations hide an outside deletion after expiry.**  
   [watch.js:133](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/watch.js:133)

   Updating a path moves its entire expectation list behind newer paths, including its older entries. Pruning stops at the first entirely live list; `consume()` no longer checks expiry itself.

   **Reproduced:** pending removal of A at `0s`, change to B at `5s`, restoration of A at `6s`, outside deletion of A at `11s`. B’s live expectation stopped pruning before A’s expired removal. HEAD tagged the deletion **studio**, producing **zero outside notices**; `cb6af5e` tagged it **outside**, producing one. No identical-byte exception is involved.

   Check expiry when consuming, and prune without assuming list order matches every entry’s expiry.

No files changed.
