# Phase 1d — find grok's REAL containment flag

Worktree (work here only):
/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-harness-picker

## What we now know (from your own last run — do not re-derive)
`--permission-mode plan` is NOT containment. Your 2a probe demanded a write, grok was in
plan mode, no blocked/denied event was emitted, and SKILL.md WAS MUTATED. Plan mode is a
mode echo. Grok therefore currently ships with NO working containment, and the descriptor's
`containment: ['--permission-mode','plan']` is wrong.

You also built the thing that makes this fixable: a write-demand probe that reliably
CAUSES a mutation when grok is uncontained. That is a working POSITIVE CONTROL. Use it as
the detector for every candidate below.

## The flags never tried
`grok --help` lists tool-restriction flags that are the direct analogue of Claude's
`--disallowedTools`, which is exactly what worked for Claude:
  --disallowed-tools <TOOLS>   Built-in tools to remove (comma-separated)
  --tools <TOOLS>              Built-in tools to allow (comma-separated)
  --deny <RULE>                Permission deny rule (compat alias --disallowedTools)
  --allow <RULE>               Permission allow rule (compat alias --allowedTools)
Grok's write-capable built-ins observed in its init event:
  write, search_replace, run_terminal_command

## Objective
Find the flag combination that DEMONSTRABLY prevents grok from writing, prove it with the
positive-control probe, and set it as grok's `containment` in lib/harness.js.

## Method — probe, do not guess
For each candidate, run the write-demand probe against a throwaway temp dir and record:
  (1) does the init event still LIST write/search_replace/run_terminal_command?
  (2) does the file actually get mutated?
Candidates, in order:
  a. --disallowed-tools write,search_replace,run_terminal_command
  b. --tools read_file            (allowlist only a read tool)
  c. --deny <appropriate rule>    (check `grok --help` for the rule syntax)
  d. any combination of the above, and optionally with --permission-mode plan added
A candidate PASSES only if the file is NOT mutated AND, ideally, the write tools are absent
from the init event. Prefer a candidate where the tools are ABSENT (the strong evidence
Claude gives) over one where they are merely listed-but-refused.

Report the full probe matrix — every candidate tried and what each did. This is a finding
worth keeping even for the candidates that fail.

## Then
- Set grok's `containment` in lib/harness.js to whatever actually worked.
- Update the grok containment assertion in tests/phase1.mjs to assert on the REAL evidence
  (tools absent, or a demonstrated no-mutation under the write-demand probe), and remove the
  UNVERIFIED label ONLY if it genuinely passes.
- Keep the negative control, the exit-0 assertion, and every currently-passing check.
- If NOTHING contains grok, say so plainly, leave it UNVERIFIED, and recommend that grok be
  marked unsafe-for-Assist in the descriptor rather than shipped with fake containment.
  An honest "grok cannot be contained" is a perfectly acceptable outcome of this phase.

## Constraints
- Do NOT modify ~/.claude, ~/.codex, ~/.grok. Temp dirs only, and assert the target path is
  inside the temp dir before every probe run.
- Do NOT touch server.js or public/app.js.
- Do NOT add dependencies.
- Do NOT weaken any existing check.

## Validate
./verify.sh

## Stop when
Either grok's containment is proven with the positive control and verify.sh is green, or you
have shown with a full probe matrix that no available flag contains grok.
