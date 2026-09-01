# Phase 1f — strip MCP tools from the containment allowlist

Worktree (work here only):
/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-harness-picker

STATE: ./verify.sh is 15/15 green. Both harnesses use allowlist containment
(claude `--tools Read`, grok `--tools read_file`). Do not disturb any passing check.

## Why this matters (correcting your last judgment call)
You found `--tools Read --strict-mcp-config` was the strongest strip (toolCount=1) but did
not ship it, reasoning that "local mutation was already prevented."

That reasons about the wrong threat model. `--tools Read` strips BUILTINS; MCP tools survive.
This machine's MCP set includes write-capable tools well beyond the filesystem — Neon
`run_sql` (can mutate a database), Gmail `send_message` (can send mail), Drive `create_file`.
An Assist turn is a propose-diffs-for-review feature. It has no business being able to
execute SQL or send email, and the containment test would NEVER catch it, because that test
only diffs a temp file tree.

"Local mutation prevented" is not the bar. The bar is: an Assist turn cannot take a
consequential action outside the Accept/Reject flow.

## Objective
Ship MCP-stripped containment for both harnesses, proven.

## Steps
1. CLAUDE: add `--strict-mcp-config` (or whatever flag you verified reduces toolCount to
   exactly the allowlisted builtin) to the `containment` array in lib/harness.js.
2. GROK: find and apply the equivalent. Your earlier probe noted MCP meta-tools
   `search_tool` and `use_tool` survive `--tools read_file`. Check `grok --help` for an
   MCP-restricting flag (something like --strict-mcp-config / --no-mcp / --mcp-config).
   If grok has NO such flag, say so plainly and record it as a known residual rather than
   inventing one.
3. Extend the containment assertion for BOTH harnesses to assert the effective tool set
   contains ONLY the allowlisted read tool — i.e. assert on the init event's tool list /
   toolCount, not merely that write builtins are absent. An MCP tool appearing in that list
   must FAIL the check.
4. Re-run the write-demand probe for both to confirm nothing regressed.

## Constraints
- Do NOT modify ~/.claude, ~/.codex, ~/.grok, or any MCP config. Temp dirs only.
- Do NOT touch server.js or public/app.js.
- Do NOT add dependencies.
- Every currently-passing check must stay passing. Do not weaken anything.

## Validate
./verify.sh

## Stop when
Both harnesses run with only their allowlisted read tool in the effective tool set and
verify.sh is green — or you have shown with evidence that a harness has no flag to strip
MCP tools, in which case record it as an explicit known residual.
