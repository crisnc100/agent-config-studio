# Context — skill packaging + export

## What exists already (verified by exploration, 2026-09-22)

**Discovery is largely built.** `lib/registry.js:303-304` already scans `~/.claude/skills`
and `~/.codex/skills`; `skillEntry()` (registry.js:77-102) reads SKILL.md frontmatter and
collects companion files into `files:[{name,path,display,kind,size,mtime}]`. Exposed at
`GET /api/registry` and consumed once at boot into `S.registry.groups` (app.js:81) under
`claude-skills`, `codex-skills`, `plugin-skills`, `retired`. **Project-scoped skills are NOT
discovered** — that is genuinely new.

**Path safety is built and sufficient.** `resolveSafe()` (paths.js:48-64) expands `~`,
resolves to the nearest existing ancestor with `fs.realpathSync`, and checks the REAL path
against `SAFE_ROOTS` — so a symlink cannot escape a root. `isDenied()` blocks `.credentials.json`,
`auth.json`, `.git`, `node_modules` as path segments. Throws `{status:403|400}`.
`SAFE_ROOTS` = `~/.claude ~/.codex ~/Documents/Projects ~/.agents ~/.grok ~/.config/worktree`.

**The HTTP layer cannot return binary.** Everything matching `/api/*` is forced through
`json(res, 200, await handler())` (server.js:804-813). A download must bypass the ROUTES table
entirely, like `handleChat`/`handleEvents` do (server.js:796-802) with `(req,res)` handlers that
write their own headers. Such a handler must replicate the dispatcher's try/catch, because
`resolveSafe`'s `.status` errors are only turned into JSON responses by the dispatcher.

**Guards a-e are exclusively about spawning harness binaries.** A pure fs+zlib module that never
calls spawn/exec/execFile triggers none of them and needs no new guard entry. Path-escape
protection therefore has to be proven by a TEST, not by guards.mjs.

**No zip library, and the repo is contractually zero-dependency** (no `dependencies` key at all).
Node ships DEFLATE (`zlib.deflateRawSync`) but no ZIP container writer, and `zlib.crc32` is not
reliably present on Node 20. The container and CRC-32 must be hand-rolled.

**Frontend** is one 2581-line file, panels are an if-chain in `boot()` (app.js:79-107) keyed on
`location.hash`; `openTrash()` (app.js:1062-1107) is the template. `api()` (app.js:49-58) always
calls `res.json()` and cannot carry a download.

## What the data on this machine actually looks like (verified)

- **Global**: 29 skills at depth 2 under `~/.claude/skills`, PLUS 12 more inside
  `~/.claude/skills/synced/<uuid>/...` at depth 4 (216 files, 4.2MB — 3/4 of the tree).
  Discovery must not assume one-folder-per-skill.
- **`find-skills` is a BROKEN symlink** -> `~/.agents/skills/find-skills`, which does not exist.
  `~/.agents` is already a SAFE_ROOT, so the design is fine; the target is simply missing.
  Discovery must not crash, and the row must be visibly unexportable.
- **Name collisions are real**: `decision` x7; `investigate`, `handoff`, `code-review`, `build`,
  `advisor` x2 each. A zip keyed on `<name>/SKILL.md` silently overwrites.
- **`~/Documents/Projects`**: 28 `.claude/skills` dirs.
- **`~/Documents/Garman-Homes`**: 346 SKILL.md files but only **30 distinct names** — the kylie
  worktrees each carry the same 12. Naive listing floods the picker with ~29x duplicates.
  This tree is ALSO not currently a SAFE_ROOT.
- Full scan cost measured at 0.15s, so discovery breadth is not a performance concern.

## Decisions Cris made this session

- Bundle = whole skill folder (companion files included), because several skills break without them.
- Single download names the file `<skill-name>.md`; multi-select is a zip.
- Collisions: prefix by source ONLY when needed (`team-skills-bundle__decision/`), unique names stay clean.
- `synced/` skills are listed, named from their SKILL.md frontmatter rather than the UUID folder.
- Scan `~/Documents/Projects` AND `~/Documents/Garman-Homes`.
- Usage data (last invoked / count) comes from ~/.claude/projects transcripts: 1351 files, 1.1GB,
  invocations appear as `"skill":"<name>"`. Retire/delete is a later, confirmed, destructive action.
- Original ask was a MEMORY audit; he has only 3 memory files (~4KB), so that analysis moves to skills.
