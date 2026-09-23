# Plan — one model registry, every skill points at it  (rev 2, after Grok 4.7 Bounce)

## Outcome

A model ID lives in exactly one file. Skills, skill scripts, skill configs and the ACS Assist
picker resolve models by **family name** through that file, so a release (Opus 5.5, Grok 4.7) is a
one-line registry edit — and a lint proves no raw ID has crept back into any in-scope file.

Phase 1 of 2. Phase 2 (the "check for new models" button + daily check) builds on this afterwards.

## Design

### Registry = family → id. Nothing else.
The Bounce showed roles-with-effort cannot be behavior-neutral: the same id runs at medium, high
and xhigh across call sites, and the two skill trees disagree. So **effort is policy and stays at the
call site as a literal**; the registry only answers "which id is current Opus?".

- `models.default.json` (ACS repo) — shipped defaults; a fresh machine works with no user file.
- `~/.agent-config-studio/models.json` — user overrides, **per key merge** (a file setting only
  `opus` keeps every other default). Unknown keys → error, not silent no-op.

```json
{ "version": 1,
  "models": { "fable": "claude-fable-5-1", "opus": "claude-opus-5", "sonnet": "claude-sonnet-5",
              "haiku": "claude-haiku-4-5-20251001", "astra": "gpt-6-astra", "sol": "gpt-5.6-sol",
              "terra": "gpt-5.6-terra", "grok": "grok-4.6", "grok-prev": "grok-4.5" },
  "assist": {
    "claude": { "default": "sonnet", "picker": [
      { "model": "sonnet", "note": "fast" }, { "model": "opus", "note": "slower" },
      { "model": "haiku" }, { "model": "fable", "note": "judgment, ~$0.60/turn", "effort": "high" } ] },
    "grok":   { "default": "grok", "picker": [ { "model": "grok" }, { "model": "grok-prev" } ] } } }
```
Initial values = today's values (behavior-neutral). Picker labels are derived from the id
(`claude-sonnet-5` → "Sonnet 5 · fast"), so the text and order match today exactly.
Deliberate, stated changes: Assist Fable `claude-fable-5` → `claude-fable-5-1`, with saved picker
selections of the old id migrated to the new one (not silently reset to Sonnet).

### Resolver — `bin/model-id` (zero-dep Node, `#!/usr/bin/env node`)
- `model-id <family>` → id. `model-id <raw-id>` → passes through unchanged (so `REVIEW_MODEL=gpt-5.6-sol`
  and existing config values keep working).
- **Failure never yields an empty string.** Unknown family / malformed registry → exit 1, error on
  stderr, and stdout prints `MODEL-ID-UNRESOLVED-<name>` — an id every CLI rejects loudly, so an
  unchecked `$(model-id x)` can never fall through to a CLI's own default (e.g. `-m ""` → Codex's
  config.toml model).
- Reads `$HOME` (not `os.userInfo()`); imports only `lib/models.js`, never `lib/harness.js`.
- `--json` (merged registry), `--table` (family → id), `--lint [paths]`, `--sidecars` (below).
- Installed as `~/.local/bin/model-id` → symlink into the **trunk** checkout (stable), never a worktree.

### Skills — rewrite rules (per-file behavior-neutral; the two trees are NOT reconciled)
1. Shell lines: `--model "$(model-id fable)"`, `-m "$(model-id astra)" -c model_reasoning_effort=medium`
   — effort literal unchanged from what that exact line has today.
2. `.mjs` scripts: raw-id defaults become `resolve('opus')` via `lib`-free exec of `model-id`
   (or reading the registry JSON directly). **`claudeModel: 'sonnet'` is a team-mode sentinel and is
   NOT resolved** — the `!== 'sonnet'` branches in review.mjs:318, review-loop-claude.mjs:23/79/183
   behave identically. Substring effort inference (`includes('fable')`) is preserved.
3. Model-proof checks (advisor `modelUsage` must include fable) become executable:
   `jq -e --arg m "$(model-id fable)" '.modelUsage | has($m)'` — never a comment or prose literal.
4. Prose names families (Fable, Opus, Astra, Sol, Grok), never ids or versioned names. Agent-tool
   short names (`model: opus`) are Claude Code aliases, not ids — unchanged.
5. Skill configs: model-valued keys hold a family (`"codexModel": "astra"`); `_help` / `_presets`
   text rewritten to point at the registry instead of telling the user to edit the id there.
6. CLAUDE.md lanes section: policy text kept verbatim except versioned names → families; a line
   points at `model-id --table` for the current ids.

### Sidecars — files the registry cannot own
`~/.claude/settings.json` (`model`, `modelSettings` keyed by id) and `~/.codex/config.toml` (`model`)
are CLI-owned. `model-id --sidecars` reports every id there that is not a current registry value
(e.g. `modelSettings["claude-opus-5"]` after a bump). Reported, not rewritten — Phase 2's updater
proposes those edits alongside the registry change.

### Lint — `model-id --lint`
Fails on raw ids (`claude-(opus|sonnet|fable|haiku)-…`, `gpt-\d…`, `grok-\d…`) and versioned names
(`(Fable|Opus|Sonnet|Haiku) \d`, `GPT-\d`, `Grok \d`) in: `~/.claude/skills`, `~/.codex/skills`
(excluding `.system/`, `synced/`, `*.bak*`, `skills_retired/`), `~/.claude/CLAUDE.md`, the three skill
configs, any `.claude/review-config.json` under `~/Documents/Projects`. ACS's own `lib/`, `public/`,
`server.js` are covered by a test, not the user-facing lint. Allowed: the registry files only.

### ACS Assist
- Registry read **per request** (not snapshotted at import — `lib/chat.js:18-19` constants go), so an
  edit shows up without restarting the server.
- Malformed/invalid user file → ACS still starts, uses shipped defaults, and `/api/harnesses` carries
  a visible `registryError` the UI shows. Never a crash at import.
- Every id passes `^[a-z0-9][a-z0-9.\-]{0,63}$` before entering the allowlist; a bad id is dropped with
  a reason. If the default is dropped, default = first surviving picker entry; if none survive, the
  shipped defaults are used. `server.js:138-142` validates the chosen default against the allowlist.
- `lib/assist.js:98`, `public/app.js:1750` hardcoded defaults come from the harness.

## Acceptance criteria

1. **Call-site manifest, before/after.** Before any edit, a script captures every model-bearing line
   in scope into `builds/model-registry/callsites.before.json` (file, line, the model id, effort flag).
   After, each site renders (with `model-id` substituted) to the same id + same effort. Count of sites
   before = after + zero unexplained. The only diffs allowed are the two stated changes.
2. **Scripts resolve the same.** For review.mjs, review-loop.mjs, review-loop-claude.mjs: the resolved
   codex model, codex effort, verifier model + effort, and the **full lens list (model + effort per
   lens)** are identical before/after, with the live configs and with no configs.
3. **Resolver contract.** Every family resolves; raw ids pass through; partial user file merges per
   key; unknown key in user file → error; malformed file → exit 1 + `MODEL-ID-UNRESOLVED-*` on stdout;
   `$HOME` honored; runs from a non-interactive `/bin/sh -c` with a minimal PATH.
4. **One-edit proof.** Temp HOME, set `opus` → `claude-opus-5-5` in the user file only: `model-id opus`,
   the review scripts' verifier + opus lens, and `/api/harnesses` on an **already-running** server all
   show the new id; `--sidecars` flags `settings.json`'s `claude-opus-5` entry.
5. **Assist safety.** Planted ids `--help`, `a b`, `x;rm`, 65-char → each rejected with a reason, never in
   spawn argv, server returns 200 on `/api/harnesses` and a turn with the default still works;
   default-dropped and all-dropped cases covered. All existing guards pass unmodified.
6. **Fresh machine + broken file.** No user file → Assist offers today's exact labels, order, default.
   Malformed user file → server starts, `registryError` present, defaults served.
7. **Lint.** Exit 0 over full scope after refactor. Planting a raw id, a versioned name, and a raw id
   in a project `.claude/review-config.json` each → non-zero, naming file:line.
8. **Backup is restorable.** Backup dir holds every edited non-git file + `manifest.json` (path, sha256
   before, sha256 after) + `restore.sh`; a test restores into a temp copy and checksums match "before".
9. **Suite.** `./verify.sh` exit 0, zero failures, twice; tests use a temp HOME and assert the real
   `~/.agent-config-studio`, `~/.claude/skills`, `~/.codex/skills` are byte-identical after the run.

## Surfaced, not fixed (Cris's call)
- `~/.codex/config.toml` model is `gpt-5.6-sol`, but CLAUDE.md says bare `codex exec` resolves to Astra.
- The Claude and Codex skill trees disagree (e.g. Codex advisor degrades to Sol xhigh; Claude advisor
  config is Astra). Preserved as-is.
- Opus 5.5 (`claude-opus-5-5`) is in the local Claude catalog; `grok-4.7` in `grok models`; after
  Cris's CLI update the Codex picker lists `gpt-6-sol` and `gpt-6-luna`. The bump is the follow-up diff.

## Lanes
Orchestrator Opus 5.5 · implementer Opus subagent · Bounce ran on `grok-4.7` · Grade: `grok-4.7`
(never `grok-4.7-build-fast` — Cris, 2026-09-22).
