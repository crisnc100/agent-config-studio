**PASS — all three targeted fixes in 9784a29.**

| Item | Grade | Evidence |
|---|---|---|
| **C2/C4 — unreadable companions** | **PASS** | Listing/stat failures now produce broken rows before hashing: [lib/skills.js:235](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/skills.js:235), [lib/skills.js:439](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/skills.js:439). Independent probes returned two distinct broken rows, zero reads/aliases, and **409** for single and multiple selections. |
| **P2 — directory collisions** | **PASS** | Names are reserved per parent and descendants reuse the resolved directory: [lib/zip.js:252](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/zip.js:252). Python independently recovered **10 distinct payloads and five empty directories**, preserving modes. Another **500 adversarial selections** passed uniqueness and directory-identity checks. |
| **C14 — tripwire coverage** | **PASS** | Both missing paths are covered: [tests/real-home.mjs:56](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/tests/real-home.mjs:56), [tests/real-home.mjs:68](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/tests/real-home.mjs:68). Independent snapshots detected same-length edits to both files and seat-entry additions, consistent with [criterion 14](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/builds/skill-export/plan.md:85). |

**No new bug introduced by 9784a29 found.**

Validation used memory-only probes. Full fixture suites and `unzip`/`ditto` extraction were not rerun because the sandbox prohibits writes. No files changed.
