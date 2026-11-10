---
name: pr
description: "Write a pull request description a person can read in a minute, in the user's own style: what changed and why in plain words, whether it matched the goal, how to try it, what was reviewed, fixed and deferred. Facts come from a read-only helper (pr-facts.mjs: the branch's files by purpose, the plan, the review gate's summary and tier), the style from ~/.agent-config-studio/pr/style.json, and a check of the written body runs before gh pr create or gh pr edit. Use when opening or updating a PR, or when the user says '/pr' or 'write the PR description'."
---

# /pr — the PR description, in your style

The description is for a person deciding whether to merge. Every fact in it comes from the helper; your job is the
plain words around those facts. The helper never writes anything but the style file the first time it runs, and it
calls no model.

```bash
PR="${CODEX_HOME:-$HOME/.codex}/skills/pr/pr-facts.mjs"
```

## 1. Get the facts

```bash
node "$PR" > "${TMPDIR:-/tmp}/pr-facts.json"          # add --base <branch> when the base is not the PR's or the default
```

One JSON object: `branch`, `head`, `base` (and where it came from), `pr` (the open PR, or null), `gh` (false when
`gh` is not installed), `commits`, `files` and `counts` by purpose (code, tests, docs, config, static, builds),
`plan` (its Outcome and Out of scope), `buildLog`, `review`, `docs`, `style`, `gif` and `warnings`. An `error` key
means it could not run: say the error in one line and stop.

Tell the user, in one line each, any `warnings` and any `style.note` (for example a style file that could not be
created, so the defaults were used). Carry on.

**Sandbox:** `~/.agent-config-studio/pr/` is outside the workspace, so in a workspace-write sandbox the first run
cannot create the style file: `style.note` says so and the defaults are used. That is fine; to create the file,
rerun the same command once with escalated permissions (`sandbox_permissions: "require_escalated"`,
justification: "create the /pr style file"). `gh` needs the network: when `gh pr view` is refused, `pr` is null, so
pass `--base` if you know the base, and when `gh pr create` answers that a PR already exists, use `gh pr edit` instead.

## 2. Write the description

Write it to a file (`${TMPDIR:-/tmp}/pr-body.md`). The style decides which sections appear, in what order, under which
titles: `style.sections`, each `## <title>` in that order, only those with `on: true`. `style.tone` is `plain`
(short sentences, no jargon, explain any code term in a few words) or `technical`. `style.emoji` false means no
✅ ⚠️ ❌ markers: write "done", "not asked", "not done" instead.

**Never invent facts the helper did not give.** No sha, review id, finding id or file path that is not in the facts
JSON; no test you did not see run; no reviewer the summary does not name. When a fact is missing, say it is
missing.

**Nothing goes above the first section.** Deferred HIGH findings are listed first inside Deferred findings;
unmet criteria (`review.criteria`) go in "Did it match the goal?" as not-done lines. Never paste the
reviewer's raw lines into the body: the full text belongs only in the Review record, when the style turns it on.

The sections, by id (default titles; the user's style may retitle any but Deferred findings):

| id | Default title | What goes in it |
|---|---|---|
| `gif` | (no heading) | When `gif.url` is set: `![](<gif.url>)` as the first line. Off by default. |
| `summary` | What this does and why | 2–3 plain sentences: what it does and why (the problem it solves), not the mechanics. |
| `goal` | Did it match the goal? | Against `plan.outcome` and `plan.outOfScope`: ✅ asked and done, ⚠️ done but not asked, ❌ asked but not done, one line each. Each unmet criterion in `review.criteria` is a not-done line (❌, or "not met") naming its criterion id (e.g. C2) and no other, never ✅ (a line naming two criteria counts for neither); when this section is off, those lines go in Deferred findings. No plan: say there was no plan to check against. |
| `changes` | Files changed | The files grouped by purpose (`files`), one line each on why it changed; counts from `counts`. Group many small files into one line. |
| `try` | How to try it | The commands or steps a reviewer runs to see it work. |
| `review` | Review highlights | Who reviewed: the `review.reviewer` and `review.security` lines. From `review.findings`, each HIGH finding with status fixed: its id and `score` copied as given, and a one-line why from its `issue`. MEDIUMs and LOWs as counts only, from `review.bySeverity` (e.g. "3 MEDIUM: 2 fixed, 1 deferred"). When `review.findings` is null, `review.findingsNote` says why: use `review.fixed` and `review.counts` instead. |
| `deferred` | Deferred findings | One entry per item in `review.deferredItems`, HIGHs first: the id and its `score` exactly as given (e.g. `x1 HIGH 18/100 (likelihood 2/10 × impact 9/10)`), then in plain words what could go wrong and when, why it was deferred (`reason`), and where it is tracked (`trackedIn`) when the reason names it. No file:line, function names, trigger commands or fix ideas unless the reader needs them to understand it. One entry per item: two items never share an entry, even with the same id. A `preExisting` item was there before this branch: say so. An item of kind `unknown` goes in as its raw `line`, verbatim. "none" when it is empty. |
| `docs` | Docs and context | Docs updated? CLAUDE.md or AGENTS.md updated or created? New comments clear? ✅ or a one-line reason each, from `docs` (`codeWithoutDocs` lists code changed with no docs change). When the context pass ran, `docsTable` holds its rows: one line per row, the doc or the reason none is needed; `--check` fails a changed code file no row covers. |
| `agent` | What the agent did | Off by default. Short notes from `buildLog`: the decisions and why. No build log: what you decided in this session, briefly. |
| `quote` | Agent's take | One first-person sentence summing up the PR. |
| `record` | Review record | Off by default. When on and the review is closed: `<details><summary>Review record</summary>`, then `review.summary` in a code block, then `</details>`. |

**The review states are three, and each is said as it is:**

- `review.state` "absent": the review section says `not reviewed (no review gate)`. Leave Deferred findings out.
- `review.state` "in-progress": the review section says `review in progress — not closed at this commit`, with
  `review.reason`. Deferred findings stays, saying the review is not closed yet, so nothing is deferred so far.
  Never write "not reviewed" for a review in progress.
- `review.state` "closed": the review section and Deferred findings are written from `review` as above. Deferred
  findings stays on, titled exactly "Deferred findings", outside any `<details>`.
- `review.state` "error": say the review gate could not be read, with `review.reason`.

Length is a guide, not a gate: most sections are one to five lines; the whole body reads in a minute.

## 3. Check it

```bash
node "$PR" --check "${TMPDIR:-/tmp}/pr-body.md"        # same --base as step 1
```

It prints `{ ok, problems, warnings }`. On exit 1, fix each problem in the body and run the check again; never open
or update the PR while it fails. It checks only what must hold: the sections in the style's order, every deferred item
in its own entry in Deferred findings with its id followed by its exact score (an unknown line verbatim), each unmet
criterion as a not-done line in the goal section (or in Deferred findings when that is off), no deferred id above the
first section, the record folded, and no sha, id or path that is not in the facts. Warnings are yours to
judge.

## 4. Open or update the PR

When `gh` is false, `gh` is not installed: say so in one line, show the body file's path, and stop; nothing is
written.

When `pr` is set (a PR already exists for this branch, `pr.number`), update it with gh pr edit; otherwise create it:

```bash
gh pr edit <pr.number> --body-file "${TMPDIR:-/tmp}/pr-body.md"
gh pr create --base <base branch> --title "<one plain line>" --body-file "${TMPDIR:-/tmp}/pr-body.md"
```

A rerun after more commits (a fix round, a new close) starts again at step 1, so the HEAD, the tier and the deferred
lines are the current ones.

In a sandbox, run gh with escalated permissions (justification: "open or update the pull request").

Then say the PR's URL in one line. Don't restate the description.

## The style file

`~/.agent-config-studio/pr/style.json`, created from `style.example.json` (next to the helper) the first time the
helper runs, and never overwritten. The user edits it by hand:

- `sections`: the list above, in the order they appear; each `{ "id", "title", "on" }`, and the gif entry also
  `"urls": [ … ]` (one is picked by the branch name, so a rerun keeps the same one). A section left out of the list
  is off. "Deferred findings" keeps its title and stays on whenever a review exists.
- `tone`: `"plain"` or `"technical"`. `emoji`: `true` or `false`.

Anything else is ignored, with a warning in the helper's JSON.
