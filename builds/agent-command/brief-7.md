# Test-slice review 2026-11-16-21-17-49-7b578f — fix all five (f1 HIGH, f2–f5 MEDIUM). These are test files only, plus lib/agent.js only if a test reveals a real code bug (say so).

For f3–f5 prove each strengthened check: show it fails against the mutation the finding describes, then passes on the real code. Same grouping; you can't commit. Reply DONE with one line per finding.

## f1 HIGH tests/agent-cli.mjs:13
The fake cmux executables fail on CI's pinned Node 20.0.0. These extensionless files contain static imports but have no enclosing package declaring module type, so Node parses them as CommonJS and rejects them before the fixture runs. Parsing the generated body with module detection disabled reproduced the SyntaxError. This blocks successful opens in all five listed suites. See the [Node 20 module rules](https://nodejs.org/download/release/v20.0.0/docs/api/esm.html#enabling).

trigger: The required offline CI job runs these suites on Node 20.0.0.

suggestion: Use a CommonJS-compatible dynamic import in each extensionless wrapper, or explicitly establish its module type.

## f2 MEDIUM tests/agent-cli.mjs:14
These suites preserve CODEX_HOME, CLAUDE_CONFIG_DIR and GROK_HOME while replacing HOME. The fake cmux honors those overrides when writing transcripts, so verification can write synthetic sessions into the user's actual harness homes. An in-memory execution confirmed writes outside the temporary home. With CODEX_HOME set, parallel suites also reuse rollout-session-1.jsonl and can overwrite one another's fixtures, causing incorrect discovery or failures.

trigger: Run verification with a harness-home override exported, particularly the offline suite with --jobs 4 and CODEX_HOME set.

suggestion: Remove all three inherited harness-home overrides from these environments, as agent-review-fixes.mjs and agent-git-access.mjs already do.

## f3 MEDIUM tests/guards.mjs:397
The cmux-only guard checks only the first literal prefix, rather than the complete executable argument. Replacing the production call with spawnSync('cmux' + process.env.AGENT_SUFFIX, ...) left every static guard passing in an in-memory mutation check. The argument is computed and can name another executable, contradicting the property this new exemption must enforce.

trigger: A source change computes the executable from a 'cmux' prefix, then verification runs the subprocess guard.

suggestion: Require the entire first argument to be exactly the cmux literal, and add a mutation case containing a literal followed by an expression.

## f4 MEDIUM tests/guards.mjs:1063
The import scanner requires whitespace after import and before from, missing valid named-import syntax such as import{openWorker}from './lib/agent.js';. Adding that statement to server.js in memory passed every static guard; Node's module syntax checker also accepted it. The server can therefore import the worker module without this isolation check detecting the dependency.

trigger: A server module imports the worker using compact named-import syntax and the import-graph guard runs.

suggestion: Recognize valid named-import token boundaries without requiring whitespace, and cover a compact named import in setup-guards.mjs.

## f5 MEDIUM tests/agent-git-access.mjs:53
The symlink regression assertion rejects only the logical .git/logs path. An implementation that follows the symlink and grants its resolved fakeLogs target passes this assertion, despite widening access outside Git metadata. I evaluated the exact assertion with an argv containing that unrelated directory and it passed. The earlier exact-grant assertion runs before the symlink exists, so it does not cover this failure.

trigger: The launcher grants a symlink's physical target instead of rejecting it, and the symlink regression case runs.

suggestion: Assert the complete expected grant list for the symlinked fixture, excluding both the logical logs path and its resolved target.

## Notes from the orchestrator
- f1: check CI's Node version in .github/workflows; make the fake executables load as ESM there (e.g. a package.json with "type":"module" next to them, or write them as .mjs and point the wrapper at node), and run the five suites under that exact Node version (npx node@<ver> or a downloaded binary) to prove it. If you can't get that Node version offline, say so — the orchestrator will check CI.
- f2: the test harness must unset CODEX_HOME, CLAUDE_CONFIG_DIR and GROK_HOME (or point them into the temp home) so nothing is ever written to a real harness home, and give each suite its own session ids.

