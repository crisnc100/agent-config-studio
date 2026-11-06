# Plan: ui-clarity — a clear, calm studio with workflow diagrams

## Goal
Make every area of Agent Config Studio easy to follow for a daily user and a newcomer: fewer words, one name per thing, nothing hard to see, and a diagram for each skill pack showing its steps and which role and model does each one. Product truth: PRODUCT.md. Mode: Operate (precision and restraint, not a new visual identity). This refines the existing look; it is not a rebrand.

## Evidence (baseline critique, 2026-11-05, seeded QA server)
- Design review: Nielsen 20/40. Fails 6 of 8 cognitive-load checks. The workflows are never drawn. The same thing has several names: Jobs vs Roles; memory vs instruction files; Delete vs Trash; "both harnesses" when there are three CLIs; Scope / Scope chain / What applies where. Most pages open with caveat paragraphs, debug lines and titles shown twice. Codex status contradicts itself across Home, Setup, Packs and Usage.
- Evidence pass:
  - In the light theme, `--muted` is 3.94–4.14:1 (fails AA everywhere), and coloured badges and notes are 3.3–3.9:1.
  - 4 selects plus the editor show no focus at all.
  - At 390 wide, Home, Models, Packs and Worktrees scroll sideways.
  - 10–10.5px text is common.
  - No console errors.
  - Detector: 1 minor glow, 1 false positive.

## Split: 3 PRs
Each one leaves main working on its own, and they can be reverted separately. A and B touch different files (A: copy and CSS across views; B: a new diagram module plus Packs and Models). C depends on A's naming.

### PR A — words, names and visibility (copy + CSS, no new features)
A1. One name per thing:
- "Roles" everywhere; the UI matches the skills' "ACS → Models → Roles".
- "Instruction files": never "memory" for CLAUDE.md or AGENTS.md. "Memory" means only auto-memory.
- "Trash" for anything recoverable; "Delete" only when it is permanent.
- "your CLIs" or "Claude Code, Codex and Grok", never "both harnesses".
- One title for Scope.
- A short glossary tip (ⓘ) for the terms that stay: trunk, seat, effort, worktree.

A2. Cut words:
- Drop the page heading when it repeats the top bar.
- Caveat paragraphs go behind an ⓘ or "Details".
- Remove debug output: transcript timings, folder classification counts, full temp paths.
- Fix plurals ("5 project folders").
- Every page's intro is at most one sentence.

A3. Packs card:
- Check the needs once, at the top ("To use packs: do these 2 things").
- Each card shows ✓ or the one missing need.
- Hide part ids and types; show what each part does in plain words.

A4. Visibility:
- Light `--muted` reaches ≥4.5:1, and coloured badges and notes reach ≥4.5:1 in both themes.
- No text under 11px.
- Focus is visible on every control: the 4 selects and the editor.
- Disabled buttons carry a reason in their title or nearby text, not only 0.4 opacity.
- No sideways scroll at 390 in any view: tables scroll inside their own box, long paths wrap.

A5. Consistent status: Home, Setup, Packs and Usage agree on each CLI. Where "installed" and "on the studio's PATH" really differ, say that in one sentence.

### PR B — workflow diagrams
B1. A diagram component, plain HTML/CSS with no library.
- It draws a horizontal row of step boxes (it stacks vertically under ~600px).
- Each step shows who does it: a role (resolved live from the studio's roles to the model and effort, e.g. "reviewer → Opus · xhigh"), "you", "your session agent", or "a script (no model)".
- Optional steps are shown only when that setting is on; turned off, they show as dimmed and labelled "off".
- An unset role shows "not set — choose", linked to its row on Models.

B2. Diagram data lives with each pack in pack.json, as a `workflow` key. It is written for every pack:
- review-gate (/code-review): reviewer pick, security pass, quote check, fix round by the builder, dispute verdict, one fix check, deferred plus log, push gate. Its variants (premium, both, claude) are shown as tabs.
- build: Understand, Shape plus Bounce (advisor) plus your approval, Build (builder), Grade (judge, other vendor), you judge. A small note covers lightweight mode.
- pr: facts script, the session agent writes, `--check`, gh; it says "no model is called".
- advisor (with its second and both variants), second-opinion, handoff, flag, worktree (a command flow).

B3. Placement:
- On each Packs card, the diagram is the first thing under the one-line summary.
- On Models, each role row gets a "Used by" line naming the pack steps that use that role.

B4. Copy inside the diagrams follows A1's names. If B merges before A, B uses the new names itself.

### PR C — navigation calm-down
C1.
- Group the sidebar under 4 short headings: Overview (Home, Usage); Workflows (Packs, Skills, Models); Files (Files, Context, Scope, MCP); Upkeep (Memory, Worktrees, Audit).
- Pages and URLs are unchanged.
- Setup is reachable from the sidebar footer.

C2. Home "Needs attention":
- The top 3 items, ranked by consequence (a retiring or vanished model before housekeeping), then "Show all N".
- Home no longer repeats the Usage bars in full: one compact line per account, with a link.

C3. MCP:
- An empty state that says what MCP servers are in one plain line and where to add one.
- One "none configured" line, not three.

## Acceptance bar (each checkable)
1. A string sweep (a test) finds no "both harnesses", no "Jobs" heading on Models, and no "memory file" meaning instruction file. Delete and Trash are used per A1.
2. Contrast: an automated check over every view in both themes finds no visible non-disabled text below 4.5:1 (3:1 for ≥18px or bold ≥14px). No text under 11px.
3. Every interactive control shows a visible focus change. A test asserts no `outline: none` without a replacement focus style.
4. At 390×844, no view's main area is wider than its box (checked in a browser).
5. Every pack in packs/ has a `workflow` in pack.json and renders a diagram on Packs. The review-gate and build diagrams name the live role model (change the reviewer role on Models and the Packs diagram updates without a reload). Turning off an optional part dims its step.
6. Models role rows show "Used by" for every role a pack workflow names.
7. The existing suites pass (`node tests/*.mjs` per verify.sh, plus packs and UI tests), and new tests cover the diagram data shape and rendering.
8. No new dependencies; CSP unchanged (`script-src 'self'`).
9. Review:
- `/impeccable` critique after the build: Nielsen ≥30/40 and no P1 left.
- `/qa-tester` in Chrome on the seeded server covers criteria 2–6 in both themes at 1440 and 390.
- `/code-review` on each PR.
- Reports lead with what was reviewed and verified.

## Out of scope
A new visual identity or palette beyond the contrast fixes; new features in Memory, Worktrees or Audit; changes to the review-gate runtime; any write path to the user's config beyond what exists.

## Builder and phases
- Builder: Opus, a native subagent (frontend/design fit). Effort: xhigh, by the Jev rule.
- Phases are one per PR (A, B, C), each with a commit. The orchestrator reviews before the next phase.
- B can run in parallel with A in its own worktree only after `git merge-tree` shows no conflict. The default is sequential: A, then B, then C.

## Bounce revisions (Fable, 2026-11-05) — these override anything above
Checked against the code: the catalog route whitelists fields (lib/packs-routes.js:41); the fake DOM has no CSS or layout (tests/fixtures/fake-dom.mjs:5); "Jobs" is pinned (tests/roles-ui.mjs:85); and there is a 9px rule (styles.css:133).

R1. **Sequential A → B → C, no parallel worktree.** A and B share packs-view.js, the Models role rows and styles.css. B builds on A's names, so there is only one naming regime.

R2. **Server changes are in scope, named:**
- (a) lib/packs-routes.js passes `workflow` through.
- (b) Instruction-file labels: lib/registry.js `kindLabel: 'memory'` → "instructions" for CLAUDE.md and AGENTS.md. "both harnesses" and "new harness detected" become plain words (lib/registry.js:422, lib/packs.js:1032).
- (c) A5 status: Packs reads CLI presence from the same detector as Home and Setup (lib/setup-clis.js). Where PATH really differs, Packs says "installed, but not on the PATH the studio sees", once.
- (d) A small read-only field for the review gate's `security` setting (off | required | always), from the home review config, so the security-pass step can show whether it is on.

R3. **Roles on Packs:** packs-view.js fetches `/api/roles` itself (the existing route; it returns members, effort and an unset flag). It refetches when Packs opens and after a role is saved in this tab. Criterion 5's "updates" means: change a role on Models, open Packs, and the diagram shows it. A CLI `--set-role` shows on the next visit to Packs. No file watcher is added.

R4. **Steps show the truth about pools and swaps:**
- A pool step lists its members: "reviewer: Opus or Sol (picked per review)".
- The Grade step says "judge: Fable — Astra instead when the builder is the same vendor as Fable", computed from the ids' vendors.
- Per-run variants (premium, both, claude) are tabs with no on/off state.

R5. **Workflow data shape:** each step = `{ id, label, who: role|you|agent|script, role?, part?, setting? }`.
- `part` links the step to an optional pack part (it is dimmed when that part is off).
- `setting` links it to a config value such as security.
- A step with neither is always on.
- The mapping is written in pack.json and tested.

R6. **Drift guard:** a test checks that every role named in a pack's workflow appears in both its SKILL.md twins (claude and codex), and that `validatePack` validates the `workflow` shape.

R7. **No version bump** for adding `workflow`. It is catalog metadata served from the repo and installs nothing, so installed packs aren't marked "update available".

R8. **Tests that change:** each change goes in its own test-only commit naming each assertion, reviewed by the other vendor and listed in the PR body:
- tests/roles-ui.mjs:85
- tests/models-layout-ui.mjs:86,115,186
- tests/model-guide-ui.mjs:89 (Jobs → Roles)
- tests/shell.mjs:7,46 and tests/packs-ui.mjs:60 (sidebar groups, PR C)
- tests/home.mjs:116,336,330-345 (memory label; Needs-attention top 3, PR C)
- tests/batch-delete-ui.mjs (Delete → Trash labels and the confirm text)
- tests/packs-ui.mjs:66 (per-part details)

The frozen review-gate test file is untouched.

R9. **Criterion 1** becomes a per-view sweep with an allowlist. "memory" is allowed for auto-memory (Home's memory-fact line, the Memory view). "Delete" is allowed only on permanent actions.

R10. **No second "Used by":**
- Role rows get "Steps: /code-review · reviewer pick; /build · Grade".
- Family cards keep "Used by N roles" (renamed from jobs).

R11. **Criteria 2–4 are verified in Chrome by /qa-tester,** using a measurement script like the baseline evidence pass: contrast per visible text node in both themes, focus change per control, and main-area width at 390×844. Each result is in the report.

Static guards in tests:
- no CSS font-size under 11px in styles.css (the 9px badge included);
- the four selects and the editor have a :focus-visible rule with an outline or box-shadow.

R12. **Copy fixes:**
- pr says "no extra model is called".
- handoff, flag and worktree get a one-line strip ("your session agent writes the handoff file — no extra model"), not a full diagram.
- The diagram's stacking reuses the existing 700px breakpoint.

R13. PRODUCT.md lists six roles, including `security`.

## Cris, 2026-11-05: mobile is out of scope
Mobile and phone width are not relevant to this build. QA, the impeccable critique and the acceptance bar check desktop only (1440, plus common desktop widths), in both themes. A4's "no sideways scroll at 390" and criterion 4 are dropped. Diagram stacking is not required.

## Cris, 2026-11-06: no window sizes in QA
QA runs in the browser window as it is (full screen). Never resize, zoom or emulate widths. It's a desktop web app, so there are no size or width checks.

## PR E — Home usage bars back

Cris: "I miss the bars on the homepage for accounts and usage." C2 had cut Home's accounts card to one line (the tightest window, text only).
- paintAccounts shows every quota window again: "N% left", a thin bar (.usage-track.home-track > .usage-fill, width = left, data-level by pressure), then the label and "resets in". C2's route line, per-account rows and Open Usage stay.
- Compact: each window is a grid row (64px % | 120px bar | label), the track is 5px, and rows are 3px apart. So bars line up across windows and accounts.
- Test change, in its own test-only commit: home.mjs '9 each account is one compact line…' becomes '9 each account shows every window as percent left'. New guard: one bar per reported window, its width equal to its "% left", with a level.
- Browser (seeded QA server, window as it is): 5 windows across 3 accounts, every track starts at the same x (607px) and is 5px tall, and each fill's width matches its percentage.
