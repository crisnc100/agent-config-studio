**FAIL at `7cd5452`. Five original bugs are fixed; four remain partially fixed.** The overwrite race still permits data loss, and a new compatibility regression prevents restoring previously accepted empty-folder operations.

| Original bug | Verdict | Evidence |
|---|---|---|
| 1. Trash metadata destroys payload | **FIXED** | Payloads now live under `data/`, separate from metadata ([mutate.js:214](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/mutate.js:214)). In memory, files named `trash-meta.json`, `trash-meta.pending.json`, and `data` all listed and restored with their original bytes. |
| 2. Interrupted operations falsely restore | **NOT FIXED** | New `started` records recover correctly, including interruption after an index undo. But legacy `done:false` records are still excluded ([memory-ops.js:642](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/memory-ops.js:642)): reproduced `restored:true` with the changed index untouched. Interruption inside fact restoration also prevents retry; details below. |
| 3. Concurrent edits / directory substitution | **NOT FIXED** | Rechecking after history closes the original window, but `writeIndex` awaits writing the temporary file before an unchecked rename ([memory-ops.js:439](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/memory-ops.js:439)). Reproduced both overwritten external edits and a write redirected outside memory; Accept returned `applied`. |
| 4. Restore bypasses containment | **NOT FIXED** | The payload redirect is now refused, but recursive destination-directory creation happens **before** Memory’s containment callback ([mutate.js:321](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/mutate.js:321)). Reproduced a refused Restore creating `.claude/hooks/sub` through a substituted memory-directory symlink. |
| 5. Context IDs expose transcripts | **FIXED** | The resolved target must itself be a context file under Projects ([context-map.js:108](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/context-map.js:108)). Retargeting an already-minted context ID to a transcript returned 403 in memory. Discovery also excluded it. |
| 6. Link cleanup deletes prose | **FIXED** | Whole-bullet removal now distinguishes remaining prose ([memory-index.js:321](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/memory-index.js:321)). The original reproduction preserves `— KEEP THIS UNRELATED PROSE`. **The corrected assertion at tests/memory.mjs:208 is correct**, not a weakened check. |
| 7. Finding eligibility not rechecked | **FIXED** | Missing targets and archive replacements become checked participants; already-indexed files are rejected ([memory-ops.js:326](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/memory-ops.js:326), [memory-ops.js:373](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/memory-ops.js:373)). Reproduced rejection of stale dangling/unindexed IDs and targets reappearing after preview. |
| 8. Real-home protection narrowed | **NOT FIXED** | Arbitrary slug and context additions now fail, but probe-shaped names exempt their **entire new subtree**, without provenance or emptiness checks ([real-home.mjs:277](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/tests/real-home.mjs:277)). An unexpected memory file beneath such a slug produced zero failures; the `87419d3` comparator rejected the same synthetic snapshot. |
| 9. Discovery/display omissions | **FIXED** | Populated probes are filtered from groups, rows and findings ([memory-ops.js:170](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/memory-ops.js:170)). Context aliases collapse only within the same directory ([context-map.js:191](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/context-map.js:191)). Both original reproductions passed in memory. |

| Criterion | Grade | Evidence |
|---|---|---|
| 1. Discovery | **PASS** | State resolution, worktree grouping, frontmatter and successful-write matching remain implemented; populated-probe omission is fixed. See memory-index.js:98, :667 and :395; gitmeta.js:55. |
| 2. Exact link edits | **PASS** | Executed byte comparisons for one and five removals from a 13-link line, preserving remaining links and prose. Lone-link prose and empty-bullet cases also passed. |
| 3. Empty-folder eligibility | **PASS** | In-memory reproduction: adding a transcript after preview caused a reported skip and preserved the slug. A subsequent preview refused it. |
| 4. Trash safety | **PASS** | In-memory checks passed for same-name files trashed in the same millisecond, interrupted pending-metadata recovery, collision names, and surfaced history failure. |
| 5. Complete undo | **FAIL** | Legacy false-success recovery, interruption inside fact restoration, and the new empty-slug compatibility regression remain. Restore can also overwrite concurrent index edits. |
| 6. Conflicts before step one | **FAIL** | Besides the overwrite race, changing the index during a fact’s baseline-history call still allowed the fact to be trashed before Accept returned 409. |
| 7. IDs and containment | **FAIL** | ID-only handlers and transcript restrictions pass. Directory substitution still redirects index writes; refused Restore can create directories outside memory. |
| 8. Spawns and guards | **PASS** | `node tests/guards.mjs`: **9 passed, 0 failed**. Existing A–G implementations are unchanged versus `87419d3`; H is additive. |
| 9. Context map | **PASS** | Scope reproduction passed; adjacent aliases still collapse. Walker, outlines and drift handling remain present. Registry is unchanged; the fixes do not alter the sidebar. |
| 10. Real-machine report | **PASS** | Required report is present with counts, lists and timing measurements. This grades the report’s coverage, not independent remeasurement. |
| 11. Honest wording | **PASS** | Executed wording assertions: “last written” and “unknown” present; prohibited wording absent. Caveat remains present. |
| 12. Suite / real-home protection | **FAIL** | The probe-subtree exemption leaves a reproduced protection gap. Sandbox denial of `mktemp` is **not** counted as a finding; two full suite passes were not independently verified here. |
| 13. Browser QA | **N/A** | Excluded as requested. |

**Bugs remaining or newly found**

1. **P1 — Accept and Restore still overwrite concurrent edits and allow directory redirection.**  
   Both callers validate before entering `writeIndex`, whose awaited temporary-file write creates another interleaving window before rename. Injecting an external edit during that await lost the edit; Accept returned `applied`, and Restore returned `restored:true`. Substituting the memory directory during the same window redirected the replacement into `.claude/hooks/MEMORY.md`. See [memory-ops.js:560](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/memory-ops.js:560) and [memory-ops.js:668](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/memory-ops.js:668).

   There is also an operation-wide conflict gap: each late check validates only that step’s requirements. Changing the index during the fact-trash baseline call resulted in the fact being removed **before** the index conflict was detected. The operation remained restorable, but criterion 6’s “nothing changed” guarantee failed.

2. **P1 — Legacy interrupted operations still falsely report restoration.**  
   The new state machine fixes newly recorded interrupted index edits. It does not recover an existing interrupted record containing `done:false`: that step never reaches inspection, and the operation is marked restored. The in-memory reproduction retained the post-cleanup bytes. This is the original false-success defect for persisted records.

3. **P2 — Newly introduced regression: previously completed empty-slug operations cannot restore.**  
   Old trash steps lack `target`. The new callback interprets that absence as a memory file because it uses `s.target !== 'slug'` ([memory-ops.js:682](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/memory-ops.js:682)). Reproduced a legacy `done:true` empty-slug operation failing with “not inside a memory folder.” Its payload remains in trash.

4. **P2 — Restore cannot resume after interruption between hard-link creation and trash-payload removal.**  
   At [mutate.js:337](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/mutate.js:337), restoration creates the destination before removing the source. An interruption there leaves both present. Retry treats that as an outside-file conflict at memory-ops.js:613 and refuses indefinitely. Reproduced with intact fact bytes. This is a newly identified recovery gap, not newly introduced hard-link code.

5. **P2 — Containment checks occur after an external directory mutation.**  
   Restoring `memory/sub/fact.md` after replacing `memory` with a symlink to `.claude/hooks` creates `hooks/sub`, then refuses the payload restoration. Run Memory’s containment validation before recursive `mkdir`, as well as before placing the payload.

6. **P2 — The real-home exception still hides unintended writes.**  
   A new slug matching the probe-name regex can contain `memory/UNEXPECTED.md` and still pass. A name is insufficient evidence that the suite created the slug, and the exception is broader than the documented empty-memory case.

Apart from the real-home comparator exception, I found no weakened existing tests or guards versus `87419d3`; `verify.sh` only adds suites. Verification used actual source with in-memory filesystem/history substitutes, pure-function checks, and the guard suite. No files were changed.
