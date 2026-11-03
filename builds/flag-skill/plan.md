# /flag: workflow issues captured as evidence

A pack, `flag`, with one skill for both harnesses and a small helper that writes one redacted JSON report per
workflow issue to `~/.agent-config-studio/field-reports/`, and lists them for a later session to group and act on.

## Where the helper ships, and why
`flag.mjs` ships inside the skill folder, next to `SKILL.md`, for each harness
(`packs/flag/skills/{claude,codex}/flag/flag.mjs` → `~/.claude/skills/flag/flag.mjs` and
`$CODEX_HOME/skills/flag/flag.mjs`). That is how the packs already ship a skill's own runtime files
(`advisor-contract.md`, `build/grade.schema.json`): a `skill` part copies every listed file, tracks it, updates it
and removes it on uninstall, with no installer change.
- Not the shared runtime: `lib/packs.js` treats `/runtime/` as the review gate's (`RUNTIME_SRC`, `needsRuntime`,
  its refs and version come from `review-gate`), so a second runtime means installer changes for one small script.
- Not beside `ask-model` in `tools/`: that is installed by `acs install-model-id`, outside the pack installer, and
  `/flag` must work without `model-id` (it runs no model; `requires.modelId` and `askModel` are false).
- Cost: two byte-identical copies in the repo. A test pins them identical.

## Report (one file per issue)
`~/.agent-config-studio/field-reports/<YYYY-MM-DD>-<slug>-<6 hex>.json`, mode 0600, folder 0700 (tightened if it
exists looser). Written with `wx`, so nothing is overwritten. The slug comes from `what` after redaction.
Fields: `id`, `ts`, `project {path, name}` (git top level of the cwd, else the cwd), `branch`, `harness`, `model`,
`severity` (low|medium|high), `what`, `expected`, `rulesInForce` (quoted rules, list), `toolCalls` (list: the agent's
own quotes as `{source: "agent", quote}`, and transcript entries as `{source: "transcript", line, entry}`),
`agentTake`, `transcript`, `transcriptHow` (`given`, `session-id`, `newest-in-cwd`, or null).
Input is JSON on stdin (a quoted heredoc), never argv: no secret ever sits in a process list or shell history.
Unknown input keys are refused (typos would silently drop evidence). `what` and `severity` are required.

## Transcript excerpts (formats read from real files, read-only)
- Claude Code `~/.claude/projects/<slug>/<session>.jsonl`: one JSON object per line; tool calls are
  `message.content[]` items `{type: "tool_use", id, name, input}` on assistant lines, results are
  `{type: "tool_result", tool_use_id, content}` on user lines. The model is `message.model`.
- Codex `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`: `{timestamp, type, payload}`; tool calls are
  `response_item` payloads `custom_tool_call {call_id, name, input}` / `custom_tool_call_output {call_id, output}`
  (older `function_call {call_id, arguments}` / `function_call_output` are matched the same way). The first line is
  `session_meta` with `payload.cwd`.
`excerpts: {lines: ["120-140", "200"], toolIds: ["toolu_…", "call_…"]}` copies those lines (a tool id brings its
call and its result) verbatim, as parsed JSON, redacted; any string over 20,000 characters is cut with a visible
`[TRUNCATED n chars]` marker. A line or id that is not there is an error, not a silent gap.
`transcript: "auto"`: Claude Code from `CLAUDE_CODE_SESSION_ID` (seen in this session's env); Codex from
`CODEX_THREAD_ID` if set (unverified that Codex sets it), else the newest rollout whose `session_meta` cwd is this
cwd, recorded as `newest-in-cwd`. `find --text <s>` lists matching line numbers and tool ids so the agent can pick
lines without reading the whole file. A transcript must be a `.jsonl` file and is never a credential file
(`.credentials.json`, `auth.json`), checked after resolving links. The helper reads nothing else.

## Redaction (before anything is written, every string, every field, excerpts included)
`[REDACTED:<kind>]` for: private-key blocks (also unterminated); JWTs; `Bearer`/`Basic` credentials; prefixed tokens
(`sk-ant-`, `sk-`, `ghp_ gho_ ghs_ ghu_ ghr_ github_pat_`, `xox?-`, `AKIA/ASIA`, `rnd_`, `AIza`, `glpat-`, `npm_`);
passwords in URLs; `NAME=value` / `--name value` / `"name": "value"` where the name contains KEY, TOKEN, SECRET or
PASSWORD (any case). Numbers, booleans and null are left alone (`input_tokens: 2` stays). With `:` in prose the
value is redacted when the name is upper case, the value is quoted, has a digit, or is 8+ characters; `=` and flags
always redact. In parsed transcript entries an object key with such a name has its string value redacted whole.
Over-redaction is the accepted failure mode.

## List
`flag.mjs list [--since 2026-11-01|7d|24h] [--project <name or path>] [--json]`: newest first by `ts`; one line per
report (id, ts, severity, project, branch, what) or the full reports as JSON. An unreadable file is named on stderr
and skipped. `show <id>` prints one. The skill's `/flag review` reads them, groups by cause and proposes rule or
skill changes citing report ids; it never edits a rule.

## Pack
`packs/flag/pack.json`: one `skill` part, default on, both harnesses, files `SKILL.md` and `flag.mjs` per harness.
`requires`: node >=20, git false (branch is best effort), modelId false, askModel false, clis anyOf claude/codex/grok.
`lib/packs.js` ORDER gains `flag` after `handoff`. Docs: packs/README.md table.

## Codex sandbox
In Codex's workspace-write sandbox `~/.agent-config-studio/field-reports` is outside the writable roots, so the
write fails. The helper says so in one line and the Codex skill reruns that one command with escalated permissions.
Open choice below.

## Existing tests that change (own test-only commit)
`review.packs.test.mjs`: `IDS` gains `flag`; the SKILL.md count 10 → 12 (three asserts). `packs-catalog.mjs` C10 list
gains `flag`; `packs-server.mjs` catalog order gains `flag`. Each still pins the full set and order.

## Validation
New: `packs/flag/tests/flag.test.mjs` (node:test, temp HOME): writes, modes, each redaction kind, a planted key
in a transcript excerpt, excerpt copying by line and id, find, refusals, list/since/project. `tests/packs-flag.mjs`
(packs sandbox): installs to both skill folders, the installed helper runs, uninstall leaves nothing. Plus
`tests/packs-install.mjs`, `packs-update.mjs`, `packs-catalog.mjs`, `packs-server.mjs` and `review.packs.test.mjs`.

## Open choice
Codex writes: (A, shipped) rerun with escalation, one approval per report; (B, recommended next) widen the review
gate's `codex-log-access` part into a field-reports writable root too, which needs `lib/packs.js` changes.
