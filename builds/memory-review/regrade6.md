**FAIL at `cb6af5e`. Regrade5’s three original reproductions are fixed; three new defects remain.**

| Regrade5 bug | Verdict | In-memory evidence |
|---|---|---|
| 1. Matching-path suppression | **FIXED** | Partial Restore followed by outside edits and a refused retry: both changes classified outside; open index reloaded. Subsequent deletion cleared the editor and warned. Recreating a trashed fact classified outside. |
| 2. Pending request holds events indefinitely | **FIXED** | Left Accept unresolved and delivered **10,000 events** through the actual EventSource callback: **10,000 refreshes and notices**. |
| 3. Overlapping Restores release each other’s hold | **FIXED** | First callback settled while second remained pending. Both restored files tagged studio; only the separate outside addition was announced. |

| Criterion | Grade | Evidence |
|---|---|---|
| 1. Discovery | **PASS** | Relevant implementation unchanged; prior grade retained. |
| 2. Exact link edits | **PASS** | Actual Accept removed one/five links from the 13-link fixture with exact expected bytes. |
| 3. Empty-folder eligibility | **PASS** | File added after preview caused a reported skip, zero steps, and preserved contents. |
| 4. Trash safety | **PASS** | Payload/persistence safeguards retained; exercised actual trash and restoration with mocked I/O. |
| 5. Complete undo | **PASS** | Fact-plus-index and index-repair restoration preserved exact preimages. Outside-edited indexes refused with diffs. |
| 6. Conflicts before step one | **PASS** | Concurrent duplicate Accepts returned `applied`/409; containment checks unchanged. |
| 7. IDs and containment | **PASS** | Forged/path-shaped IDs refused. No new client inputs or tagging endpoint; origin and hashes computed server-side. |
| 8. Spawns and guards | **PASS** | Guard suite: **9 passed, 0 failed**. |
| 9. Context map | **PASS** | Context and registry implementation unchanged; prior grade retained. |
| 10. Real-machine report | **PASS** | Required report present; measurements not independently repeated. |
| 11. Honest wording | **PASS** | Wording/caveat checks passed; relevant wording unchanged. |
| 12. Suite / real-home protection | **PASS*** | Protection unchanged; changed JavaScript passed syntax checks. |
| 13. Browser QA | **N/A** | As requested. |

*Full-suite execution excluded under your read-only-sandbox instruction. Accepted race limits unchanged. The actual broadcast handler preserved all six paths in a mixed batch across two messages; no partition loss found.*

**Bugs**

1. **P2 — A genuine outside deletion is tagged studio.**  
   [mutate.js:405](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/mutate.js:405) registers removal for `abs` and every element of `files`. For a single file, `files` is `[abs]`: **two expectations for one removal**.

   **Reproduced:** actual Memory Accept trashed a fact; its removal consumed one expectation. An outside writer recreated it with **different bytes**, then deleted it within 10 seconds. Recreation was correctly outside, but deletion consumed the leftover expectation and became studio. The actual client handler produced **zero warnings and left the deleted file open**. This is outside the accepted identical-bytes exception.

   Deduplicate removal registration and invalidate obsolete expectations when subsequent events contradict them.

2. **P2 — Expired expectations accumulate indefinitely.**  
   [watch.js:121](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/watch.js:121) and `consume()` prune only the path currently visited. There is no global expiry cleanup or capacity bound.

   **Reproduced:** trashed 200 distinct files and consumed their removal events. **200 leftover expectations remained**. Advancing classification time by a day and processing an unrelated event retained all 200. Deleted paths need never appear again. Unobserved directory expectations likewise persist.

   Expiry must reclaim stored entries independently of future events on those paths.

3. **P2 — Studio saves stop updating other tabs’ non-memory editors.**  
   [app.js:791](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/public/app.js:791) returns before editor synchronization for every studio event. The server broadcasts that tag to every tab.

   **Reproduced:** tab A saved `CLAUDE.md`; tab B had it open without edits. HEAD retained old content with **zero reloads or notices**. Running the same event through the `0557324` handler reloaded it. Previously, suppression belonged to the writing page.

   Preserve editor synchronization across tabs while suppressing unnecessary own-write notices.

No files changed.
