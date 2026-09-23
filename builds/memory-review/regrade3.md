**FAIL at `8d71d75`. Five prior bugs are fixed; bug 1 remains partially fixed. Two reproduced defects remain outside the accepted race limit.**

| Prior bug from `regrade.md` | Verdict | Evidence |
|---|---|---|
| 1. Concurrent edits / directory redirection / participant gap | **NOT FIXED** | Original reproductions now pass: Accept preserves edits and returns 409; Restore preserves edits and refuses; changing the index during fact history prevents trashing the fact. However, temporary writes can still escape containment, and cross-device trash can delete concurrent edits. Details below. |
| 2. Legacy interrupted operations falsely restore | **FIXED** | In-memory `done:false` legacy record returned 409, “unrecognised operation record”; index bytes stayed unchanged. Refusal matches the owner’s decision. |
| 3. Legacy empty-slug operations cannot restore | **FIXED** | Legacy record without `target` explicitly refused with 409, as intended. A current-schema empty-slug operation successfully trashed and restored its `memory/` directory. |
| 4. Interruption after linking prevents retry | **FIXED** | Interrupted immediately after the restore link: first Restore stopped with both copies present; retry returned `restored:true`, preserved fact bytes, and cleared trash. |
| 5. Refused Restore creates directories outside memory | **FIXED** | Substituted `memory → .claude/hooks`: Restore refused without creating `hooks/sub`. Restoring the real directory allowed retry to recreate `memory/sub` and restore the fact. |
| 6. Probe exception hides unintended writes | **FIXED** | Synthetic snapshots: empty probe directories passed; `memory/UNEXPECTED.md`, a nested directory, and substituted symlinks all failed. New context files also failed. |

| Criterion | Grade | Evidence |
|---|---|---|
| 1. Discovery | **PASS** | Discovery, worktree resolution, frontmatter, successful-write matching and probe filtering remain intact; relevant modules are unchanged since round 2. |
| 2. Exact link edits | **PASS** | Executed exact byte comparisons for one and five removals from the 13-link fixture. Unrelated single-bullet prose survives. |
| 3. Empty-folder eligibility | **PASS** | Adding a transcript after preview produced a reported skip and preserved the directory. |
| 4. Trash safety | **FAIL** | Collision names and interrupted metadata recovery passed. Cross-device copying can still lose concurrent edits. |
| 5. Complete undo | **PASS** | Fact-plus-index undo passed; fresh module instances recovered interruptions after index mutation and during Restore. Hard-link retry and current-schema empty-slug restore passed. |
| 6. Conflicts before step one | **FAIL** | Normal participant checks and duplicate concurrent Accepts passed. The cross-device fallback still mutates after an unchecked await. |
| 7. IDs and containment | **FAIL** | Forged/path-shaped IDs were refused; Memory/Context handlers remain ID-only. Temporary index writes can escape memory containment. |
| 8. Spawns and guards | **PASS** | `node tests/guards.mjs`: **9 passed, 0 failed**. Guards A–G unchanged versus `87419d3`; H additive. |
| 9. Context map | **PASS** | Round-2 scope fix, walking, outlines and drift handling remain unchanged. Registry unchanged versus `87419d3`. |
| 10. Real-machine report | **PASS** | Report covers required counts, lists, collapsing and timing/RSS measurements. Coverage assessed; measurements not independently repeated. |
| 11. Honest wording | **PASS** | Executed wording assertions: required labels present, prohibited wording absent, caveat present. |
| 12. Suite / real-home protection | **PASS*** | Probe protection reproductions passed; existing tests/guards were not weakened. `verify.sh` only adds suites. |
| 13. Browser QA | **N/A** | Excluded as requested. |

*Full-suite execution is excluded under your sandbox instruction; this does not claim two independently observed `verify.sh` passes.*

**Bugs**

1. **P1 — Cross-device trash deletes edits made during its copy await.**  
   [mutate.js:229](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/mutate.js:229) handles `EXDEV` by awaiting the copy, then removing the source without revalidation.

   **Reproduced in memory:** forced the source-to-trash rename to return `EXDEV`; copied `FACT` into trash; changed the source to `EXTERNAL AFTER COPY` before the copy promise resolved. Accept returned **`applied`**, the source disappeared, and trash contained only **`FACT`**. The external edit was lost.

   This is a remaining asynchronous conflict gap, not the accepted synchronous race. Refuse cross-device Memory mutations or implement a checked fallback that preserves intervening edits.

2. **P2 — Round-3 index writing creates a temporary file outside memory before checking containment.**  
   [memory-ops.js:488](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-memory-review/lib/memory-ops.js:488) writes the temporary file before calling `verify()`.

   **Reproduced in memory, without the operation fault hook:** during the awaited history baseline, moved the memory directory aside and replaced it with a symlink to `.claude/hooks`. Accept wrote the proposed index contents into **`hooks/.MEMORY.md.acs-<random>.tmp`**, then returned **409**. Cleanup removed the temporary file, but the outside write already occurred.

   Validate containment immediately before safely opening the temporary file; retain the final synchronous validation before replacement.

Verification executed the actual operation/mutation source with in-memory filesystem and history substitutes, plus pure-function checks and the guard suite. No files changed.
