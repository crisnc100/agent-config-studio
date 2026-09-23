# Plan — Memory & context review + cleanup  (rev 2, after Astra Bounce)

## Outcome

ACS gets a **Memory** view and a **Context** view.

- **Memory** shows every Claude auto-memory fact, grouped by repo. For each fact it shows its age
  and the last time an agent actually wrote it. It also finds structural rot: empty folders,
  orphaned folders, broken or missing index lines, and duplicates. It offers one-click cleanups.
  Every cleanup is restorable from the ACS trash and needs an explicit Accept.
- **Context** shows, per project, which CLAUDE.md / AGENTS.md files exist. Identical copies are
  collapsed (worktree copies, symlinks). A file outline shows each file's headings, so you see
  what a project tells its agents without opening the codebase. A worktree copy that has
  drifted from trunk is flagged.

## Facts this is built on (survey, 2026-09-23)

- **Memory lives in `~/.claude/projects/<slug>/memory/`.** There are 257 dirs with a `memory/`
  folder; only 21 are non-empty, holding 385 files, and 18 of those have a `MEMORY.md` index.
  222 of the empty dirs are temp probes such as `-private-var-folders-…-acs-claude-writeprobe-*`
  and `-private-tmp-claude-501-*`.
- **Slugs are lossy.** `/`, `_`, `.` and spaces all became `-`, and the encoding changed over
  time. Decoding a slug to a path must resolve greedily against the filesystem, and may come out
  "unresolved".
- **Memory is keyed by the main checkout, not the worktree.** For example, Air-Flo's worktrees
  share `-…-personal-AirFlo/memory`. Transcripts, however, sit under each worktree's own slug.
  So activity must be **rolled up per repo**, via the git common dir.
- **Frontmatter.** Files carry `name`, `description` and `metadata.{type, modified,
  originSessionId}`. 87 files use an older format without nested `type`, and 5 have no
  frontmatter at all.
- **Index rot.** 28 index lines point at missing files: 27 in kylie-main (some moved to
  `_archive/`) and 1 elsewhere. 18 files are not in any index: 14 in dirs that have one, and 4
  in three dirs that have no MEMORY.md.
- **Orphans.** 8 memory dirs whose project path no longer exists. Most are relocated projects:
  `Projects/AirFlo` → `personal/AirFlo`, `DegreeDigtial`, `DataAnalysisProject` (twice),
  `AI-TowerDefense` (twice), `maya-receptionist-demo`, `pastureandporch`.
- **Duplicates.** No byte-identical memory bodies. 5 names repeat across dirs, all from
  relocations.
- **"Last used" by name-grep is useless.** The index is loaded into every session, so every name
  appears everywhere. Usable signals are frontmatter `modified`, file mtime, and explicit
  Write/Edit tool calls on that exact memory path in transcripts (rare, but accurate).
- **Context files.** 48 under `~/Documents/Projects`: 20 are `AGENTS.md -> CLAUDE.md` symlinks,
  and 31 of the 33 copies in worktrees are identical to trunk. Today ACS's `discoverProjectMemory`
  (lib/registry.js) lists every airflo-wt copy separately.
- **Codex `memories_1.sqlite` has 0 rows.** Grok `memory-v2` has 13 observations in one scope.
  `~/.grok/memtrace` is telemetry, not memory.

## Design (rev 2 — Astra's Bounce cut the risky actions and corrected three facts)

**Corrected facts.**
- **Worktree resolution is two steps.** A worktree's `.git` file names
  `<main>/.git/worktrees/<name>`, and that directory's `commondir` file holds a path relative to
  itself (`../..`) that leads to the common dir. The resolver follows both steps. It reads only
  these two tiny metadata files through a dedicated internal reader, never through the general
  file routes, which keep denying `.git`.
- **Only 5 slugs are truly empty.** 241 have an empty `memory/` folder, but 236 of those hold
  transcripts. Empty-dir cleanup therefore targets only slugs containing nothing but an empty
  `memory/`. Transcript-bearing slugs are never offered for deletion.
- **Index lines hold many links.** kylie-main MEMORY.md:73 has 13 links. Index edits work at the
  granularity of a single markdown link, never a whole line.

**Repo grouping (`lib/memory-index.js`).** Slugs are decoded greedily against the filesystem
into one of five states:
- `resolved`
- `ambiguous` (more than one path encodes to it)
- `inaccessible` (a permission error, or a volume that isn't mounted)
- `non-git`
- `missing`, confirmed only when every candidate prefix up to a real existing ancestor fails.

`resolved` git paths group by the two-step common dir. Every other state stays standalone.
Temp-probe slugs are recognised by pattern and hidden from the project list.

**Memory rows.** A row is every `.md` under `memory/` **except `MEMORY.md` itself**. `_archive/`
files are shown under "archived", and are never offered for re-indexing.
- `modified`: taken from frontmatter; a future or unparseable date falls back to mtime and is
  flagged.
- `lastWrite`: the newest `assistant` record whose `message.content[]` has a
  Write/Edit/MultiEdit `tool_use` with `input.file_path` equal to that file, **and** a matching
  `tool_result` (by `tool_use_id`) that is not an error.
  - The scan covers the repo's slugs and their nested subagent transcripts, and tolerates a
    partial last line.
  - With no evidence, the value is "unknown", never "never".
  - The scanner is new code, streaming and cached per transcript by size, mtime and inode.

**Findings and actions. Phase 1 ships only low-blast-radius actions.**
1. **Empty slug dirs:** the 5 true-empty slugs and any temp-probe slug containing only an empty
   `memory/`. Action: trash, one bulk Accept. Eligibility is re-checked at Accept time; a slug
   that is no longer empty is skipped and reported.
2. **Dangling index links:** remove exactly that link's markdown (and a now-empty list bullet),
   leaving every other link and all prose on the line byte-identical. When a same-basename file
   exists in `_archive/`, the offer is "point at archive" instead. Shown as a diff; Accept applies.
3. **Unindexed live files:** append one index entry built from the file's frontmatter, as a diff.
   A dir with no MEMORY.md gets one created, also shown as a diff.
4. **Orphaned and duplicate memory: review only, no migration in phase 1.** The panel shows the
   orphan dir with its resolution state and, where a same-named repo exists, a side-by-side view
   against that repo's memory. The only action is **trash this file** (a single file plus its
   index link). Moving or merging memory between dirs is **deferred to phase 2**: reference
   rewriting and index merging are unsafe to rush.
5. **Oversized index:** a warning above 200 lines. No action.

**Review queue.**
- Live facts sorted by `max(modified, lastWrite)`, oldest first, with an age filter.
- **Keep** records `{sha256 of content, reviewedAt}` in the ACS state file. The fact reappears
  after N days, or at once if its content changes. The memory file is never edited.
- **Trash** removes the file and its index link together as one operation, undone together.

**Operations and undo — the safety core.**
- **Trash IDs become collision-proof.** `lib/mutate.js` gets a millisecond timestamp plus a random
  suffix, and the destination is created exclusively. Metadata is written **before** the data
  move (a temp metadata file, then the move, then a rename to final), so an interrupted trash
  still lists and restores. A history failure is logged and surfaced, never swallowed.
- **Every cleanup is one operation record** `{id, kind, steps[], preimages[]}`, stored in the ACS
  state dir **before** execution.
  - Restore replays the preimages. For an index edit, restore applies the inverse link edit to
    the current file. If the file changed since, restore refuses and shows the diff instead of
    clobbering.
  - Operations survive a restart.
- **Conflict checks cover every participating file.** Before execution each one is re-hashed
  (sha256, not only mtime) against the preview. Any mismatch aborts the whole operation before
  its first step. Accepts are serialised by a per-repo lock, and a duplicate submission of the
  same operation id is a no-op.
- **Ids are opaque and minted server-side,** random and mapped to a finding in memory; they are
  not base64 paths. At Accept time the target is re-resolved, and the op refuses when:
  - `lstat` shows a symlink anywhere on the path under `~/.claude/projects`;
  - `realpath` leaves `~/.claude/projects/<slug>/memory` (for a memory file);
  - the target hits the credential deny-list.

**Context map (`lib/context-map.js`).**
- A new walker, not the registry's. It finds CLAUDE.md, AGENTS.md and `.cursor/rules/*.mdc`,
  including inside dot-dirs such as `.cursor` and `.worktrees`, and skips node_modules, .git,
  dist and build.
- **Byte-identical copies are collapsed only in this view.** Each collapsed entry lists every
  physical path and which one opens in the editor (trunk first). Files at different relative
  scopes are never merged.
- An outline shows each file's headings with line counts.
- A drifted worktree copy gets a badge and a two-file diff (a new generic text diff, since the
  existing compare is skill-specific).
- **The registry and sidebar are not changed.** History treats the registry as its inventory
  (history.js:87), so collapsing there would record real files as deleted. The sidebar stays
  as it is.

**Other stores.** A read-only count line each for Codex and Grok memory, opened with sqlite in
`?immutable=1` mode through `node:sqlite` when available. When it isn't, the line says the count
couldn't be read. No spawns.

**Freshness.** The scan cache is invalidated by transcript size, mtime or inode changes and by
new files appearing, via a directory listing checked on each view open. One scan runs at a time,
and concurrent callers share it. The cold scan streams; its peak memory and duration are
measured and reported, and the server keeps answering other routes during it.

## Acceptance criteria

1. **Discovery on fixtures (temp HOME):**
   - all five slug states, including an ambiguous encoding and an inaccessible dir;
   - a two-step worktree `.git` → `commondir` resolution with a relative path, plus a project dir
     below a checkout root;
   - temp probes hidden, and `MEMORY.md` never counted as a row;
   - `_archive/` shown as archived and never offered for indexing;
   - both frontmatter formats, and a file with none; a future date gets flagged;
   - `lastWrite` counts only successful Write/Edit/MultiEdit on the exact path. The fixture has
     50 name mentions, 1 successful Edit, 1 errored Edit, 1 Edit with no result and 1 in a
     subagent transcript; it yields the successful one plus the subagent one. No evidence →
     "unknown".
2. **Link-level index edits are exact.** A fixture line with 13 links, 5 of them dangling: fixing
   one leaves the other 12 links and all prose byte-identical. Fixing all 5 in one Accept is also
   exact. A test asserts the byte diff.
3. **Eligibility is exact.** Empty-dir cleanup is offered only for slugs containing nothing but an
   empty `memory/`. A slug with a transcript is never offered. A slug that gains a file between
   preview and Accept is skipped and reported.
4. **Trash cannot lose data.**
   - Two same-basename files trashed in the same millisecond both survive and both restore.
   - An interrupted trash (the process killed between steps, simulated) is still listed and
     restores.
   - A history failure is surfaced.
5. **Operations undo completely.**
   - A fact trash restores both the file and its index link.
   - An index repair restores to the pre-image.
   - Restore after the index was edited by someone else refuses and shows the diff.
   - Operations survive a server restart.
6. **Conflicts abort before step one.** Changing any participating file after the preview, a
   duplicate submission, two concurrent Accepts, and a symlink swapped in after the preview are
   each refused with nothing changed.
7. **Ids and paths.** Forged and base64-path ids, valid-but-ineligible ids, symlinked dirs, and a
   deny-listed file behind a `.md` name are each refused. No route accepts a path. No response
   carries transcript text beyond the memory file's own content.
8. **No new spawns** (a guard-f-style check on the new libs). Existing guards are unmodified.
9. **Context map.** On fixtures:
   - copies collapse, but every path stays listed;
   - `.cursor/rules/*.mdc` and `.worktrees` are found;
   - a drift badge appears and the diff opens;
   - outlines are present.
   The registry and sidebar are unchanged (history inventory test).
10. **Real-machine report** (reported, not asserted), with every line explained:
    - counts per slug state and per finding;
    - the 5 true-empty slugs;
    - the orphan list with its states;
    - dangling links (about 28) and unindexed files (about 18);
    - Air-Flo's context files collapsing;
    - the cold-scan duration and peak RSS, plus the warm duration.
11. **Honest wording.** The UI never says "unused", "stale" or "never used". It says "last written"
    or "unknown", with the caveat. Checked in QA.
12. **Suite.** `./verify.sh` exits 0 twice. The real-home check is **extended**: it covers every
    real `~/.claude/projects/*/memory` tree and every discovered context file, and records
    directories as well as files, so deleting an empty directory would show.
13. **Browser QA** against a temp-HOME QA server:
    - both views render;
    - the review queue works: Keep persists and resurfaces on a content change;
    - empty-dir bulk trash and restore;
    - a link-level index repair diff applied and then restored;
    - an orphan side-by-side view with a single-file trash and restore.

## Deferred to phase 2
- Orphan/duplicate **migration** (moving memory between dirs, merging indexes, rewriting links).
- Near-duplicate detection.
- Codex/Grok memory writes.

## Out of scope
- Editing memory bodies (the existing editor does this).
- Auto-running any cleanup.
- Atlas/VPS memory.

## Lanes
Orchestrator Opus · implementer Opus medium · Bounce: Astra (ran) · Grade: Astra or Fable,
whichever is available with no waiting · QA: /qa-tester.
