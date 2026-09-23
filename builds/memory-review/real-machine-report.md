# Real-machine report — Memory & Context discovery (criterion 10)

Run on 2026-09-23 at 14:52 UTC against the real HOME (`/Users/cortega`). It was a **read-only** run: the
script called `scanMemoryWrites` and `discoverMemory` from `lib/memory-index.js`, and `contextMap`
from `lib/context-map.js`, directly. It never called any route, `memoryView`, preview, accept or
keep, so no ids were minted and no action was possible. The transcript cache went to a temp file,
not to `~/.agent-config-studio`.

To prove nothing was written, `tests/real-home.mjs save` ran before the script and `check` ran
after. The check reported **2 passed, 0 failed**. It hashes every `~/.claude/projects/*/memory`
tree, every slug directory, and every context file.

Nothing is asserted here. These are reported numbers, and each one is explained.

## Scan cost

| Measure | Value | What it means |
|---|---|---|
| Cold scan | **2,097 ms**, 1,254 transcripts, 1.18 GB read | Every session transcript and subagent transcript under `~/.claude/projects`, streamed in 256 KB chunks, with no cache. |
| Peak RSS during the cold scan | **189 MB** (189,251,584 B) | The process's RSS, sampled after each file. Bounded by 8 concurrent files × 256 KB buffers plus the retained results. Nothing reads a whole file. |
| Worst event-loop stall during the cold scan | **28 ms** | Sampled every 20 ms. The scan is async, so the server keeps answering other routes while it runs. |
| Warm scan | **17 ms**, 0 files read, 1,254 reused | Same listing, with every transcript matched on size + mtime + inode. This is the cost of a Memory view open when nothing changed. |
| Discovery (slugs, memory, index, findings) | 116 ms | Decodes 386 slugs against the filesystem and reads 425 memory files through the contained reader. |
| Context map | 158 ms | Walks `~/Documents/Projects`, including dot-dirs. It skips `node_modules`, `.git`, `dist`, `build` and other generated trees. |

## Slug states (386 slug directories)

| State | Count | Why |
|---|---|---|
| `temp-probe` | 245 | The slug starts in `/private/var/folders` or `/private/tmp`. These are ACS write probes, containment probes and scratchpads. They are hidden from the project list, and decoding is skipped. (The survey counted 240; the live suites have added more since.) |
| `resolved` | 53 | The slug decoded to one existing directory inside a git checkout. |
| `non-git` | 24 | The slug decoded to one existing directory that is not in any checkout, for example `~`, `~/Documents/Projects`, or `~/Documents/Garman-Homes` and its non-repo subfolders. |
| `missing` | 64 | Every candidate prefix was listed without error, and none led to an existing directory. Most are old worktrees and relocated projects. Only 8 of them hold memory (see Orphans). |
| `ambiguous` | 0 | No slug matched more than one existing path. |
| `inaccessible` | 0 | No directory on any candidate path refused a listing, and no slug is under an unmounted `/Volumes`. |

## Memory inventory

- **425 memory rows in 21 memory directories, plus 18 `MEMORY.md` indexes.** Indexes are never rows.
  Of the 425 rows, 40 are under `_archive/`, which leaves 385 live facts. That matches the survey's
  385.
- **Frontmatter formats:** 343 nested (`metadata:` block), 75 flat (the older top-level `type:`),
  and 7 with no frontmatter. The survey said "5 have no frontmatter"; the other 2 are in `_archive/`.
- **No future or unparseable `modified` dates** were flagged.
- **56 facts have a "last written" date.** Each one comes from a successful Write/Edit/MultiEdit on
  that exact file with a non-error tool_result. The other 369 read "last written: unknown", because
  no retained transcript holds a completed write to them.
- **Nothing was excluded.** No symlinks, protected names or unreadable files turned up inside any
  real memory directory.
- **Grouped by repository**, memory rolls up as expected:
  - `kylie-main` has 194 rows across 16 slugs. Its memory sits in the `kylie-main` slug and in
    `kylie-maya`, a checkout of the same repository.
  - `stella` has 45 rows across 18 slugs.
  - `AirFlo` has 65 rows across 6 slugs: the main checkout, its `apps/dealer-portal` subfolder,
    `airflo-trunk` and 3 worktrees. Its memory is only under the main `personal-AirFlo` slug.

## The 5 true-empty slugs (offered for the empty-folder trash)

Each of these holds nothing but an empty `memory/`:

1. `-Users-cortega--claude-skills` (resolved)
2. `-Users-cortega--codex-skills-advisor` (non-git)
3. `-Users-cortega--codex-skills-code-review` (non-git)
4. `-Users-cortega--codex-skills-qa-tester` (non-git)
5. `-Users-cortega-Documents-Projects-personal-agent-config-studio` (resolved)

No temp probe qualifies, which matches Astra's Bounce finding. At the time of this run, 260 slugs
had an empty `memory/`: these 5, 254 that also hold a transcript, and 1 that holds other entries.
The 255 are never offered. (The Bounce counted 241; the live suites add probe slugs on every run.)

## Orphans (memory whose project folder was not found)

8 memory directories, all in state **`missing`**. Each state was confirmed by listing every
candidate prefix. "Deepest existing folder" is the last real directory on the decoded path.

| Slug (HOME prefix dropped) | Files | Deepest existing folder | Same-named project with a slug |
|---|---|---|---|
| `Documents-Projects-AirFlo` | 4 | `~/Documents/Projects` | **AirFlo** (`personal/AirFlo`): side-by-side offered |
| `Documents-Projects-DegreeDigtial` | 16 | `~/Documents/Projects` | none |
| `Documents-Projects-AI-TowerDefense-Game` | 11 | `~/Documents/Projects` | none |
| `Documents-Projects-AI-TowerDefense_Game` | 1 | `~/Documents/Projects` | none |
| `Documents-Projects-DataAnalysisProject` | 11 | `~/Documents/Projects` | none |
| `Documents-Projects-Data-Analysis-project` | 6 | `~/Documents/Projects` | none |
| `Documents-Garman-Homes-05-Development-maya-receptionist-demo` | 5 | `~/Documents/Garman-Homes/05-Development` | none |
| `Local-Sites-pastureandporch-app-public` | 3 | `~` | none |

These match the plan's list. On "none": `personal/DegreeDigtial`, `personal/DataAnalysisProject` and
`personal/AI_TowerDefense_Game` do exist on disk, but no Claude session has run in any of them. They
have no slug and no memory, so there is nothing to compare side by side. The panel shows those
orphans with their state, and the only action on each is trashing a single file. Migration is
phase 2.

## Dangling index links: 28

- **27 in kylie-main.** Two are single-link entry bullets, at lines 53 and 54; these are removed
  whole. The other 25 sit in multi-link lines 73, 74 and 88–100, and each is removed at link
  granularity. Line 73 is the 13-link line, with 5 dangling.
- **6 of the 27 have a same-named file in `_archive/`**, so they are offered "point at archive"
  instead of removal:
  - `maya-receptionist.md` (line 90)
  - `automation-comments-feature.md` (line 91)
  - `utility-invoice-refactor.md` (line 95)
  - `duke-energy-tracking.md`, `filing-assistant-analysis.md` and
    `filing-assistant-lindsay-meeting-2026-04-22.md` (line 99)
- **1 in `Documents-Projects-AI-TowerDefense-Game`**, at line 5: `feedback_config_ux_feel.md`. That
  file lives in the sibling orphan `AI-TowerDefense_Game`, which is exactly the relocation the
  orphan review surfaces.

The plan expected "about 28". **28** were found.

## Unindexed files: 17

- **13 in directories that have an index:**
  - kylie-main (9): `anewgo-room-categorization`, `feedback_be_proactive_in_incidents`,
    `feedback_cma_dont_autoclassify_builders`, `feedback_diagnose_then_build_ui_fix`,
    `feedback_rbac_apply_overrides_at_canonical_level`, `project_tsr_2026_corruption_fix`,
    `rbac-details`, `reference_kylie_frontend_deploy_architecture`, `user_cma_usage_context`
  - stella (2): `feedback_verify_once_not_repeatedly`, `marketing-description-design`
  - AI-TowerDefense-Game (1): `project_loadout_system`
  - DegreeDigtial (1): `feedback_design_quality`
- **4 in 3 directories with no MEMORY.md**, where Accept would create the index:
  - Garman-Homes 02-Projects-Automation: `zapier-migration`
  - google-workspace: `no-external-msp`, `venmo-code-relay`
  - AI-TowerDefense_Game: `feedback_config_ux_feel`

The plan expected about 18. **17** were found, and 4 in dirs without an index matches exactly. The
survey said 14 in dirs with an index, against the 13 here. The one-file difference is
**unexplained**. No index uses `./` or `%`-encoded targets that the normaliser could have
reconciled. Archived files are excluded by design, and may be what the survey counted.

## Duplicates: 5 names in more than one directory

- `project-airflo`: `~/Documents/Projects` (workspace slug) and `personal-AirFlo`
- `feedback-codex-model`, `feedback-codex-submit-pattern`, `feedback-sprint-mode` and
  `project-github-account`: each in both `DataAnalysisProject` and `Data-Analysis-project`, the two
  encodings of one relocated project

## Oversized indexes (>200 lines)

None. The largest index has 108 lines.

## Other stores (read-only, no spawn)

- **Codex:** `~/.codex/memories_1.sqlite` has **0 rows** in `stage1_outputs`. It was opened through
  `node:sqlite` with `?immutable=1`, so no lock, journal or `-wal` file was created.
- **Grok:** `~/.grok/memory-v2` holds **13 observations in 1 scope** (`workspaces/cortega-…`). These
  are counted as `observations/**/*.md` files. The `memory_state.sqlite` beside them holds
  bookkeeping tables only, so the files are what gets counted.

## Context map: Air-Flo collapsing

`~/Documents/Projects` holds **109 instruction files**. They collapse to **15 entries**: 93
identical copies folded in, and 1 entry with drift.

**AirFlo:**
- Its 96 files come from 12 checkouts: `airflo-trunk` plus 11 worktrees under `airflo-wt`. The
  count includes each checkout's `AGENTS.md -> CLAUDE.md` link.
- They collapse to **4 scopes**:
  - `CLAUDE.md`: 24 copies, one variant. 281 lines, 12 headings.
  - `apps/dealer-portal/CLAUDE.md`: 24 copies, one variant. 94 lines.
  - `supabase/migrations/CLAUDE.md`: 24 copies, one variant. 46 lines.
  - `apps/dealer-portal/lib/production/CLAUDE.md`: **drifted**. Trunk and 17 copies are identical
    (73 lines). Six copies in three worktrees differ (84 lines), and each gets a drift badge and a
    diff.
- **Trunk comes from `.worktrees.conf`.** The trunk is `airflo-trunk`, the checkout whose
  `.worktrees.conf` names itself as `TRUNK=`. Git's main checkout, `personal/AirFlo`, holds no
  `CLAUDE.md`. If git's main checkout were taken as trunk, no copy would ever count as drifted.

**Everything else:**
- `boat-app-project`, `DataAnalysisProject`, `ortegasolutions` (an `AGENTS.md` plus its link),
  `pp-site-handover`, `tmp-pp-leads` and the `~/Documents/Projects` workspace `CLAUDE.md` each hold
  one entry per file.
- `FlexBreak` has two checkouts. Its `.cursor/rules/cursorrules.mdc` collapses 2 copies. A second
  `.mdc` under `.artifacts/launch-check/` sits at a different scope, so it stays separate even
  though it is identical.
- **No file was unreadable.**
