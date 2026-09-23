**FAIL at `0557324`. Both regrade4 bugs are FIXED; three event-handling defects remain.**

| Regrade4 bug | Verdict | In-memory evidence |
|---|---|---|
| Short writes truncate indexes | **FIXED** | Same five-byte injection produced `# Ind` at `4153c86`. HEAD preserved complete UTF-8 bytes through Accept and Restore. Zero-byte returns and thrown errors preserved the original, closed descriptors, and removed temporary files. |
| Suppression hides changes beneath skipped folders | **FIXED** | Actual event handler announced `OUTSIDE.md` beneath a skipped slug and reloaded its subsequent change. Accept skipped the populated folder with zero steps. |

| Criterion | Grade | Evidence |
|---|---|---|
| 1. Discovery | **PASS** | Relevant modules unchanged; prior grade retained. |
| 2. Exact link edits | **PASS** | One/five removals from the 13-link fixture matched expected bytes; short-write reproduction passes. |
| 3. Empty-folder eligibility | **PASS** | Newly added file caused a reported skip and survived. |
| 4. Trash safety | **PASS** | Mutation implementation unchanged; prior grade retained. |
| 5. Complete undo | **PASS** | Short-write Restore restored exact bytes; outside edits caused refusal with a diff. Remaining coverage retained. |
| 6. Conflicts before step one | **PASS** | Concurrent duplicate Accepts yielded `applied`/409; prior containment checks retained. |
| 7. IDs and containment | **PASS** | Forged/path-shaped IDs refused; containment implementation retained. |
| 8. Spawns and guards | **PASS** | Guard suite: **9 passed**. |
| 9. Context map | **PASS** | Relevant implementation unchanged; prior grade retained. |
| 10. Real-machine report | **PASS** | Required report remains present; measurements not independently repeated. |
| 11. Honest wording | **PASS** | Executed wording and caveat assertions passed. |
| 12. Suite / real-home protection | **PASS*** | Protection unchanged; tests additive. Own-write suite: **8 passed**; syntax checks passed. |
| 13. Browser QA | **N/A** | As requested. |

*Full-suite execution excluded as instructed. Accepted synchronous race limit unchanged. The overall failure concerns the additional event-handling checks below.*

**Bugs**

1. **P2 — Suppression still hides genuine changes at matching paths.**  
   [own-writes.js:43](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/own-writes.js:43) reads persistent `undone` flags; [app.js:1913](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/app.js:1913) registers them even when the current Restore refuses.

   **Reproduced:** partially restored a two-index operation, then changed both indexes externally. Retry refused without writing but returned the earlier step’s `undone:true`. Feeding that actual response through the Restore callback suppressed the held outside-change event: **zero reloads or warnings**. External deletion at a historical `undone` path was likewise silently suppressed.

   Separately, the 15-second path exemption still hides an outside writer recreating a just-trashed fact: **zero addition notices**. Exact path matching establishes neither event origin nor which request changed it. Return changes specific to the current attempt and distinguish matching operation events from subsequent outside changes.

2. **P2 — An unsettled request holds all file events indefinitely.**  
   [app.js:779](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/app.js:779) has no hold deadline or capacity limit; [api:49](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/app.js:49) has no request timeout.

   **Reproduced:** left Accept pending and delivered **10,000 events**. All remained queued, with **zero registry refreshes or notices**; advancing the mocked clock did nothing. A stalled server/history operation therefore disables live updates and grows the queue until settlement or page reload. Bound the hold and provide a release/resynchronization path.

3. **P3 — Overlapping Restores release each other’s hold.**  
   [app.js:780](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/app.js:780) clears one shared hold whenever either request settles.

   **Reproduced:** clicked Restore for two distinct operations. After the first response, the second remained pending but `heldEvents` was already null. Its restored-file event was immediately announced as **“1 added outside the studio”** before its response could identify the write. Track outstanding requests or serialize these controls.

HTTP failures, network rejection, and response-processing exceptions **did release and replay events** in both callbacks. No files changed.
