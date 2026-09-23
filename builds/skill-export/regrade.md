**FAIL — 6 of the 8 re-graded criteria still fail.** Commit `3290e0b` fixes several original defects, but containment remains bypassable and two test changes narrow the original bar.

| Criterion | Grade | Evidence |
|---|---|---|
| **1 — Discovery** | **PASS** | `.system` is now scanned. Independent real-machine discovery returned **132 rows, six `.system` skills, one broken row**, and the expected sources. [lib/skills.js:325](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/skills.js:325) |
| **2 — Bundle identity** | **FAIL** | The JSON digest fixes ambiguous boundaries and includes modes. However, excluded deep companions never enter that digest. My in-memory fixture had two bundles differing in `d0/…/d9/buried.md`; discovery returned **one row with one alias**. [lib/skills.js:207](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/skills.js:207), [lib/skills.js:259](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/skills.js:259) |
| **3 — Single markdown download** | **FAIL** | The split-surrogate defect is fixed, but grapheme truncation introduces an unbounded-header regression, detailed below. [lib/download.js:58](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/download.js:58) |
| **4 — Complete ZIP recovery** | **FAIL** | Deep companions and empty directories remain omitted. Reporting exclusions does not satisfy “recovered paths and bytes identical to source.” New tests assert the omissions instead of recovery. [lib/skills.js:207](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/skills.js:207), [tests/zip.mjs:658](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/tests/zip.mjs:658) |
| **5 — Extraction-path uniqueness** | **PASS** | Normalized collision keys are used throughout; file/parent conflicts are rejected in both orders. Independent probes returned **409** for NFC/NFD duplicates and both conflict orders; the resolver produced distinct suffixed paths. [lib/zip.js:186](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/zip.js:186), [lib/zip.js:340](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/zip.js:340) |
| **6 — Containment** | **FAIL** | Repeated swaps inside the skill directory bypass the post-open checks. The reader returned `OUTSIDE_SKILL_SENTINEL`; Python independently recovered it from the resulting ZIP. [lib/skills.js:153](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/skills.js:153) |
| **10 — Caps and selection handling** | **FAIL** | Metadata preflight, ID handling, and the aggregate read budget are fixed. The **64 MiB per-bundle cap is not enforced during reading**: a stale-metadata probe successfully packaged **75,497,473 bytes** from one bundle. [lib/download.js:161](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/download.js:161), [lib/zip.js:491](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/zip.js:491) |
| **14 — Seven trees byte-identical** | **FAIL** | Selected trees genuinely use SHA-256, but substantial portions remain names-only or unobserved. Modeled edits to `.grok/AGENTS.md` and `Documents/Projects/app/README.md` produced **no differences**. [tests/real-home.mjs:48](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/tests/real-home.mjs:48), [tests/real-home.mjs:140](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/tests/real-home.mjs:140) |

The original **P1 containment finding remains FAIL**. `O_NOFOLLOW` is present, and the descriptor inode is compared, but `realpathSync(abs)` resolves the pathname, not the descriptor. This modeled sequence passes every check:

1. Both directory stats see the original `sub/` inode.
2. Both leaf stats and `open()` see the outside file through a temporarily symlinked `sub/`.
3. `sub/` is restored before `realpath()`.
4. Reads use the already-open outside descriptor.

This requires changing **only `sub/` inside the skill**, contradicting the comment that the remaining vulnerability requires access above the skill root. [lib/skills.js:125](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/skills.js:125)

The swap tests are **not tautological**: they perform real fixture swaps, establish a clean baseline, and demonstrate leakage in the old reader. Their limitation is one swap window per attempt; they miss the sequence above. Also, the “realpath deny” fixture fails the preceding path-equality check, so it does not isolate the deny check. [tests/skills.mjs:370](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/tests/skills.mjs:370), [tests/skills.mjs:469](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/tests/skills.mjs:469)

The original **P1 cap finding is only partially fixed — FAIL overall**. My four-byte-budget probe stopped after five bytes with **413**, confirming bounded reading. Export also avoids discovery-time hashing. The remaining bundle-cap bypass described above is **P2**.

All four original P2 findings are fixed:

| Finding | Grade | Evidence |
|---|---|---|
| Cross-origin GET work | **PASS** | `same-site` and `cross-site` independently evaluated false; both skills routes gate before work. [server.js:99](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/server.js:99), [server.js:714](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/server.js:714) |
| Order-dependent ZIP conflicts | **PASS** | Both orders independently returned 409. [lib/zip.js:343](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/zip.js:343) |
| Reserved `filename*` | **PASS** | `CON` independently produced only `filename="skill.md"`. [lib/download.js:125](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/download.js:125) |
| Frontmatter usage lookup | **PASS** | A renamed-folder probe matched `dumb-down` through `displayName`. [lib/skill-usage.js:343](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/skill-usage.js:343) |

**New P2 regressions:**

- **Unbounded download header.** `a` followed by 10,000 combining accents remains one grapheme. The new code emits a **60,051-byte header**, versus **645 bytes before this commit**. An independent in-memory Node HTTP-client probe rejected it with `HPE_HEADER_OVERFLOW`. [lib/download.js:61](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/lib/download.js:61)
- **Tripwire exclusions are too broad.** `/(-wal|-shm|-journal)$|\.tmp/` ignores arbitrary persistent names. Adding `important.tmpbackup` or `notes-wal` produced no differences. Empty directories under `.agent-config-studio` also disappear from the consolidated snapshot. [tests/real-home.mjs:69](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/tests/real-home.mjs:69), [tests/real-home.mjs:124](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-skill-export/tests/real-home.mjs:124)

The **5→6 entry-count** and **cross-site 200→403** expectation changes are legitimate fixes. Accepting incomplete archives and broadening tripwire exclusions do not meet the unchanged acceptance criteria.

I read every requested file and the commit stat. **No files changed.** Full fixture suites and `verify.sh` were not rerun because this session is filesystem read-only; the independent probes used memory only.
