# Build log — model registry

- Baseline `./verify.sh` exit 0 (needs sandbox off: tests listen on 127.0.0.1).
- There is no `/api/harnesses` route today; the harness payload rides `/api/registry`. Criterion 4/6 name
  `/api/harnesses`, so it is added as a read-only route returning the same payload + `registryError`, and
  `/api/registry` carries `registryError` too (the UI reads that one).
- Install (orchestrator decision, overrides plan's "symlink into trunk"): `acs install-model-id` copies the
  resolver into `~/.agent-config-studio/resolver/` and writes a POSIX-sh launcher at
  `~/.agent-config-studio/bin/model-id`; `~/.local/bin/model-id` symlinks to the launcher. Reason for the
  launcher: node lives in /usr/local/bin, so `#!/usr/bin/env node` alone fails under PATH=/usr/bin:/bin.
  The launcher pins the absolute node that ran the install, falls back to `command -v node`, and if
  neither exists prints `MODEL-ID-UNRESOLVED-<name>` + exit 1 (never an empty string).
- `~/.claude/skills/find-skills` is a symlink out of scope (`~/.agents`, target missing); lint and
  capture do not follow symlinks.
- 19:25 CLAUDE.md was rewritten mid-build to post-bump lanes (gpt-6-sol, claude-opus-5-5). Called back
  to the orchestrator; Phase A/B/C proceed, CLAUDE.md waits for the answer.
- callsites.before.json is the capture from 19:3x, before lib/harness.js was edited (its `assist` and
  `acs` sections are the pre-refactor picker). A re-capture right before the skill rewrite showed every
  in-scope file byte-identical to it, so the original was kept.
- Backup: /Users/cortega/.agent-config-studio/backups/model-registry-2026-09-22T23-39-19-928Z (24 files incl. CLAUDE.md); every sha256Before equals the callsites.before.json hash.
- DEVIATION (orchestrator-approved): ~/.claude/CLAUDE.md is out of this build — not edited (no pointer
  line either), dropped from the lint scope (`LINT_DEFERRED` in lib/models.js; `--lint` prints a
  "NOT linted" line for it, and an explicit path to it is still linted), and dropped from the backup
  manifest so restore.sh can never overwrite the lanes edit made after the backup. The bump diff rewrites
  it to families and removes the deferral. compare.mjs reports it as EXTERNAL (changed during the build,
  not by it).
- Skill writes: the backup/baseline was taken seconds before rewrite-skills.py ran; every backup
  sha256Before equals the callsites.before.json hash, and rewrite-skills.py aborts on any count mismatch,
  so no concurrently edited file was overwritten.
- Launcher node pin: pins the install-time node (/usr/local/bin/node here); if that path is missing it
  uses `command -v node`; with no node at all it prints MODEL-ID-UNRESOLVED-<name>, exit 1. Tested in
  tests/models.mjs by repointing the pin at /opt/homebrew/bin/node-not-here. Re-run `acs install-model-id`
  after moving node or pulling registry changes (the install is a copy).
- `sonnet` as a Claude Code alias is never resolved (review team lenses, fixer default); any other
  claudeModel value now resolves through the registry, so a family name works where an id did.
- Launcher order (orchestrator request): pinned node → `command -v node` → /opt/homebrew/bin/node → MODEL-ID-UNRESOLVED-<name>, exit 1. MODEL_ID_BREW_NODE overrides the Homebrew path, for the test only.
- Grade fixes 1–4 (Cris-approved):
  1. model-id is on PATH only via .zshrc, so a non-interactive shell got `-m ""`. Every skill
     substitution is now `"$(model-id X || echo MODEL-ID-UNRESOLVED-X)"` (44 in 11 files,
     rewrite-fallback.py, counts asserted). Fresh backup model-registry-2026-09-22T23-59-06-643Z; every
     sha256Before equalled the previous sha256After. `--lint` now fails on a substitution with no `||`.
     When model-id IS found but fails, stdout carries two UNRESOLVED lines — still an id every CLI rejects.
  2. assist now merges per field within a harness (picker replaces as a list; default replaces;
     retired merges per key). Supersedes the earlier "per harness" note.
  3. README documents `acs install-model-id`.
  4. Removed builds/model-registry/__pycache__ (unstaged), grade-diff.patch, grade-skills.patch;
     .gitignore gains __pycache__/.
