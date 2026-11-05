# PR: a `pr` pack — PR descriptions in your own style

Asked by Cris 2026-11-05. Personal only for now (a team layer comes later, when a team's rules need to win). Scope: the PR description, not the PR workflow. One PR: a new pack with one skill (claude + codex twins), one helper script and one config file; they only work together.

## Outcome
When an agent opens a PR, the `/pr` skill writes a description a person can read in a minute: what changed and why in plain words, whether it stayed in scope, what changed by purpose, how to try it, what was reviewed, fixed and deferred, and the raw review record folded away. The style (sections, order, tone, length, emoji, GIFs) comes from the user's own style file, so every ACS user gets their own.

## Pieces
1. **Style file** `~/.agent-config-studio/pr/style.json` (created from a shipped `style.example.json` at install; never overwritten):
   - `sections`: ordered list; each `{id, title, on, maxWords?}`. Ids: `summary`, `scope`, `changes`, `try`, `reviewed`, `deferred`, `docs`, `tier`, `record`. Defaults: all on, in that order; `deferred` must stay on whenever a review summary exists (the code-review skill requires a "Deferred findings" section); `record` folded in `<details>`.
   - `tone`: `plain` (default: short sentences, no jargon, explain any code term) | `technical`.
   - `emoji`: true/false (section markers like ✅ ⚠️ ❌ in the scope list).
   - `gif`: `{on: false, urls: []}`; when on, one URL from the user's list goes at the top (picked by a hash of the branch name, so reruns are stable). Nothing is fetched.
   - `footer`: optional text.
2. **Helper** `pr-facts.mjs` (no model calls, read-only) prints one JSON object for the current branch: branch, base, commits (subjects), files grouped by purpose (code, tests, docs, config, static, builds) with line counts, the plan file if found (`builds/<slug>/plan.md`: its Outcome and Out of scope sections), the review gate's `--summary` text and `--tier-json` (when the review gate is installed; omitted otherwise), docs check (behavior files changed with no docs/skill/README change → listed), and the resolved style. `--check <file>` validates a written description against the style: required sections present in order, word limits, `Deferred findings` section present when a review exists, raw record folded; exit 1 with the reasons.
3. **Skill** `pr` (claude + codex twins): run the helper, write the description from the facts in the configured style (rules for each section, plain-language examples), run `--check`, then `gh pr create --body-file`. If the review gate shows deferred HIGHs or unmet criteria, they go first, above the summary. Never invent facts the helper didn't give; say "not reviewed" when there is no review.
4. **Pack** `packs/pr/pack.json` (claude + codex harnesses), listed in the catalog; install creates the style file from the example; uninstall keeps the user's style file.

## Acceptance criteria (each checked by a test)
1. `pr-facts.mjs` on a fixture repo: files grouped by purpose with counts; plan Outcome/Out of scope extracted; review summary and tier included when a stub review.mjs is present, omitted cleanly when not; docs check lists a changed code file with no docs change.
2. Style: defaults when no style file; a style with sections reordered/turned off is respected in the resolved style; `deferred` can't be turned off while a review exists (warning, kept on); unknown keys warned and ignored.
3. `--check`: passes a description matching the style; fails naming each missing/out-of-order section, over-limit section, missing Deferred findings, unfolded record.
4. GIF: off → none; on with urls → the same URL for the same branch every run; on with empty list → none, with a note.
5. Pack: installs both skill twins and the helper, creates the style file only when absent, uninstall keeps it; pack catalog and pack tests pass; skill text passes the personal-text and model-name sweeps.
6. No existing test assertion changes; the full suite and the root pack tests pass.

## Out of scope
Team/repo PR rules (later), running tests or checks before the PR, an ACS screen for the style (later; edit the JSON for now), changing the review gate's `--summary`.

## Revisions after the Bounce (Fable, bounce.out) — these override the sections above
- **Style file is created lazily** by the helper on first run (the flag pack's pattern), from `style.example.json` shipped in the skill folder; no new installer kind. If the write fails (e.g. Codex sandbox), the helper uses the defaults and says so in its JSON. Uninstall never touches it.
- **Style axes cut to what matters:** `sections` (order, on/off, title — except `deferred`, whose title is pinned to "Deferred findings" and which stays on and outside any fold whenever a review exists), `tone` (`plain` default | `technical`), `emoji` (true/false), `gif` (`{on:false, urls:[]}`, shipped empty). Cut: `footer`, per-section `maxWords` (length guidance lives in the skill text, never enforced), the `tier` section (the review summary already prints it).
- **Base and diff:** `--base` flag, else the open PR's base (`gh pr view`), else the upstream/`origin/HEAD` branch; three-dot diffs, merges excluded, so a stacked PR or a main merge reports only the branch's own changes.
- **Classification table** (in the helper and the plan): tests = test file names/folders and `fixtures/`; docs = `*.md`/`*.mdx`/`*.txt`/`docs/`; static = images, fonts, css; config = json/yaml/toml/lock and dotfiles; builds = `builds/`; code = everything else. Docs check: code files changed with no docs file changed.
- **Review states, all distinct:** review gate not installed → "not reviewed (no review gate)"; installed but HEAD not closed → "review in progress — not closed at this commit" with the gate's reason; closed → summary + tier. The skill never writes "not reviewed" for an in-progress review.
- **Findings stay exact:** deferred and filed lines are copied verbatim from `--summary` (ids and scores); plain words only around them. Deferred HIGHs and unmet criteria go first.
- **Re-runs:** if a PR already exists for the branch, `gh pr edit --body-file`; else `gh pr create`. `gh` missing → a plain message, nothing written.
- **`--check` checks invariants only:** sections as `## <title>` in the configured order; "Deferred findings" present, exact title, outside `<details>`, with every deferred line from `--summary` verbatim; raw record inside `<details>`; no file path, finding id or sha in the body that isn't in the facts. Warnings are in the JSON, not stderr.
- **Tests added/changed:** skill text pinned (helper run, --check before create/edit, deferred first, no invented facts); twin helpers byte-identical with each SKILL.md using its own path; one case runs the real review-gate `review.mjs` against a temp log (closed, in-progress and absent states). The existing pinned pack lists/counts (review.packs.test.mjs IDS and SKILL.md counts, packs-server catalog order, packs-ui card count) change in ONE test-only commit naming each assertion, per Cris's rule.

## Cris's format (2026-11-05) — final; overrides the section lists above
Default sections, in order, each configurable (on/off, order, title except "Deferred findings"):
1. `gif` — optional, from the user's list (off by default, list empty).
2. `summary` "What this does" — 2–3 plain sentences, purpose not mechanics.
3. `goal` "Did it match the goal?" — ✅ asked and done / ⚠️ done but not asked / ❌ asked but not done, against the plan's Outcome and Out of scope (when no plan: says so).
4. `changes` "What changed" — files grouped by purpose, one line each on why.
5. `try` "How to try it".
6. `review` "Review highlights" — who reviewed (code + security reviewer families), the HIGH findings that were fixed with a one-line why each and their scores (copied from the summary), MEDIUMs/LOWs as counts only.
7. `deferred` "Deferred findings" — required whenever a review exists, exact title, outside any fold, lines verbatim from --summary.
8. `docs` "Docs and context" — docs updated?, CLAUDE.md/AGENTS.md updated or created?, new comments clear? (✅ or a one-line reason each; from the helper's docs check and, later, the docs pass).
9. `agent` "What the agent did" — short notes from the build log (decisions and why).
10. `quote` "Agent's take" — one first-person sentence from the agent summing up the PR (configurable on/off; on by default).
11. `record` raw review summary in `<details>` — OFF by default.
`--check` invariants unchanged (Deferred findings rules; record folded when on; no invented facts). Out of scope still: the docs pass itself (next PR), changing CLAUDE.md's "--summary in the PR body" rule (orchestrator updates it after merge, with Cris's OK).
