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
