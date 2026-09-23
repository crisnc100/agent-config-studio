# Fix log — Grade round 1 (Astra, 8 of 15 FAIL)

Every fix below has a regression test that FAILS against the pre-fix code and passes after.
"Before" was proven by running the new tests against `git archive HEAD` (commit fe8b520) in a
scratch copy. For the swap probe, the old `readInSkill` was given only the `io` seam, with its
logic unchanged, so the fs double could reach it.

`./verify.sh`: exit 0 twice in a row, 1376 passed / 0 failed across 24 suites both times.
`tests/guards.mjs` and `package.json` unchanged.

## C1: dot-prefixed skill containers
- **Fix:** `scanSkillsDir` no longer skips every dot-name. It skips only `SKIP_DIRS`
  (`.git .hg .svn .cache __pycache__ node_modules`). `~/.codex/skills/.system/*` is now
  discovered: 6 real skills, and global-codex went from 10 to 16 rows.
- **Test:** skills.mjs `C1 a skill under ~/.codex/skills/.system is discovered`, and
  `C1 VCS and cache directories are still skipped`. Before: `FAIL … — []`.

## C2: injective bundle hash, with modes
- **Fix:** `bundleHash` is now sha256 over `JSON.stringify([{path, mode, sha256}])`.
- **Tests:** skills.mjs:
  - `C2 file a=\`x\0b\0y\` and files a=x,b=y are two rows, not one`. Before: collapsed, 1 alias.
  - `C2 a script differing only in its executable bit is a different bundle`. Before: `[["644","644"]]`, collapsed.
- **Real machine:** 132 rows, 519 aliases collapsed, garman-homes 63 rows (the handoff said 61).
  Unverified whether the +2 comes from mode-splitting or from machine drift since 2026-09-22.

## C3: display-name truncation
- **Fix:** `cleanName` truncates by grapheme (`Intl.Segmenter`) after `toWellFormed()`, then trims.
- **Tests:** export.mjs:
  - `C3 a 99-ASCII-plus-emoji frontmatter name downloads 200, not 500`. Before: `500 {"error":"URI malformed"}`.
  - `C3 truncation keeps a ZWJ sequence whole rather than splitting it`. Before: `"bbbb\ud83d"`.

## C4: depth and empty directories are explicit exclusions
- **Fix:** `listSkillFiles` pushes `{rel:'…/', reason:'deeper than the 8-level bundle limit'}` and
  `{rel:'…/', reason:'empty directory'}`. `buildSkillsZip` returns its Buffer with `.excluded`,
  prefixed by archive path. The export sends `x-skills-excluded: <count>`. A count and not
  names, because names in a header would be an injection surface; the names are on each row's
  `excluded` in /api/skills.
- **Limit not raised:** `BUNDLE_DEPTH` stays at 8. On the real machine no bundle exceeds it (the
  only real exclusion is 1 empty directory), so there is no reason to raise it.
- **Tests:** skills.mjs `C4 a subtree past the bundle depth limit is an explicit exclusion` and
  `C4 an empty directory is an explicit exclusion`. zip.mjs `C4 the archive result lists the
  too-deep subtree and the empty directory, by archive path`. export.mjs `C4 …and the response
  counts the names it refused to ship`. Before: `FAIL … — []` / header `null`.

## C5: collisions on NFC + case-folded extraction paths
- **Fix:** `pathKey()` is `NFC → toUpperCase → toLowerCase → NFC`, and it is used everywhere
  collisions are decided: `planSkillPrefixes`, `resolveArchivePaths`, `buildSkillsZip`'s
  directory records, and `buildZip`. `buildZip` now also keeps a `parents` set, so the
  file-versus-parent conflict is caught in either order (the P2 order-dependence).
- **Tests:** zip.mjs:
  - `C5 buildZip refuses \`café\` spelled NFC and NFD as two entries`
  - `C5 buildZip refuses \`a/b\` THEN file \`a\` — the order the old check missed`
  - `C5 unzip: both café skills survive extraction` / `C5 ditto: …`. Before: `1 files`, one
    skill overwrote the other.

## C6 / P1: containment anchored to the opened descriptor (the most important item)
- **Fix, in `readInSkill`:**
  1. no-follow walk;
  2. `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`;
  3. a SECOND no-follow walk AFTER the open, where every directory inode must match the first
     walk and the leaf must be the fd's own inode (`fstat`);
  4. `realpath` of the opened path must equal it and sit inside the skill directory;
  5. `isDenied` runs on that realpath.
- **Directory listings:** `listSkillFiles` lists a directory only between two walks that agree on
  its inode.
- **Root links:** `resolveSkillsRoot` lstat's each skills ROOT (the SOURCES roots and every
  project `.claude|.codex|.agents/skills`). If it is a link, it is realpath'd and must pass
  `resolveSafe(real, SKILL_ROOTS)`. If not, it becomes a broken row "skills root is a link that
  points outside the skill roots". All roots are real paths from there down.
- **Tests:** skills.mjs, using an injectable `io` (a Proxy over fs that swaps `sub/` for a link
  to an outside dir before the Nth fs call, then either leaves it or flips it back):
  - `C6 negative control: the pre-fix check-then-open reader DOES leak under this swap`. This
    passes, which proves the double reproduces Astra's attack.
  - `C6 an intermediate-directory swap before ANY of the reader's 10 fs calls leaks no outside
    byte`. After: 0 leaks. Before (old logic, seam only): `2 of 16 attempts leaked`.
  - `C6 …and through buildSkillsZip: no archive contains the outside sentinel`. Before:
    `2 leaking archives of 11 built`.
  - `C6 a read whose realpath is not the path walked is refused`: the deny check runs on the
    realpath.
  - `C6 a skills ROOT linked outside the skill roots yields no exportable row`. Before: an
    exportable row at `…/p-link/.claude/skills/leak`.
  - `C6 …and none of its bytes reached the listing`, and
    `C6 a skills root linked INSIDE the skill roots is still followed`.
- **Residual, stated in the code comment:** Node has no `openat()`, so an ANCESTOR of the skill
  directory being flipped back and forth several times within one read is not provably excluded.
  That attack needs write access above the skill root (the harness home or the project checkout).

## C10 / P1: limits enforced while reading
- **Fix:**
  - `readInSkill` reads in chunks against `min(8MB, budget.remaining)`, buffers at most cap+1
    bytes, then throws 413.
  - `buildSkillsZip` shares one budget across the whole archive, also checks the running total
    after every file, and its preflight counts directory records (`dirRecordCount`).
  - `assertSelectionFits` counts directory records too, and takes the per-file and per-bundle
    caps (`SKILL_LIMITS`).
  - The export no longer calls `listSkills()`. The new `resolveSkills(ids)` walks directories,
    matches only the selected ids and describes them from lstat metadata. Nothing is read or
    hashed before the preflight.
- **Tests:**
  - skills.mjs `C10 a 24-byte file read against a 4-byte budget is refused with 413` and
    `…after buffering at most budget + 1 bytes`. Before: 24 bytes read, no refusal.
  - zip.mjs `C10 a selection whose FILES fit the entry cap but whose directory records do not is
    refused` and `…before a single file was read`. Before: `5 reads`.
  - zip.mjs `C10 a file that grew past the cap after discovery is refused with 413` and
    `…having buffered no more than the cap + 1 byte`.
  - export.mjs `C10 an oversized selection answers 413, not 409`, using a sparse 65MB companion.
    Before: `409 {"error":"skill cannot be exported: bundle is larger than the size cap"}`.
  - export.mjs `C10 the export handler resolves only the selected ids — it never calls listSkills()`.
- **Changed expectation:** export.mjs `a selection inside the caps passes` asserted
  `entries === 5`, which is the files-only count the Grade flagged. It now asserts 6: 5 files
  plus their one directory record. That is a fix, not a weakening. The comment in the test says so.

## C14: the real-home tripwire proves what it claims
- **Fix:** consolidated onto `tests/real-home.mjs`. `tests/real-homes.mjs` is deleted and its
  coverage moved over, none of it dropped. The file is now both the verify.sh CLI and the module
  the four skill suites import.
  - **By sha256:** every file under `~/.agent-config-studio`, `~/.claude/skills`,
    `~/.codex/skills` and `~/.agents`; every project skill tree under `~/Documents/Projects` and
    `~/Documents/Garman-Homes`, found as discovery finds them; the loose files atop both project
    roots; and the pinned files `settings.json`, `CLAUDE.md`, `config.toml` and `AGENTS.md`.
    `seats.json` and `accounts.json` are covered by the `~/.agent-config-studio` tree.
  - **By entry names only:** `~/.claude`, `~/.codex`, `~/.grok`, and both project roots two levels
    deep. The second level replaces the old per-entry mtime print, since a directory's mtime
    moves exactly when its children's names do.
  - **CLI catalogs:** the existing stamp and rewrite rule, unchanged.
- **Assertion text:** content lines say "byte-identical (sha256)". Name lines say "entry names
  unchanged (contents not compared)".
- **Class rule:** `TRANSIENT = /(-wal|-shm|-journal)$|\.tmp/`, ignored in the name-set check only.
  The comment names its evidence: `~/.codex` carries six SQLite siblings, and a 20-second sample
  on 2026-09-23 saw no churn.
- **Test:** skills.mjs `C14 tripwire …`. It runs `real-home.mjs save/check` against a scratch
  HOME:
  - it FAILS on a nested edit with the same size and mtime (skills, project and Garman trees);
  - it FAILS on an in-place pinned-file edit and on a new name in a live home;
  - it passes on `-wal`/`-shm`/`.tmp` siblings and on an unpinned append.
- **Before:** the old tripwire, handed a same-size, same-mtime edit of `~/.codex/config.toml`,
  printed `ok the files this app can edit are byte-for-byte untouched`.

## P2: cross-origin GET gate
- **Fix:** the new `strictSameOrigin(req)` is used by `/api/skills/export` and `GET /api/skills`.
  It passes `same-origin`, `none`, or an absent header (non-browser), and in each case any Origin
  must match Host. `same-site` (another localhost port) and `cross-site` are refused. The global
  non-GET `sameOriginRequest` is untouched.
- **Changed expectation:** export.mjs previously asserted `GET /api/skills` answers a cross-site
  request with 200 ("global GET exemption is unchanged"). That test encoded the bug. It now
  asserts 403 for cross-site, for same-site with no Origin, and for another port's Origin, and
  200 for same-origin. The "global GET policy is otherwise unchanged" contrast moved to
  `GET /api/harnesses`, which still answers a cross-site request with 200.
- **Tests:** export.mjs `P2 Sec-Fetch-Site: same-site with NO Origin is refused`, and
  `P2 GET /api/skills refuses …` ×3. Before: 200.

## P2: Content-Disposition filename*
- **Fix:** `isDeviceName` checks the stem before the first dot. It applies to the exact name
  before `filename*` is built, and to the ASCII fallback.
- **Tests:** export.mjs `P2 a reserved name gets NO filename* restoring it` and
  `P2 a skill named CON downloads as skill.md`. Before: `filename*=UTF-8''CON.md`, and
  `con.notes` came through as `con.notes.md`.

## P2: usage matched on the frontmatter name
- **Fix:** `attachUsage` looks up `displayName` first, then the dir `name`. Rows share a count
  when they resolve to the same key.
- **Test:** skill-usage.mjs `P2 a renamed synced dir is matched on its frontmatter name, not its
  folder`, using `synced/<uuid>/x7f3` whose frontmatter name is `dumb-down`. Before:
  `observed:false, count:null`.

# Fix log — re-grade round (Astra, builds/skill-export/regrade.md, 6 of 8 FAIL)

Cris decided the three disputed criteria on 2026-09-23; the fixes follow those decisions.

## C6 — repeated in-skill swap: ACCEPTED LIMIT (Cris, 2026-09-23)
- Not chased further. The comment at `readInSkill` was wrong: it said the residual race needed
  access ABOVE the skill root. It now says what Astra showed: a repeated swap needs only write
  access to a subdirectory INSIDE the skill. Closing it needs openat, and Node on macOS has none.
  The limit is recorded under criterion 6 in plan.md.
- The "realpath deny" test did not isolate the deny check: equality failed first. The deny check
  now runs on the realpath BEFORE the equality and containment comparisons, and a protected hit
  is tagged `reason:'protected'`. Tests in skills.mjs:
  - `C6 a read whose REALPATH is protected is refused BY THE DENY CHECK (lexical path is not protected)`
    asserts `reason === 'protected'`;
  - `C6 …while an unprotected outside realpath is refused by containment, not deny` is the contrast
    showing the two checks are distinct.

## C2 / C4 — complete archives (Cris, 2026-09-23)
- **Depth:** `BUNDLE_DEPTH` is now 32. A bundle deeper than that is REFUSED whole: a broken row
  whose reason reads "bundle is deeper than the 32-level limit (at …); refusing to export it
  partially". The export answers 409 with that message.
- **Empty directories:** they are part of the bundle (`emptyDirs`, with mode). They enter
  `bundleHash` and are written as ZIP directory records with their own mode. They go through the
  same path resolution as files, so an empty `Foo/` and a file `foo` are de-conflicted.
- **Only exclusions left:** links, protected names and non-regular files, which containment
  refuses by design.
- **Tests that asserted the omissions were REPLACED with tests asserting recovery.** This is not a
  weakening: the old tests encoded the Grade's C4 defect.
  - zip.mjs `C4 unzip|ditto: the recovered tree is identical to the source — paths, bytes, modes,
    empty dirs, the 20-deep file`, plus `…the empty directories are really empty` and `…an empty
    directory keeps its mode` (0700).
  - zip.mjs `C4 a 33-deep bundle is refused whole: broken, no files`.
  - skills.mjs `C4 a file 20 directories down is part of the bundle`,
    `C4 an empty directory is part of the bundle, not an exclusion`, and
    `C4 a bundle 33 directories deep is refused whole: broken, with the reason`.
  - export.mjs `C4 a 33-deep skill is refused, not exported partially` (409) and
    `C4 …with a message that says why`.
  - skills.mjs `C2 bundles differing only in a companion 10 directories down are two rows`
    (Astra's C2 probe).

## C14 — criterion reworded (Cris, 2026-09-23)
- plan.md criterion 14 now reads: "Every tree ACS reads or writes is compared by sha256; the live
  agent homes ~/.claude, ~/.codex, ~/.grok are compared by entry names, and the assertion says so."
- **More sha256 coverage:** `~/.claude/{hooks,agents,commands,skills_retired}` and `~/.codex/rules`
  (listed in lib/registry.js and lib/mutate.js), plus the single files ACS lists or edits:
  - `~/.claude/{settings.json, settings.local.json, CLAUDE.md, advisor-config.json, investigate-config.json, review-config.json}`
  - `~/.codex/{config.toml, AGENTS.md}`
  - `~/.grok/AGENTS.md`
- **Directories** are recorded in the snapshot, so an empty directory added under
  `~/.agent-config-studio` shows.
- **Ignore rule narrowed** to two anchored whole-suffix shapes:
  `/\.(sqlite3?|db)-(wal|shm|journal)$|.\.tmp(\.[A-Za-z0-9]+)?$/`. The SQLite part is anchored to
  a database name because `notes-wal` must count; the evidence is that the six `~/.codex` siblings
  are all `<name>.sqlite-wal|-shm`.
- **Tests:** skills.mjs `C14 tripwire FAILS on a persistent name that merely CONTAINS .tmp
  (important.tmpbackup)`, `…ENDS in -wal without being a database sibling (notes-wal)`, `…an
  empty directory appearing under ~/.agent-config-studio`, and `…an in-place edit of
  ~/.grok/AGENTS.md`.

## C10 — per-bundle cap enforced during reading
- **Fix:**
  - `ZIP_LIMITS.maxBundleBytes` is 64 MiB, and `lib/skills.js` takes its cap from it.
  - `buildSkillsZip` hands each read a budget of `min(selection left, bundle left)` and checks both
    running totals after every file. Its preflight also checks recorded bundle size.
  - `listSkills` hashing reads against a 64 MiB budget too.
- **Test:** zip.mjs `C10 a 75MB bundle whose metadata said a few bytes is refused with 413 at the
  64MiB bundle cap` and `…having buffered no more than the bundle cap + 1 byte`. This is Astra's
  stale-metadata probe: 10 sparse 7.5MB files recorded as 1 byte each.

## P2 — Content-Disposition bounded by bytes
- **Fix:** `cleanName` keeps at most 100 graphemes AND at most 600 percent-encoded bytes, cut on
  grapheme boundaries. A grapheme over the budget by itself is dropped. `contentDisposition`
  refuses anything over `MAX_HEADER_BYTES` (1024).
- **Tests:** export.mjs:
  - `P2 Content-Disposition stays within 1024 bytes for every oversized name`;
  - `P2 …a grapheme that alone exceeds the budget is dropped, not cut`;
  - `P2 a name of a + 10,000 combining accents downloads 200 through a Node HTTP client`, which
    uses `node:http.get`, the client that hit HPE_HEADER_OVERFLOW;
  - `P2 …with a Content-Disposition under 1KB`.

## Found while proving the tripwire: silent no-op on a linked path
- `tests/real-home.mjs` decided whether it was run directly by comparing an unresolved `argv[1]`
  with the resolved `import.meta.url`. Invoked through a linked path (`/var` → `/private/var`), it
  skipped the whole check and exited 0. verify.sh was unaffected, since it runs from the repo path,
  which is not linked. Both sides are now compared by realpath.
- Probe: a `check` through `$TMPDIR` now prints `FAIL entry names changed: ~/.codex:
  +important.tmpbackup`. Before, it printed nothing and exited 0.

`./verify.sh` for this round: exit 0 twice in a row, 1406 passed / 0 failed across 24 suites both
times.
