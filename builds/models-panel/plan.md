# Plan — Models panel + "check for new models"  (phase 2, rev 2 after Fable Bounce)

## Outcome

ACS has a **Models** view. It shows every registry family, its current id, where that id comes
from, and where it is used, and it lets you change an id in place. Without being asked and at zero
token cost, ACS tells you when:
- a CLI offers a newer model in a family,
- a model you pin is being retired, or
- a model you pin is no longer offered.
It proposes the change; you accept or dismiss it. Nothing is ever applied automatically.

Cut from `main` after PR #7 (the bump) merges. The registry is then opus claude-opus-5-5, sol
gpt-6-sol and grok grok-4.7.

## Sources (verified 2026-09-22 against the real files)

Each CLI caches its catalog on disk. Reading these needs no spawn, no network and no credential.

- **Claude:** `~/.claude/cache/model-catalog/*-cc.json` → `catalog.config.models[]` with
  `{id, name, short_name, min_claude_code_version}`, plus `fetchedAt`/`staleAt`. If several files
  exist (one per login), the newest `fetchedAt` wins.
- **Codex:** `models_cache.json` in `~/.codex` **and every registered codex seat home**
  (lib/usage/seats.js); the newest `fetched_at` wins. Entries are `models[]` with
  `{slug, display_name, visibility, upgrade?{model, migration_markdown, retirement_at}}`.
  `gpt-5.5` has a real `upgrade`/`retirement_at` today.
- **Grok:** `~/.grok/models_cache.json` → `models{id:{info:{id,name,model_family,hidden}}}`. Age is
  taken from `renewed_at`, falling back to `fetched_at`.

**Projection rule.** Only `{vendor, id, displayName, family, hidden, minCliVersion, upgrade,
retirementAt, fetchedAt}` leaves `lib/models-catalog.js`. File paths, filenames, `identity`,
`auth_method`, `origin`, `etag`, `model_messages` and every other field stay inside it.

## Design

### Families and vendors
- A family's **vendor** comes from its current id's prefix: `claude-` → claude, `gpt-` → codex,
  `grok-` → grok.
- A family's **catalog family** comes from the catalog's own metadata:
  - Claude: `short_name` lowercased.
  - Codex: the slug's trailing word, but only if it is alphabetic. `gpt-5.5` → null. Hidden,
    `-latest` and `codex-*` slugs are excluded.
  - Grok: `grok-<ver>` → grok. Suffixed variants (`-build-fast`) and `info.hidden` are never proposed.
- A registry key matches the catalog family of the same name (opus ↔ Opus). **`grok-prev` is a
  pinned-previous family.** The registry gets an optional `"track": false` per family; `grok-prev`
  ships with it, and such families never get update proposals. They still get retirement and
  vanished alerts.

### Alerts, per family
1. **Update available.** Same vendor, same catalog family, and a newer version. Versions are parsed
   from the id as numeric segments (`claude-opus-5-10` → [5,10]; `gpt-6-sol` → [6]; `grok-4.7` →
   [4,7]) and compared numerically. An id that doesn't parse is never proposed.
   - For Claude, a candidate whose `min_claude_code_version` exceeds the installed `claude
     --version` is shown as "needs Claude Code ≥ X" and can't be accepted. The version comes from
     the harness's existing `readVersion` detection, which is already in the pinned harness spawn
     path; no new spawn.
2. **Retiring.** The current id carries `upgrade`/`retirement_at` in its catalog. The alert shows the
   date, the vendor's message and the suggested id. This can cross families.
3. **Vanished.** The current id is absent from a catalog that loaded fine.

### Detection triggers
- Detection runs at server start and on the view's "Check now" button, which re-reads the files.
- There is no timer. A timer re-reading files can't update an open tab without SSE, and it keeps
  test processes alive.
- The pending-alert count is included in the existing boot payload, so the badge shows without a
  click.
- Where-used is computed lazily when a row expands, never on the boot path.
- A dismissed alert stays dismissed per family and id (`~/.agent-config-studio/models-dismissed.json`)
  until a different candidate appears.

### Models view
- A footer-bar **Models** button (beside MCP and Trash in index.html:48-52), with a count badge.
- The view follows the `usage` view's pattern (app.js:331).
- Table: family · current id · display name · source (default | your override) · alerts.
- Expanding a row shows where-used: file:line, matched **only** on `model-id <family>` inside the
  lint scope (skills, configs, CLAUDE.md). Bare family words in prose are never matched.
- Edit id inline. It is shape-checked. A different vendor prefix from the current id needs explicit
  confirm; an id absent from that vendor's catalog shows a warning and needs confirm.
- "Reset to default" removes the override.
- Catalog ages are shown. When a catalog is older than 7 days, the view says "run `<cli>` once to
  refresh". A missing catalog shows a per-vendor note and never crashes the view.

### Writes
- An edit writes **only the changed key** into the user file's existing JSON. It never writes back
  the merged registry, and every other override (including `assist`) survives byte-for-byte.
- If the user file is malformed, edits are refused with the error shown. The user's file is never
  overwritten.
- Writes are atomic (temp + rename) and go through the shadow history repo
  (`history.recordBaseline`/`record`, as PUT /api/file does), so undo matches every other ACS
  edit. No new backup format.
- POST routes sit behind the existing same-origin gate, and ids are shape-checked server-side.

### Sidecars — computed from the single edit (old id → new id), never from the general stale scan
- `settings.json` `modelSettings["<old>"]`: the proposal is decided by Cris (see below). It is a
  positional text edit of only that key's region, leaving every other byte identical.
- `config.toml`: a top-level `model = "<old>"` line is proposed as `"<new>"`, and only that line
  changes.
- Both go through the same mtime conflict check as PUT /api/file (server.js:516-523), and both go
  through history.

## Acceptance criteria

1. **View renders.** A browser test clicks Models and sees every family with id, source and alerts.
   `/api/models` returns the same data. With a malformed user file, the view shows `registryError`,
   the defaults are served, edits are refused, and the server stays up.
2. **Detection fixtures (temp HOME, all three formats):**
   - `claude-opus-5-6` is proposed over `claude-opus-5-5`; `claude-opus-5` is not.
   - Numeric compare: `claude-opus-5-10` beats `-5-9`, and `x-5.10` beats `x-5.6`.
   - `grok-4.7-build-fast` and hidden grok models are never proposed.
   - `grok-prev` (`track:false`) is never proposed.
   - Codex hidden, `-latest`, `codex-*` and `gpt-5.5` (numeric trailing word) are never proposed.
   - An unparseable id is never proposed.
   - A Claude candidate above the installed CLI version is shown as not acceptable.
   - A Codex `upgrade`/`retirement_at` on a pinned id raises Retiring with date and suggestion.
   - A pinned id missing from the catalog raises Vanished.
   - Two Claude catalogs → the newer `fetchedAt` wins.
   - A newer seat-home Codex cache wins over `~/.codex`.
   - A missing catalog gives a per-vendor note; a stale catalog gives a stale note.
3. **Real-machine report.** This is a reported step, not a suite assertion. After the bump merges,
   the detector runs read-only on the real catalogs and prints the full alert list. Expected today:
   no updates, no retiring, no vanished, because every pinned id is current in its catalog. Every
   line of that list must be explained in the report.
4. **Nothing sensitive leaves the server.** Fixtures plant unique markers in `identity`,
   `auth_method`, `origin`, `etag` and `model_messages`, and in the catalog **filename**. No marker
   and no catalog file path appears in any response body.
5. **No new process spawns.** A new static guard scans `lib/models-catalog.js` and the models
   routes, with comments and strings stripped, for any `child_process`/`node:child_process`
   specifier, including dynamic `import()`. The Claude CLI version comes from existing detection.
   All existing guards pass unmodified.
6. **Edit round-trip.**
   - Editing opus in the view writes only `models.opus` into the user file. A pre-existing `assist`
     override and another family's override are byte-identical afterwards.
   - After the edit, `model-id opus` (temp HOME) and the running server's Assist picker change.
     History records the change, and Reset removes only that key.
   - Bad ids (`--x`, `a b`, 65 chars) → 400 with the file unchanged.
   - Changing the vendor prefix, or an id absent from the catalog, requires confirm.
7. **Alert flow.**
   - Accepting an update writes exactly what a manual edit writes.
   - Dismiss survives a server restart, and a different newer candidate un-hides.
   - The count badge shows after a restart with nothing clicked.
8. **Sidecars.**
   - After an opus change, the strip proposes the `modelSettings` action. Accept changes only that
     key's region: every other byte of `settings.json` is identical, and a top-level
     `"model": "<old>"` elsewhere in the file is untouched unless the user accepts it separately.
   - `config.toml` changes only its top-level `model =` line.
   - An external edit between proposal and Accept → refused as a conflict.
9. **Suite.** `./verify.sh` exits 0 with zero failures, twice, with a temp HOME everywhere. Real-file
   check: `~/.claude/settings.json`, `~/.codex/config.toml`, the three catalog files, and the
   existing real-home roots are byte-identical after the run.
10. **Browser QA.** /qa-tester runs criteria 1, 6 and 7 against a server **started with a temp HOME
    seeded with fixtures**, never the live HOME.

## Decision (settled 2026-09-22)
- `settings.json` `modelSettings` on a model change → **Copy**: add the new key with the same value and
  keep the old key. (Cris approved the bar without picking; this is the recommended default and can be
  revisited.)

## Out of scope
- Refreshing a CLI's catalog, which would mean spawning it.
- Web search, and any auto-apply.
- Editing skills (they already resolve through the registry).
- Atlas/VPS config.
- Adding new families (e.g. luna).

## Lanes
Orchestrator Opus · implementer Opus medium (UI-heavy; the Sol co-default is on the exhausted Pro
seat) · Bounce: Fable (ran) · Grade: Astra high, cross-family, if the Pro seat has reset, else
Fable (stated) · QA: /qa-tester.
