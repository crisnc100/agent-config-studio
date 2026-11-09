# Plan — one coordinator, three reviews: code, security, context

**Status:** draft v2 for Cris (2026-11-09). Revised after the Bounce (`bounce.out`, fable). Inputs: Cris's flow, the advisors' read in `advice/`, decisions.md.

## Outcome

There are four skills. Three do one job each, and each runs on its own on any branch or diff. The fourth is the coordinator.

| Skill | Job | Model role | Edits files? |
|---|---|---|---|
| `/code-review` | Does the code do what the branch meant, without breaking anything? | `reviewer` | No (findings) |
| `/security-check` | Does this change open a hole? | `security` | No (findings) |
| `/context-pass` | Comments and technical docs: right, deliberate, and readable from outside | `writer` (new) | Comments and docs only |
| `/pr-review` | **The coordinator.** It runs the three in one flow for a PR and owns the order of the steps. | none of its own | No |

The PR description stays with `/pr`, which writes it last, from the final close.

**Portable by design** (Cris, 2026-11-09):
- `/code-review`, `/security-check` and `/context-pass` each work in any project, alone. Each has its own focus, with no knowledge of the others.
- `/code-review` has no security section and never starts a security pass.
- Only `/pr-review` knows the sequence. It is what runs when a PR is finished and being made ready.
- Test: each of the three skills runs in a scratch repo with no review-gate config, no ACS roles beyond its own, and the other two skills absent.

### The PR flow (`/pr-review`)

```
BUILD (phases; never any docs work per phase)
  → REVIEW: code + security in parallel → one record → one fix round → ONE fix check → close
  → CONTEXT: /context-pass on the final code (comments + docs only, one commit)
  → a slice review of exactly the files that commit touched, with a "docs" focus (claims checked against the code) → close the slice
  → push → /pr writes the description (deferred findings come from the closes) → Cris merges
```

Why the context pass goes after the fix check, not before it:
- The fix check reads code correctness only and ignores docs (`review.mjs:3844`).
- After a fix check, only builds/ and test files may change (`:3028-3033`). The gate's own message names a slice review as the sanctioned way to cover later files.
- So this order uses no new gate exception, and the docs describe the final code, after every fix.

The cost is one small extra review per PR, and only when the context pass changed something.

### Running alone

- `/security-check` alone writes to its **own log file**, which the gate never reads, the same way shadow records worked (`:3310-3314`).
  - It never sets `reviews/latest` and never counts toward rotation.
  - Its filed findings never reach a later review as "already decided".
  - So it can never satisfy a push, a close, `--summary` or `--tier-json`.
  - Its HIGH findings are printed plainly. If a PR review of the same branch runs later, `/pr-review` feeds that review the branch's open standalone findings as context.
- `/context-pass` alone (on a folder or files) takes a short brief: what this code is for, and who reads it. It edits, and prints its docs table.

## Cris's decisions (2026-11-09)

- One coordinator, three jobs, no separate loops.
- Each review runs on its own, so security and context never need a code review to unlock them.
- The context-pass agent is briefed in depth by the orchestrator.
- Every comment is deliberate and meaningful, never random.
- Slop is prevented at the source: the comment rule goes in the global instruction files (pending Cris's yes on the text).
- The name is `/context-pass`.
- The script's module split comes later.

## The `/context-pass` brief (PR mode)

The orchestrator writes the brief as a JSON file. `context-pass.mjs --check-brief <file>` refuses a brief that is missing a field or has an empty one, and names which. The skill runs that check first, which gives "refuses a missing field" a real mechanism.

1. **purpose:** what we built and why, in the user's words (the plan's goal).
2. **mechanism:** how it works now, step by step: each changed file's role, the data between files, and any new command, flag, config key or UI. Written by the orchestrator from the builder's phase reports and its own read of the diff. The writer verifies each point against the code before using it.
3. **decisions:** the trade-offs a future reader needs, with what was rejected.
4. **readers:** who reads each surface. README / user docs → users; reference → people configuring it; comments → the next maintainer.
5. **diff and doc map:** the final diff, plus for each changed behavior the docs that describe it. The map comes from a grep that also searches the **old names** of anything renamed, and includes the twin copies (claude/codex).
6. **untouchable:**
   - code and tests;
   - agent-instruction files (SKILL.md, CLAUDE.md, AGENTS.md, pack `instructions/`);
   - `.md` files that are program input (e.g. `lib/commands.md`, `calibration.md`, `advisor-contract.md`);
   - generated blocks (`acs:model-guide`);
   - doc text that tests pin (e.g. `tests/readme.mjs`).
   The writer reports changes needed in these and never edits them.

Deferred findings are not in the brief. They are known only after the fix check, and they go into the PR description through `/pr`.

**The writer's rules:**
- **Deliberate comments:**
  - Every comment tells the next reader something the code can't: why, a constraint, a trade-off, a trap.
  - Otherwise it is deleted, including slop left by earlier agents.
  - No narration, section banners, name-restating JSDoc, or process notes ("fixed", "now", "per review").
  - Keep license headers and ticketed TODOs.
- **Directive and executable comments are never touched:** `@ts-…`, `//go:build`, `# type: ignore`, lint directives, docstrings that tests read, Rust doc tests, Go `// Output:` examples.
- **Every doc claim is true of the code:** the writer confirms each one by reading the code, and records the claim with its `file:line` in the docs table. An unconfirmed claim is not written.
- **The right place, not the main file** (Cris, 2026-11-09). A project's root CLAUDE.md / AGENTS.md stays short: only what every agent needs in every session there. Anything else goes, in this order:
  1. into a sub-folder CLAUDE.md / AGENTS.md next to the code it is about (read only when an agent works there);
  2. or into a fuller doc (e.g. `docs/<topic>.md`), with a one-line pointer from the root file ("read docs/x.md before touching y");
  3. or nowhere, if the code already says it.

  Instruction files are untouchable for the writer, so its report proposes the change with its target file and level (root, sub-folder, or pointer plus doc). The same rule shapes the docs it writes itself: one home per fact, linked rather than repeated.
- **Docs describe the result, not the journey.**
- **Cut as well as add:** stale, wrong or duplicated text goes.

**Output:**
- one commit of comment and doc edits;
- the **docs table**, one row per changed behavior:
  - the doc updated, with each new claim → `file:line`;
  - or a concrete reason no doc is needed;
- a report of needed changes in untouchable files.

**Checks on the output:**
- **The slice review's "docs" focus:** it reads every changed doc line and comment against the code, flags any claim that is untrue or not backed by code, and flags any code-line change. This is a new focus prompt for slice reviews; there is no new gate path.
- **`pr-facts --check`:** fails when a changed behavior has no table row. It can check the table's rows and their completeness against the changed files, not its truth; truth is the slice review's job.
- **A test:** the skill refuses to edit untouchable files. The writer's own commit is diffed, and any path in the untouchable list fails it.

## The writer's model (Cris to decide)

The `writer` role is new, and a new role starts unset on existing installs (`lib/roles.js:195`), so Cris picks it in ACS → Models → Roles.

The task is multi-file and needs why-judgment. Sonnet's own notes say "one concrete, single-file task … weak on open-ended design" (`lib/roles.default.json`). The standing rule says Sonnet writes technical documentation.

**Decided (Cris, 2026-11-09):** Opus first, Sonnet as fallback. A record of which writer's docs pass the docs review cleanly, like the reviewer records, settles it over time.

How the writer runs:
- **Claude harness:** a native subagent, so it can write and Cris can watch it.
- **Codex harness:** `codex exec` with workspace-write.
- Not through `ask-model`, which is read-only.

## PRs (in order; each leaves main working)

1. **Review-gate PR C**, in flight: shadow pickers removed, security prompt borrowings added, skill shortening reverted.
2. **Split the skills:** `/code-review`, `/security-check` with `--security-only`, and `/pr-review`.
   - **The security-only log:** a separate file, with no path into the gate.
   - **Leak tests:**
     - plant a complete close for a security-only run, then assert that push, `--summary` and `--tier-json` all refuse;
     - `--fix-check <security-only id>` refuses;
     - `reviews/latest` is unchanged;
     - rotation counts are unchanged.
   - **Sequence owner:** `/pr-review` owns the sequence, so the order lives in a skill, not only in the optional instructions part (`pack.json:184-186`).
   - **/build:** updated so a Grade-based build hands its tip to `/pr-review`, with the Grade and code review closes as today.
   - **A security switch in ACS** (Cris, 2026-11-09): Packs → Review gate gets a three-way control, Off / When code changes / Always, for `security.run` in the home config. It shows the diff first, keeps a backup, and uses the three button styles. Today the studio only shows the setting, read-only.
   - **Security config:** the coordinated flow runs `/security-check` only when `security.run` is on. `/pr-review` says plainly when it is off, so a PR never looks security-reviewed when it wasn't.
   - **Pinned skill-text tests:** there are at least 10 (`review.packs.test.mjs:309`, `review.security.test.mjs:433`, `review.close.test.mjs:958` and `:1108`, `review.slices.test.mjs:305`, …). They change in one test-only commit, checked by the other vendor.
   - **Risk glob:** naming the folder `security-check` matches the default riskPaths glob `*security*` (`:798-801`). We accept that: changes to the security skill should be risk-tier anyway.
3. **`/context-pass`:**
   - the skill for both harnesses;
   - `context-pass.mjs` (`--check-brief` and the untouchable-paths check);
   - the slice review's "docs" focus;
   - the `writer` role (roles.js, packs.js, the pack.json workflow step);
   - the docs table feeding `pr-facts --check`;
   - the flow text in /build, /pr-review and /code-review: once per PR, never per phase;
   - **merge tier:** a comment-only commit covered by a closed slice must not push the tier to HIGH (`:2805-2810`). This is a tier-logic change in protected code, so it is called out in the PR and gets its own test.
4. **Later, a separate decision:** the module split of review.mjs. It starts with a shared-state object (`SLICE`, `CONTEXT`, `DIFF_BASE`, … reassigned at `:3295-3297`), then pure moves, keeping the single-file contracts.

## Bar

- **Standalone `/security-check`:** returns findings, and every leak test passes: push, close, summary, tier, latest and rotation are all untouched.
- **Standalone `/context-pass`:** on a folder, it produces edits and a table.
- **Coordinated PR flow, on a test repo with `security.run` on:**
  - one record holds the code and security findings;
  - one fix round and one fix check;
  - the context commit is covered by a closed docs-focus slice;
  - the push passes with no new gate exception;
  - the merge tier is unchanged by comment-only edits.
- **`--check-brief`:** refuses each missing field, by name.
- **Untouchable files:** the test fails a writer commit that touches any of them.
- **Docs focus:** on a planted wrong doc claim, it flags the claim.
- **`pr-facts --check`:** fails when a changed behavior has no table row.
- **Frozen file and suite:** `review.test.mjs` stays byte-identical, and the full review-gate suite passes.

## Out of scope

- Whole-repo audits: `/deep-review`, Cloudflare's security-audit.
- New push-gate exceptions.
- A plugin framework.
- Documenting per phase or per fix.
- The module split, which is PR 4 and a later decision.
