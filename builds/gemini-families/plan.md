# Adopt a catalog model as a family (usage PR D) — plan

Goal: from the Models page, Cris adds a model from Antigravity's catalog as a new family, the way `neon` exists today
(e.g. Gemini 4 Argon → `argon`). It then resolves through model-id, can be put in roles, and runs through agy. Only
`gemini-` ids from agy's catalog are offered (decisions.md: never Opus or GPT-OSS through Antigravity).

Branch `gemini-families`, stacked on `gemini-models` (PR C, #107: the Antigravity list in
~/.agent-config-studio/cache/agy-models.json). One PR: the registry change has no use without adoption, and adoption
needs it.

Revised after the advisor gate (advisor.out, adopted in full by the orchestrator 2026-11-20). Cut from the first draft:
the flavor write at adoption, the `harness`/`from` keys, the name form, the effort picker change, the shadowed state
and newer-version handling.

## What the code does today (read 2026-11-20)
- `models.default.json` holds the family list. `~/.agent-config-studio/models.json` may only override ids of shipped
  families. checkShape (lib/models.js) refuses an unknown family or key, and then loadRegistry returns `error` and
  model-id refuses every family. A new family can never go there.
- The installed resolver is a copy (`acs install-model-id` → ~/.agent-config-studio/resolver/). ask-model imports
  its lib/. The review gate resolves through `model-id --role <r> --json` and `model-id <family>`, picks the CLI from
  the id prefix (review.mjs:475), and accepts family names matching `/^[a-z]+(-prev)?$/` (review.mjs:449).
- roles.json and paused.json are checked against the shipped family list:
  - lib/roles.js:258 and :373; lib/pause.js:21;
  - lib/models-panel.js set/reset and server.js knownFamily do the same.
  An unknown family anywhere in roles.json (a role or a flavor, lib/roles.js:154) refuses the whole file.
- resolverStale (lib/roles-panel.js:64) compares the installed lib/roles.js to the shipped one. Writes are refused
  while it is stale:
  - every version-2 roles.json write (roles-panel.js:129);
  - every pause (pause.js:132).
- agy families cannot build: acs-agent refuses a non-claude/codex/grok id (lib/agent.js:491).

## Design

### families.json
`~/.agent-config-studio/families.json`:
```json
{ "version": 1, "families": { "argon": { "id": "gemini-4-argon", "addedAt": "2026-11-21T…Z" } } }
```
- Its own file: today's resolver and studio never open it, so adding a family changes nothing for them until a role,
  flavor or pause names it.
- lib/models.js (standalone, copied by install) reads it in loadRegistry. The file's stat is part of the cache key,
  so a running studio sees an adoption at once. Readable entries are merged into `registry.models`.
- Beside `registry` and `defaults`, loadRegistry returns:
  - `userFamilies` (name → entry);
  - `familiesHidden` (name → reason);
  - `familiesError`.
  They are not inside `registry`, so `model-id --json` (which spreads it) gains no key.
- Entry rules. An entry that breaks one is hidden with its reason, never fatal, and written back unchanged by every
  write:
  - name: letters only, 2–24 characters (the review gate's family-name rule; never mistaken for a raw id);
  - not a shipped family's name;
  - not a reserved word: claude, codex, grok, agy, gemini, opencode (CLI, account and harness tokens);
  - keys: only `id` and `addedAt`. A future key, such as an opencode entry's, hides the entry;
  - id: passes ID_RE and is an agy (`gemini-`) id.
- File errors: not JSON, not an object, `families` not an object, or `version` other than 1. Each one means
  `familiesError`, no user families and no writes, like the sibling files. Shipped families and models.json resolve
  as before; the resolver's `error` stays null.
- Blast radius: a role, flavor or pause that names a hidden entry, or names one while families.json is broken, makes
  roles.json (or paused.json) invalid, the way any unknown family does today. The error names families.json and the
  reason, e.g. `unknown family "argon" — ~/.agent-config-studio/families.json has it, but hidden: its id is not a
  gemini- id`.

### Everything that lists families
roles.js (checkRoles families, readPaused), pause.js families(), server.js knownFamily, and models-panel set/reset use
shipped + readable user families. resolverStale also compares the installed lib/models.js. ask-model, the review
gate, workflow.js and acs-agent are unchanged: they resolve through the registry and pick the CLI from the prefix.

### Adopting
- Models → Model ids, under the Antigravity catalog line: "Not added yet:" lists each catalog entry
  - whose catalog family word is non-null (so no orchestrators),
  - whose id no family holds,
  each with a one-click Add (secondary button). No form.
- The family's name is the catalog word (`gemini-4-argon` → `argon`). Update alerts match catalog entries by that
  word (lib/models-catalog.js:315), so a renamed family would never get one.
- POST /api/models/adopt {id}, strict same-origin, checked against the in-memory catalog at request time:
  - the Antigravity catalog is readable;
  - the id is in it, with a non-null family word;
  - no family holds the id;
  - the name passes the entry rules and is not a shipped, added or hidden family's name;
  - the installed resolver is not stale (409 with the install line);
  - families.json is not in error.
  The write is atomic and recorded in history. Hidden entries and the rest of the file are kept byte for byte where
  untouched.
- Set and Accept on an added family write its id in families.json. They hard-refuse (400) any id the read side would
  hide, such as a non-gemini id; the catalog warnings still ask to confirm. An added family has no Reset.
- Remove (on an added family's row): refused while a role (use or alt), a flavor or a pause names it, with where it
  is named. Otherwise it removes the entry from families.json, touching no other file.
- Rows for added families say "added by you" in Set by.

### Back-compat
| Reader | families.json alone | a role, flavor or pause naming `argon` |
|---|---|---|
| older installed resolver (model-id, ask-model, review gate) | ignored | refuses roles.json / paused.json |
| older studio (Cris's trunk `acs` until pulled) | ignored | shows roles.json invalid, refuses edits, never rewrites |
Adding a family touches only families.json and is refused while the resolver is stale. Role, flavor and pause writes
are already refused while it is stale. An older studio checkout reads the same files and shows roles.json invalid
once a role or flavor names an added family. Known limit, with no data loss.

## Phases

### Phase 1 — registry and resolver
lib/models.js: read families.json, the entry rules, file errors, the cache key, and `userFamilies`, `familiesHidden`
and `familiesError` beside `defaults`. lib/roles.js and lib/pause.js use the merged list, and their unknown-family
error names families.json and the reason. resolverStale compares models.js too. server.js knownFamily and the
models-panel family checks use the merged list.
Pass/fail:
- tests/models.mjs or a new tests/models-families.mjs (temp HOME):
  - `model-id argon` prints its id, and `--table` lists it;
  - `model-id --json` has no new top-level key;
  - a broken file, a version-2 file or a non-object leaves `model-id opus` working and adds no family;
  - each hidden reason hides only that entry: a digit, a reserved name, a shipped name, an unknown key, a non-gemini
    id;
  - an edit to families.json shows on the next loadRegistry (cache key).
- Roles and pause tests:
  - a role, a flavor and a pause naming an added family resolve;
  - naming a hidden one fails with families.json and the reason in the error.
- A scripted check, recorded in log.md: a copy of main's lib/models.js + lib/roles.js resolver, run against the same
  temp HOME with a families.json, resolves shipped families and roles exactly as without it. Not a suite test: CI
  checkouts may not have main's history.
- tests/models.mjs (lint), tests/guards.mjs.

### Phase 2 — writes and routes
lib/models-panel.js: adoptFamily, removeFamily, and setModel/accept/reset for added families. server.js: POST
/api/models/adopt and /api/models/remove; the view's rows carry `source: 'added'`.
Pass/fail: tests/models-families.mjs (temp HOME, a planted Antigravity list, the real server for the routes):
- Add writes exactly one `{id, addedAt}` entry named by the catalog word.
- Add refuses, each with its reason:
  - an orchestrator;
  - an id not in the catalog;
  - an id a family holds;
  - a name a shipped, added or hidden family has;
  - a stale resolver;
  - a broken families.json;
  - a cross-origin request.
- Hidden entries survive Add and Remove byte for byte.
- Set or Accept on an added family write families.json, never models.json, and a non-gemini id is refused with no
  write. Reset is refused.
- Remove is refused while a role, alt, flavor or pause names the family; otherwise it touches only families.json.
- guards f/g pass.

### Phase 3 — screen
public/app.js: the "Not added yet" list with Add, Remove on added rows, "added by you".
Pass/fail: tests/models-layout-ui.mjs additions:
- the list leaves out held ids and orchestrators;
- Add posts {id} and shows a refusal;
- Remove shows where the family is named when refused.
Browser QA is the orchestrator's, under a temp HOME.

## Follow-ups (filed, not in this PR)
- Does agy reject an effort the model does not list (e.g. xhigh for argon)? If so, limit the effort pickers
  (public/app.js:5130, :5203, :5387) by the catalog's `efforts`.
- A builder/security warning by vendor for agy families (neon included), if wanted.

## Known limits
- An older ACS checkout shows roles.json as invalid once a role or flavor names an added family, and refuses role
  edits until it is updated. It never rewrites the file.
- Only Antigravity's catalog offers models, and only gemini- ids.
- A name collision with the catalog word is refused; hand-edit families.json to pick another name.
