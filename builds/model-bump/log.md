# Build log — model bump

- CLI checks before setting ids: `grok models` lists grok-4.7 (default) and grok-4.6; `codex debug models`
  lists gpt-6-sol; claude-opus-5-5 appears 41× in the installed Claude CLI (2.1.280) and in a cached
  session model in ~/.claude.json (no live call was made).
- Registry: opus claude-opus-5-5, sol gpt-6-sol, grok grok-4.7, grok-prev grok-4.6.
- CLAUDE.md: back in lint scope (LINT_DEFERRED removed). 10 edits by rewrite-claude-md.py, sha-guarded
  (8fd0c0ed… read, re-checked immediately before write). Pointer line to `model-id --table` added.
- settings.json: modelSettings key claude-opus-5 → claude-opus-5-5 (value kept); claude-fable-5 removed
  (claude-fable-5-1 exists). JSON checked equal to the intended result, key order unchanged.
- Skills: rewrite-skills.py (53 edits, 9 files), sha-guarded against the backup. Orchestrator decisions:
  gate order Fable → Astra high → NOT RUN; Opus advisor method and Opus gate fallback removed; builder
  lanes fixed (Sol/Opus co-default, Astra/Fable never build, no "legacy" Sol, Grok benched).
- Backup model-registry-2026-09-23T00-09-22-385Z: 11 files (2 unedited candidates dropped), finalized.
- Tests updated for the new defaults (never weakened): models-assist EXPECTED (Opus 5.5 · slower,
  Grok 4.7, Grok 4.6, grok default grok-4.7, default-dropped → claude-opus-5-5, grok turn → grok-4.7);
  one-edit proofs in models-assist / models / models-scripts / sidecars now bump to claude-opus-6 (the
  old target claude-opus-5-5 is the default now, so it proved nothing); the deferral test became
  "CLAUDE.md is linted again".
- Full diff of the live files: builds/model-bump/live-files.diff.
