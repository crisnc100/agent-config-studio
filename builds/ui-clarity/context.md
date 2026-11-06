# Context: baseline critique (2026-11-05), seeded QA server `node tests/redesign-qa-server.mjs` (port 8797)

## Design review (Assessment A, Opus) — key evidence
- Areas: 12 sidebar items + Trash + theme; Setup only reachable from Home.
- Naming conflicts: Models page heading "Jobs" (app.js:4573) + button "Add a role" (app.js:4594) while skills say "ACS → Models → Roles"; Scope calls instruction files "memory files"; Delete vs Trash; "0 skills across both harnesses" (app.js:1958); Scope / "Scope chain" / "What applies where"; "5h rolling" vs "5-hour".
- Debug/noise shown to users: "Transcripts: 6 (0 read, 6 from cache) in 2 ms." (app.js:2318); folder classification counts with bad plurals; git shim temp path on Packs; Context count said twice (app.js:2865).
- Jargon list: trunk, seat, harness, lanes, ROUTE TO, env: missing:1, provably done, PATH, app-server, "Assist registry", "Frame, Bar and Judge", model-id/ask-model PATH lines repeated on 5 packs.
- "grok-prevpinned" missing space (app.js:4348). Job editor = free-text comma list of model names.
- Codex status contradicts across Home/Setup/Packs/Usage.
- Packs: "who does each step" only in a collapsed prose section, naming roles not models. No diagram code exists in public/.
- Diagram contents per pack (from SKILL.md): see plan.md B2; review-gate SKILL at packs/review-gate/skills/claude/code-review/SKILL.md; build at packs/build/skills/claude/build/SKILL.md:41-64; pr says no model is called (pr SKILL.md:10).
- Strengths to keep: preview-before-write safety copy, Trash + history, Setup wizard style, Usage freshness, model-id alerts.

## Evidence pass (Assessment B, Opus)
- Detector: dark-glow styles.css:599 (live dot, minor), side-tab styles.css:250 (blockquote, false positive).
- Light theme `--muted: #767d8a` (styles.css:34) 3.94–4.14:1 everywhere; coloured badges/notes 3.30–3.87:1 (Needs-you badge, drifted, note boxes, alerts, pinned, Usage % left, DONE tag, pack chips, disclosure links). Dark theme clean except "pinned" badge 4.11:1.
- Text <12px counts at 390: Models 77, Packs 63, Memory 54, Context 34. Smallest 10px.
- No focus change: .scope-select, .assist-harness, .assist-model, .sess-select (outline:none at styles.css:368,533,618); editor outline+border removed (styles.css:66,278).
- 390 overflow: Home (Open Usage button cut), Models table 696px, Packs git path, Worktrees scope-note path.
- Tap targets <24px at 390: Packs 54, Models 20, Memory 18.
- No console errors. CSP script-src 'self', frame-ancestors 'none'.
- 390 screenshots: /private/tmp/claude-501/-Users-cortega/4cb140f1-7b68-4bbe-91ef-4f10b5331acd/scratchpad/acs390/
