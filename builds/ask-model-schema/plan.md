# C3: `ask-model --schema <file.json>`

Source: `skills-work/plans/reusable-pieces-sweep.md`, C3. review.mjs stays as it is.

## Flags, as review.mjs passes them today
- claude: `--json-schema '<schema JSON>'` (review.mjs:1587), with `--output-format json`; the answer is `structured_output`,
  else `result` parsed as JSON (parseClaude).
- grok: `--json-schema '<schema JSON>'` (review.mjs:1470); the answer is `structuredOutput`, an object or a JSON string
  (parseGrok).
- codex: `--output-schema <file>` (review.mjs:1430); ask-model passes the given file's absolute path, and the answer is
  stdout parsed as JSON.
Read-only tools, no MCP, the model check and the effort rule are unchanged: the schema flag is added to the same argv.

## Validation
A small validator in ask-model.mjs for the subset the gate's schemas use: `type` (one name or a list), `properties`,
`required`, `items`, `enum`, `additionalProperties` (true or false only), `minimum`, `maximum`, `minItems`, plus the
annotations `description`, `title`, `$schema`, which check nothing. Any other keyword, or a malformed one, refuses the
schema with exit 64 before a model runs, naming it. A missing or unreadable or non-JSON schema file is 64 too.
After a good call: the answer must be JSON and match, else exit 6 with the first error (`$.criteria[0].verdict: …`)
on stderr and nothing on stdout. A match prints only the JSON (2-space indented) on stdout. Exits 2, 3, 4 and 5 keep
their meaning and come first; --json carries the JSON text as `answer`.

## Open choice: the Grade's schema and `--log-grade`
codex's structured output is OpenAI strict mode: every property must be in `required`, and an optional field is a
nullable type (review.mjs:1066 says so, and its review schema does that for `file` and `line`). The Grade contract
makes a finding's `file` and `line` optional, but `readGrade` (review.mjs `--log-grade`) refuses `null` for them, so
a strict Grade schema can produce a grade.json `--log-grade` rejects. `vendor`, `effort` and `severity` are optional
and derivable, so the schema leaves them out. The options:
- **A (recommended):** `readGrade` treats a `null` file, line or severity as absent (two lines and a test in
  review-gate). The schema makes `file` and `line` `["string","null"]`, the pattern review.mjs's own review schema uses,
  and the documented contract is unchanged.
- **B:** the schema requires `file` and `line` as strings. No runtime change, but every finding must name a location,
  which tightens the documented contract ("file and line are optional").
- **C:** the skill strips `null` file/line with jq before `--log-grade`. No runtime change; more shell in the skill.
The proposed schema (A) is in `packs/build/grade.schema.json` once decided: family, model, criteria (minItems 1;
id, criterion, verdict PASS|FAIL, evidence) and findings (likelihood and impact 1–10, protected, trigger, issue,
file|null, line|null, evidence), every object closed.

## Tests (stub CLIs, temp HOME)
`tests/ask-model.mjs`: the flag per vendor, a matching answer → 0 with only the JSON on stdout, not JSON → 6, a
mismatch → 6 with the first error, an unsupported or malformed keyword → 64, a missing or non-JSON schema file → 64,
and a schema on fresh defaults with each CLI. The Grade skill test once the choice is made.
