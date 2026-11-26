# Builder selection: read-only mapping report

**Recommendation:** ship this as one PR in three phases. Keep the choosing logic in `lib/roles.js`, which the installed resolver already copies, and add one new command, `model-id --pick builder`. Store the setting as a new builder-only `pick` field in roles.json. The Roles editor writes it, the guide renders it, and both build skills run `--pick` once per task and write the result into `plan.md`. `--role builder` output stays exactly as it is now. I edited nothing and ran nothing that calls a model or the network.

## 1. Where selection happens today, and whether Jev is wired
- **Code:** `resolveRole` drops paused families and returns the first one left (`lib/roles.js:433-466`). `model-id --role` prints that (`bin/model-id.mjs:238-243`). `ask-model --role` takes the same family (`tools/ask-model.mjs:1127-1139`). `--build` only works for agy models (`:1111`, `:1859`). `docs/neon-builder.md` says ask-model "does not rotate builders".
- **Skills (instructions only, no code):** in the Claude skill, the orchestrator picks "using each family's flavor… taste matters for frontend, design and copy" (`packs/build/skills/claude/build/SKILL.md:56`, `:98`). That line is a hidden Opus preference. The escalation rule switches family by itself when the orchestrator picked the lane (`:87`). The Codex skill only says "the builder role's family" (`codex/build/SKILL.md:25`). Neither skill has a Neon dispatch route.
- **Guide:** says "The first family is the answer" (`lib/roles.js:576-578`). Your current builder note ("Rotate available builders… Prefer Opus…") is free text that nothing reads.
- **Jev is not wired.** "jev" appears only as an MCP server name in grok tests (`tests/ask-model.mjs:937`). The CLI is `~/.local/bin/jev`, which points to `~/.claude/skills/jev/scripts/jev.py`.

## 2. Role schema, save path, UI and install touchpoints
- **Schema:** add `pick` to `ROLE_KEYS` (`roles.js:47`) and validate it in `checkRoles` (`:129-151`). Shape: `{mode: ordered|random|jev, usage: bool, design?: <family>}`, allowed on `builder` only. A `design` family that isn't in `use` gets a warning, not a refusal, so `--set-role` installs don't break. `packs.js:1128` already keeps every field in `ROLE_FIELDS`.
- **Older resolvers:** an older installed resolver rejects unknown keys, which would break every role flag. Add a `hasPick` refusal next to the existing ones (`roles-panel.js:132-134`). `resolverStale` (`:67-73`) already covers roles.js, so the install list (`model-id.mjs:84-92`) doesn't change.
- **Studio view and UI:** `rolesView` returns `pick` (`roles-panel.js:353-373`). The role editor gets the new controls (`public/app.js:5350-5376`), Save sends `pick` (`:5387`), and the lineup row shows the mode (`:5193`). No new routes are needed (`server.js:1363-1374`).
- **Describe:** add `pick` to the Describe SCHEMA (`lib/describe.js:38-61`). Otherwise an accepted proposal drops it, because it replaces the whole file.
- **Guide:** `guideText` (`roles.js:583-592`) adds selection text only when `pick` is set, so users without it get the same bytes.

## 3. Cached usage signal
- **Source:** `~/.agent-config-studio/usage-snapshot.json`, read directly as JSON. Never import `lib/usage`. Its format: `{takenAt, seats[{vendor, ok, duplicateOf, rateLimited, stale(codex), windows[{usedPercent, resetsAt, kind}]}]}`. It is written by `bin/usage.mjs:73-76` and `seats.js:397-414`.
- **Freshness:** it is refreshed only when the studio's Home or Usage timers run, or when `acs-usage` runs (`app.js:3348`, `:3726`; `refresh.js:40`). The live file was 5 minutes old when I checked.
- **Family mapping:** family → id → `vendorOf` → `subscriptionOf` → seat vendor (`models.js:31-44`).
- **Rule:** use each seat's tightest window (`pause.js:172-182`). Exclude a family only when a fresh, non-duplicate seat shows ≤10% left (the "high" pressure line, `usage-view.js:76`). "Fresh" means within 60 minutes (`codex.js:158`). Missing, stale or failed readings count as unknown and stay eligible; never route on stale data (`usage-view.js:11`). If usage would exclude everyone, ignore usage and say so. Paused families are already excluded by resolveRole.
- **Unknowns:**
  - Claude `weekly_scoped` windows are per model (`claude.js:111`). I recommend ignoring scoped windows whose label doesn't name the family. I haven't verified that display names match family names.
  - With several seats on one subscription, I don't know which one the CLI will use. I'd count the subscription as available if any seat has headroom.

## 4. Jev integration and fallback
- **Inputs:** `--json-out` with the JSON request on stdin; `--timeout` (default 15s). Output is `answers.<q>.{choice, confidence}`. It exits 1 on HTTP or network failure and 2 on a missing key or bad input.
- **Call:** one Choice question among the eligible families plus a `none` escape option. Each option's text comes from that family's saved flavor (likes, quirks, avoid). The task text comes from a capped `--task-file`.
- **Result:** act when confidence ≥ 0.7 and the choice is eligible; that matches the threshold in the jev skill. In every other case (jev missing, exit code, timeout, bad JSON, low confidence, `none`), fall back and report why.
- **Safety:** spawn the jev path resolved from absolute PATH entries, with fixed arguments and a hard kill after the timeout. This needs a `bin/model-id.mjs` entry in the guards allowlist (`tests/guards.mjs:352-417`), because guard B scans `bin/`. The alternative, the orchestrator running jev itself, avoids the guard change but splits one result across several commands.
- **Shadow rule:** your shadow-only Jev rule (`~/.claude/CLAUDE.md:40`) stays for other lanes. Jev decides only in builder `jev` mode.

## 5. Task-choice contract (skill text only, no new state store)
- **Picking:** before the first Build call, if `plan.md` has no `Builder:` line, run `model-id --pick builder [--design] [--task-file …]` once. Record `Builder: <family> · <effort> — <mode/reason>`. A family you name with `/build <family>` wins and is recorded the same way.
- **Keeping it:** every phase, fix and resume uses that family. Fresh phase workers are fine. agy has no resume, so each phase is a new `ask-model --family "$BUILDER" --build` call.
- **Replacing it:** only after a quota or startup failure, or when you change it. Re-pick with `--exclude <old>` and add `Builder replaced: old → new (why)` plus a short handoff note to `plan.md`/`log.md`.
- **Escalation:** the rule at `SKILL.md:87` becomes "ask first" in every case.
- **Other notes:** lightweight mode states the choice inline. Any `/handoff` copies the Builder line into Key Context. `--design` is the orchestrator's call at Frame, recorded as `New visual design: yes|no`.
- **Skill edits must not break the skill test:** keep `BUILDER=<family>` and the single `EFFORT_FLAG` block (`review.skills.test.mjs:166-169`). The new pick and agy code blocks must not match its other patterns (`:121`, `:146`, `:212`, `:262`).

## 6. Tests and browser checks
- **New `tests/roles-pick.mjs`:**
  - Schema and stale-resolver 409.
  - Ordered `--pick` returns the same family as `--role`, and `--role` output stays byte-identical (pinned at `tests/roles.mjs:131`, `:296`).
  - Random uniformity, with an injected random function enumerated over every index.
  - Usage: fresh, stale, missing, duplicate, all-excluded, and scoped-window fixtures.
  - Design preference is exact.
  - `--exclude` and paused families.
  - Jev via a PATH stub `jev`: success, low confidence, exit 1/2, timeout, ineligible choice, missing CLI.
  - The guide is unchanged when `pick` isn't set.
- **New UI test** in the style of `roles-ui.mjs`. **New skill test** that runs the pick block from both SKILL.md files against stubs.
- **Test-only commit:** register the new files in `tests/SUITE` and add the guards allowlist entry. The frozen `review.test.mjs` is not touched.
- **Browser:** `node tests/models-qa-server.mjs` (temp HOME, no resolver installed, builder unset). Open Models → Roles → builder, set the mode, usage and design, save, reload, then check roles.json and the guide's "needs updating" notice.

## 7. Scope and file list (one PR)
1. **Resolver:** `lib/roles.js`, `bin/model-id.mjs` (`--pick` must be added to `FULL_USAGE` at `:43`, which `tests/readme.mjs:52` reads), `tests/roles-pick.mjs`, plus the test-only commit.
2. **Studio:** `lib/roles-panel.js`, `lib/describe.js`, `public/app.js`, a new UI test.
3. **Skills:** `packs/build/skills/{claude,codex}/build/SKILL.md`, `README.md` ("Nothing… swaps a family" and the `--pick` docs), a new skill test.

After merge you'd run `acs install-model-id` and `acs packs update build`, then update your builder note. As written it is a hidden Opus preference.

## Questions for you
1. When Jev fails or isn't confident, should it fall back to the ordered pick (the current behaviour) or to a random pick? I recommend ordered.
2. Should "genuinely new visual design" be the orchestrator's explicit `--design` call at Frame (my recommendation, exact and testable), or a separate Jev yes/no question?
