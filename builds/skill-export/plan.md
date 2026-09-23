# Plan v2 — skill packaging + export (Bounce folded in)

## Outcome

In Agent Config Studio, Cris sees every skill on his machine in one list, selects any subset,
and downloads them — one skill as a readable `<skill-name>.md`, several as a `.zip` a recipient
can drop into a skills directory. Each row also shows how often that skill NAME appears in
Claude Code transcripts and when it was last seen, as a usage signal.

## What the Bounce changed (all adopted)

- **B1 contradiction:** `resolveSafe()` hardcodes `SAFE_ROOTS`, so a separate `SKILL_ROOTS`
  list could never work — every Garman-Homes read would 403. FIX: `resolveSafe(input, roots)`
  gains an OPTIONAL roots argument defaulting to `SAFE_ROOTS`. The skills module passes its own
  read-only root list. No existing caller changes, and no other route gains reach.
- **B2 the real boundary:** "inside an allowed root" is far too weak — a companion symlink to
  `~/Documents/Projects/other/.env` satisfies it. FIX: a bundled file must resolve INSIDE THE
  SKILL'S OWN DIRECTORY. That is the containment rule; roots are a second, outer check.
- **B3 reads happen at discovery too** (frontmatter, hashing), before any export check. FIX: the
  containment rule is enforced in ONE reader used by discovery, hashing, single-md and zip alike.
- **B4 TOCTOU:** realpath-then-open leaves a window. FIX: refuse symlinks anywhere inside a skill
  folder outright, and open with a descriptor whose realpath is re-checked. A skill that is itself
  a symlink (find-skills) is allowed at the ROOT only, resolved once.
- **B5/B6 `unzip -t` proves almost nothing.** FIX: extract with TWO independent readers — system
  `unzip` AND macOS `ditto -x -k` — then compare recovered paths and bytes against the source.
  Explicit format contract: UTF-8 flag (bit 11), byte lengths not string lengths, matching
  local/central metadata, valid DOS date, version fields, Unix mode bits for executables.
- **B7/B8 name safety and uniqueness:** reject/encode `..`, absolute, backslash, colon, NUL and
  control characters, trailing dots/spaces, and device names. Then assert EVERY final extraction
  path in a selection is unique; a residual clash gets a numeric suffix rather than silently
  overwriting. Proven over a large adversarial selection, not two rows.
- **B9 duplicate collapse** hashes the WHOLE bundle (relative paths + contents), not just SKILL.md.
- **B12/B13 the usage number is weaker than it sounded** — a `"skill":"x"` string match cannot
  prove an invocation, cannot tell seven `decision` copies apart, and cannot see Codex or Grok.
  FIX: the feature ships as an explicitly NAME-LEVEL, Claude-Code-only signal, labelled as such in
  the UI, and "never seen" is never rendered as "safe to delete".
- **B17 retirement is cut from this build** (see Out of scope).
- **B18 isolation:** the untouched-real-files assertion covers `~/.claude`, `~/.codex`, `~/.grok`,
  `~/.agent-config-studio`, `~/.agents`, `~/Documents/Projects` and `~/Documents/Garman-Homes`,
  and HOME is redirected BEFORE any import because lib/paths.js binds it at module load.

## Out of scope (deliberate)

- **Retire/delete.** It mutates repositories, contradicts the read-only access model, and — until
  usage can be attributed to a SPECIFIC copy rather than a name — the data cannot justify the
  recommendation it would be making. Revisit once export ships and the signal is trusted.
- Memory-file auditing (only 3 files exist, ~4KB).
- ZIP64, encryption, and archives above the size cap: refused with a clear error, not handled.

## Acceptance criteria

1. `GET /api/skills` lists global (including `synced/<uuid>/` at depth 4), `~/Documents/Projects`
   and `~/Documents/Garman-Homes` skills, each labelled by source. The broken `find-skills`
   symlink appears as `broken:true` and the request does not throw.
2. Garman-Homes duplicates collapse by BUNDLE hash, not by name. Measured on the real machine:
   346 SKILL.md -> 61 rows with 504 aliases collapsed. The '~30' in v2 of this plan was wrong —
   it was derived from distinct NAMES, but several kylie worktree copies genuinely differ in their
   companion files and must stay separate, which is the rule working. The criterion is: identical
   bundles collapse to one row carrying aliases, differing bundles stay distinct rows.
3. One skill downloads as `<skill-name>.md`, never `SKILL.md`, frontmatter intact.
4. Several download as a zip that BOTH `unzip` and `ditto -x -k` extract, with recovered paths and
   bytes identical to source, companion files and executable bits preserved.
5. Every final extraction path in a selection is unique — asserted across an adversarial selection
   containing all seven `decision` skills plus a skill literally named `global__decision`.
6. A symlink inside a skill folder pointing anywhere outside that skill's own directory is excluded
   at DISCOVERY, at hash, at single-md and from the zip — four injection tests, one per read path.
   Targets include `~/.ssh/id_rsa`, `~/.claude/.credentials.json`, and a sibling project's `.env`.
   **Accepted limit (Cris, 2026-09-23):** a REPEATED swap of a subdirectory inside the skill —
   link for the open and the leaf stats, real directory for the directory stats and the realpath —
   passes every post-open check. It needs only write access to a subdirectory INSIDE the skill,
   and closing it needs a descriptor-relative walk (openat per component), which Node on macOS
   does not have. Documented at `readInSkill` in lib/skills.js; not pursued further.
7. Adding the skills root list does NOT widen any existing route: `GET /api/file` still 403s on a
   Garman-Homes path after this change. Asserted.
8. Client sends only opaque ids; the NEW endpoints accept no filesystem path. Asserted.
9. Malformed archive-entry names (`..\x`, `C:\x`, NUL, control chars, trailing dot/space) are
   rejected, and rejection never merges two distinct names into one.
10. Over-cap selections refuse with 413 before buffering; repeated ids, unknown ids and mixed
    valid/invalid ids all behave predictably.
11. Usage counts match a fixture corpus exactly, including NEGATIVE fixtures (the string appearing
    in prose or a tool result must NOT count). The UI labels it name-level and Claude-only.
12. A warm usage read of the real 1.1GB corpus completes without loading a whole file into memory
    and without exhausting file descriptors; cold and warm timings both reported.
13. `./verify.sh` passes in full; new suites registered; guards untouched and still passing.
14. Every tree ACS reads or writes is compared by sha256; the live agent homes ~/.claude, ~/.codex,
    ~/.grok are compared by entry names, and the assertion says so (Cris, 2026-09-23).
    Stated exclusions from sha256, because live processes write them continuously:
    ~/.claude/projects (the transcript corpus), ~/.claude/plugins, ~/.grok beyond AGENTS.md, and
    the project checkouts under ~/Documents/Projects. The checkouts are covered by entry names two
    levels deep plus sha256 of their skill trees (orchestrator, 2026-09-23, per Cris's intent).
15. `package.json` still has no `dependencies`.
