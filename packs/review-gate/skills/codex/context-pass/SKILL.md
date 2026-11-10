---
name: context-pass
description: Bring comments and technical docs in line with the final code, once. A writer from the `writer` role in ACS (Models → Roles) edits comments and docs only, from a brief a script checks first; every doc claim it writes is backed by a file:line in its docs table; a script fails its commit if it touched code lines, tests, agent-instruction files, generated blocks or doc text a test pins. PR mode takes a JSON brief and runs inside pr-review after the close; standalone mode works on a folder or files with a short brief.
---

# context-pass — comments and docs that match the code

One writer, one commit of comment and doc edits, one table that backs every claim. It runs once per PR, on the final code, never per phase or per fix. It never edits a code line.

The checks live in the shared runtime:
```bash
CP="$HOME/.agent-config-studio/review-gate/context-pass.mjs"
```

## Step 1 — the brief, checked first

**PR mode.** The orchestrator writes `builds/<slug>/context-brief.json` with:
- `mode`: `"pr"`;
- `purpose`: what was built and why, in the user's words (the plan's goal);
- `mechanism`: how it works now, step by step (each changed file's role, the data between files, any new command, flag, config key or UI), from the builder's phase reports and the orchestrator's own read of the diff;
- `decisions`: the trade-offs a future reader needs, with what was rejected;
- `readers`: who reads each surface (README and user docs → users; reference → people configuring it; comments → the next maintainer);
- `base`: the ref the final diff is taken from;
- `docMap`: for each changed behavior, `{ "behavior", "docs": [paths] }`, from a grep that also searches the old names of anything renamed, twin copies included (`docs` is `[]` when none does yet);
- `untouchable`: paths and globs this repo adds to the built-in list (program-input `.md` files, docs that tests pin).

**Standalone mode** (a folder or files): `{ "mode": "standalone", "purpose", "readers", "paths": [...] }`.

```bash
node "$CP" --check-brief builds/<slug>/context-brief.json
```
It refuses a missing, empty or unknown field and names each one. Never start the writer on a refused brief.

## Step 2 — the writer

Resolve the writer: `eval "$(model-id --role writer || echo 'echo "model-id failed: run acs install-model-id (see the Agent Config Studio README)" >&2; exit 1')"` sets `family`, `id` and `effort`. An unset role stops here with its fix (ACS → Models → Roles, or `acs packs install review-gate --set-role writer=<family>[,…]`); no model is picked for you. This harness runs a Codex writer: use the role's first family whose id starts with `gpt-` (the families, in order, are in `model-id --role writer --json`), at its effort. When the role has none, stop and say so. Never run the writer through ask-model, which is read-only.

Write the prompt (the brief, the rules below word for word, and: edit only comments and docs; one commit, `Context pass: <one line>`; never push; write the docs table; report needed changes to untouchable files instead of making them) to `builds/<slug>/context-prompt.md`, then:
```bash
codex exec --skip-git-repo-check --sandbox workspace-write -m "$id" -c model_reasoning_effort="$effort" "$(cat builds/<slug>/context-prompt.md)"
```

## The writer's rules

- **Deliberate comments.** Every comment tells the next reader something the code can't: why, a constraint, a trade-off, a trap. Otherwise delete it, including slop left by earlier agents. No narration, section banners, name-restating doc comments or process notes ("fixed", "now", "per review"). Keep license headers and ticketed TODOs.
- **Directive and executable comments are never touched:** `@ts-…`, `//go:build`, `# type: ignore`, lint directives, docstrings that tests read, Rust doc tests, Go `// Output:` examples.
- **Never edit a line that holds code,** even to change a comment at its end. Never add or remove a block-comment delimiter (`/*`, `*/`): edit the text inside a block comment, and report a whole block that should go.
- **Every doc claim is true of the code.** Confirm each one by reading the code, and record it with its `file:line` in the docs table. A claim you cannot confirm is not written. Check each point of the brief's `mechanism` against the code before using it.
- **The right place, not the main file.** A project's root CLAUDE.md or AGENTS.md stays short: only what every agent needs in every session there. Anything else goes, in this order: into a sub-folder CLAUDE.md or AGENTS.md next to the code it is about; or into a fuller doc (`docs/<topic>.md`) with a one-line pointer from the root file; or nowhere, when the code already says it. Instruction files are untouchable for the writer, so propose each such change in the report, naming its target file and level (root, sub-folder, or pointer plus doc). The docs you write follow the same rule: one home per fact, linked rather than repeated.
- **Docs describe the result, not the journey.**
- **Cut as well as add:** stale, wrong or duplicated text goes.

## Step 3 — check the writer's commit

```bash
node "$CP" --check-commit HEAD --brief builds/<slug>/context-brief.json
```
It fails, naming each path and why, when the commit touched a test file, an agent-instruction file (SKILL.md, CLAUDE.md, AGENTS.md, GEMINI.md, `.cursor/rules`, a pack's `instructions/`, `.claude/`, `.codex/`, `.agents/`), a path the brief lists, a generated block (`<!-- ns:name … -->` … `<!-- /ns:name -->`), a doc line a test quotes, or a line in a code file that is not comment or blank (`.env`-style files count as code files with `#` comments; `builds/<slug>/docs-table.json` is this skill's own output and passes). The code-line part fails closed (anything it cannot read for sure counts as code) and is only an accident barrier: the docs-focus slice reviews the commit as code. On a failure, take those changes out of the commit (restore the files from `HEAD~1` and amend) and put them in the report. Never change the check.

## Step 4 — the docs table

Write `builds/<slug>/docs-table.json` (standalone: print it), one row per changed behavior:
```json
{"rows":[{"behavior":"<what changed>","files":["<changed code files>"],"docs":[{"path":"<doc>","claims":[{"claim":"<what the doc says>","at":"<file:line that backs it>"}]}]},
        {"behavior":"<what changed>","files":["<changed code files>"],"none":"<why no doc is needed>"}]}
```
Every changed code file sits in some row. `pr-facts --check` fails a changed code file no row covers, a row with neither docs nor a reason, and a claim whose `file:line` is not in the repo.

## Output

One commit of comment and doc edits (or none); the docs table; a report of the changes needed in untouchable files, each with its target file and level. In PR mode, pr-review then reviews exactly the files that commit touched as one docs-focus slice and closes it. Standalone, report the table and the needed changes, and stop.
